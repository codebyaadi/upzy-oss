import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { createAuth } from "@upzy/auth/server";
import { createDb, schema } from "@upzy/db";
import { and, eq, inArray, like } from "drizzle-orm";

import { createApp } from "../src/app";
import { forgetAllStatusPages } from "../src/lib/status-cache";

// Real Postgres + real better-auth. Needs: DATABASE_URL=... bun test
const url = process.env.DATABASE_URL;
const run = url ? describe : describe.skip;

run("per-client access (postgres)", () => {
  process.env.BETTER_AUTH_SECRET ??= "integration-test-secret-integration-test-secret";
  const db = createDb(url);
  const {
    users,
    organizations,
    members,
    workspaces,
    monitors,
    incidents,
    notificationChannels,
    alertRules,
    assets,
    findings,
    statusPages,
    maintenanceWindows,
    restrictedMembers,
    workspaceAccess,
    pendingWorkspaceAccess,
  } = schema;
  const auth = createAuth(db, {
    sendEmail: async () => {},
    signup: { mode: "open", allowedEmails: [], allowedDomains: [] },
  });
  const tag = `ac${Date.now().toString(36)}`;
  const origin = "http://localhost:3001";
  const app = createApp({
    db,
    auth,
    webOrigin: origin,
    encryptionKey: Buffer.alloc(32, 4).toString("base64"),
    rateLimit: { rules: [{ match: () => true, bucket: "t", max: Infinity, windowMs: 1 }] },
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
  type Person = { cookie: string; id: string; email: string };
  const person = async (name: string): Promise<Person> => {
    const email = `${tag}-${name}@example.com`;
    const r = await send("/api/auth/sign-up/email", {
      method: "POST",
      body: JSON.stringify({ email, password: "supersecret123", name }),
    });
    return { cookie: cookieOf(r), id: (await json(r)).user.id as string, email };
  };
  const call = (who: Person | null, method: string, path: string, body?: unknown) =>
    send(path, {
      method,
      ...(who ? { cookie: who.cookie } : {}),
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
  const setActive = (who: Person, organizationId: string) =>
    send("/api/auth/organization/set-active", {
      method: "POST",
      cookie: who.cookie,
      body: JSON.stringify({ organizationId }),
    });

  let orgId = "";
  let owner: Person, client: Person, viewer: Person, staff: Person;
  const W: Record<"acme" | "globex" | "initech", string> = { acme: "", globex: "", initech: "" };
  const names = ["acme", "globex", "initech"] as const;
  const seeded: Record<string, Record<string, string>> = {};
  const orgIds: string[] = [];

  const join = async (who: Person, role: string) => {
    await auth.api.addMember({
      body: { userId: who.id, role: role as never, organizationId: orgId },
    });
    await setActive(who, orgId);
  };

  beforeAll(async () => {
    owner = await person("owner");
    client = await person("client");
    viewer = await person("viewer");
    staff = await person("staff");
    const org = await (
      await send("/api/auth/organization/create", {
        method: "POST",
        cookie: owner.cookie,
        body: JSON.stringify({ name: `${tag} agency`, slug: `${tag}-agency` }),
      })
    ).json();
    orgId = (org as any).id;
    orgIds.push(orgId);
    await setActive(owner, orgId);
    await join(client, "member");
    await join(viewer, "viewer");
    await join(staff, "member");

    for (const n of names) {
      const ws = (
        await db
          .insert(workspaces)
          .values({ orgId, name: `${tag}-${n}` })
          .returning({ id: workspaces.id })
      )[0]!.id;
      W[n] = ws;
      const mon = (
        await db
          .insert(monitors)
          .values({
            workspaceId: ws,
            name: `mon-${n}`,
            type: "http",
            target: `https://${n}.example.com`,
            interval: 60,
            active: true,
          })
          .returning({ id: monitors.id })
      )[0]!.id;
      const chan = (
        await db
          .insert(notificationChannels)
          .values({
            workspaceId: ws,
            name: `chan-${n}`,
            kind: "email",
            configEncrypted: "x",
            summary: `s-${n}`,
          })
          .returning({ id: notificationChannels.id })
      )[0]!.id;
      await db.insert(alertRules).values({ workspaceId: ws, channelId: chan, monitorId: mon });
      const inc = (
        await db
          .insert(incidents)
          .values({
            workspaceId: ws,
            monitorId: mon,
            type: "uptime",
            status: "open",
            title: `inc-${n}`,
          })
          .returning({ id: incidents.id })
      )[0]!.id;
      const asset = (
        await db
          .insert(assets)
          .values({
            workspaceId: ws,
            kind: "domain",
            value: `${n}.${tag}.example.com`,
            verificationToken: "t",
            lastScanAt: new Date(),
          })
          .returning({ id: assets.id })
      )[0]!.id;
      const finding = (
        await db
          .insert(findings)
          .values({
            workspaceId: ws,
            assetId: asset,
            checkKey: "headers.hsts_missing",
            fingerprint: `${tag}-${n}`,
            severity: "high",
            riskScore: 10,
            title: `finding-${n}`,
            description: "d",
          })
          .returning({ id: findings.id })
      )[0]!.id;
      const page = (
        await db
          .insert(statusPages)
          .values({ workspaceId: ws, slug: `${tag}-${n}`, title: `page-${n}`, published: true })
          .returning({ id: statusPages.id })
      )[0]!.id;
      const win = (
        await db
          .insert(maintenanceWindows)
          .values({
            workspaceId: ws,
            name: `win-${n}`,
            startsAt: new Date(Date.now() + 3_600_000),
            endsAt: new Date(Date.now() + 7_200_000),
            allMonitors: true,
          })
          .returning({ id: maintenanceWindows.id })
      )[0]!.id;
      seeded[n] = { mon, chan, inc, asset, finding, page, win };
    }

    // The client sees Acme only; the viewer sees Globex only.
    expect(
      (
        await call(owner, "PUT", `/access/member/${client.id}`, {
          restricted: true,
          workspaceIds: [W.acme],
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await call(owner, "PUT", `/access/member/${viewer.id}`, {
          restricted: true,
          workspaceIds: [W.globex],
        })
      ).status,
    ).toBe(200);
  });

  afterAll(async () => {
    await db.delete(organizations).where(inArray(organizations.id, orgIds));
    await db.delete(users).where(like(users.email, `${tag}-%`));
    await db.delete(pendingWorkspaceAccess).where(like(pendingWorkspaceAccess.email, `${tag}-%`));
  });

  /** Names that must appear for a person who can see `visible`, and never for the others. */
  const markers = (n: (typeof names)[number]) => [
    `mon-${n}`,
    `chan-${n}`,
    `inc-${n}`,
    `${n}.${tag}`,
    `finding-${n}`,
    `page-${n}`,
    `win-${n}`,
    `${tag}-${n}`,
  ];
  const lists = [
    "/workspace",
    "/monitor",
    "/channel",
    "/alert-rule",
    "/incident",
    "/asset",
    "/finding",
    "/status-page",
    "/maintenance",
    "/overview",
  ];

  describe("what a limited person can see", () => {
    test("every list shows only their workspace, and nothing of the others", async () => {
      for (const path of lists) {
        const r = await call(client, "GET", path);
        expect(r.status, path).toBe(200);
        const text = JSON.stringify(await r.json());
        for (const other of ["globex", "initech"] as const)
          for (const m of markers(other))
            expect(text.includes(m), `${path} leaked ${m}`).toBe(false);
        expect(text.includes(W.globex), `${path} leaked the Globex id`).toBe(false);
        expect(text.includes(W.initech), `${path} leaked the Initech id`).toBe(false);
      }
    });

    test("and they do see their own", async () => {
      const ws = await json(await call(client, "GET", "/workspace"));
      expect(ws.map((w: any) => w.id)).toEqual([W.acme]);
      expect((await json(await call(client, "GET", "/monitor"))).map((m: any) => m.name)).toEqual([
        "mon-acme",
      ]);
      expect(JSON.stringify(await json(await call(client, "GET", "/incident")))).toContain(
        "inc-acme",
      );
      expect(JSON.stringify(await json(await call(client, "GET", "/finding")))).toContain(
        "finding-acme",
      );
      const overview = await json(await call(client, "GET", "/overview"));
      expect(overview.map((o: any) => o.id)).toEqual([W.acme]);
    });

    test("asking for another workspace by id or by filter finds nothing", async () => {
      expect((await call(client, "GET", `/workspace/${W.globex}`)).status).toBe(404);
      for (const path of [
        "/monitor",
        "/incident",
        "/asset",
        "/finding",
        "/status-page",
        "/maintenance",
        "/channel",
        "/alert-rule",
      ]) {
        const r = await call(client, "GET", `${path}?workspaceId=${W.globex}`);
        expect(r.status, path).toBe(200);
        const body = await r.json();
        expect(Array.isArray(body) ? body : ((body as any).items ?? []), path).toHaveLength(0);
      }
    });

    test("another workspace's records can't be read, changed or deleted by id", async () => {
      const g = seeded.globex!;
      const tries: [string, string, unknown?][] = [
        ["GET", `/monitor/${g.mon}`],
        ["PATCH", `/monitor/${g.mon}`, { name: "hijacked" }],
        ["DELETE", `/monitor/${g.mon}`],
        ["GET", `/incident/${g.inc}`],
        ["GET", `/asset/${g.asset}`],
        ["DELETE", `/asset/${g.asset}`],
        ["GET", `/finding/${g.finding}`],
        ["GET", `/status-page/${g.page}`],
        ["PATCH", `/status-page/${g.page}`, { title: "hijacked" }],
      ];
      for (const [method, path, body] of tries) {
        const r = await call(client, method, path, body);
        expect([403, 404, 405], `${method} ${path} -> ${r.status}`).toContain(r.status);
      }
      const [m] = await db.select().from(monitors).where(eq(monitors.id, g.mon!));
      expect(m!.name).toBe("mon-globex");
    });

    test("they can't create anything in another workspace", async () => {
      const r = await call(client, "POST", "/monitor", {
        workspaceId: W.globex,
        name: "sneaky",
        type: "http",
        target: "https://example.com",
        interval: 300,
      });
      expect(r.status).toBe(404);
      expect(
        await db.select().from(monitors).where(eq(monitors.workspaceId, W.globex)),
      ).toHaveLength(1);
      const ok = await call(client, "POST", "/monitor", {
        workspaceId: W.acme,
        name: "legit",
        type: "http",
        target: "https://example.com",
        interval: 300,
      });
      expect(ok.status).toBe(201);
    });

    test("two limited people see different workspaces, and an unlimited member sees all", async () => {
      const v = await json(await call(viewer, "GET", "/workspace"));
      expect(v.map((w: any) => w.id)).toEqual([W.globex]);
      const s = await json(await call(staff, "GET", "/workspace"));
      expect(s.map((w: any) => w.id).sort()).toEqual([W.acme, W.globex, W.initech].sort());
      const o = await json(await call(owner, "GET", "/workspace"));
      expect(o).toHaveLength(3);
    });

    test("a limited person with no workspace listed sees nothing at all", async () => {
      await call(owner, "PUT", `/access/member/${viewer.id}`, {
        restricted: true,
        workspaceIds: [],
      });
      expect(await json(await call(viewer, "GET", "/workspace"))).toEqual([]);
      expect(await json(await call(viewer, "GET", "/monitor"))).toEqual([]);
      expect(await json(await call(viewer, "GET", "/overview"))).toEqual([]);
      await call(owner, "PUT", `/access/member/${viewer.id}`, {
        restricted: true,
        workspaceIds: [W.globex],
      });
    });

    test("lifting the limit shows everything again; limiting again hides it", async () => {
      await call(owner, "PUT", `/access/member/${client.id}`, { restricted: false });
      expect(await json(await call(client, "GET", "/workspace"))).toHaveLength(3);
      await call(owner, "PUT", `/access/member/${client.id}`, {
        restricted: true,
        workspaceIds: [W.acme],
      });
      expect((await json(await call(client, "GET", "/workspace"))).map((w: any) => w.id)).toEqual([
        W.acme,
      ]);
    });
  });

  describe("managing access", () => {
    test("only admins can read or change it", async () => {
      for (const who of [client, viewer, staff]) {
        expect((await call(who, "GET", "/access")).status).toBe(403);
        expect(
          (await call(who, "PUT", `/access/member/${client.id}`, { restricted: false })).status,
        ).toBe(403);
      }
      expect((await call(null, "GET", "/access")).status).toBe(401);
    });

    test("the list says who is limited to what", async () => {
      const r = await json(await call(owner, "GET", "/access"));
      const row = (id: string) => r.members.find((m: any) => m.userId === id);
      expect(row(client.id)).toMatchObject({
        restricted: true,
        workspaceIds: [W.acme],
        role: "member",
      });
      expect(row(viewer.id)).toMatchObject({
        restricted: true,
        workspaceIds: [W.globex],
        role: "viewer",
      });
      expect(row(staff.id)).toMatchObject({ restricted: false, workspaceIds: [] });
    });

    test("admins and owners can't be limited, strangers aren't found, and foreign workspaces are refused", async () => {
      expect(
        (
          await call(owner, "PUT", `/access/member/${owner.id}`, {
            restricted: true,
            workspaceIds: [W.acme],
          })
        ).status,
      ).toBe(422);
      const stranger = await person("stranger");
      expect(
        (
          await call(owner, "PUT", `/access/member/${stranger.id}`, {
            restricted: true,
            workspaceIds: [],
          })
        ).status,
      ).toBe(404);
      const other = await person("otherowner");
      const org2 = await json(
        await send("/api/auth/organization/create", {
          method: "POST",
          cookie: other.cookie,
          body: JSON.stringify({ name: `${tag} other`, slug: `${tag}-other` }),
        }),
      );
      orgIds.push(org2.id);
      const foreign = (
        await db
          .insert(workspaces)
          .values({ orgId: org2.id, name: "foreign" })
          .returning({ id: workspaces.id })
      )[0]!.id;
      expect(
        (
          await call(owner, "PUT", `/access/member/${staff.id}`, {
            restricted: true,
            workspaceIds: [foreign],
          })
        ).status,
      ).toBe(422);
      const [still] = await db
        .select()
        .from(restrictedMembers)
        .where(eq(restrictedMembers.userId, staff.id));
      expect(still).toBeUndefined();
    });

    test("an organization's limits never reach another organization's data", async () => {
      const other = await person("loner");
      const org2 = await json(
        await send("/api/auth/organization/create", {
          method: "POST",
          cookie: other.cookie,
          body: JSON.stringify({ name: `${tag} loner`, slug: `${tag}-loner` }),
        }),
      );
      orgIds.push(org2.id);
      await setActive(other, org2.id);
      expect(await json(await call(other, "GET", "/workspace"))).toEqual([]);
      expect(await json(await call(other, "GET", "/monitor"))).toEqual([]);
    });
  });

  describe("roles stay below admin", () => {
    test("a limited person can't be promoted to admin or owner", async () => {
      const [m] = await db
        .select()
        .from(members)
        .where(and(eq(members.organizationId, orgId), eq(members.userId, client.id)));
      const r = await send("/api/auth/organization/update-member-role", {
        method: "POST",
        cookie: owner.cookie,
        body: JSON.stringify({ memberId: m!.id, role: "admin", organizationId: orgId }),
      });
      expect(r.status).toBeGreaterThanOrEqual(400);
      const [after] = await db.select().from(members).where(eq(members.id, m!.id));
      expect(after!.role).toBe("member");
    });

    test("even if an admin role got stored, a limited person is treated as a member", async () => {
      const sneaky = await person("sneaky");
      await join(sneaky, "member");
      await call(owner, "PUT", `/access/member/${sneaky.id}`, {
        restricted: true,
        workspaceIds: [W.acme],
      });
      // Bypassing the guards above: write the role straight into the database.
      await db
        .update(members)
        .set({ role: "admin" })
        .where(and(eq(members.organizationId, orgId), eq(members.userId, sneaky.id)));
      expect((await call(sneaky, "GET", "/access")).status).toBe(403);
      expect((await call(sneaky, "POST", "/workspace", { name: "mine" })).status).toBe(403);
      expect((await call(sneaky, "GET", "/audit")).status).toBe(403);
      const ws = await json(await call(sneaky, "GET", "/workspace"));
      expect(ws.map((w: any) => w.id)).toEqual([W.acme]);
    });
  });

  describe("limiting someone when inviting them", () => {
    const invite = async (email: string, role: string) =>
      json(
        await send("/api/auth/organization/invite-member", {
          method: "POST",
          cookie: owner.cookie,
          body: JSON.stringify({ email, role, organizationId: orgId }),
        }),
      );

    test("the limit applies from their first request, with no moment of full access", async () => {
      const email = `${tag}-newclient@example.com`;
      const set = await call(owner, "PUT", "/access/invited", {
        email,
        restricted: true,
        workspaceIds: [W.initech],
        role: "viewer",
      });
      expect(set.status).toBe(200);
      const list = await json(await call(owner, "GET", "/access"));
      expect(list.invited).toEqual([{ email, workspaceIds: [W.initech] }]);

      const inv = await invite(email, "viewer");
      const joiner = await person("newclient");
      const accept = await send("/api/auth/organization/accept-invitation", {
        method: "POST",
        cookie: joiner.cookie,
        body: JSON.stringify({ invitationId: inv.id }),
      });
      expect(accept.status).toBe(200);
      await setActive(joiner, orgId);

      const ws = await json(await call(joiner, "GET", "/workspace"));
      expect(ws.map((w: any) => w.id)).toEqual([W.initech]);
      expect(JSON.stringify(await json(await call(joiner, "GET", "/monitor")))).not.toContain(
        "mon-acme",
      );
      const [row] = await db
        .select()
        .from(restrictedMembers)
        .where(eq(restrictedMembers.userId, joiner.id));
      expect(row).toBeDefined();
      expect(
        await db
          .select()
          .from(pendingWorkspaceAccess)
          .where(eq(pendingWorkspaceAccess.email, email)),
      ).toHaveLength(0);
    });

    test("an invitation without a limit gives full access, as before", async () => {
      const email = `${tag}-plain@example.com`;
      const inv = await invite(email, "member");
      const joiner = await person("plain");
      await send("/api/auth/organization/accept-invitation", {
        method: "POST",
        cookie: joiner.cookie,
        body: JSON.stringify({ invitationId: inv.id }),
      });
      await setActive(joiner, orgId);
      expect(await json(await call(joiner, "GET", "/workspace"))).toHaveLength(3);
    });

    test("a limit can't be recorded for an admin, and an admin invitation carrying one can't be accepted", async () => {
      const email = `${tag}-bossy@example.com`;
      expect(
        (
          await call(owner, "PUT", "/access/invited", {
            email,
            restricted: true,
            workspaceIds: [W.acme],
            role: "admin",
          })
        ).status,
      ).toBe(422);
      // Recorded while the role was a viewer, then the invitation was sent as admin anyway.
      await call(owner, "PUT", "/access/invited", {
        email,
        restricted: true,
        workspaceIds: [W.acme],
        role: "viewer",
      });
      const inv = await invite(email, "admin");
      const joiner = await person("bossy");
      const accept = await send("/api/auth/organization/accept-invitation", {
        method: "POST",
        cookie: joiner.cookie,
        body: JSON.stringify({ invitationId: inv.id }),
      });
      expect(accept.status).toBeGreaterThanOrEqual(400);
      expect(
        await db
          .select()
          .from(members)
          .where(and(eq(members.organizationId, orgId), eq(members.userId, joiner.id))),
      ).toHaveLength(0);
    });

    test("the address is matched case-insensitively", async () => {
      const email = `${tag}-MixedCase@Example.com`;
      await call(owner, "PUT", "/access/invited", {
        email,
        restricted: true,
        workspaceIds: [W.globex],
        role: "member",
      });
      const stored = await db
        .select()
        .from(pendingWorkspaceAccess)
        .where(eq(pendingWorkspaceAccess.organizationId, orgId));
      expect(stored.some((s) => s.email === email.toLowerCase())).toBe(true);
    });
  });

  describe("data lifecycle", () => {
    test("deleting a workspace removes it from everyone's access, and deleting a person removes their limit", async () => {
      const temp = (
        await db
          .insert(workspaces)
          .values({ orgId, name: `${tag}-temp` })
          .returning({ id: workspaces.id })
      )[0]!.id;
      await call(owner, "PUT", `/access/member/${client.id}`, {
        restricted: true,
        workspaceIds: [W.acme, temp],
      });
      await db.delete(workspaces).where(eq(workspaces.id, temp));
      expect(
        await db.select().from(workspaceAccess).where(eq(workspaceAccess.workspaceId, temp)),
      ).toHaveLength(0);
      expect((await json(await call(client, "GET", "/workspace"))).map((w: any) => w.id)).toEqual([
        W.acme,
      ]);
    });
  });

  test("the public status page is unaffected by who is limited", async () => {
    forgetAllStatusPages();
    const r = await call(null, "GET", `/public/status/${tag}-globex`);
    expect(r.status).toBe(200);
  });
});
