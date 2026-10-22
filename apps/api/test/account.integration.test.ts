import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import type { Email } from "@upzy/auth/email";
import { createAuth } from "@upzy/auth/server";
import { unsubscribeToken } from "@upzy/auth/unsubscribe";
import { createDb, schema } from "@upzy/db";
import { eq, inArray, like, sql } from "drizzle-orm";

import { createApp } from "../src/app";

// Real Postgres + real better-auth. Needs: DATABASE_URL=... bun test
const url = process.env.DATABASE_URL;
const run = url ? describe : describe.skip;

run("account, unsubscribe and deletion (postgres)", () => {
  const SECRET = "integration-test-secret-integration-test-secret";
  process.env.BETTER_AUTH_SECRET ??= SECRET;
  const secret = process.env.BETTER_AUTH_SECRET;
  const db = createDb(url);
  const {
    users,
    organizations,
    workspaces,
    monitors,
    members,
    subscriptions,
    sessions,
    jobs,
    lifecycleEmails,
  } = schema;

  const sent: Email[] = [];
  const cancelled: string[] = [];
  let providerDown = false;
  const cancelSubscription = async (id: string) => {
    if (providerDown) throw new Error("provider is down");
    cancelled.push(id);
  };
  const auth = createAuth(db, {
    sendEmail: async (e) => void sent.push(e),
    signup: { mode: "open", allowedEmails: [], allowedDomains: [] },
    cancelSubscription,
  });
  const tag = `ac${Date.now()}`;
  const origin = "http://localhost:3001";
  const app = createApp({
    db,
    auth,
    webOrigin: origin,
    encryptionKey: Buffer.alloc(32, 4).toString("base64"),
    rateLimit: { rules: [{ match: () => true, bucket: "t", max: Infinity, windowMs: 1 }] },
    cancelSubscription,
    authSecret: secret,
  });
  const send = (path: string, init: RequestInit & { cookie?: string } = {}) =>
    app.handle(
      new Request(`http://localhost${path}`, {
        ...init,
        headers: {
          "content-type": "application/json",
          origin,
          ...(init.cookie ? { cookie: init.cookie } : {}),
        },
      }),
    );
  const json = async (r: Response) => (await r.json()) as any;
  const cookieOf = (r: Response) =>
    r.headers
      .getSetCookie()
      .map((c) => c.split(";")[0])
      .join("; ");
  const PASSWORD = "supersecret123";
  const person = async (name: string) => {
    const r = await send("/api/auth/sign-up/email", {
      method: "POST",
      body: JSON.stringify({ email: `${tag}-${name}@example.com`, password: PASSWORD, name }),
    });
    return { cookie: cookieOf(r), id: (await json(r)).user.id as string, name };
  };
  type Person = Awaited<ReturnType<typeof person>>;
  const orgIds: string[] = [];
  const makeOrg = async (who: Person, slug: string) => {
    const org = await json(
      await send("/api/auth/organization/create", {
        method: "POST",
        cookie: who.cookie,
        body: JSON.stringify({ name: `${tag} ${slug}`, slug: `${tag}-${slug}` }),
      }),
    );
    orgIds.push(org.id);
    await send("/api/auth/organization/set-active", {
      method: "POST",
      cookie: who.cookie,
      body: JSON.stringify({ organizationId: org.id }),
    });
    const ws = (
      await db
        .insert(workspaces)
        .values({ orgId: org.id, name: "w" })
        .returning({ id: workspaces.id })
    )[0]!.id;
    await db.insert(monitors).values({
      workspaceId: ws,
      name: "api",
      type: "http",
      target: "https://example.com",
      interval: 60,
      active: true,
    });
    return { id: org.id as string, name: `${tag} ${slug}`, ws };
  };
  const join = async (org: { id: string }, who: Person, role: string) => {
    await auth.api.addMember({
      body: { userId: who.id, role: role as never, organizationId: org.id },
    });
    await send("/api/auth/organization/set-active", {
      method: "POST",
      cookie: who.cookie,
      body: JSON.stringify({ organizationId: org.id }),
    });
  };
  const call = (who: Person | null, method: string, path: string, body?: unknown) =>
    send(path, {
      method,
      ...(who ? { cookie: who.cookie } : {}),
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
  const orgExists = async (id: string) =>
    (await db.select({ id: organizations.id }).from(organizations).where(eq(organizations.id, id)))
      .length > 0;
  const userExists = async (id: string) =>
    (await db.select({ id: users.id }).from(users).where(eq(users.id, id))).length > 0;
  const mailTo = async (who: Person) =>
    (await db.select({ payload: jobs.payload }).from(jobs).where(eq(jobs.queue, "email")))
      .map((r) => r.payload as Email)
      .filter((e) => e.to === `${tag}-${who.name}@example.com`);

  afterAll(async () => {
    await db.delete(organizations).where(inArray(organizations.id, orgIds));
    await db.delete(users).where(like(users.email, `${tag}-%`));
    await db.delete(jobs).where(sql`${jobs.payload}::text like ${`%${tag}%`}`);
  });

  describe("unsubscribe and preferences", () => {
    let who: Person;
    beforeAll(async () => {
      who = await person("pref");
    });
    const flag = async () =>
      (await db.select().from(users).where(eq(users.id, who.id)))[0]!.lifecycleEmails;

    test("a valid link turns lifecycle emails off, without signing in", async () => {
      expect(await flag()).toBe(true);
      const r = await send(
        `/lifecycle/unsubscribe?u=${encodeURIComponent(who.id)}&t=${unsubscribeToken(secret, who.id)}`,
      );
      expect(r.status).toBe(200);
      expect(r.headers.get("content-type")).toContain("text/html");
      expect(await r.text()).toContain("unsubscribed");
      expect(await flag()).toBe(false);
    });

    test("a wrong or borrowed token changes nothing", async () => {
      await db.update(users).set({ lifecycleEmails: true }).where(eq(users.id, who.id));
      const stranger = await person("stranger");
      for (const t of [
        "deadbeef",
        unsubscribeToken(secret, stranger.id),
        unsubscribeToken("another-secret", who.id),
      ]) {
        const r = await send(`/lifecycle/unsubscribe?u=${encodeURIComponent(who.id)}&t=${t}`);
        expect(r.status).toBe(400);
      }
      expect(await flag()).toBe(true);
    });

    test("the signed-in user can read and change the preference", async () => {
      expect((await json(await call(who, "GET", "/account"))).lifecycleEmails).toBe(true);
      const r = await call(who, "PATCH", "/account", { lifecycleEmails: false });
      expect(r.status).toBe(200);
      expect((await json(await call(who, "GET", "/account"))).lifecycleEmails).toBe(false);
      expect((await call(null, "GET", "/account")).status).toBe(401);
      expect(
        (await call(who, "PATCH", "/account", { lifecycleEmails: "no" })).status,
      ).toBeGreaterThanOrEqual(400);
    });
  });

  describe("deleting an organization", () => {
    let owner: Person, admin: Person, member: Person;
    let org: Awaited<ReturnType<typeof makeOrg>>;
    beforeAll(async () => {
      owner = await person("owner");
      admin = await person("admin");
      member = await person("member");
      org = await makeOrg(owner, "doomed");
      await join(org, admin, "admin");
      await join(org, member, "member");
    });

    test("only an owner can, so admins and members are refused", async () => {
      for (const who of [admin, member])
        expect((await call(who, "DELETE", "/organization", { confirm: org.name })).status).toBe(
          403,
        );
      expect(await orgExists(org.id)).toBe(true);
    });

    test("the name has to be typed exactly", async () => {
      for (const confirm of ["", "nope", org.name.toUpperCase(), `${org.name} x`]) {
        const r = await call(owner, "DELETE", "/organization", { confirm });
        expect([400, 422]).toContain(r.status);
      }
      expect(await orgExists(org.id)).toBe(true);
    });

    test("a payment provider failure deletes nothing, then a retry cancels the subscription and deletes everything", async () => {
      await db.insert(subscriptions).values({
        organizationId: org.id,
        plan: "pro",
        status: "active",
        providerSubscriptionId: `${tag}-sub`,
      });
      providerDown = true;
      const failed = await call(owner, "DELETE", "/organization", { confirm: org.name });
      expect(failed.status).toBe(502);
      expect(await orgExists(org.id)).toBe(true);
      expect(cancelled).toHaveLength(0);

      providerDown = false;
      const ok = await call(owner, "DELETE", "/organization", { confirm: org.name });
      expect(ok.status).toBe(204);
      expect(cancelled).toEqual([`${tag}-sub`]);
      expect(await orgExists(org.id)).toBe(false);
      expect(await db.select().from(workspaces).where(eq(workspaces.orgId, org.id))).toHaveLength(
        0,
      );
      expect(await db.select().from(monitors).where(eq(monitors.workspaceId, org.ws))).toHaveLength(
        0,
      );
      expect(
        await db.select().from(members).where(eq(members.organizationId, org.id)),
      ).toHaveLength(0);
      expect(
        await db.select().from(subscriptions).where(eq(subscriptions.organizationId, org.id)),
      ).toHaveLength(0);
      // Nobody is left pointing at it.
      const left = await db
        .select()
        .from(sessions)
        .where(eq(sessions.activeOrganizationId, org.id));
      expect(left).toHaveLength(0);
    });

    test("the other members are told, and the person who did it is not emailed about their own action", async () => {
      expect((await mailTo(admin)).map((e) => e.subject)).toContain(
        `${org.name} was deleted on Upzy`,
      );
      expect((await mailTo(member)).map((e) => e.subject)).toContain(
        `${org.name} was deleted on Upzy`,
      );
      expect((await mailTo(owner)).map((e) => e.subject)).not.toContain(
        `${org.name} was deleted on Upzy`,
      );
    });

    test("it cannot touch another organization, and a signed-out caller is refused", async () => {
      const other = await person("bystander");
      const theirs = await makeOrg(other, "safe");
      expect((await call(null, "DELETE", "/organization", { confirm: theirs.name })).status).toBe(
        401,
      );
      // The active organization decides the target, so an owner elsewhere can't name it.
      const r = await call(owner, "DELETE", "/organization", { confirm: theirs.name });
      expect(r.status).not.toBe(204);
      expect(await orgExists(theirs.id)).toBe(true);
    });

    test("a free organization with no subscription needs no provider call", async () => {
      const solo = await person("freeowner");
      const free = await makeOrg(solo, "free");
      const before = cancelled.length;
      expect((await call(solo, "DELETE", "/organization", { confirm: free.name })).status).toBe(
        204,
      );
      expect(cancelled).toHaveLength(before);
      expect(await orgExists(free.id)).toBe(false);
    });
  });

  describe("deleting an account", () => {
    const del = (who: Person, password?: string) =>
      call(who, "POST", "/api/auth/delete-user", password ? { password } : {});

    test("needs the right password", async () => {
      const who = await person("wrongpw");
      expect((await del(who, "not-the-password")).status).toBeGreaterThanOrEqual(400);
      expect(await userExists(who.id)).toBe(true);
    });

    test("removes the account, its sessions and the organizations it was alone in, and cancels their subscription", async () => {
      const who = await person("alone");
      const mine = await makeOrg(who, "alone-org");
      await db.insert(subscriptions).values({
        organizationId: mine.id,
        plan: "starter",
        status: "active",
        providerSubscriptionId: `${tag}-alone-sub`,
      });
      sent.length = 0;
      const r = await del(who, PASSWORD);
      expect(r.status).toBe(200);
      expect(await userExists(who.id)).toBe(false);
      expect(await orgExists(mine.id)).toBe(false);
      expect(cancelled).toContain(`${tag}-alone-sub`);
      expect(await db.select().from(sessions).where(eq(sessions.userId, who.id))).toHaveLength(0);
      expect(sent.map((e) => e.subject)).toContain("Your Upzy account was deleted");
      expect(sent.find((e) => e.subject === "Your Upzy account was deleted")!.to).toBe(
        `${tag}-alone@example.com`,
      );
    });

    test("a sole owner of an organization with other people must hand it over first", async () => {
      const boss = await person("boss");
      const crew = await person("crew");
      const team = await makeOrg(boss, "team");
      await join(team, crew, "member");

      const info = await json(await call(boss, "GET", "/account"));
      expect(info.blockedBy).toEqual([{ id: team.id, name: team.name }]);

      const r = await del(boss, PASSWORD);
      expect(r.status).toBe(400);
      expect((await json(r)).message).toContain(team.name);
      expect(await userExists(boss.id)).toBe(true);
      expect(await orgExists(team.id)).toBe(true);

      // With a second owner the first can go, and the organization lives on with its people.
      await db.update(members).set({ role: "owner" }).where(eq(members.userId, crew.id));
      expect((await json(await call(boss, "GET", "/account"))).blockedBy).toEqual([]);
      expect((await del(boss, PASSWORD)).status).toBe(200);
      expect(await userExists(boss.id)).toBe(false);
      expect(await orgExists(team.id)).toBe(true);
      expect(await userExists(crew.id)).toBe(true);
    });

    test("a member leaving does not touch the organization they belonged to", async () => {
      const lead = await person("lead");
      const joiner = await person("joiner");
      const o = await makeOrg(lead, "stays");
      await join(o, joiner, "member");
      expect((await del(joiner, PASSWORD)).status).toBe(200);
      expect(await orgExists(o.id)).toBe(true);
      expect(await userExists(lead.id)).toBe(true);
    });

    test("nothing is deleted when the subscription can't be cancelled", async () => {
      const who = await person("billed");
      const mine = await makeOrg(who, "billed-org");
      await db.insert(subscriptions).values({
        organizationId: mine.id,
        plan: "pro",
        status: "active",
        providerSubscriptionId: `${tag}-billed-sub`,
      });
      providerDown = true;
      const r = await del(who, PASSWORD);
      providerDown = false;
      expect(r.status).toBeGreaterThanOrEqual(400);
      expect(await userExists(who.id)).toBe(true);
      expect(await orgExists(mine.id)).toBe(true);
    });

    test("lifecycle records for a deleted organization are removed with it", async () => {
      const who = await person("records");
      const mine = await makeOrg(who, "records-org");
      await db.insert(lifecycleEmails).values({ subject: mine.id, kind: "trial_ending" });
      expect((await call(who, "DELETE", "/organization", { confirm: mine.name })).status).toBe(204);
      expect(
        await db.select().from(lifecycleEmails).where(eq(lifecycleEmails.subject, mine.id)),
      ).toHaveLength(0);
    });
  });
});
