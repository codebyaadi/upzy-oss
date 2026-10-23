import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";

import { createAuth } from "@upzy/auth/server";
import { createDb, schema } from "@upzy/db";
import { inArray, like } from "drizzle-orm";

import { createApp } from "../src/app";

// Real Postgres + real better-auth. Needs: DATABASE_URL=... bun test
const url = process.env.DATABASE_URL;
const run = url ? describe : describe.skip;

const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
/** RFC 6238 with the defaults better-auth uses: SHA-1, 6 digits, 30 second steps. */
function totp(secretBase32: string, at = Date.now()): string {
  let bits = "";
  for (const c of secretBase32.replace(/=+$/, "").toUpperCase())
    bits += B32.indexOf(c).toString(2).padStart(5, "0");
  const key = Buffer.from(bits.match(/.{8}/g)!.map((b) => parseInt(b, 2)));
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(at / 1000 / 30)));
  const h = createHmac("sha1", key).update(counter).digest();
  const o = h[h.length - 1]! & 0xf;
  const n = ((h[o]! & 0x7f) << 24) | (h[o + 1]! << 16) | (h[o + 2]! << 8) | h[o + 3]!;
  return String(n % 1_000_000).padStart(6, "0");
}

run("organization two-factor policy (postgres)", () => {
  process.env.BETTER_AUTH_SECRET ??= "integration-test-secret-integration-test-secret";
  const db = createDb(url);
  const { users, organizations } = schema;
  const auth = createAuth(db, {
    sendEmail: async () => {},
    signup: { mode: "open", allowedEmails: [], allowedDomains: [] },
  });
  const tag = `tf${Date.now()}`;
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
  /** Sets up an authenticator app the way the settings page does, and returns the secret. */
  const enroll = async (who: Person) => {
    const enabled = await json(
      await call(who, "POST", "/api/auth/two-factor/enable", { password: PASSWORD }),
    );
    const secret = new URL(enabled.totpURI).searchParams.get("secret")!;
    // Enabling alone changes nothing: the first correct code turns it on.
    const status = await json(await call(who, "GET", "/security"));
    expect(status.twoFactorEnabled).toBe(false);
    const verified = await call(who, "POST", "/api/auth/two-factor/verify-totp", {
      code: totp(secret),
    });
    expect(verified.status).toBe(200);
    // Verifying issues a fresh session cookie.
    const fresh = cookieOf(verified);
    if (fresh) who.cookie = fresh;
    return { secret, backupCodes: enabled.backupCodes as string[] };
  };

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
    await db.delete(organizations).where(inArray(organizations.id, [orgId]));
    await db.delete(users).where(like(users.email, `${tag}-%`));
  });

  test("with no rule, nobody is asked for anything", async () => {
    expect((await call(member, "GET", "/workspace")).status).toBe(200);
    const status = await json(await call(member, "GET", "/security"));
    expect(status).toEqual({
      twoFactorEnabled: false,
      organizationRequires: false,
      blocked: false,
    });
  });

  test("only admins can read or change the rule", async () => {
    expect((await call(member, "GET", "/security/policy")).status).toBe(403);
    expect((await call(member, "PUT", "/security/policy", { requireTwoFactor: true })).status).toBe(
      403,
    );
  });

  test("an admin who hasn't set up two-factor can't require it, so they can't lock themselves out", async () => {
    const r = await call(owner, "PUT", "/security/policy", { requireTwoFactor: true });
    expect(r.status).toBe(400);
    expect((await json(r)).message).toContain("your own account");
    expect((await json(await call(owner, "GET", "/security/policy"))).requireTwoFactor).toBe(false);
  });

  test("the policy lists who is missing, and enforcing it blocks them but not an enrolled admin", async () => {
    await enroll(owner);
    const policy = await json(await call(owner, "GET", "/security/policy"));
    expect(policy.withoutTwoFactor.map((m: any) => m.email)).toEqual([member.email]);

    expect((await call(owner, "PUT", "/security/policy", { requireTwoFactor: true })).status).toBe(
      200,
    );

    // The enrolled owner carries on.
    expect((await call(owner, "GET", "/workspace")).status).toBe(200);

    // The member is stopped at every organization route, with a code the app can act on.
    const blocked = await call(member, "GET", "/workspace");
    expect(blocked.status).toBe(403);
    expect(await json(blocked)).toMatchObject({ code: "two_factor_required" });

    // But can still see why, and reach setup.
    expect(await json(await call(member, "GET", "/security"))).toEqual({
      twoFactorEnabled: false,
      organizationRequires: true,
      blocked: true,
    });
  });

  test("the rule also covers the member-management calls better-auth handles itself", async () => {
    // Make the member an admin so only the missing two-factor stands in the way.
    await auth.api.updateMemberRole({
      body: {
        memberId: (await db.query.members.findFirst({
          where: (m, { eq, and }) => and(eq(m.userId, member.id), eq(m.organizationId, orgId)),
        }))!.id,
        role: "admin",
        organizationId: orgId,
      },
      headers: new Headers({ cookie: owner.cookie }),
    });
    const r = await call(member, "POST", "/api/auth/organization/invite-member", {
      email: `${tag}-new@example.com`,
      role: "member",
      organizationId: orgId,
    });
    expect(r.status).toBe(403);
    expect((await json(r)).message).toContain("two-factor");
  });

  test("setting up two-factor lifts the block", async () => {
    await enroll(member);
    expect((await call(member, "GET", "/workspace")).status).toBe(200);
    expect(await json(await call(member, "GET", "/security"))).toEqual({
      twoFactorEnabled: true,
      organizationRequires: true,
      blocked: false,
    });
    expect((await json(await call(owner, "GET", "/security/policy"))).withoutTwoFactor).toEqual([]);
  });

  test("signing in with two-factor on asks for a code, and a wrong one is refused", async () => {
    const r = await send("/api/auth/sign-in/email", {
      method: "POST",
      body: JSON.stringify({ email: owner.email, password: PASSWORD }),
    });
    const body = await json(r);
    expect(body.twoFactorRedirect).toBe(true);
    expect(body.user).toBeUndefined();
    const pending = cookieOf(r);
    const wrong = await send("/api/auth/two-factor/verify-totp", {
      method: "POST",
      cookie: pending,
      body: JSON.stringify({ code: "000000" }),
    });
    expect(wrong.status).toBeGreaterThanOrEqual(400);
    // The half-signed-in cookie doesn't open anything.
    expect((await call({ ...owner, cookie: pending }, "GET", "/workspace")).status).toBe(401);
  });

  test("an admin can switch the rule off again", async () => {
    expect((await call(owner, "PUT", "/security/policy", { requireTwoFactor: false })).status).toBe(
      200,
    );
    expect((await json(await call(owner, "GET", "/security/policy"))).requireTwoFactor).toBe(false);
  });
});
