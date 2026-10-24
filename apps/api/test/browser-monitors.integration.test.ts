import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { createAuth } from "@upzy/auth/server";
import { createDb, schema } from "@upzy/db";
import { inArray, like } from "drizzle-orm";

import { createApp } from "../src/app";

// Real Postgres + real better-auth. Needs: DATABASE_URL=... bun test
const url = process.env.DATABASE_URL;
const run = url ? describe : describe.skip;

run("browser monitors (postgres)", () => {
  process.env.BETTER_AUTH_SECRET ??= "integration-test-secret-integration-test-secret";
  const db = createDb(url);
  const { users, organizations, workspaces } = schema;
  const auth = createAuth(db, {
    sendEmail: async () => {},
    signup: { mode: "open", allowedEmails: [], allowedDomains: [] },
  });
  const tag = `bm${Date.now()}`;
  const origin = "http://localhost:3001";
  const app = createApp({
    db,
    auth,
    webOrigin: origin,
    encryptionKey: Buffer.alloc(32, 4).toString("base64"),
    rateLimit: { rules: [{ match: () => true, bucket: "t", max: Infinity, windowMs: 1 }] },
  });
  let cookie = "";
  const send = (path: string, init: RequestInit = {}) =>
    app.handle(
      new Request(`http://localhost${path}`, {
        ...init,
        headers: { "content-type": "application/json", origin, cookie },
      }),
    );
  const json = async (r: Response) => (await r.json()) as any;
  let ws = "";
  let orgId = "";
  const previous = process.env.BROWSER_WS_ENDPOINT;

  beforeAll(async () => {
    const r = await app.handle(
      new Request("http://localhost/api/auth/sign-up/email", {
        method: "POST",
        headers: { "content-type": "application/json", origin },
        body: JSON.stringify({
          email: `${tag}@example.com`,
          password: "supersecret123",
          name: "b",
        }),
      }),
    );
    cookie = r.headers
      .getSetCookie()
      .map((c) => c.split(";")[0])
      .join("; ");
    const org = await json(
      await send("/api/auth/organization/create", {
        method: "POST",
        body: JSON.stringify({ name: tag, slug: tag }),
      }),
    );
    orgId = org.id;
    await send("/api/auth/organization/set-active", {
      method: "POST",
      body: JSON.stringify({ organizationId: orgId }),
    });
    ws = (
      await db.insert(workspaces).values({ orgId, name: "w" }).returning({ id: workspaces.id })
    )[0]!.id;
  });
  afterAll(async () => {
    if (previous === undefined) delete process.env.BROWSER_WS_ENDPOINT;
    else process.env.BROWSER_WS_ENDPOINT = previous;
    await db.delete(organizations).where(inArray(organizations.id, [orgId]));
    await db.delete(users).where(like(users.email, `${tag}%`));
  });

  const create = (over: object = {}) =>
    send("/monitor", {
      method: "POST",
      body: JSON.stringify({
        workspaceId: ws,
        name: "login",
        type: "synthetic",
        target: "https://example.com/login",
        interval: 300,
        config: { browser: [{ do: "fill", selector: "#pw", value: "{{secret.PW}}" }] },
        secrets: { PW: "hunter2-hunter2" },
        ...over,
      }),
    });

  test("where there is no browser server, the type is not offered and cannot be created", async () => {
    delete process.env.BROWSER_WS_ENDPOINT;
    const caps = await json(await send("/monitor/regions"));
    expect(caps.browser.enabled).toBe(false);
    const r = await create();
    expect(r.status).toBe(422);
    expect((await json(r)).message).toContain("aren't set up");
  });

  test("with one, it is created with its steps, and the secret is never returned", async () => {
    process.env.BROWSER_WS_ENDPOINT = "ws://browser:3000/token";
    expect((await json(await send("/monitor/regions"))).browser.enabled).toBe(true);
    const r = await create({ regions: ["eu-west"] });
    expect(r.status).toBe(201);
    const m = await json(r);
    expect(m.type).toBe("synthetic");
    expect(m.regions).toEqual([]);
    expect(m.config.browser).toHaveLength(1);
    expect(m.secretNames).toEqual(["PW"]);
    expect(JSON.stringify(m)).not.toContain("hunter2-hunter2");
  });

  test("it cannot run more often than every five minutes", async () => {
    const r = await create({ interval: 60 });
    expect(r.status).toBe(422);
    expect((await json(r)).message).toContain("5 minutes");
  });

  test("steps are checked: a missing secret, a private address, or code are all refused", async () => {
    for (const config of [
      { browser: [{ do: "fill", selector: "#a", value: "{{secret.MISSING}}" }] },
      { browser: [{ do: "goto", url: "http://169.254.169.254/" }] },
      { browser: [{ do: "evaluate", script: "1" }] },
    ]) {
      const r = await create({ config, secrets: {} });
      expect(r.status, JSON.stringify(config)).toBeGreaterThanOrEqual(400);
      expect(r.status).toBeLessThan(500);
    }
  });

  test("steps can be edited later, but only on a browser monitor", async () => {
    const m = await json(await create());
    const patched = await send(`/monitor/${m.id}`, {
      method: "PATCH",
      body: JSON.stringify({
        config: { browser: [{ do: "expect_text", text: "Welcome" }] },
        latencyThresholdMs: null,
      }),
    });
    expect(patched.status).toBe(200);
    expect((await json(patched)).config.browser).toEqual([{ do: "expect_text", text: "Welcome" }]);

    const http = await json(
      await send("/monitor", {
        method: "POST",
        body: JSON.stringify({
          workspaceId: ws,
          name: "site",
          type: "http",
          target: "https://example.com",
          interval: 60,
        }),
      }),
    );
    const bad = await send(`/monitor/${http.id}`, {
      method: "PATCH",
      body: JSON.stringify({
        config: { browser: [{ do: "click", selector: "#x" }] },
        latencyThresholdMs: null,
      }),
    });
    expect(bad.status).toBeGreaterThanOrEqual(400);
  });

  test("it cannot be sped up below five minutes by an edit", async () => {
    const m = await json(await create());
    const r = await send(`/monitor/${m.id}`, {
      method: "PATCH",
      body: JSON.stringify({ interval: 60, latencyThresholdMs: null }),
    });
    expect(r.status).toBe(422);
  });
});
