import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { createAuth } from "@upzy/auth/server";
import { createDb, schema } from "@upzy/db";
import { eq, sql } from "drizzle-orm";

import { createApp } from "../src/app";

// Real Postgres + real better-auth. Needs: DATABASE_URL=... bun test
const url = process.env.DATABASE_URL;
const run = url ? describe : describe.skip;

run("health score and fix for my stack (postgres)", () => {
  process.env.BETTER_AUTH_SECRET ??= "integration-test-secret-integration-test-secret";
  const db = createDb(url);
  const auth = createAuth(db, {
    sendEmail: async () => {},
    signup: { mode: "open", allowedEmails: [], allowedDomains: [] },
  });
  const tag = `hf${Date.now()}`;
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
  let assetId = "";
  const fid: Record<string, string> = {};

  beforeAll(async () => {
    owner = await person("owner");
    other = await person("other");
    A = await makeOrg(owner, "a");
    await makeOrg(other, "b");
    assetId = (
      await db
        .insert(schema.assets)
        .values({
          workspaceId: A.ws,
          kind: "domain",
          value: `${tag}.example.com`,
          verificationToken: "t",
        })
        .returning({ id: schema.assets.id })
    )[0]!.id;
    const add = async (
      checkKey: string,
      severity: "medium" | "low" | "critical",
      extra: object = {},
    ) =>
      (
        await db
          .insert(schema.findings)
          .values({
            workspaceId: A.ws,
            assetId,
            checkKey,
            fingerprint: `${tag}-${checkKey}`,
            severity,
            title: checkKey,
            description: "d",
            ...extra,
          })
          .returning({ id: schema.findings.id })
      )[0]!.id;
    fid.hsts = await add("headers.hsts_missing", "medium");
    fid.nosniff = await add("headers.nosniff_missing", "low");
    fid.dmarc = await add("email.dmarc_missing", "medium");
    fid.cve = await add("cve.vulnerable_component", "low");
    fid.done = await add("headers.csp_missing", "medium", { status: "resolved" });
  });
  afterAll(async () => {
    await db.delete(schema.jobs).where(sql`${schema.jobs.payload}::text like ${`%${fid.hsts}%`}`);
    await db.delete(schema.organizations).where(eq(schema.organizations.id, A.orgId));
  });

  const listed = async (who = owner) =>
    (await json(await call(who, "GET", "/asset"))).find((a: any) => a.id === assetId);

  test("an asset that has never been scanned has no grade; once scanned it gets one with its stack", async () => {
    expect((await listed()).health).toBeNull();
    await db
      .update(schema.assets)
      .set({
        lastScanAt: new Date(),
        stack: { platform: "cloudflare", server: "nginx", framework: "unknown" },
      })
      .where(eq(schema.assets.id, assetId));
    const a = await listed();
    expect(a.stackLabel).toBe("Cloudflare in front of nginx");
    // Two open mediums (hsts, dmarc) put it at a B; resolved findings don't count.
    expect(a.health.grade).toBe("B");
    expect(a.health.categories.email).toBe(88);
  });

  test("health detail has the breakdown, the trend and one snippet for every missing header", async () => {
    const d = await json(await call(owner, "GET", `/asset/${assetId}/health`));
    expect(d.health.score).toBeLessThanOrEqual(89);
    expect(d.history).toEqual([]);
    expect(d.stackLabel).toBe("Cloudflare in front of nginx");
    const code = d.headersFix.snippets.map((s: any) => s.code).join("\n");
    expect(code).toContain("Strict-Transport-Security");
    expect(code).toContain("X-Content-Type-Options");
    expect(code).not.toContain("Content-Security-Policy"); // that finding is resolved
    // Other organizations don't see it.
    expect((await call(other, "GET", `/asset/${assetId}/health`)).status).toBe(404);
  });

  test("a finding comes with the fix for the detected stack, or none when there's no template", async () => {
    const f = await json(await call(owner, "GET", `/finding/${fid.hsts}`));
    expect(f.fix.target).toBe("Cloudflare");
    expect(f.fix.detected).toBe("Cloudflare in front of nginx");
    expect(f.fix.snippets.map((s: any) => s.language)).toEqual(["text", "nginx"]);
    const dns = await json(await call(owner, "GET", `/finding/${fid.dmarc}`));
    expect(dns.fix.snippets[0].code).toContain(`_dmarc.${tag}.example.com.  TXT`);
    expect((await json(await call(owner, "GET", `/finding/${fid.cve}`))).fix).toBeNull();
  });

  test("verify fix queues a re-check of that finding; closed findings, other orgs and rapid repeats are refused", async () => {
    const r = await call(owner, "POST", `/finding/${fid.hsts}/verify`);
    expect(r.status).toBe(202);
    const job = await db
      .select()
      .from(schema.jobs)
      .where(
        sql`${schema.jobs.queue} = 'verify-fix' and ${schema.jobs.payload}->>'findingId' = ${fid.hsts}`,
      );
    expect(job).toHaveLength(1);
    expect((await json(await call(owner, "GET", `/finding/${fid.hsts}`))).verifyStatus).toBe(
      "pending",
    );
    // A second request while one is queued doesn't queue another.
    await call(owner, "POST", `/finding/${fid.hsts}/verify`);
    expect(
      await db
        .select()
        .from(schema.jobs)
        .where(
          sql`${schema.jobs.queue} = 'verify-fix' and ${schema.jobs.payload}->>'findingId' = ${fid.hsts}`,
        ),
    ).toHaveLength(1);

    expect((await call(owner, "POST", `/finding/${fid.done}/verify`)).status).toBe(409);
    expect((await call(other, "POST", `/finding/${fid.hsts}/verify`)).status).toBe(404);

    await db
      .update(schema.findings)
      .set({ lastVerifiedAt: new Date() })
      .where(eq(schema.findings.id, fid.nosniff!));
    expect((await call(owner, "POST", `/finding/${fid.nosniff}/verify`)).status).toBe(429);
  });
});
