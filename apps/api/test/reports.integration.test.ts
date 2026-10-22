import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { createAuth } from "@upzy/auth/server";
import { reportUnsubscribeToken } from "@upzy/auth/unsubscribe";
import { loadBillingConfig, type DodoClient } from "@upzy/billing";
import { createDb, schema } from "@upzy/db";
import { and, eq, inArray, like, sql } from "drizzle-orm";

import { createApp } from "../src/app";

// Real Postgres + real better-auth. Needs: DATABASE_URL=... bun test
const url = process.env.DATABASE_URL;
const run = url ? describe : describe.skip;

run("client reports API (postgres)", () => {
  const SECRET = "integration-test-secret-integration-test-secret";
  process.env.BETTER_AUTH_SECRET ??= SECRET;
  const secret = process.env.BETTER_AUTH_SECRET;
  const db = createDb(url);
  const {
    users,
    organizations,
    workspaces,
    members,
    reportSchedules,
    reportRecipients,
    jobs,
    subscriptions,
  } = schema;
  const auth = createAuth(db, {
    sendEmail: async () => {},
    signup: { mode: "open", allowedEmails: [], allowedDomains: [] },
  });
  const tag = `rr${Date.now()}`;
  const origin = "http://localhost:3001";
  const dodo: DodoClient = {
    createCheckout: async () => ({ url: "https://pay.example/1", sessionId: "s" }),
    createPortal: async () => ({ url: "https://portal.example/1" }),
    cancelSubscription: async () => {},
  };
  const make = (billing: object) =>
    createApp({
      db,
      auth,
      webOrigin: origin,
      encryptionKey: Buffer.alloc(32, 4).toString("base64"),
      rateLimit: { rules: [{ match: () => true, bucket: "t", max: Infinity, windowMs: 1 }] },
      billing: billing as never,
      authSecret: secret,
    });
  const off = make({ config: loadBillingConfig({}) });
  const on = make({
    config: loadBillingConfig({ DODO_API_KEY: "sk_test", DODO_WEBHOOK_SECRET: "whsec_x" }),
    dodo,
  });
  const send = (app: typeof off, path: string, init: RequestInit & { cookie?: string } = {}) =>
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
  type Person = { cookie: string; id: string; email: string };
  const person = async (name: string): Promise<Person> => {
    const email = `${tag}-${name}@example.com`;
    const r = await send(off, "/api/auth/sign-up/email", {
      method: "POST",
      body: JSON.stringify({ email, password: "supersecret123", name }),
    });
    return { cookie: cookieOf(r), id: (await json(r)).user.id as string, email };
  };
  const orgIds: string[] = [];
  const makeOrg = async (who: Person, slug: string) => {
    const org = await json(
      await send(off, "/api/auth/organization/create", {
        method: "POST",
        cookie: who.cookie,
        body: JSON.stringify({ name: `${tag} ${slug}`, slug: `${tag}-${slug}` }),
      }),
    );
    orgIds.push(org.id);
    await send(off, "/api/auth/organization/set-active", {
      method: "POST",
      cookie: who.cookie,
      body: JSON.stringify({ organizationId: org.id }),
    });
    const ws = (
      await db
        .insert(workspaces)
        .values({ orgId: org.id, name: "Acme" })
        .returning({ id: workspaces.id })
    )[0]!.id;
    return { orgId: org.id as string, ws };
  };
  const call = (
    app: typeof off,
    who: Person | null,
    method: string,
    path: string,
    body?: unknown,
  ) =>
    send(app, path, {
      method,
      ...(who ? { cookie: who.cookie } : {}),
      ...(body ? { body: JSON.stringify(body) } : {}),
    });

  let owner: Person, member: Person, other: Person;
  let A = { orgId: "", ws: "" };
  let B = { orgId: "", ws: "" };
  const settings = (over: Record<string, unknown> = {}) => ({
    workspaceId: A.ws,
    enabled: true,
    frequency: "monthly",
    recipients: [`${tag}-c1@example.com`],
    ...over,
  });

  beforeAll(async () => {
    owner = await person("owner");
    member = await person("member");
    other = await person("other");
    A = await makeOrg(owner, "a");
    B = await makeOrg(other, "b");
    await auth.api.addMember({
      body: { userId: member.id, role: "member", organizationId: A.orgId },
    });
    await send(off, "/api/auth/organization/set-active", {
      method: "POST",
      cookie: member.cookie,
      body: JSON.stringify({ organizationId: A.orgId }),
    });
  });
  afterAll(async () => {
    await db.delete(organizations).where(inArray(organizations.id, orgIds));
    await db.delete(users).where(like(users.email, `${tag}-%`));
    await db.delete(jobs).where(sql`${jobs.payload}::text like ${`%${tag}%`}`);
  });

  test("only admins can see or change report settings", async () => {
    expect((await call(off, null, "GET", `/reports?workspaceId=${A.ws}`)).status).toBe(401);
    expect((await call(off, member, "GET", `/reports?workspaceId=${A.ws}`)).status).toBe(403);
    expect((await call(off, member, "PUT", "/reports", settings())).status).toBe(403);
    expect((await call(off, member, "POST", "/reports/test", { workspaceId: A.ws })).status).toBe(
      403,
    );
  });

  test("before anything is set it reports sensible defaults", async () => {
    const r = await json(await call(off, owner, "GET", `/reports?workspaceId=${A.ws}`));
    expect(r).toMatchObject({
      enabled: false,
      frequency: "monthly",
      recipients: [],
      lastSentPeriod: null,
      available: true,
      maxRecipients: 10,
    });
  });

  test("saves a schedule and its recipients, lowercased and without repeats", async () => {
    const r = await call(
      off,
      owner,
      "PUT",
      "/reports",
      settings({
        frequency: "weekly",
        recipients: [`${tag}-C1@Example.com`, `${tag}-c1@example.com`, `${tag}-c2@example.com`],
      }),
    );
    expect(r.status).toBe(200);
    const got = await json(await call(off, owner, "GET", `/reports?workspaceId=${A.ws}`));
    expect(got.enabled).toBe(true);
    expect(got.frequency).toBe("weekly");
    expect(got.recipients.map((x: any) => x.email).sort()).toEqual([
      `${tag}-c1@example.com`,
      `${tag}-c2@example.com`,
    ]);
  });

  test("a recipient who opted out stays opted out when the list is saved again", async () => {
    await db
      .update(reportRecipients)
      .set({ unsubscribedAt: new Date() })
      .where(
        and(
          eq(reportRecipients.workspaceId, A.ws),
          eq(reportRecipients.email, `${tag}-c2@example.com`),
        ),
      );
    await call(
      off,
      owner,
      "PUT",
      "/reports",
      settings({
        recipients: [`${tag}-c1@example.com`, `${tag}-c2@example.com`, `${tag}-c3@example.com`],
      }),
    );
    const got = await json(await call(off, owner, "GET", `/reports?workspaceId=${A.ws}`));
    const by = (e: string) =>
      got.recipients.find((x: any) => x.email === `${tag}-${e}@example.com`);
    expect(by("c2").unsubscribed).toBe(true);
    expect(by("c1").unsubscribed).toBe(false);
    expect(by("c3").unsubscribed).toBe(false);
    // Dropping one removes it.
    await call(off, owner, "PUT", "/reports", settings({ recipients: [`${tag}-c1@example.com`] }));
    const after = await json(await call(off, owner, "GET", `/reports?workspaceId=${A.ws}`));
    expect(after.recipients.map((x: any) => x.email)).toEqual([`${tag}-c1@example.com`]);
  });

  test("rejects bad input", async () => {
    for (const bad of [
      settings({ recipients: ["not-an-email"] }),
      settings({ frequency: "daily" }),
      settings({ recipients: Array.from({ length: 11 }, (_, i) => `${tag}-x${i}@example.com`) }),
      { ...settings(), workspaceId: "nope" },
    ]) {
      const r = await call(off, owner, "PUT", "/reports", bad);
      expect(r.status).toBeGreaterThanOrEqual(400);
      expect(r.status).toBeLessThan(500);
    }
    // Turning reports on with nobody to send to makes no sense.
    expect((await call(off, owner, "PUT", "/reports", settings({ recipients: [] }))).status).toBe(
      422,
    );
    // Turning them off with nobody is fine.
    expect(
      (await call(off, owner, "PUT", "/reports", settings({ enabled: false, recipients: [] })))
        .status,
    ).toBe(200);
  });

  test("another organization's workspace is not found", async () => {
    expect((await call(off, owner, "GET", `/reports?workspaceId=${B.ws}`)).status).toBe(404);
    expect(
      (await call(off, owner, "PUT", "/reports", settings({ workspaceId: B.ws }))).status,
    ).toBe(404);
    expect((await call(off, owner, "POST", "/reports/test", { workspaceId: B.ws })).status).toBe(
      404,
    );
    expect(
      await db.select().from(reportSchedules).where(eq(reportSchedules.workspaceId, B.ws)),
    ).toHaveLength(0);
  });

  describe("plans", () => {
    test("on a plan without reports (the Pro trial) turning them on is a 402, but the settings can still be saved off", async () => {
      const r = await call(on, owner, "PUT", "/reports", settings());
      expect(r.status).toBe(402);
      expect((await json(r)).message).toContain("Agency");
      expect((await call(on, owner, "PUT", "/reports", settings({ enabled: false }))).status).toBe(
        200,
      );
      const got = await json(await call(on, owner, "GET", `/reports?workspaceId=${A.ws}`));
      expect(got.available).toBe(false);
      expect((await call(on, owner, "POST", "/reports/test", { workspaceId: A.ws })).status).toBe(
        402,
      );
    });

    test("on the Agency plan it works", async () => {
      await db
        .insert(subscriptions)
        .values({ organizationId: A.orgId, plan: "agency", status: "active" })
        .onConflictDoUpdate({
          target: subscriptions.organizationId,
          set: { plan: "agency", status: "active" },
        });
      expect((await call(on, owner, "PUT", "/reports", settings())).status).toBe(200);
      expect(
        (await json(await call(on, owner, "GET", `/reports?workspaceId=${A.ws}`))).available,
      ).toBe(true);
    });
  });

  describe("test report", () => {
    test("is queued for the person asking, and only one at a time", async () => {
      await db.delete(jobs).where(eq(jobs.queue, "report"));
      const first = await call(off, owner, "POST", "/reports/test", { workspaceId: A.ws });
      expect(first.status).toBe(200);
      expect((await json(first)).to).toBe(owner.email);
      const queued = await db.select().from(jobs).where(eq(jobs.queue, "report"));
      expect(queued).toHaveLength(1);
      expect(queued[0]!.payload).toMatchObject({
        kind: "test",
        workspaceId: A.ws,
        to: owner.email,
      });
      expect((await call(off, owner, "POST", "/reports/test", { workspaceId: A.ws })).status).toBe(
        409,
      );
    });
  });

  describe("unsubscribe", () => {
    const link = (w: string, e: string, t: string) =>
      `/reports/unsubscribe?w=${encodeURIComponent(w)}&e=${encodeURIComponent(e)}&t=${t}`;
    const addr = () => `${tag}-unsub@example.com`;

    test("a valid link opts that address out, without signing in", async () => {
      await db
        .insert(reportRecipients)
        .values({ workspaceId: A.ws, email: addr() })
        .onConflictDoNothing();
      const r = await call(
        off,
        null,
        "GET",
        link(A.ws, addr(), reportUnsubscribeToken(secret, A.ws, addr())),
      );
      expect(r.status).toBe(200);
      expect(await r.text()).toContain("unsubscribed");
      const [row] = await db
        .select()
        .from(reportRecipients)
        .where(and(eq(reportRecipients.workspaceId, A.ws), eq(reportRecipients.email, addr())));
      expect(row!.unsubscribedAt).not.toBeNull();
    });

    test("a wrong token, another workspace's token or another address's token changes nothing", async () => {
      const other1 = `${tag}-keep@example.com`;
      await db
        .insert(reportRecipients)
        .values({ workspaceId: A.ws, email: other1 })
        .onConflictDoNothing();
      for (const t of [
        "deadbeef",
        reportUnsubscribeToken(secret, B.ws, other1),
        reportUnsubscribeToken(secret, A.ws, addr()),
        reportUnsubscribeToken("another-secret", A.ws, other1),
      ]) {
        const r = await call(off, null, "GET", link(A.ws, other1, t));
        expect(r.status).toBe(400);
      }
      const [row] = await db
        .select()
        .from(reportRecipients)
        .where(and(eq(reportRecipients.workspaceId, A.ws), eq(reportRecipients.email, other1)));
      expect(row!.unsubscribedAt).toBeNull();
    });
  });

  test("schedules, recipients and members are removed with their workspace", async () => {
    const [m] = await db.select().from(members).where(eq(members.userId, member.id));
    expect(m).toBeDefined();
    await db.delete(workspaces).where(eq(workspaces.id, A.ws));
    expect(
      await db.select().from(reportSchedules).where(eq(reportSchedules.workspaceId, A.ws)),
    ).toHaveLength(0);
    expect(
      await db.select().from(reportRecipients).where(eq(reportRecipients.workspaceId, A.ws)),
    ).toHaveLength(0);
  });
});
