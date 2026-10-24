import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { createAuth } from "@upzy/auth/server";
import { createDb, schema } from "@upzy/db";
import { inArray, like } from "drizzle-orm";

import { createApp } from "../src/app";

// Real Postgres + real better-auth. Needs: DATABASE_URL=... bun test
const url = process.env.DATABASE_URL;
const run = url ? describe : describe.skip;

run("monitor regions (postgres)", () => {
  process.env.BETTER_AUTH_SECRET ??= "integration-test-secret-integration-test-secret";
  const db = createDb(url);
  const { users, organizations, workspaces } = schema;
  const auth = createAuth(db, {
    sendEmail: async () => {},
    signup: { mode: "open", allowedEmails: [], allowedDomains: [] },
  });
  const tag = `rg${Date.now()}`;
  const origin = "http://localhost:3001";
  const app = createApp({
    db,
    auth,
    webOrigin: origin,
    encryptionKey: Buffer.alloc(32, 4).toString("base64"),
    rateLimit: { rules: [{ match: () => true, bucket: "t", max: Infinity, windowMs: 1 }] },
  });
  const send = (path: string, cookie: string, init: RequestInit = {}) =>
    app.handle(
      new Request(`http://localhost${path}`, {
        ...init,
        headers: { "content-type": "application/json", origin, cookie },
      }),
    );
  const json = async (r: Response) => (await r.json()) as any;
  let cookie = "";
  let ws = "";
  let orgId = "";
  const previous = process.env.PROBE_REGIONS;

  beforeAll(async () => {
    process.env.PROBE_REGIONS = "eu-west,us-east";
    const r = await app.handle(
      new Request("http://localhost/api/auth/sign-up/email", {
        method: "POST",
        headers: { "content-type": "application/json", origin },
        body: JSON.stringify({
          email: `${tag}@example.com`,
          password: "supersecret123",
          name: "r",
        }),
      }),
    );
    cookie = r.headers
      .getSetCookie()
      .map((c) => c.split(";")[0])
      .join("; ");
    const org = await json(
      await send("/api/auth/organization/create", cookie, {
        method: "POST",
        body: JSON.stringify({ name: tag, slug: tag }),
      }),
    );
    orgId = org.id;
    await send("/api/auth/organization/set-active", cookie, {
      method: "POST",
      body: JSON.stringify({ organizationId: orgId }),
    });
    ws = (
      await db.insert(workspaces).values({ orgId, name: "w" }).returning({ id: workspaces.id })
    )[0]!.id;
  });
  afterAll(async () => {
    if (previous === undefined) delete process.env.PROBE_REGIONS;
    else process.env.PROBE_REGIONS = previous;
    await db.delete(organizations).where(inArray(organizations.id, [orgId]));
    await db.delete(users).where(like(users.email, `${tag}%`));
  });

  const create = (extra: object) =>
    send("/monitor", cookie, {
      method: "POST",
      body: JSON.stringify({
        workspaceId: ws,
        name: "site",
        type: "http",
        target: "https://example.com",
        interval: 60,
        ...extra,
      }),
    });

  test("lists what this installation offers, main server first", async () => {
    const r = await send("/monitor/regions", cookie);
    expect(r.status).toBe(200);
    expect(await json(r)).toMatchObject({ regions: ["local", "eu-west", "us-east"], max: null });
  });

  test("a monitor can be created with regions, and shows them", async () => {
    const r = await create({ regions: ["eu-west", "us-east", "eu-west"] });
    expect(r.status).toBe(201);
    const m = await json(r);
    expect(m.regions).toEqual(["eu-west", "us-east"]);
    const detail = await json(await send(`/monitor/${m.id}`, cookie));
    expect(detail.regions).toEqual(["eu-west", "us-east"]);
    expect(detail.regionStates).toEqual([]);
  });

  test("no regions means the main server", async () => {
    const m = await json(await create({}));
    expect(m.regions).toEqual([]);
  });

  test("a region this installation doesn't offer is refused", async () => {
    const r = await create({ regions: ["mars-1"] });
    expect(r.status).toBe(422);
    expect((await json(r)).message).toContain("mars-1");
  });

  test("a malformed region name is refused by validation", async () => {
    expect((await create({ regions: ["EU West!"] })).status).toBeGreaterThanOrEqual(400);
  });

  test("an update that doesn't mention regions leaves them alone", async () => {
    const m = await json(await create({ regions: ["eu-west", "us-east"] }));
    const r = await send(`/monitor/${m.id}`, cookie, {
      method: "PATCH",
      body: JSON.stringify({ name: "renamed", latencyThresholdMs: null }),
    });
    expect(r.status).toBe(200);
    expect((await json(r)).regions).toEqual(["eu-west", "us-east"]);
  });

  test("regions can be changed later, and a heartbeat ignores them", async () => {
    const m = await json(await create({ regions: ["eu-west"] }));
    const patched = await send(`/monitor/${m.id}`, cookie, {
      method: "PATCH",
      body: JSON.stringify({ regions: ["local", "us-east"], latencyThresholdMs: null }),
    });
    expect(patched.status).toBe(200);
    expect((await json(patched)).regions).toEqual(["local", "us-east"]);

    const hb = await json(
      await create({
        type: "heartbeat",
        target: undefined,
        config: { expectEvery: 3600 },
        regions: ["eu-west"],
      }),
    );
    expect(hb.regions).toEqual([]);
  });
});
