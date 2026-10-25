import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { createAuth } from "@upzy/auth/server";
import { createDb, schema } from "@upzy/db";
import { eq, inArray, like } from "drizzle-orm";

import { createApp } from "../src/app";

// Real Postgres + real better-auth. Needs: DATABASE_URL=... bun test
const url = process.env.DATABASE_URL;
const run = url ? describe : describe.skip;

run("change feed (postgres)", () => {
  process.env.BETTER_AUTH_SECRET ??= "integration-test-secret-integration-test-secret";
  const db = createDb(url);
  const { users, organizations, workspaces, monitors, incidents } = schema;
  const auth = createAuth(db, {
    sendEmail: async () => {},
    signup: { mode: "open", allowedEmails: [], allowedDomains: [] },
  });
  const tag = `ch${Date.now()}`;
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

  beforeAll(async () => {
    const r = await app.handle(
      new Request("http://localhost/api/auth/sign-up/email", {
        method: "POST",
        headers: { "content-type": "application/json", origin },
        body: JSON.stringify({
          email: `${tag}@example.com`,
          password: "supersecret123",
          name: "c",
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
    await db.delete(organizations).where(inArray(organizations.id, [orgId]));
    await db.delete(users).where(like(users.email, `${tag}%`));
  });

  const feed = async () => json(await send(`/changes?workspaceId=${ws}`, cookie));

  test("the fingerprints move when a monitor's state or an incident changes, and only then", async () => {
    const [m] = await db
      .insert(monitors)
      .values({
        workspaceId: ws,
        name: "m",
        type: "http",
        target: "https://example.com",
        interval: 60,
        active: true,
      })
      .returning();
    const first = await feed();
    expect(first.monitors).toHaveLength(32);

    // Checks come in all the time without changing state: the fingerprint must not move for them.
    await db
      .update(monitors)
      .set({ lastCheckAt: new Date(), lastResponseMs: 90 })
      .where(eq(monitors.id, m!.id));
    expect(await feed()).toEqual(first);

    await db.update(monitors).set({ lastStatus: "down" }).where(eq(monitors.id, m!.id));
    const down = await feed();
    expect(down.monitors).not.toBe(first.monitors);
    expect(down.incidents).toBe(first.incidents);

    const [inc] = await db
      .insert(incidents)
      .values({ workspaceId: ws, monitorId: m!.id, type: "uptime", status: "open" })
      .returning();
    const opened = await feed();
    expect(opened.incidents).not.toBe(down.incidents);

    await db
      .update(incidents)
      .set({ status: "resolved", resolvedAt: new Date() })
      .where(eq(incidents.id, inc!.id));
    expect((await feed()).incidents).not.toBe(opened.incidents);
  });

  test("another organization's workspace is refused", async () => {
    const other = (
      await db
        .insert(organizations)
        .values({ id: `${tag}-o`, name: "o", slug: `${tag}-o`, createdAt: new Date() })
        .returning()
    )[0]!;
    const w = (await db.insert(workspaces).values({ orgId: other.id, name: "x" }).returning())[0]!;
    const res = await send(`/changes?workspaceId=${w.id}`, cookie);
    expect(res.status).toBe(404);
    await db.delete(organizations).where(eq(organizations.id, other.id));
  });

  test("signing in is required", async () => {
    const res = await app.handle(new Request(`http://localhost/changes?workspaceId=${ws}`));
    expect(res.status).toBe(401);
  });
});
