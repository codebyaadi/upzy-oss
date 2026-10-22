import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { createAuth } from "@upzy/auth/server";
import { createDb, schema } from "@upzy/db";
import { eq } from "drizzle-orm";

import { createApp } from "../src/app";

// Real Postgres + real better-auth. Needs: DATABASE_URL=... bun test
const url = process.env.DATABASE_URL;
const run = url ? describe : describe.skip;

run("onboarding (postgres)", () => {
  process.env.BETTER_AUTH_SECRET ??= "integration-test-secret-integration-test-secret";
  const db = createDb(url);
  const auth = createAuth(db, {
    sendEmail: async () => {},
    signup: { mode: "open", allowedEmails: [], allowedDomains: [] },
  });
  const tag = `ob${Date.now()}`;
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
    return { cookie: cookieOf(r) };
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
    const [ws] = await db
      .insert(schema.workspaces)
      .values({ orgId: org.id, name: `${slug} ws` })
      .returning({ id: schema.workspaces.id });
    return { orgId: org.id as string, ws: ws!.id };
  };
  const call = (who: { cookie: string }, method: string, path: string, body?: unknown) =>
    send(path, { method, cookie: who.cookie, ...(body ? { body: JSON.stringify(body) } : {}) });

  let owner: { cookie: string }, other: { cookie: string };
  let A = { orgId: "", ws: "" };
  let B = { orgId: "", ws: "" };
  const site = (who: { cookie: string }, ws: string, s: string) =>
    call(who, "POST", "/onboarding/site", { workspaceId: ws, site: s });

  beforeAll(async () => {
    owner = await person("owner");
    other = await person("other");
    A = await makeOrg(owner, "a");
    B = await makeOrg(other, "b");
  });
  afterAll(async () => {
    await db.delete(schema.organizations).where(eq(schema.organizations.id, A.orgId));
    await db.delete(schema.organizations).where(eq(schema.organizations.id, B.orgId));
  });

  const monitorsOf = (ws: string) =>
    db.select().from(schema.monitors).where(eq(schema.monitors.workspaceId, ws));
  const assetsOf = (ws: string) =>
    db.select().from(schema.assets).where(eq(schema.assets.workspaceId, ws));

  test("a website becomes a domain asset, an uptime monitor and a certificate monitor, with ownership instructions", async () => {
    const r = await site(owner, A.ws, `https://www.${tag}.com/`);
    expect(r.status).toBe(201);
    const b = await json(r);
    expect(b.asset).toMatchObject({
      value: `${tag}.com`,
      kind: "domain",
      verified: false,
      created: true,
    });
    expect(b.verification.dns.value).toContain("upzy");
    expect(b.verification.file.content.length).toBeGreaterThan(10);
    expect(b.monitors.map((m: any) => [m.type, m.created])).toEqual([
      ["http", true],
      ["ssl", true],
    ]);

    const ms = await monitorsOf(A.ws);
    const http = ms.find((m) => m.type === "http")!;
    expect(http).toMatchObject({
      target: `https://www.${tag}.com/`,
      interval: 300,
      active: true,
      failureThreshold: 2,
    });
    expect(ms.find((m) => m.type === "ssl")).toMatchObject({
      target: `www.${tag}.com`,
      interval: 3600,
    });
    // Due immediately, so the first scan happens within seconds.
    const [a] = await assetsOf(A.ws);
    expect(a!.nextScanAt.getTime()).toBeLessThanOrEqual(Date.now());
  });

  test("doing it again reuses everything; a repeat asks for a fresh scan only if the last one is old", async () => {
    const [before] = await assetsOf(A.ws);
    await db
      .update(schema.assets)
      .set({
        lastScanAt: new Date(Date.now() - 60 * 60_000),
        nextScanAt: new Date(Date.now() + 86_400_000),
      })
      .where(eq(schema.assets.id, before!.id));
    const b = await json(await site(owner, A.ws, `${tag}.com`));
    expect(b.asset).toMatchObject({ id: before!.id, created: false });
    // Same asset; the bare domain is a different monitor address from the www one, so only that http monitor is new.
    expect(b.monitors.map((m: any) => m.created)).toEqual([true, true]);
    const again = await json(await site(owner, A.ws, `${tag}.com`));
    expect(again.monitors.map((m: any) => m.created)).toEqual([false, false]);
    expect(await assetsOf(A.ws)).toHaveLength(1);
    expect(await monitorsOf(A.ws)).toHaveLength(4);
    const [after] = await assetsOf(A.ws);
    expect(after!.nextScanAt.getTime()).toBeLessThanOrEqual(Date.now());
  });

  test("a subdomain is scanned as itself", async () => {
    const b = await json(await site(owner, A.ws, `app.${tag}.com`));
    expect(b.asset).toMatchObject({ value: `app.${tag}.com`, kind: "subdomain" });
  });

  test("a site covered by a verified domain is verified at once", async () => {
    await db
      .update(schema.assets)
      .set({ verified: true, verifiedAt: new Date() })
      .where(eq(schema.assets.value, `${tag}.com`));
    const b = await json(await site(owner, A.ws, `blog.${tag}.com`));
    expect(b.asset.verified).toBe(true);
    expect(b.verification).toBeNull();
  });

  test("non-public or malformed addresses are refused, and other organizations' workspaces are off limits", async () => {
    for (const bad of [
      "localhost",
      "10.0.0.1",
      "http://127.0.0.1/",
      "intranet.internal",
      "not a site",
      "ftp://x.example.com",
    ])
      expect((await site(owner, A.ws, bad)).status).toBe(400);
    const nothing = (await monitorsOf(A.ws)).length;
    expect((await site(owner, B.ws, "stranger.example.com")).status).toBe(404);
    expect((await site(other, A.ws, "stranger.example.com")).status).toBe(404);
    expect((await monitorsOf(A.ws)).length).toBe(nothing);
    expect((await monitorsOf(B.ws)).length).toBe(0);
  });
});
