import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { createAuth } from "@upzy/auth/server";
import { createDb, schema } from "@upzy/db";
import { inArray, like } from "drizzle-orm";

import { createApp } from "../src/app";

// Real Postgres (with pgvector) + real better-auth. Needs: DATABASE_URL=... bun test
const url = process.env.DATABASE_URL;
const run = url ? describe : describe.skip;

run("similar incidents (postgres)", () => {
  process.env.BETTER_AUTH_SECRET ??= "integration-test-secret-integration-test-secret";
  const db = createDb(url);
  const { users, organizations, workspaces, monitors, monitorChecks, incidents } = schema;
  const auth = createAuth(db, {
    sendEmail: async () => {},
    signup: { mode: "open", allowedEmails: [], allowedDomains: [] },
  });
  const tag = `si${Date.now()}`;
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
  const cookieOf = (r: Response) =>
    r.headers
      .getSetCookie()
      .map((c) => c.split(";")[0])
      .join("; ");
  const orgIds: string[] = [];
  const person = async (name: string) => {
    const r = await app.handle(
      new Request("http://localhost/api/auth/sign-up/email", {
        method: "POST",
        headers: { "content-type": "application/json", origin },
        body: JSON.stringify({
          email: `${tag}-${name}@example.com`,
          password: "supersecret123",
          name,
        }),
      }),
    );
    const cookie = cookieOf(r);
    const org = await json(
      await send("/api/auth/organization/create", cookie, {
        method: "POST",
        body: JSON.stringify({ name: `${tag} ${name}`, slug: `${tag}-${name}` }),
      }),
    );
    orgIds.push(org.id);
    await send("/api/auth/organization/set-active", cookie, {
      method: "POST",
      body: JSON.stringify({ organizationId: org.id }),
    });
    const [w] = await db
      .insert(workspaces)
      .values({ orgId: org.id, name: "w" })
      .returning({ id: workspaces.id });
    return { cookie, ws: w!.id };
  };
  async function incident(ws: string, name: string, resolved: boolean) {
    const created = new Date(Date.now() - 3_600_000);
    const [m] = await db
      .insert(monitors)
      .values({
        workspaceId: ws,
        name,
        type: "http",
        target: `https://${name}.example.com`,
        interval: 60,
        active: true,
      })
      .returning({ id: monitors.id });
    await db.insert(monitorChecks).values({
      monitorId: m!.id,
      status: "down",
      error: "connect ECONNREFUSED 10.0.0.1:443",
      errorKind: "http",
      createdAt: new Date(created.getTime() + 60_000),
    });
    const [i] = await db
      .insert(incidents)
      .values({
        workspaceId: ws,
        monitorId: m!.id,
        type: "uptime",
        status: resolved ? "resolved" : "open",
        title: `${name} is down`,
        createdAt: created,
        resolvedAt: resolved ? new Date(created.getTime() + 600_000) : null,
      })
      .returning({ id: incidents.id });
    return i!.id;
  }

  let alice: Awaited<ReturnType<typeof person>>;
  let bob: Awaited<ReturnType<typeof person>>;
  beforeAll(async () => {
    alice = await person("alice");
    bob = await person("bob");
  });
  afterAll(async () => {
    await db.delete(organizations).where(inArray(organizations.id, orgIds));
    await db.delete(users).where(like(users.email, `${tag}-%`));
  });

  test("a member sees earlier look-alike incidents of their own workspace", async () => {
    const now = await incident(alice.ws, "web", false);
    const before = await incident(alice.ws, "api", true);
    const r = await send(`/incident/${now}/similar`, alice.cookie);
    expect(r.status).toBe(200);
    const list = await json(r);
    expect(list.map((x: any) => x.id)).toEqual([before]);
    expect(list[0]).toMatchObject({ monitorName: "api", status: "resolved" });
  });

  test("another organization can't read them, or even tell the incident exists", async () => {
    const mine = await incident(alice.ws, "private", false);
    const r = await send(`/incident/${mine}/similar`, bob.cookie);
    expect(r.status).toBe(404);
  });

  test("a signed-out request is refused", async () => {
    const r = await app.handle(
      new Request("http://localhost/incident/00000000-0000-4000-8000-000000000000/similar", {
        headers: { origin },
      }),
    );
    expect(r.status).toBe(401);
  });
});
