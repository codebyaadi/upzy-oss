import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { createSign, generateKeyPairSync, randomUUID } from "node:crypto";

import { createAuth } from "@upzy/auth/server";
import { createDb, schema } from "@upzy/db";
import { eq, inArray, like } from "drizzle-orm";

import { createApp } from "../src/app";

// Real Postgres + real better-auth + a small OpenID Connect provider run in the test.
// Needs: DATABASE_URL=... bun test
setDefaultTimeout(30_000);
const url = process.env.DATABASE_URL;
const run = url ? describe : describe.skip;

const b64 = (b: Buffer | string) => Buffer.from(b).toString("base64url");

/** Just enough of an OpenID Connect provider for the authorization-code flow. */
function mockProvider(clientId: string, clientSecret: string) {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const jwk = { ...publicKey.export({ format: "jwk" }), kid: "k1", alg: "RS256", use: "sig" };
  const sign = (claims: Record<string, unknown>) => {
    const head = b64(JSON.stringify({ alg: "RS256", typ: "JWT", kid: "k1" }));
    const body = b64(JSON.stringify(claims));
    const sig = createSign("RSA-SHA256").update(`${head}.${body}`).sign(privateKey);
    return `${head}.${body}.${b64(sig)}`;
  };
  const codes = new Map<string, { nonce?: string; email: string }>();
  let nextEmail = "";
  const server: ReturnType<typeof Bun.serve> = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req): Promise<Response> {
      const u = new URL(req.url);
      const origin: string = `http://127.0.0.1:${server.port}`;
      if (u.pathname === "/.well-known/openid-configuration")
        return Response.json({
          issuer: origin,
          authorization_endpoint: `${origin}/authorize`,
          token_endpoint: `${origin}/token`,
          jwks_uri: `${origin}/jwks`,
          userinfo_endpoint: `${origin}/userinfo`,
          id_token_signing_alg_values_supported: ["RS256"],
          token_endpoint_auth_methods_supported: ["client_secret_basic", "client_secret_post"],
          response_types_supported: ["code"],
          subject_types_supported: ["public"],
        });
      if (u.pathname === "/userinfo")
        return Response.json({
          sub: `sub-${nextEmail}`,
          email: nextEmail,
          email_verified: true,
          name: "Sso Person",
        });
      if (u.pathname === "/jwks") return Response.json({ keys: [jwk] });
      if (u.pathname === "/authorize") {
        const code = randomUUID();
        codes.set(code, { nonce: u.searchParams.get("nonce") ?? undefined, email: nextEmail });
        const back = new URL(u.searchParams.get("redirect_uri")!);
        back.searchParams.set("code", code);
        back.searchParams.set("state", u.searchParams.get("state")!);
        return Response.redirect(back.toString(), 302);
      }
      if (u.pathname === "/token") {
        const form = new URLSearchParams(await req.text());
        const basic = req.headers.get("authorization");
        const okBasic =
          basic === `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`;
        const okPost =
          form.get("client_id") === clientId && form.get("client_secret") === clientSecret;
        const entry = codes.get(form.get("code") ?? "");
        if (!entry || !(okBasic || okPost))
          return Response.json({ error: "invalid_grant" }, { status: 400 });
        const now = Math.floor(Date.now() / 1000);
        return Response.json({
          access_token: randomUUID(),
          token_type: "Bearer",
          expires_in: 3600,
          id_token: sign({
            iss: origin,
            aud: clientId,
            sub: `sub-${entry.email}`,
            email: entry.email,
            email_verified: true,
            name: "Sso Person",
            nonce: entry.nonce,
            iat: now,
            exp: now + 600,
          }),
        });
      }
      return new Response("not found", { status: 404 });
    },
  });
  return {
    origin: `http://127.0.0.1:${server.port}`,
    signInAs: (email: string) => (nextEmail = email),
    stop: () => server.stop(true),
  };
}

run("single sign-on (postgres)", () => {
  process.env.BETTER_AUTH_SECRET ??= "integration-test-secret-integration-test-secret";
  const clientId = "upzy-client";
  const clientSecret = "s3cret-value";
  const idp = mockProvider(clientId, clientSecret);
  // The test provider is on loopback, which production refuses unless the operator lists it.
  process.env.SSO_TRUSTED_ORIGINS = idp.origin;
  const db = createDb(url);
  const { users, organizations, ssoProviders, organizationSecurity } = schema;
  const auth = createAuth(db, {
    sendEmail: async () => {},
    signup: { mode: "open", allowedEmails: [], allowedDomains: [] },
  });
  const tag = `sso${Date.now()}`;
  const domain = `${tag}.example.com`;
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
        redirect: "manual",
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
  const PASSWORD = "supersecret123";
  type Person = { cookie: string; id: string; email: string };
  const person = async (name: string): Promise<Person> => {
    const email = `${tag}-${name}@example.com`;
    const r = await send("/api/auth/sign-up/email", {
      method: "POST",
      body: JSON.stringify({ email, password: PASSWORD, name }),
    });
    return { cookie: cookieOf(r), id: (await json(r)).user.id as string, email };
  };
  const call = (who: Person, method: string, path: string, body?: unknown) =>
    send(path, {
      method,
      cookie: who.cookie,
      ...(body ? { body: JSON.stringify(body) } : {}),
    });

  let orgId = "";
  let owner: Person, member: Person;
  beforeAll(async () => {
    owner = await person("owner");
    member = await person("member");
    const org = await json(
      await call(owner, "POST", "/api/auth/organization/create", {
        name: `${tag} org`,
        slug: `${tag}-org`,
      }),
    );
    orgId = org.id;
    await call(owner, "POST", "/api/auth/organization/set-active", { organizationId: orgId });
    await auth.api.addMember({
      body: { userId: member.id, role: "member", organizationId: orgId },
    });
    await call(member, "POST", "/api/auth/organization/set-active", { organizationId: orgId });
  });
  afterAll(async () => {
    idp.stop();
    await db.delete(organizations).where(inArray(organizations.id, [orgId]));
    await db.delete(users).where(like(users.email, `${tag}-%`));
    await db.delete(users).where(like(users.email, `%@${domain}`));
  });

  const setup = { issuer: idp.origin, domain, clientId, clientSecret };

  test("only an admin can set it up", async () => {
    expect((await call(member, "GET", "/sso")).status).toBe(403);
    expect((await call(member, "POST", "/sso", setup)).status).toBe(403);
  });

  test("the provider's own routes for registering and editing are not open over HTTP", async () => {
    const r = await call(owner, "POST", "/api/auth/sso/register", {
      providerId: "x",
      issuer: idp.origin,
      domain,
    });
    expect(r.status).toBe(404);
  });

  test("an address that isn't public is refused, and so is one that isn't https", async () => {
    for (const issuer of ["https://127.0.0.1", "http://example.com", "https://localhost"]) {
      const r = await call(owner, "POST", "/sso", { ...setup, issuer });
      expect(r.status).toBe(400);
    }
  });

  test("setting it up returns the DNS record to add, and never the secret", async () => {
    const r = await call(owner, "POST", "/sso", setup);
    expect(r.status).toBe(200);
    const body = await json(r);
    expect(JSON.stringify(body)).not.toContain(clientSecret);
    expect(body.provider).toMatchObject({ domain, domainVerified: false, clientId });
    expect(body.provider.redirectUri).toContain("/api/auth/sso/callback/sso-");
    expect(body.verification).toMatchObject({ type: "TXT" });
    expect(body.verification.name).toBe(`_better-auth-token-${body.provider.providerId}.${domain}`);
    expect(body.verification.value.length).toBeGreaterThan(10);

    const again = await json(await call(owner, "GET", "/sso"));
    expect(again.verification.value).toBe(body.verification.value);
    expect(JSON.stringify(again)).not.toContain(clientSecret);
  });

  test("only one provider per organization", async () => {
    expect((await call(owner, "POST", "/sso", setup)).status).toBe(409);
  });

  test("until the domain is proven, nobody signs in through it", async () => {
    const fail = await call(owner, "POST", "/sso/verify");
    expect(fail.status).toBe(400); // no DNS record exists
    const r = await send("/api/auth/sign-in/sso", {
      method: "POST",
      body: JSON.stringify({ email: `someone@${domain}`, callbackURL: `${origin}/` }),
    });
    expect(r.status).toBeGreaterThanOrEqual(400);
  });

  test("with the domain proven, signing in creates the person and adds them to the organization", async () => {
    await db
      .update(ssoProviders)
      .set({ domainVerified: true })
      .where(eq(ssoProviders.organizationId, orgId));
    const email = `newhire@${domain}`;
    idp.signInAs(email);

    const start = await send("/api/auth/sign-in/sso", {
      method: "POST",
      body: JSON.stringify({ email, callbackURL: `${origin}/dashboard` }),
    });
    expect(start.status).toBe(200);
    const { url: authorizeUrl } = await json(start);
    let jar = cookieOf(start);

    const authorize = await fetch(authorizeUrl, { redirect: "manual" });
    expect(authorize.status).toBe(302);
    const callback = new URL(authorize.headers.get("location")!);
    const done = await send(`${callback.pathname}${callback.search}`, { cookie: jar });
    expect(done.status).toBe(302);
    expect(done.headers.get("location")).toBe(`${origin}/dashboard`);
    jar = cookieOf(done);

    const session = await json(await send("/api/auth/get-session", { cookie: jar }));
    expect(session.user.email).toBe(email);

    const [user] = await db.select().from(users).where(eq(users.email, email));
    const memberRows = await db
      .select()
      .from(schema.members)
      .where(eq(schema.members.userId, user!.id));
    expect(memberRows.map((m) => [m.organizationId, m.role])).toEqual([[orgId, "member"]]);
  });

  test("someone from another domain can't use this provider", async () => {
    idp.signInAs(`outsider@elsewhere-${tag}.com`);
    const r = await send("/api/auth/sign-in/sso", {
      method: "POST",
      body: JSON.stringify({
        email: `outsider@elsewhere-${tag}.com`,
        callbackURL: `${origin}/`,
      }),
    });
    expect(r.status).toBeGreaterThanOrEqual(400);
  });

  test("when the organization requires two-factor, single sign-in people are not asked for Upzy's", async () => {
    await db.insert(organizationSecurity).values({ organizationId: orgId, requireTwoFactor: true });
    const email = `second@${domain}`;
    idp.signInAs(email);
    const start = await send("/api/auth/sign-in/sso", {
      method: "POST",
      body: JSON.stringify({ email, callbackURL: `${origin}/` }),
    });
    const authorize = await fetch((await json(start)).url, { redirect: "manual" });
    const cb = new URL(authorize.headers.get("location")!);
    const done = await send(`${cb.pathname}${cb.search}`, { cookie: cookieOf(start) });
    const sso: Person = { cookie: cookieOf(done), id: "", email };
    await call(sso, "POST", "/api/auth/organization/set-active", { organizationId: orgId });

    const status = await json(await call(sso, "GET", "/security"));
    expect(status).toMatchObject({ organizationRequires: true, blocked: false });
    expect((await call(sso, "GET", "/workspace")).status).toBe(200);

    // A member who signs in with a password is still held to the rule.
    const pw = await json(await call(member, "GET", "/security"));
    expect(pw).toMatchObject({ organizationRequires: true, blocked: true });
    // The owner has no second factor either, and the rule applies to them: they are held out until it is lifted.
    expect((await call(owner, "DELETE", "/sso")).status).toBe(403);
    await db.delete(organizationSecurity).where(eq(organizationSecurity.organizationId, orgId));
  });

  test("removing it removes the provider", async () => {
    expect((await call(owner, "DELETE", "/sso")).status).toBe(200);
    expect((await json(await call(owner, "GET", "/sso"))).provider).toBeNull();
    expect(
      await db.select().from(ssoProviders).where(eq(ssoProviders.organizationId, orgId)),
    ).toHaveLength(0);
  });
});
