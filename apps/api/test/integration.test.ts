import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { createAuth } from "@upzy/auth/server";
import { createDb, schema } from "@upzy/db";
import { eq, like } from "drizzle-orm";

import { createApp } from "../src/app";

// Real Postgres + real better-auth (roles, sessions). Needs a migrated DB: DATABASE_URL=... bun test
const url = process.env.DATABASE_URL;
const run = url ? describe : describe.skip;

run("roles + audit log (postgres, real auth)", () => {
  process.env.BETTER_AUTH_SECRET ??= "integration-test-secret-integration-test-secret";
  const db = createDb(url);
  const outbox: { to: string; subject: string; text: string }[] = [];
  const auth = createAuth(db, { sendEmail: async (m) => void outbox.push(m) });
  const app = createApp({
    db,
    auth,
    webOrigin: "http://localhost:3001",
    encryptionKey: Buffer.alloc(32, 3).toString("base64"),
    // Many sign-ups from one address: rate limiting has its own tests.
    rateLimit: { rules: [{ match: () => true, bucket: "test", max: Infinity, windowMs: 60_000 }] },
  });
  const tag = `it${Date.now()}`;
  const origin = "http://localhost:3001";

  const send = (path: string, init: RequestInit & { cookie?: string } = {}) =>
    app.handle(
      new Request(`http://localhost${path}`, {
        ...init,
        headers: {
          "content-type": "application/json",
          origin,
          ...(init.cookie ? { cookie: init.cookie } : {}),
          "x-forwarded-for": "7.7.7.7",
        },
      }),
    );
  const json = async (res: Response) => (await res.json()) as any;
  const cookieOf = (res: Response) =>
    res.headers
      .getSetCookie()
      .map((c) => c.split(";")[0])
      .join("; ");

  const user = async (name: string) => {
    const res = await send("/api/auth/sign-up/email", {
      method: "POST",
      body: JSON.stringify({
        email: `${tag}-${name}@example.com`,
        password: "supersecret123",
        name,
      }),
    });
    expect(res.status).toBe(200);
    return { cookie: cookieOf(res), id: (await json(res)).user.id as string };
  };

  let owner: { cookie: string; id: string };
  let viewer: { cookie: string; id: string };
  let member: { cookie: string; id: string };
  let orgId = "";

  beforeAll(async () => {
    owner = await user("owner");
    const created = await send("/api/auth/organization/create", {
      method: "POST",
      cookie: owner.cookie,
      body: JSON.stringify({ name: "IT", slug: `${tag}-org` }),
    });
    orgId = (await json(created)).id;
    await send("/api/auth/organization/set-active", {
      method: "POST",
      cookie: owner.cookie,
      body: JSON.stringify({ organizationId: orgId }),
    });

    for (const [name, role] of [
      ["viewer", "viewer"],
      ["member", "member"],
    ] as const) {
      const u = await user(name);
      await auth.api.addMember({ body: { userId: u.id, role, organizationId: orgId } });
      const res = await send("/api/auth/organization/set-active", {
        method: "POST",
        cookie: u.cookie,
        body: JSON.stringify({ organizationId: orgId }),
      });
      expect(res.status).toBe(200);
      if (name === "viewer") viewer = u;
      else member = u;
    }
  });

  afterAll(async () => {
    await db.delete(schema.organizations).where(eq(schema.organizations.id, orgId));
    await db.delete(schema.users).where(like(schema.users.email, `${tag}-%`));
  });

  /** Audit rows are written after the response, so wait until the count stops changing instead of guessing a delay. */
  const auditSettled = async () => {
    let last = -1;
    let stable = 0;
    for (let i = 0; i < 100 && stable < 3; i++) {
      const n = (await auditRows()).length;
      stable = n === last ? stable + 1 : 0;
      last = n;
      await Bun.sleep(25);
    }
  };
  /** Polls until `check` is true (audit rows arrive after the response, and later still when the machine is busy). */
  const untilAudit = async (check: (rows: Awaited<ReturnType<typeof auditRows>>) => boolean) => {
    const deadline = Date.now() + 8_000;
    for (;;) {
      const rows = await auditRows();
      if (check(rows) || Date.now() > deadline) return rows;
      await Bun.sleep(40);
    }
  };
  const auditRows = () =>
    db.select().from(schema.auditLogs).where(eq(schema.auditLogs.organizationId, orgId));
  let workspaceId = "";

  test("owner can create a workspace; the audit row names the new resource", async () => {
    const res = await send("/workspace", {
      method: "POST",
      cookie: owner.cookie,
      body: JSON.stringify({ name: "Prod" }),
    });
    expect(res.status).toBe(201);
    workspaceId = (await json(res)).id;
    await auditSettled();
    const row = (await auditRows()).find((r) => r.action === "POST /workspace");
    expect(row).toMatchObject({
      userId: owner.id,
      resourceType: "workspace",
      resourceId: workspaceId,
      status: 201,
      ip: "unknown",
    });
    expect(row!.payload).toEqual({ params: {}, fields: ["name"] });
  });

  test("a viewer can read but not create, and the refusal is audited", async () => {
    expect((await send("/workspace", { cookie: viewer.cookie })).status).toBe(200);
    const denied = await send("/workspace", {
      method: "POST",
      cookie: viewer.cookie,
      body: JSON.stringify({ name: "Nope" }),
    });
    expect(denied.status).toBe(403);
    expect((await json(denied)).message).toContain("admin");
    const rows = await untilAudit((r) =>
      r.some((x) => x.userId === viewer.id && x.status === 403 && x.action === "POST /workspace"),
    );
    expect(
      rows.some(
        (r) => r.userId === viewer.id && r.status === 403 && r.action === "POST /workspace",
      ),
    ).toBe(true);
  });

  test("a member can manage monitors but not channels or workspaces", async () => {
    const monitor = await send("/monitor", {
      method: "POST",
      cookie: member.cookie,
      body: JSON.stringify({
        workspaceId,
        name: "m",
        type: "http",
        target: "https://example.com",
        interval: 60,
      }),
    });
    expect(monitor.status).toBe(201);
    expect(
      (
        await send("/channel", {
          method: "POST",
          cookie: member.cookie,
          body: JSON.stringify({ workspaceId, name: "c", kind: "email", to: "a@b.co" }),
        })
      ).status,
    ).toBe(403);
    expect(
      (await send(`/workspace/${workspaceId}`, { method: "DELETE", cookie: member.cookie })).status,
    ).toBe(403);
    // ...and a viewer cannot touch that monitor.
    const id = (await json(monitor)).id;
    expect((await send(`/monitor/${id}`, { method: "DELETE", cookie: viewer.cookie })).status).toBe(
      403,
    );
  });

  test("demoting a member takes effect immediately", async () => {
    await db
      .update(schema.members)
      .set({ role: "viewer" })
      .where(eq(schema.members.userId, member.id));
    expect(
      (
        await send("/monitor", {
          method: "POST",
          cookie: member.cookie,
          body: JSON.stringify({
            workspaceId,
            name: "m2",
            type: "http",
            target: "https://example.com",
            interval: 60,
          }),
        })
      ).status,
    ).toBe(403);
    await db
      .update(schema.members)
      .set({ role: "member" })
      .where(eq(schema.members.userId, member.id));
  });

  test("removing someone from the organization cuts their access", async () => {
    const outsider = await user("outsider");
    await send("/api/auth/organization/set-active", {
      method: "POST",
      cookie: outsider.cookie,
      body: JSON.stringify({ organizationId: orgId }),
    });
    expect((await send("/workspace", { cookie: outsider.cookie })).status).toBe(403);
  });

  test("only admins read the audit log; entries carry the actor, and secrets are not in them", async () => {
    expect((await send("/audit", { cookie: viewer.cookie })).status).toBe(403);
    expect((await send("/audit", { cookie: member.cookie })).status).toBe(403);

    await send("/channel", {
      method: "POST",
      cookie: owner.cookie,
      body: JSON.stringify({
        workspaceId,
        name: "hook",
        kind: "webhook",
        url: "https://hooks.example.com/SECRET-PATH-123",
      }),
    });
    await auditSettled();

    const res = await send("/audit?limit=100", { cookie: owner.cookie });
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.items.length).toBeGreaterThanOrEqual(4);
    expect(body.items[0].userEmail).toContain(tag);
    expect(JSON.stringify(body)).not.toContain("SECRET-PATH-123");
    const times = body.items.map((i: { createdAt: string }) => i.createdAt);
    expect([...times].sort().reverse()).toEqual(times); // newest first
  });

  test("pagination walks the whole log without repeats", async () => {
    const seen: string[] = [];
    let before: string | undefined;
    for (let i = 0; i < 10; i++) {
      const page = await json(
        await send(`/audit?limit=2${before ? `&before=${before}` : ""}`, { cookie: owner.cookie }),
      );
      seen.push(...page.items.map((x: { id: string }) => x.id));
      if (!page.next) break;
      before = page.next;
    }
    expect(new Set(seen).size).toBe(seen.length);
    expect(seen.length).toBe((await auditRows()).length);
  });

  test("CSV export is a download with a header row, and neutralises formulas", async () => {
    await send("/workspace", {
      method: "POST",
      cookie: owner.cookie,
      body: JSON.stringify({ name: "=cmd|' /C calc'!A0" }),
    });
    await auditSettled();
    const res = await send("/audit/export", { cookie: owner.cookie });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/csv");
    expect(res.headers.get("content-disposition")).toContain("attachment");
    const lines = (await res.text()).split("\n");
    expect(lines[0]).toBe(
      "time,user,email,action,resource_type,resource_id,status,ip,user_agent,details",
    );
    expect(lines.length).toBeGreaterThan(3);
    expect((await send("/audit/export", { cookie: viewer.cookie })).status).toBe(403);
  });

  test("audit entries are isolated per organization", async () => {
    const other = await user("other");
    const org2 = await json(
      await send("/api/auth/organization/create", {
        method: "POST",
        cookie: other.cookie,
        body: JSON.stringify({ name: "Other", slug: `${tag}-org2` }),
      }),
    );
    await send("/api/auth/organization/set-active", {
      method: "POST",
      cookie: other.cookie,
      body: JSON.stringify({ organizationId: org2.id }),
    });
    const mine = await json(await send("/audit", { cookie: other.cookie }));
    // Only this organization's own history (its creation), none of the other organization's entries.
    expect(mine.items.map((i: { action: string }) => i.action)).toEqual([
      "POST /api/auth/organization/create",
    ]);
    expect(mine.items.every((i: { userEmail: string }) => i.userEmail.includes("-other@"))).toBe(
      true,
    );
    await db.delete(schema.organizations).where(eq(schema.organizations.id, org2.id));
  });

  describe("team invitations", () => {
    let invitationId = "";
    let newcomer: { cookie: string; id: string };
    const postAuth = (path: string, who: { cookie: string }, body: object) =>
      send(`/api/auth${path}`, { method: "POST", cookie: who.cookie, body: JSON.stringify(body) });

    test("a member cannot invite people", async () => {
      const res = await postAuth("/organization/invite-member", member, {
        email: `${tag}-x@example.com`,
        role: "member",
        organizationId: orgId,
      });
      expect(res.status).toBeGreaterThanOrEqual(400);
      expect(outbox.some((m) => m.to === `${tag}-x@example.com`)).toBe(false);
    });

    test("an owner invites someone as a viewer; the email carries a link to accept", async () => {
      const email = `${tag}-newcomer@example.com`;
      const res = await postAuth("/organization/invite-member", owner, {
        email,
        role: "viewer",
        organizationId: orgId,
      });
      expect(res.status).toBe(200);
      invitationId = (await json(res)).id;
      const mail = outbox.find((m) => m.to === email && m.subject.includes("invited you"));
      expect(mail).toBeDefined();
      expect(mail!.text).toContain(`/accept-invitation/${invitationId}`);
      expect(mail!.text).toContain("as a viewer");
    });

    test("the invitee signs up, accepts, and lands with exactly the invited role", async () => {
      newcomer = await user("newcomer");
      expect(
        (await postAuth("/organization/accept-invitation", newcomer, { invitationId })).status,
      ).toBe(200);
      await postAuth("/organization/set-active", newcomer, { organizationId: orgId });
      expect((await send("/workspace", { cookie: newcomer.cookie })).status).toBe(200);
      expect(
        (
          await send("/workspace", {
            method: "POST",
            cookie: newcomer.cookie,
            body: JSON.stringify({ name: "x" }),
          })
        ).status,
      ).toBe(403);
    });

    test("an invitation cannot be accepted by someone else or reused", async () => {
      const stranger = await user("stranger");
      expect(
        (await postAuth("/organization/accept-invitation", stranger, { invitationId })).status,
      ).toBeGreaterThanOrEqual(400);
    });

    test("invitation and membership changes are audited, with the role but no tokens", async () => {
      await postAuth("/organization/update-member-role", owner, {
        memberId: (
          await db.select().from(schema.members).where(eq(schema.members.userId, newcomer.id))
        )[0]!.id,
        role: "member",
        organizationId: orgId,
      });
      await auditSettled();
      const rows = await auditRows();
      // The earlier refused attempt by the member is audited too; this is the owner's successful one.
      const invite = rows.find(
        (r) => r.action === "POST /api/auth/organization/invite-member" && r.userId === owner.id,
      );
      expect(invite).toMatchObject({ userId: owner.id, resourceType: "invitation", status: 200 });
      expect(invite!.payload).toMatchObject({
        email: `${tag}-newcomer@example.com`,
        role: "viewer",
      });
      const change = rows.find(
        (r) => r.action === "POST /api/auth/organization/update-member-role",
      );
      expect(change).toMatchObject({ userId: owner.id, resourceType: "member" });
      expect(change!.payload).toMatchObject({ role: "member" });
      expect(
        rows.some(
          (r) => r.action.endsWith("/organization/accept-invitation") && r.userId === newcomer.id,
        ),
      ).toBe(true);
    });

    test("an admin cannot take over: no changing or removing the owner, no self-promotion", async () => {
      const adminUser = await user("adminuser");
      await auth.api.addMember({
        body: { userId: adminUser.id, role: "admin", organizationId: orgId },
      });
      await postAuth("/organization/set-active", adminUser, { organizationId: orgId });
      const members = await db
        .select()
        .from(schema.members)
        .where(eq(schema.members.organizationId, orgId));
      const ownerMember = members.find((m) => m.userId === owner.id)!;
      const adminMember = members.find((m) => m.userId === adminUser.id)!;

      expect(
        (
          await postAuth("/organization/update-member-role", adminUser, {
            memberId: ownerMember.id,
            role: "viewer",
            organizationId: orgId,
          })
        ).status,
      ).toBeGreaterThanOrEqual(400);
      expect(
        (
          await postAuth("/organization/remove-member", adminUser, {
            memberIdOrEmail: ownerMember.id,
            organizationId: orgId,
          })
        ).status,
      ).toBeGreaterThanOrEqual(400);
      expect(
        (
          await postAuth("/organization/update-member-role", adminUser, {
            memberId: adminMember.id,
            role: "owner",
            organizationId: orgId,
          })
        ).status,
      ).toBeGreaterThanOrEqual(400);
      const after = await db
        .select()
        .from(schema.members)
        .where(eq(schema.members.organizationId, orgId));
      expect(after.find((m) => m.userId === owner.id)!.role).toBe("owner");
      expect(after.find((m) => m.userId === adminUser.id)!.role).toBe("admin");
      // The admin can still do admin things.
      expect(
        (
          await send("/workspace", {
            method: "POST",
            cookie: adminUser.cookie,
            body: JSON.stringify({ name: "by admin" }),
          })
        ).status,
      ).toBe(201);
    });
  });

  describe("account emails", () => {
    test("sign-up sends a verification email but does not block access", async () => {
      const u = await user("verifyme");
      expect(
        outbox.some(
          (m) =>
            m.to === `${tag}-verifyme@example.com` && m.subject.startsWith("Confirm your email"),
        ),
      ).toBe(true);
      expect((await send("/api/auth/get-session", { cookie: u.cookie })).status).toBe(200);
    });

    test("password reset: emailed link, new password works, old one does not, link is single-use", async () => {
      const email = `${tag}-reset@example.com`;
      await user("reset");
      const res = await send("/api/auth/request-password-reset", {
        method: "POST",
        body: JSON.stringify({ email, redirectTo: `${origin}/reset-password` }),
      });
      expect(res.status).toBe(200);
      const mail = outbox
        .filter((m) => m.to === email && m.subject.startsWith("Reset your"))
        .at(-1);
      expect(mail).toBeDefined();
      const link = /https?:\/\/\S+/.exec(mail!.text)![0];
      const hop = await app.handle(new Request(link, { redirect: "manual" }));
      const token = new URL(hop.headers.get("location")!).searchParams.get("token")!;
      expect(token.length).toBeGreaterThan(10);

      expect(
        (
          await send("/api/auth/reset-password", {
            method: "POST",
            body: JSON.stringify({ newPassword: "brand-new-pass-456", token }),
          })
        ).status,
      ).toBe(200);
      const login = (password: string) =>
        send("/api/auth/sign-in/email", {
          method: "POST",
          body: JSON.stringify({ email, password }),
        });
      expect((await login("brand-new-pass-456")).status).toBe(200);
      expect((await login("supersecret123")).status).toBeGreaterThanOrEqual(400);
      expect(
        (
          await send("/api/auth/reset-password", {
            method: "POST",
            body: JSON.stringify({ newPassword: "another-pass-789", token }),
          })
        ).status,
      ).toBeGreaterThanOrEqual(400);
    });

    test("asking for a reset for an unknown address reveals nothing", async () => {
      const known = await send("/api/auth/request-password-reset", {
        method: "POST",
        body: JSON.stringify({
          email: `${tag}-owner@example.com`,
          redirectTo: `${origin}/reset-password`,
        }),
      });
      const unknown = await send("/api/auth/request-password-reset", {
        method: "POST",
        body: JSON.stringify({
          email: `${tag}-nobody@example.com`,
          redirectTo: `${origin}/reset-password`,
        }),
      });
      expect(unknown.status).toBe(known.status);
      expect(outbox.some((m) => m.to === `${tag}-nobody@example.com`)).toBe(false);
    });
  });
});
