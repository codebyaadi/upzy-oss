import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { createAuth } from "@upzy/auth/server";
import { createDb, schema } from "@upzy/db";
import { like } from "drizzle-orm";

import { createApp } from "../src/app";

// Real Postgres + real better-auth. Needs: DATABASE_URL=... bun test
const url = process.env.DATABASE_URL;
const run = url ? describe : describe.skip;

run("sign-up lock (postgres)", () => {
  process.env.BETTER_AUTH_SECRET ??= "integration-test-secret-integration-test-secret";
  const db = createDb(url);
  const tag = `su${Date.now()}`;
  const origin = "http://localhost:3001";
  const appFor = (policy: {
    mode: "open" | "invite" | "closed";
    allowedEmails?: string[];
    allowedDomains?: string[];
  }) =>
    createApp({
      db,
      auth: createAuth(db, {
        sendEmail: async () => {},
        signup: { allowedEmails: [], allowedDomains: [], ...policy },
      }),
      webOrigin: origin,
      encryptionKey: Buffer.alloc(32, 5).toString("base64"),
      rateLimit: { rules: [{ match: () => true, bucket: "t", max: Infinity, windowMs: 1 }] },
    });
  const signUp = async (app: ReturnType<typeof appFor>, email: string) => {
    const r = await app.handle(
      new Request("http://localhost/api/auth/sign-up/email", {
        method: "POST",
        headers: { "content-type": "application/json", origin },
        body: JSON.stringify({ email, password: "supersecret123", name: "T" }),
      }),
    );
    return { status: r.status, body: (await r.json()) as any };
  };

  // The very first account on an empty database is always allowed, so make sure this isn't one (CI starts empty).
  beforeAll(async () => {
    const seeded = await signUp(appFor({ mode: "open" }), `${tag}-seed@example.com`);
    expect(seeded.status).toBe(200);
  });

  afterAll(async () => {
    await db.delete(schema.users).where(like(schema.users.email, `${tag}-%`));
  });

  test("invite mode refuses a stranger with a clear message and creates nothing", async () => {
    const app = appFor({ mode: "invite" });
    const r = await signUp(app, `${tag}-stranger@example.com`);
    expect(r.status).toBe(403);
    expect(r.body.message).toContain("invitation");
    const rows = await db
      .select()
      .from(schema.users)
      .where(like(schema.users.email, `${tag}-stranger%`));
    expect(rows).toHaveLength(0);
  });

  test("allow-listed emails and domains get in", async () => {
    const app = appFor({
      mode: "invite",
      allowedEmails: [`${tag}-boss@example.com`],
      allowedDomains: [`${tag}.test`],
    });
    expect((await signUp(app, `${tag}-Boss@example.com`)).status).toBe(200);
    expect((await signUp(app, `${tag}-x@${tag}.test`)).status).toBe(200);
  });

  test("someone with a pending invitation can create the account; an expired one can't", async () => {
    const app = appFor({ mode: "invite" });
    const inviter = await signUp(appFor({ mode: "open" }), `${tag}-inviter@example.com`);
    const [org] = await db
      .insert(schema.organizations)
      .values({ id: `${tag}-org`, name: "Inv", slug: `${tag}-org`, createdAt: new Date() })
      .returning({ id: schema.organizations.id });
    const base = {
      organizationId: org!.id,
      inviterId: inviter.body.user.id,
      status: "pending",
      role: "member",
    };
    await db.insert(schema.invitations).values([
      {
        id: `${tag}-i1`,
        email: `${tag}-invited@example.com`,
        expiresAt: new Date(Date.now() + 86_400_000),
        ...base,
      },
      {
        id: `${tag}-i2`,
        email: `${tag}-late@example.com`,
        expiresAt: new Date(Date.now() - 1000),
        ...base,
      },
    ]);
    expect((await signUp(app, `${tag}-invited@example.com`)).status).toBe(200);
    expect((await signUp(app, `${tag}-late@example.com`)).status).toBe(403);
    await db.delete(schema.organizations).where(like(schema.organizations.slug, `${tag}-%`));
  });

  test("closed refuses everyone once accounts exist", async () => {
    const r = await signUp(
      appFor({ mode: "closed", allowedEmails: [`${tag}-nope@example.com`] }),
      `${tag}-nope@example.com`,
    );
    expect(r.status).toBe(403);
    expect(r.body.message).toContain("closed");
  });
});
