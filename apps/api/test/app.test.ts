import { describe, expect, test } from "bun:test";

import type { Db } from "@upzy/db";

import { createApp } from "../src/app";
import type { AuditEntry, AuditSink } from "../src/plugins/audit";

const session = (activeOrganizationId: string | null) => ({
  user: { id: "u1", email: "a@b.co" },
  session: { id: "s1", activeOrganizationId },
});

const makeApp = (
  current: ReturnType<typeof session> | null,
  role: string | null = "owner",
  auditSink: AuditSink = async () => {},
) =>
  createApp({
    // Validation and auth run before any query in these tests; the one lookup auth makes (is an admin limited?) finds nothing.
    db: { select: () => ({ from: () => ({ where: async () => [] }) }) } as unknown as Db,
    webOrigin: "http://localhost:3001",
    encryptionKey: Buffer.alloc(32, 1).toString("base64"),
    auditSink,
    auth: {
      handler: async () => new Response("auth"),
      api: {
        getSession: async () => current,
        getActiveMemberRole: async () => {
          if (role === null) throw new Error("not a member");
          return { role };
        },
      },
    } as never,
  });

const req = (path: string, init?: RequestInit) =>
  new Request(`http://localhost${path}`, {
    ...init,
    headers: { "content-type": "application/json", ...init?.headers },
  });

const ORG = "00000000-0000-4000-8000-000000000001";
const WS = "00000000-0000-4000-8000-000000000002";

describe("auth", () => {
  test("401 without a session", async () => {
    const res = await makeApp(null).handle(req("/workspace"));
    expect(res.status).toBe(401);
  });

  test("403 without an active organization", async () => {
    const res = await makeApp(session(null)).handle(req("/monitor"));
    expect(res.status).toBe(403);
  });
});

describe("cors", () => {
  test("preflight allows PATCH from the web origin", async () => {
    const res = await makeApp(null).handle(
      req("/workspace/x", {
        method: "OPTIONS",
        headers: { origin: "http://localhost:3001", "access-control-request-method": "PATCH" },
      }),
    );
    expect(res.headers.get("access-control-allow-methods")).toContain("PATCH");
  });
});

describe("validation", () => {
  const app = makeApp(session(ORG));

  test("workspace id must be a uuid", async () => {
    const res = await app.handle(req("/workspace/not-a-uuid"));
    expect(res.status).toBe(400);
  });

  test("workspace name is required", async () => {
    const res = await app.handle(
      req("/workspace", { method: "POST", body: JSON.stringify({ name: " " }) }),
    );
    expect(res.status).toBe(400);
  });

  const create = (target: string) =>
    app.handle(
      req("/monitor", {
        method: "POST",
        body: JSON.stringify({ workspaceId: WS, name: "x", type: "http", target, interval: 60 }),
      }),
    );

  for (const target of [
    "http://localhost/",
    "http://127.0.0.1/",
    "http://127.1/",
    "http://2130706433/",
    "http://169.254.169.254/latest/meta-data",
    "http://[::1]/",
    "http://10.0.0.5/",
    "http://metadata.google.internal/",
  ]) {
    test(`rejects internal target ${target}`, async () => {
      expect((await create(target)).status).toBe(400);
    });
  }
});

describe("channel validation", () => {
  const app = makeApp(session(ORG));
  const post = (body: object) =>
    app.handle(
      req("/channel", {
        method: "POST",
        body: JSON.stringify({ workspaceId: WS, name: "c", ...body }),
      }),
    );

  test("slack URL must be on hooks.slack.com", async () => {
    expect((await post({ kind: "slack", url: "https://evil.example/services/T/B/x" })).status).toBe(
      400,
    );
  });
  test("discord URL must be a webhook path", async () => {
    expect((await post({ kind: "discord", url: "https://discord.com/other" })).status).toBe(400);
  });
  test("webhook URL cannot target internal hosts", async () => {
    expect((await post({ kind: "webhook", url: "http://169.254.169.254/" })).status).toBe(400);
    expect((await post({ kind: "webhook", url: "http://localhost:8080/hook" })).status).toBe(400);
  });
  test("email must be an address", async () => {
    expect((await post({ kind: "email", to: "nope" })).status).toBe(400);
  });
  test("401 without a session", async () => {
    expect((await makeApp(null).handle(req("/channel"))).status).toBe(401);
  });
});

describe("asset validation", () => {
  const app = makeApp(session(ORG));
  const post = (body: object) =>
    app.handle(
      req("/asset", { method: "POST", body: JSON.stringify({ workspaceId: WS, ...body }) }),
    );

  for (const value of [
    "localhost",
    "127.0.0.1",
    "10.0.0.5",
    "intranet",
    "foo.internal",
    "not a host",
    "169.254.169.254",
  ]) {
    test(`rejects domain ${JSON.stringify(value)}`, async () => {
      expect((await post({ kind: "domain", value })).status).toBe(400);
    });
  }
  test("rejects URLs on internal hosts and non-http schemes", async () => {
    expect((await post({ kind: "url", value: "http://169.254.169.254/" })).status).toBe(400);
    expect((await post({ kind: "url", value: "file:///etc/passwd" })).status).toBe(400);
  });
  test("401 without a session", async () => {
    expect((await makeApp(null).handle(req("/finding"))).status).toBe(401);
  });
  test("finding id must be a uuid, and /summary is not treated as an id", async () => {
    expect((await app.handle(req("/finding/not-a-uuid"))).status).toBe(400);
  });
  test("only open/ignored may be set on a finding", async () => {
    expect(
      (
        await app.handle(
          req(`/finding/${WS}`, { method: "PATCH", body: JSON.stringify({ status: "resolved" }) }),
        )
      ).status,
    ).toBe(400);
  });
});

describe("alert rule validation", () => {
  const app = makeApp(session(ORG));
  const post = (body: object) =>
    app.handle(
      req("/alert-rule", {
        method: "POST",
        body: JSON.stringify({ workspaceId: WS, channelId: WS, ...body }),
      }),
    );

  test("finding alerts cannot be limited to a single monitor", async () => {
    expect((await post({ monitorId: WS, events: ["finding.opened"] })).status).toBe(400);
  });
  test("unknown events are rejected", async () => {
    expect((await post({ events: ["finding.resolved"] })).status).toBe(400);
  });
});

describe("discovery validation", () => {
  const app = makeApp(session(ORG));
  const post = (path: string, body: object) =>
    app.handle(req(path, { method: "POST", body: JSON.stringify(body) }));

  test("401 without a session", async () => {
    expect((await makeApp(null).handle(req("/discovery"))).status).toBe(401);
  });
  test("accept needs 1-100 uuids", async () => {
    expect((await post("/discovery/accept", { ids: [] })).status).toBe(400);
    expect((await post("/discovery/accept", { ids: ["nope"] })).status).toBe(400);
    expect(
      (await post("/discovery/accept", { ids: Array.from({ length: 101 }, () => WS) })).status,
    ).toBe(400);
    expect((await post("/discovery/dismiss", {})).status).toBe(400);
  });
  test("list status is constrained", async () => {
    expect((await app.handle(req("/discovery?status=everything"))).status).toBe(400);
  });
});

describe("rate limiting", () => {
  const build = (clock: { t: number }, max: number) =>
    createApp({
      db: {} as Db,
      webOrigin: "http://localhost:3001",
      encryptionKey: Buffer.alloc(32, 1).toString("base64"),
      auth: {
        handler: async () => new Response("auth"),
        api: { getSession: async () => null },
      } as never,
      rateLimit: {
        now: () => clock.t,
        rules: [
          { match: (p) => p === "/health", bucket: "health", max: Infinity, windowMs: 60_000 },
          {
            match: (p) => p.startsWith("/api/auth/sign-in"),
            bucket: "auth-strict",
            max: 2,
            windowMs: 60_000,
          },
          { match: () => true, bucket: "api", max, windowMs: 60_000 },
        ],
      },
    });

  const hit = (app: ReturnType<typeof build>, path: string, ip = "1.1.1.1") =>
    app.handle(req(path, { headers: { "x-forwarded-for": ip } }));

  test("requests over the limit get 429 with Retry-After and CORS headers, then recover after the window", async () => {
    const clock = { t: 1_000_000 };
    const app = createApp({
      db: {} as Db,
      webOrigin: "http://localhost:3001",
      encryptionKey: Buffer.alloc(32, 1).toString("base64"),
      auth: {
        handler: async () => new Response("auth"),
        api: { getSession: async () => null },
      } as never,
      rateLimit: {
        now: () => clock.t,
        trustProxy: true,
        rules: [{ match: () => true, bucket: "api", max: 3, windowMs: 60_000 }],
      },
    });
    for (let i = 0; i < 3; i++) expect((await hit(app as never, "/workspace")).status).toBe(401);
    const blocked = await hit(app as never, "/workspace");
    expect(blocked.status).toBe(429);
    expect(Number(blocked.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(blocked.headers.get("access-control-allow-origin")).toBe("http://localhost:3001");
    expect(blocked.headers.get("ratelimit-remaining")).toBe("0");
    clock.t += 61_000;
    expect((await hit(app as never, "/workspace")).status).toBe(401);
  });

  test("clients are limited independently", async () => {
    const app = createApp({
      db: {} as Db,
      webOrigin: "http://localhost:3001",
      encryptionKey: Buffer.alloc(32, 1).toString("base64"),
      auth: {
        handler: async () => new Response("auth"),
        api: { getSession: async () => null },
      } as never,
      rateLimit: {
        trustProxy: true,
        rules: [{ match: () => true, bucket: "api", max: 1, windowMs: 60_000 }],
      },
    });
    expect((await hit(app as never, "/workspace", "10.0.0.1")).status).toBe(401);
    expect((await hit(app as never, "/workspace", "10.0.0.1")).status).toBe(429);
    expect((await hit(app as never, "/workspace", "10.0.0.2")).status).toBe(401);
  });

  test("forwarded addresses are ignored unless the proxy is trusted", async () => {
    const app = createApp({
      db: {} as Db,
      webOrigin: "http://localhost:3001",
      encryptionKey: Buffer.alloc(32, 1).toString("base64"),
      auth: {
        handler: async () => new Response("auth"),
        api: { getSession: async () => null },
      } as never,
      rateLimit: {
        trustProxy: false,
        rules: [{ match: () => true, bucket: "api", max: 1, windowMs: 60_000 }],
      },
    });
    expect((await hit(app as never, "/workspace", "10.0.0.1")).status).toBe(401);
    // A spoofed header must not buy a fresh allowance.
    expect((await hit(app as never, "/workspace", "10.0.0.99")).status).toBe(429);
  });

  test("credential endpoints have a stricter bucket that covers the mounted auth routes", async () => {
    const clock = { t: 5_000 };
    const app = build(clock, 100);
    const signIn = () =>
      app.handle(
        req("/api/auth/sign-in/email", {
          method: "POST",
          body: "{}",
          headers: { "x-forwarded-for": "9.9.9.9" },
        }),
      );
    expect((await signIn()).status).toBe(200);
    expect((await signIn()).status).toBe(200);
    expect((await signIn()).status).toBe(429);
    // Other routes are unaffected by the auth bucket.
    expect((await hit(app, "/workspace", "9.9.9.9")).status).not.toBe(429);
  });

  test("the health check is never limited", async () => {
    const app = build({ t: 1 }, 1);
    for (let i = 0; i < 20; i++) expect((await hit(app, "/health")).status).not.toBe(429);
  });
});

describe("roles", () => {
  const ID = "00000000-0000-4000-8000-0000000000aa";
  type Case = [method: string, path: string, body: object | undefined, minimum: "member" | "admin"];
  const cases: Case[] = [
    ["POST", "/workspace", { name: "w" }, "admin"],
    ["PATCH", `/workspace/${ID}`, { name: "w" }, "admin"],
    ["DELETE", `/workspace/${ID}`, undefined, "admin"],
    ["POST", "/channel", { workspaceId: WS, name: "c", kind: "email", to: "a@b.co" }, "admin"],
    ["PATCH", `/channel/${ID}`, { enabled: false }, "admin"],
    ["DELETE", `/channel/${ID}`, undefined, "admin"],
    ["POST", `/channel/${ID}/test`, undefined, "admin"],
    ["POST", "/alert-rule", { workspaceId: WS, channelId: ID }, "admin"],
    ["PATCH", `/alert-rule/${ID}`, { enabled: false }, "admin"],
    ["DELETE", `/alert-rule/${ID}`, undefined, "admin"],
    [
      "POST",
      "/monitor",
      { workspaceId: WS, name: "m", type: "http", target: "https://example.com", interval: 60 },
      "member",
    ],
    ["PATCH", `/monitor/${ID}`, { active: false }, "member"],
    ["DELETE", `/monitor/${ID}`, undefined, "member"],
    ["PATCH", `/incident/${ID}/acknowledge`, undefined, "member"],
    ["POST", "/asset", { workspaceId: WS, kind: "domain", value: "example.com" }, "member"],
    ["POST", `/asset/${ID}/verify`, undefined, "member"],
    ["POST", `/asset/${ID}/scan`, undefined, "member"],
    ["POST", `/asset/${ID}/discover`, undefined, "member"],
    ["DELETE", `/asset/${ID}`, undefined, "member"],
    ["PATCH", `/finding/${ID}`, { status: "ignored" }, "member"],
    ["POST", "/discovery/accept", { ids: [ID] }, "member"],
    ["POST", "/discovery/dismiss", { ids: [ID] }, "member"],
  ];
  const call = (app: ReturnType<typeof makeApp>, [method, path, body]: Case) =>
    app.handle(req(path, { method, body: body ? JSON.stringify(body) : undefined }));

  for (const c of cases) {
    const [method, path, , minimum] = c;
    test(`${method} ${path.replace(ID, ":id")} needs ${minimum}`, async () => {
      expect((await call(makeApp(session(ORG), "viewer"), c)).status).toBe(403);
      if (minimum === "admin")
        expect((await call(makeApp(session(ORG), "member"), c)).status).toBe(403);
      // Allowed roles pass authorization (the handler then fails on the stub DB, which is not a 403).
      expect((await call(makeApp(session(ORG), minimum), c)).status).not.toBe(403);
      expect((await call(makeApp(session(ORG), "owner"), c)).status).not.toBe(403);
    });
  }

  test("viewers can read", async () => {
    const app = makeApp(session(ORG), "viewer");
    for (const path of ["/workspace/not-a-uuid"])
      expect((await app.handle(req(path))).status).toBe(400); // got past auth to validation
  });

  test("someone who is no longer a member of the organization is refused", async () => {
    const res = await makeApp(session(ORG), null).handle(req("/monitor"));
    expect(res.status).toBe(403);
  });

  test("a stored role string with an unknown name grants nothing; the highest known one wins", async () => {
    expect((await makeApp(session(ORG), "superuser").handle(req("/monitor"))).status).toBe(403);
    expect(
      (await makeApp(session(ORG), "viewer,admin").handle(req("/workspace/not-a-uuid"))).status,
    ).toBe(400);
  });
});

describe("audit log", () => {
  const collect = () => {
    const entries: AuditEntry[] = [];
    return { entries, sink: (async (e) => void entries.push(e)) as AuditSink };
  };
  const flush = () => Bun.sleep(5);

  test("mutations are recorded with actor, route, resource and field names only", async () => {
    const { entries, sink } = collect();
    const app = makeApp(session(ORG), "owner", sink);
    await app.handle(
      req("/workspace/00000000-0000-4000-8000-0000000000aa", {
        method: "PATCH",
        body: JSON.stringify({ name: "SECRET-NAME" }),
        headers: { "user-agent": "tests", "x-forwarded-for": "5.5.5.5" },
      }),
    );
    await flush();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      organizationId: ORG,
      userId: "u1",
      action: "PATCH /workspace/:id",
      resourceType: "workspace",
      resourceId: "00000000-0000-4000-8000-0000000000aa",
      userAgent: "tests",
    });
    expect(entries[0]!.status).toBeGreaterThanOrEqual(400); // stub DB: the attempt is recorded even when it fails
    expect(entries[0]!.payload).toEqual({
      params: { id: "00000000-0000-4000-8000-0000000000aa" },
      fields: ["name"],
    });
    expect(JSON.stringify(entries[0])).not.toContain("SECRET-NAME");
  });

  test("reads and unauthenticated requests are not logged", async () => {
    const { entries, sink } = collect();
    await makeApp(session(ORG), "owner", sink).handle(req("/workspace"));
    await makeApp(null, "owner", sink).handle(
      req("/workspace", { method: "POST", body: JSON.stringify({ name: "x" }) }),
    );
    await flush();
    expect(entries).toEqual([]);
  });

  test("a refused attempt (insufficient role) is recorded with status 403", async () => {
    const { entries, sink } = collect();
    await makeApp(session(ORG), "viewer", sink).handle(
      req("/workspace", { method: "POST", body: JSON.stringify({ name: "x" }) }),
    );
    await flush();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      status: 403,
      action: "POST /workspace",
      userId: "u1",
      organizationId: ORG,
    });
  });

  test("a failing sink never fails the request", async () => {
    const res = await makeApp(session(ORG), "owner", async () =>
      Promise.reject(new Error("db down")),
    ).handle(
      req("/workspace/not-a-uuid", { method: "PATCH", body: JSON.stringify({ name: "x" }) }),
    );
    expect(res.status).toBe(400);
  });
});

describe("audit endpoints", () => {
  test("only admins can read the audit log or export it", async () => {
    for (const role of ["viewer", "member"]) {
      const app = makeApp(session(ORG), role);
      expect((await app.handle(req("/audit"))).status).toBe(403);
      expect((await app.handle(req("/audit/export"))).status).toBe(403);
    }
    expect((await makeApp(null).handle(req("/audit"))).status).toBe(401);
  });

  test("filters are validated", async () => {
    const app = makeApp(session(ORG), "admin");
    expect((await app.handle(req("/audit?before=nope"))).status).toBe(400);
    expect((await app.handle(req("/audit?limit=1000"))).status).toBe(400);
  });
});

describe("AI routes: roles and validation", () => {
  const ID = "00000000-0000-4000-8000-0000000000aa";
  const call = (role: string, method: string, path: string, body?: object) =>
    makeApp(session(ORG), role).handle(
      req(path, { method, body: body ? JSON.stringify(body) : undefined }),
    );

  test("anyone in the organization can read the settings, but only admins change them", async () => {
    expect((await call("viewer", "PATCH", "/ai/settings", { enabled: true })).status).toBe(403);
    expect((await call("member", "PATCH", "/ai/settings", { enabled: true })).status).toBe(403);
    // (the stub DB makes the handler itself fail; authorization is what is under test)
    expect((await call("admin", "GET", "/ai/settings")).status).not.toBe(403);
    expect((await call("viewer", "GET", "/ai/settings")).status).not.toBe(403);
  });

  test("drafting a monitor and explaining a finding need the member role", async () => {
    expect(
      (
        await call("viewer", "POST", "/ai/monitor-draft", {
          workspaceId: WS,
          text: "check example.com",
        })
      ).status,
    ).toBe(403);
    expect((await call("viewer", "POST", `/ai/finding/${ID}/explain`, {})).status).toBe(403);
    expect((await call("member", "POST", `/ai/finding/${ID}/explain`)).status).not.toBe(403);
  });

  test("settings and draft input are validated", async () => {
    expect((await call("admin", "PATCH", "/ai/settings", { dailyTokenBudget: 10 })).status).toBe(
      400,
    );
    expect(
      (await call("admin", "PATCH", "/ai/settings", { smartModel: "not a model" })).status,
    ).toBe(400);
    expect(
      (await call("member", "POST", "/ai/monitor-draft", { workspaceId: WS, text: "x" })).status,
    ).toBe(400);
    expect(
      (
        await call("member", "POST", "/ai/monitor-draft", {
          workspaceId: WS,
          text: "y".repeat(1001),
        })
      ).status,
    ).toBe(400);
    expect((await call("member", "POST", "/ai/finding/not-a-uuid/explain")).status).toBe(400);
  });

  test("unauthenticated requests are refused", async () => {
    expect((await makeApp(null).handle(req("/ai/settings"))).status).toBe(401);
  });
});
