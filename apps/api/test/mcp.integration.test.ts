import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { createAuth } from "@upzy/auth/server";
import { createDb, schema } from "@upzy/db";
import { eq, inArray, like } from "drizzle-orm";

import { createApp } from "../src/app";

// Real Postgres + real better-auth. Needs: DATABASE_URL=... bun test
const url = process.env.DATABASE_URL;
const run = url ? describe : describe.skip;

run("MCP server (postgres)", () => {
  process.env.BETTER_AUTH_SECRET ??= "integration-test-secret-integration-test-secret";
  const db = createDb(url);
  const { users, organizations, workspaces, monitors, apiKeys } = schema;
  const auth = createAuth(db, {
    sendEmail: async () => {},
    signup: { mode: "open", allowedEmails: [], allowedDomains: [] },
  });
  const tag = `mcp${Date.now()}`;
  const origin = "http://localhost:3001";
  const app = createApp({
    db,
    auth,
    webOrigin: origin,
    encryptionKey: Buffer.alloc(32, 4).toString("base64"),
    rateLimit: { rules: [{ match: () => true, bucket: "t", max: Infinity, windowMs: 1 }] },
  });
  const json = async (r: Response) => (await r.json()) as any;
  const send = (path: string, cookie: string, init: RequestInit = {}) =>
    app.handle(
      new Request(`http://localhost${path}`, {
        ...init,
        headers: { "content-type": "application/json", origin, cookie },
      }),
    );

  /** A person with their own organization, one workspace and one monitor. */
  async function tenant(name: string) {
    const r = await app.handle(
      new Request("http://localhost/api/auth/sign-up/email", {
        method: "POST",
        headers: { "content-type": "application/json", origin },
        body: JSON.stringify({
          email: `${tag}${name}@example.com`,
          password: "supersecret123",
          name,
        }),
      }),
    );
    const cookie = r.headers
      .getSetCookie()
      .map((c) => c.split(";")[0])
      .join("; ");
    const org = await json(
      await send("/api/auth/organization/create", cookie, {
        method: "POST",
        body: JSON.stringify({ name: `${tag}${name}`, slug: `${tag}${name}` }),
      }),
    );
    await send("/api/auth/organization/set-active", cookie, {
      method: "POST",
      body: JSON.stringify({ organizationId: org.id }),
    });
    const ws = (
      await db
        .insert(workspaces)
        .values({ orgId: org.id, name: `${name}-ws` })
        .returning({ id: workspaces.id })
    )[0]!.id;
    await db.insert(monitors).values({
      workspaceId: ws,
      name: `${name}-site`,
      type: "http",
      target: `https://${name}.example.com`,
      interval: 60,
      active: true,
    });
    return { cookie, orgId: org.id as string };
  }

  const makeKey = async (t: { cookie: string }, scopes: string[], over: object = {}) => {
    const r = await send("/api-keys", t.cookie, {
      method: "POST",
      body: JSON.stringify({ name: "claude", scopes, ...over }),
    });
    expect(r.status).toBe(201);
    return (await json(r)) as { id: string; key: string; prefix: string };
  };

  let rpcId = 0;
  const rpc = async (key: string | null, method: string, params?: object, session?: string) => {
    const res = await app.handle(
      new Request("http://localhost/mcp", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(key ? { authorization: `Bearer ${key}` } : {}),
          ...(session ? { "mcp-session-id": session } : {}),
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params }),
      }),
    );
    return { res, body: res.status === 200 ? await json(res) : null };
  };
  const call = (key: string, name: string, args: object = {}, session?: string) =>
    rpc(key, "tools/call", { name, arguments: args }, session);
  const text = (r: { body: any }) => String(r.body?.result?.content?.[0]?.text ?? "");

  let a: Awaited<ReturnType<typeof tenant>>;
  let b: Awaited<ReturnType<typeof tenant>>;
  beforeAll(async () => {
    a = await tenant("alpha");
    b = await tenant("beta");
  });
  afterAll(async () => {
    await db.delete(organizations).where(inArray(organizations.id, [a.orgId, b.orgId]));
    await db.delete(users).where(like(users.email, `${tag}%`));
  });

  test("a key is shown once, stored only as a hash, and listed without it", async () => {
    const k = await makeKey(a, ["monitors:read"]);
    expect(k.key.startsWith("upzy_mcp_")).toBe(true);
    const [row] = await db.select().from(apiKeys).where(eq(apiKeys.id, k.id));
    expect(row!.hashedKey).not.toContain(k.key);
    expect(row!.hashedKey).toHaveLength(64);
    const list = await json(await send("/api-keys", a.cookie));
    expect(JSON.stringify(list)).not.toContain(k.key);
    expect(list.find((x: any) => x.id === k.id).prefix).toBe(k.prefix);
  });

  test("creating keys needs a signed-in admin", async () => {
    const r = await app.handle(
      new Request("http://localhost/api-keys", {
        method: "POST",
        headers: { "content-type": "application/json", origin },
        body: JSON.stringify({ name: "x", scopes: ["monitors:read"] }),
      }),
    );
    expect(r.status).toBe(401);
  });

  test("Claude Code can connect with a key: initialize, list the tools, list the monitors", async () => {
    const { key } = await makeKey(a, ["monitors:read"]);
    const init = await rpc(key, "initialize", { protocolVersion: "2025-06-18" });
    expect(init.body.result.serverInfo.name).toBe("upzy");
    expect(init.body.result.protocolVersion).toBe("2025-06-18");
    const session = init.res.headers.get("mcp-session-id")!;
    expect(session).toBeTruthy();

    const tools = await rpc(key, "tools/list", {}, session);
    const names = tools.body.result.tools.map((t: any) => t.name).sort();
    expect(names).toEqual([
      "expiringCertificates",
      "listMonitors",
      "listWorkspaces",
      "monitorStats",
    ]);
    expect(tools.body.result.tools[0].inputSchema.type).toBe("object");

    const monitorsOut = await call(key, "listMonitors", {}, session);
    expect(text(monitorsOut)).toContain("alpha-site");
    // The id it gave back works in a later call of the same session.
    const stats = await call(key, "monitorStats", { monitorId: "m1", days: 7 }, session);
    expect(text(stats)).toContain("alpha-site");
  });

  test("a key without the scope cannot call the tool, and cannot even see it", async () => {
    const { key } = await makeKey(a, ["monitors:read"]);
    const r = await call(key, "listFindings");
    expect(r.body.error.message).toContain("Unknown tool");
    const names = (await rpc(key, "tools/list")).body.result.tools.map((t: any) => t.name);
    expect(names).not.toContain("listFindings");
    expect(names).not.toContain("getIncident");
  });

  test("one organization's key never reads another's records", async () => {
    const ka = (await makeKey(a, ["monitors:read"])).key;
    const kb = (await makeKey(b, ["monitors:read"])).key;
    const fromA = text(await call(ka, "listMonitors"));
    const fromB = text(await call(kb, "listMonitors"));
    expect(fromA).toContain("alpha-site");
    expect(fromA).not.toContain("beta-site");
    expect(fromB).toContain("beta-site");
    expect(fromB).not.toContain("alpha-site");
    // Handles are per connection: B cannot use a handle that A's session was given.
    const s = (await rpc(ka, "initialize", {})).res.headers.get("mcp-session-id")!;
    await call(ka, "listMonitors", {}, s);
    const stolen = await call(kb, "monitorStats", { monitorId: "m1" }, s);
    expect(text(stolen)).toContain("No such monitor");
    expect(text(stolen)).not.toContain("alpha-site");
  });

  test("missing, wrong, revoked and expired keys are refused", async () => {
    expect((await rpc(null, "ping")).res.status).toBe(401);
    expect((await rpc("upzy_mcp_nonsense", "ping")).res.status).toBe(401);
    expect((await rpc("not-even-a-key", "ping")).res.status).toBe(401);

    const k = await makeKey(a, ["monitors:read"]);
    expect((await rpc(k.key, "ping")).res.status).toBe(200);
    const del = await send(`/api-keys/${k.id}`, a.cookie, { method: "DELETE" });
    expect(del.status).toBe(200);
    expect((await rpc(k.key, "ping")).res.status).toBe(401);

    const old = await makeKey(a, ["monitors:read"]);
    await db
      .update(apiKeys)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(apiKeys.id, old.id));
    expect((await rpc(old.key, "ping")).res.status).toBe(401);
  });

  test("another organization cannot revoke a key, and a key stops working when its owner leaves", async () => {
    const k = await makeKey(a, ["monitors:read"]);
    expect((await send(`/api-keys/${k.id}`, b.cookie, { method: "DELETE" })).status).toBe(404);
    expect((await rpc(k.key, "ping")).res.status).toBe(200);
    await db.delete(schema.members).where(eq(schema.members.organizationId, a.orgId));
    expect((await rpc(k.key, "ping")).res.status).toBe(401);
  });

  test("bad requests get protocol errors, not crashes", async () => {
    const { key } = await makeKey(b, ["monitors:read"]);
    const bad = await app.handle(
      new Request("http://localhost/mcp", {
        method: "POST",
        headers: { authorization: `Bearer ${key}` },
        body: "{nope",
      }),
    );
    expect((await json(bad)).error.code).toBe(-32700);
    expect((await rpc(key, "no/such/method")).body.error.code).toBe(-32601);
    const wrong = await call(key, "listMonitors", { limit: 9999 });
    expect(wrong.body.result.isError).toBe(true);
    const get = await app.handle(new Request("http://localhost/mcp"));
    expect(get.status).toBe(405);
  });
});
