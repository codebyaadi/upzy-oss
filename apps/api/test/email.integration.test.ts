import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { createAuth } from "@upzy/auth/server";
import { createDb, schema } from "@upzy/db";
import { eq, like, sql } from "drizzle-orm";

import { createApp } from "../src/app";

// Real Postgres + real better-auth. Needs: DATABASE_URL=... bun test
const url = process.env.DATABASE_URL;
const run = url ? describe : describe.skip;

run("email check (postgres)", () => {
  process.env.BETTER_AUTH_SECRET ??= "integration-test-secret-integration-test-secret";
  const db = createDb(url);
  const auth = createAuth(db, {
    sendEmail: async () => {},
    signup: { mode: "open", allowedEmails: [], allowedDomains: [] },
  });
  const tag = `em${Date.now()}`;
  const origin = "http://localhost:3001";
  const app = createApp({
    db,
    auth,
    webOrigin: origin,
    encryptionKey: Buffer.alloc(32, 3).toString("base64"),
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
    return {
      cookie: cookieOf(r),
      id: (await json(r)).user.id as string,
      email: `${tag}-${name}@example.com`,
    };
  };
  let owner: Awaited<ReturnType<typeof person>>, member: typeof owner, other: typeof owner;
  const saved = { smtp: process.env.SMTP_URL, from: process.env.MAIL_FROM };

  beforeAll(async () => {
    owner = await person("owner");
    member = await person("member");
    other = await person("other");
    const org = await json(
      await send("/api/auth/organization/create", {
        method: "POST",
        cookie: owner.cookie,
        body: JSON.stringify({ name: "E", slug: `${tag}-org` }),
      }),
    );
    await send("/api/auth/organization/set-active", {
      method: "POST",
      cookie: owner.cookie,
      body: JSON.stringify({ organizationId: org.id }),
    });
    await auth.api.addMember({
      body: { userId: member.id, role: "member", organizationId: org.id },
    });
    await send("/api/auth/organization/set-active", {
      method: "POST",
      cookie: member.cookie,
      body: JSON.stringify({ organizationId: org.id }),
    });
    const org2 = await json(
      await send("/api/auth/organization/create", {
        method: "POST",
        cookie: other.cookie,
        body: JSON.stringify({ name: "O", slug: `${tag}-org2` }),
      }),
    );
    await send("/api/auth/organization/set-active", {
      method: "POST",
      cookie: other.cookie,
      body: JSON.stringify({ organizationId: org2.id }),
    });
  });
  afterAll(async () => {
    if (saved.smtp === undefined) delete process.env.SMTP_URL;
    else process.env.SMTP_URL = saved.smtp;
    if (saved.from === undefined) delete process.env.MAIL_FROM;
    else process.env.MAIL_FROM = saved.from;
    await db.delete(schema.organizations).where(like(schema.organizations.slug, `${tag}-%`));
    await db.delete(schema.users).where(like(schema.users.email, `${tag}-%`));
    await db.delete(schema.jobs).where(sql`${schema.jobs.payload}->>'to' like ${`${tag}-%`}`);
  });

  test("only admins can look at or test the email setup", async () => {
    expect((await send("/email/status", { cookie: member.cookie })).status).toBe(403);
    expect((await send("/email/test", { method: "POST", cookie: member.cookie })).status).toBe(403);
    expect((await send("/email/status")).status).toBe(401);
  });

  test("without SMTP_URL it says so and refuses to queue a test", async () => {
    delete process.env.SMTP_URL;
    expect(await json(await send("/email/status", { cookie: owner.cookie }))).toEqual({
      configured: false,
    });
    const r = await send("/email/test", { method: "POST", cookie: owner.cookie });
    expect(r.status).toBe(409);
    expect((await json(r)).message).toContain("SMTP_URL");
  });

  test("status shows where mail goes, never the credentials", async () => {
    process.env.SMTP_URL = "smtps://me%40gmail.com:s3cr3t-app-pass@smtp.gmail.com:465";
    process.env.MAIL_FROM = "Upzy <me@gmail.com>";
    const r = await send("/email/status", { cookie: owner.cookie });
    const raw = JSON.stringify(await json(r));
    expect(raw).toContain("smtp.gmail.com");
    expect(raw).not.toContain("s3cr3t");
    expect(raw).not.toContain("gmail.com:s3");
    expect(JSON.parse(raw)).toMatchObject({
      configured: true,
      host: "smtp.gmail.com",
      port: 465,
      secure: true,
      from: "Upzy <me@gmail.com>",
    });
  });

  test("a test email is queued once for the caller and its result can be followed", async () => {
    process.env.SMTP_URL = "smtp://localhost:1025";
    const r = await send("/email/test", { method: "POST", cookie: owner.cookie });
    expect(r.status).toBe(200);
    const { id, to } = await json(r);
    expect(to).toBe(owner.email);
    const [job] = await db.select().from(schema.jobs).where(eq(schema.jobs.id, id));
    expect(job).toMatchObject({
      queue: "email",
      maxAttempts: 1,
      payload: { to: owner.email, subject: "Upzy test email" },
    });

    const poll = async (who = owner) =>
      json(await send(`/email/test/${id}`, { cookie: who.cookie }));
    expect(await poll()).toEqual({ state: "sending", error: null });
    await db.update(schema.jobs).set({ state: "done" }).where(eq(schema.jobs.id, id));
    expect(await poll()).toEqual({ state: "sent", error: null });
    // Someone else's test (or an unrelated job) can't be read.
    expect((await send(`/email/test/${id}`, { cookie: other.cookie })).status).toBe(404);
  });

  test("a failure shows the reason, with anything secret-looking removed", async () => {
    process.env.SMTP_URL = "smtp://localhost:1025";
    const { id } = await json(await send("/email/test", { method: "POST", cookie: owner.cookie }));
    await db
      .update(schema.jobs)
      .set({
        state: "failed",
        lastError:
          "Invalid login: 535 Username and Password not accepted. Authorization: Bearer abcdefghijklmnop12345",
      })
      .where(eq(schema.jobs.id, id));
    const res = await json(await send(`/email/test/${id}`, { cookie: owner.cookie }));
    expect(res.state).toBe("failed");
    expect(res.error).toContain("not accepted");
    expect(res.error).not.toContain("abcdefghijklmnop12345");
  });
});
