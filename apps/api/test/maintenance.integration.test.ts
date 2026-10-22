import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { createAuth } from "@upzy/auth/server";
import { createDb, schema } from "@upzy/db";
import { eq, like } from "drizzle-orm";

import { createApp } from "../src/app";
import { statusCache } from "../src/lib/status-cache";

// Real Postgres + real better-auth. Needs: DATABASE_URL=... bun test
const url = process.env.DATABASE_URL;
const run = url ? describe : describe.skip;

run("maintenance windows and the degraded state (postgres)", () => {
  process.env.BETTER_AUTH_SECRET ??= "integration-test-secret-integration-test-secret";
  const db = createDb(url);
  const auth = createAuth(db, {
    sendEmail: async () => {},
    signup: { mode: "open", allowedEmails: [], allowedDomains: [] },
  });
  const tag = `mt${Date.now()}`;
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
  const person = async (name: string) => {
    const r = await send("/api/auth/sign-up/email", {
      method: "POST",
      body: JSON.stringify({
        email: `${tag}-${name}@example.com`,
        password: "supersecret123",
        name,
      }),
    });
    return { cookie: cookieOf(r), id: (await json(r)).user.id as string };
  };
  const makeOrg = async (who: { cookie: string }, slug: string) => {
    const org = await json(
      await send("/api/auth/organization/create", {
        method: "POST",
        cookie: who.cookie,
        body: JSON.stringify({ name: slug, slug: `${tag}-${slug}` }),
      }),
    );
    await send("/api/auth/organization/set-active", {
      method: "POST",
      cookie: who.cookie,
      body: JSON.stringify({ organizationId: org.id }),
    });
    const mkWs = async (name: string) =>
      (
        await db
          .insert(schema.workspaces)
          .values({ orgId: org.id, name })
          .returning({ id: schema.workspaces.id })
      )[0]!.id;
    return {
      orgId: org.id as string,
      ws: await mkWs(`${slug} ws`),
      ws2: await mkWs(`${slug} ws2`),
    };
  };
  const call = (who: { cookie: string } | null, method: string, path: string, body?: unknown) =>
    send(path, {
      method,
      ...(who ? { cookie: who.cookie } : {}),
      ...(body ? { body: JSON.stringify(body) } : {}),
    });

  const hours = (h: number) => new Date(Date.now() + h * 3_600_000).toISOString();
  let owner: Awaited<ReturnType<typeof person>>, member: typeof owner, other: typeof owner;
  let A = { orgId: "", ws: "", ws2: "" },
    B = { orgId: "", ws: "", ws2: "" };
  const ids: Record<string, string> = {};
  const body = (over: Record<string, unknown> = {}) => ({
    workspaceId: A.ws,
    name: "Database upgrade",
    startsAt: hours(1),
    endsAt: hours(3),
    monitorIds: [ids.api],
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
    await send("/api/auth/organization/set-active", {
      method: "POST",
      cookie: member.cookie,
      body: JSON.stringify({ organizationId: A.orgId }),
    });
    const mon = async (ws: string, name: string, over: object = {}) =>
      (
        await db
          .insert(schema.monitors)
          .values({
            workspaceId: ws,
            name,
            type: "http",
            target: `https://${name}.example.com`,
            interval: 60,
            active: true,
            createdAt: new Date(Date.now() - 100 * 86_400_000),
            ...over,
          })
          .returning({ id: schema.monitors.id })
      )[0]!.id;
    ids.api = await mon(A.ws, "internal-api-name");
    ids.web = await mon(A.ws, "web");
    ids.elsewhere = await mon(A.ws2, "elsewhere");
    ids.foreign = await mon(B.ws, "foreign");
  });
  afterAll(async () => {
    await db.delete(schema.organizations).where(like(schema.organizations.slug, `${tag}-%`));
    await db.delete(schema.users).where(like(schema.users.email, `${tag}-%`));
  });

  describe("managing windows", () => {
    test("anyone in the organization can look, but only an admin schedules, because a window silences alerts", async () => {
      expect((await call(member, "POST", "/maintenance", body())).status).toBe(403);
      const created = await call(owner, "POST", "/maintenance", body());
      expect(created.status).toBe(201);
      const w = await json(created);
      ids.upcoming = w.id;
      expect(w).toMatchObject({
        name: "Database upgrade",
        phase: "upcoming",
        allMonitors: false,
        monitorIds: [ids.api],
        showOnStatusPage: true,
      });
      expect((await call(member, "PATCH", `/maintenance/${w.id}`, { name: "x" })).status).toBe(403);
      expect((await call(member, "DELETE", `/maintenance/${w.id}`)).status).toBe(403);
      expect((await call(member, "POST", `/maintenance/${w.id}/end`)).status).toBe(403);
      const seen = await json(await call(member, "GET", `/maintenance?workspaceId=${A.ws}`));
      expect(seen.map((x: { id: string }) => x.id)).toContain(w.id);
    });

    test("another organization sees and touches nothing", async () => {
      expect(await json(await call(other, "GET", "/maintenance"))).toEqual([]);
      expect(
        (await call(other, "PATCH", `/maintenance/${ids.upcoming}`, { name: "hijack" })).status,
      ).toBe(404);
      expect((await call(other, "DELETE", `/maintenance/${ids.upcoming}`)).status).toBe(404);
      expect((await call(other, "POST", `/maintenance/${ids.upcoming}/end`)).status).toBe(404);
      expect((await call(other, "POST", "/maintenance", body())).status).toBe(404); // workspace isn't theirs
    });

    test("a window must make sense", async () => {
      const bad = async (over: Record<string, unknown>) =>
        (await call(owner, "POST", "/maintenance", body(over))).status;
      expect(await bad({ endsAt: hours(1) })).toBe(422); // ends when it starts
      expect(await bad({ startsAt: hours(-5), endsAt: hours(-1) })).toBe(422); // already over
      expect(await bad({ endsAt: hours(24 * 20) })).toBe(422); // longer than 14 days
      expect(await bad({ monitorIds: [] })).toBe(422); // covers nothing
      expect(await bad({ monitorIds: [ids.foreign] })).toBe(422); // someone else's monitor
      expect(await bad({ monitorIds: [ids.elsewhere] })).toBe(422); // another workspace of this organization
      expect(await bad({ name: "   " })).toBeGreaterThanOrEqual(400);
      expect(await bad({ startsAt: "tomorrow" })).toBeGreaterThanOrEqual(400);
    });

    test("all monitors needs no list, and a list is ignored when everything is covered", async () => {
      const r = await call(
        owner,
        "POST",
        "/maintenance",
        body({ allMonitors: true, monitorIds: [ids.api] }),
      );
      expect(r.status).toBe(201);
      const w = await json(r);
      expect(w).toMatchObject({ allMonitors: true, monitorIds: [] });
      ids.all = w.id;
    });

    test("the list shows what is on now first, then what is coming, then what just ended; old ones drop off", async () => {
      const mk = (name: string, startH: number, endH: number) =>
        db
          .insert(schema.maintenanceWindows)
          .values({
            workspaceId: A.ws,
            name,
            startsAt: new Date(Date.now() + startH * 3_600_000),
            endsAt: new Date(Date.now() + endH * 3_600_000),
            allMonitors: true,
          })
          .returning({ id: schema.maintenanceWindows.id });
      await mk("on now", -1, 2);
      await mk("ended yesterday", -30, -24);
      await mk("ended last year", -24 * 400, -24 * 399);
      const list = (await json(await call(owner, "GET", `/maintenance?workspaceId=${A.ws}`))) as {
        name: string;
        phase: string;
      }[];
      const names = list.map((x) => x.name);
      expect(names).not.toContain("ended last year");
      expect(list.map((x) => x.phase)).toEqual(
        [...list.map((x) => x.phase)].sort(
          (a, b) =>
            ({ active: 0, upcoming: 1, past: 2 })[a]! - { active: 0, upcoming: 1, past: 2 }[b]!,
        ),
      );
      expect(names[0]).toBe("on now");
      expect(names.at(-1)).toBe("ended yesterday");
    });

    test("a window can be edited until it is over", async () => {
      const r = await call(owner, "PATCH", `/maintenance/${ids.upcoming}`, {
        name: "Renamed",
        monitorIds: [ids.api, ids.web],
        showOnStatusPage: false,
      });
      expect(r.status).toBe(200);
      const w = await json(r);
      expect(w).toMatchObject({ name: "Renamed", showOnStatusPage: false });
      expect([...w.monitorIds].sort()).toEqual([ids.api, ids.web].sort());
      // The merged result is validated, not just the fields sent.
      expect(
        (await call(owner, "PATCH", `/maintenance/${ids.upcoming}`, { endsAt: hours(0) })).status,
      ).toBe(422);
      expect(
        (await call(owner, "PATCH", `/maintenance/${ids.upcoming}`, { monitorIds: [ids.foreign] }))
          .status,
      ).toBe(422);
      expect(
        (await call(owner, "PATCH", `/maintenance/${ids.upcoming}`, { allMonitors: true })).status,
      ).toBe(200);
      const [past] = await db
        .insert(schema.maintenanceWindows)
        .values({
          workspaceId: A.ws,
          name: "over",
          startsAt: new Date(Date.now() - 7_200_000),
          endsAt: new Date(Date.now() - 3_600_000),
          allMonitors: true,
        })
        .returning({ id: schema.maintenanceWindows.id });
      expect(
        (await call(owner, "PATCH", `/maintenance/${past!.id}`, { name: "late edit" })).status,
      ).toBe(409);
    });

    test("ending a window in progress keeps it in the history; only one in progress can be ended", async () => {
      const [live] = await db
        .insert(schema.maintenanceWindows)
        .values({
          workspaceId: A.ws,
          name: "live",
          startsAt: new Date(Date.now() - 600_000),
          endsAt: new Date(Date.now() + 3_600_000),
          allMonitors: true,
        })
        .returning({ id: schema.maintenanceWindows.id });
      const r = await call(owner, "POST", `/maintenance/${live!.id}/end`);
      expect(r.status).toBe(200);
      expect((await json(r)).phase).toBe("past");
      expect((await call(owner, "POST", `/maintenance/${live!.id}/end`)).status).toBe(409);
      expect((await call(owner, "POST", `/maintenance/${ids.upcoming}/end`)).status).toBe(409);
    });

    test("a window can be deleted, and it takes its monitor list with it", async () => {
      const w = await json(await call(owner, "POST", "/maintenance", body({ name: "to delete" })));
      expect((await call(owner, "DELETE", `/maintenance/${w.id}`)).status).toBe(204);
      expect(
        await db
          .select()
          .from(schema.maintenanceWindowMonitors)
          .where(eq(schema.maintenanceWindowMonitors.windowId, w.id)),
      ).toHaveLength(0);
      expect((await call(owner, "DELETE", `/maintenance/${w.id}`)).status).toBe(404);
    });
  });

  describe("what monitors and the public page report", () => {
    const slug = `${tag}-pg`.toLowerCase();
    const publicStatus = async () => {
      statusCache.clear();
      return json(await send(`/public/status/${slug}`));
    };
    const setStatus = (id: string | undefined, lastStatus: "up" | "down" | "degraded") =>
      db.update(schema.monitors).set({ lastStatus }).where(eq(schema.monitors.id, id!));
    const clearWindows = () =>
      db.delete(schema.maintenanceWindows).where(eq(schema.maintenanceWindows.workspaceId, A.ws));

    beforeAll(async () => {
      await clearWindows();
      const r = await call(owner, "POST", "/status-page", {
        workspaceId: A.ws,
        title: "Acme",
        slug,
        published: true,
        components: [
          { monitorId: ids.api, displayName: "API" },
          { monitorId: ids.web, displayName: "Website" },
        ],
      });
      expect(r.status).toBe(201);
    });

    test("a degraded monitor is reported as degraded, on the dashboard and publicly", async () => {
      await clearWindows();
      await setStatus(ids.api, "degraded");
      await setStatus(ids.web, "up");
      const monitors = await json(await call(owner, "GET", `/monitor?workspaceId=${A.ws}`));
      expect(monitors.find((m: { id: string }) => m.id === ids.api).lastStatus).toBe("degraded");
      const status = await publicStatus();
      expect(status.overall).toBe("degraded");
      expect(status.components.find((c: { name: string }) => c.name === "API").status).toBe(
        "degraded",
      );
      const badge = await (await send(`/public/status/${slug}/badge.svg`)).text();
      expect(badge).toContain("degraded");
    });

    test("a covered monitor shows as under maintenance, with the window listed by name only", async () => {
      await clearWindows();
      await setStatus(ids.api, "down"); // suppressed during the window, so it has no incident
      await setStatus(ids.web, "up");
      await call(
        owner,
        "POST",
        "/maintenance",
        body({
          name: "Database upgrade",
          startsAt: hours(-1),
          endsAt: hours(2),
          monitorIds: [ids.api],
        }),
      );
      const monitors = await json(await call(member, "GET", `/monitor?workspaceId=${A.ws}`));
      const api = monitors.find((m: { id: string }) => m.id === ids.api);
      expect(api.maintenance).toMatchObject({ name: "Database upgrade" });
      expect(monitors.find((m: { id: string }) => m.id === ids.web).maintenance).toBeNull();
      expect((await json(await call(member, "GET", `/monitor/${ids.api}`))).maintenance.name).toBe(
        "Database upgrade",
      );

      const status = await publicStatus();
      expect(status.components.find((c: { name: string }) => c.name === "API").status).toBe(
        "maintenance",
      );
      expect(status.overall).toBe("maintenance");
      expect(status.maintenance).toHaveLength(1);
      expect(status.maintenance[0]).toMatchObject({ name: "Database upgrade", active: true });
      // Nothing internal leaks: not the monitor's real name, its address, or which monitors are covered.
      const text = JSON.stringify(status);
      expect(text).not.toContain("internal-api-name");
      expect(text).not.toContain("example.com");
      expect(text).not.toContain(ids.api);
      expect(await (await send(`/public/status/${slug}/badge.svg`)).text()).toContain(
        "maintenance",
      );
    });

    test("an upcoming window is announced without changing any status yet", async () => {
      await clearWindows();
      await setStatus(ids.api, "up");
      await call(
        owner,
        "POST",
        "/maintenance",
        body({ name: "Next week", startsAt: hours(48), endsAt: hours(50) }),
      );
      const status = await publicStatus();
      expect(status.overall).toBe("operational");
      expect(status.maintenance).toEqual([
        expect.objectContaining({ name: "Next week", active: false }),
      ]);
    });

    test("a window that does not cover this page's monitors is not on it", async () => {
      await clearWindows();
      await call(
        owner,
        "POST",
        "/maintenance",
        body({
          name: "Elsewhere",
          monitorIds: [ids.elsewhere],
          workspaceId: A.ws2,
          startsAt: hours(-1),
          endsAt: hours(1),
        }),
      );
      const status = await publicStatus();
      expect(status.maintenance).toEqual([]);
      expect(status.overall).not.toBe("maintenance");
    });

    test("a window kept internal changes nothing on the page, so a real outage still shows", async () => {
      await clearWindows();
      await setStatus(ids.api, "down");
      await call(
        owner,
        "POST",
        "/maintenance",
        body({
          name: "Internal only",
          startsAt: hours(-1),
          endsAt: hours(2),
          showOnStatusPage: false,
        }),
      );
      const status = await publicStatus();
      expect(status.maintenance).toEqual([]);
      expect(status.components.find((c: { name: string }) => c.name === "API").status).toBe(
        "outage",
      );
    });

    test("when a window ends the page goes back to reporting what is true", async () => {
      await clearWindows();
      await setStatus(ids.api, "down");
      const w = await json(
        await call(
          owner,
          "POST",
          "/maintenance",
          body({ startsAt: hours(-1), endsAt: hours(2), name: "Short" }),
        ),
      );
      expect((await publicStatus()).components[0].status).toBe("maintenance");
      await call(owner, "POST", `/maintenance/${w.id}/end`);
      const after = await publicStatus();
      expect(after.components.find((c: { name: string }) => c.name === "API").status).toBe(
        "outage",
      );
      expect(after.maintenance).toEqual([]);
    });
  });
});
