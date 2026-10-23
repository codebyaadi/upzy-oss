import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { createAuth } from "@upzy/auth/server";
import { decryptJson } from "@upzy/crypto";
import { createDb, schema } from "@upzy/db";
import { eq, inArray, like } from "drizzle-orm";

import { createApp } from "../src/app";

// Real Postgres + real better-auth. Needs: DATABASE_URL=... bun test
const url = process.env.DATABASE_URL;
const run = url ? describe : describe.skip;

run("integration channels (postgres)", () => {
  process.env.BETTER_AUTH_SECRET ??= "integration-test-secret-integration-test-secret";
  const db = createDb(url);
  const { users, organizations, workspaces, notificationChannels } = schema;
  const KEY = Buffer.alloc(32, 4).toString("base64");
  const auth = createAuth(db, {
    sendEmail: async () => {},
    signup: { mode: "open", allowedEmails: [], allowedDomains: [] },
  });
  const tag = `ci${Date.now()}`;
  const origin = "http://localhost:3001";
  const app = createApp({
    db,
    auth,
    webOrigin: origin,
    encryptionKey: KEY,
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
  type Person = { cookie: string; id: string };
  const person = async (name: string): Promise<Person> => {
    const r = await send("/api/auth/sign-up/email", {
      method: "POST",
      body: JSON.stringify({
        email: `${tag}-${name}@example.com`,
        password: "supersecret123",
        name,
      }),
    });
    return { cookie: cookieOf(r), id: (await json(r)).user.id as string };
  };
  const orgIds: string[] = [];
  const makeOrg = async (who: Person, slug: string) => {
    const org = await json(
      await send("/api/auth/organization/create", {
        method: "POST",
        cookie: who.cookie,
        body: JSON.stringify({ name: `${tag} ${slug}`, slug: `${tag}-${slug}` }),
      }),
    );
    orgIds.push(org.id);
    await send("/api/auth/organization/set-active", {
      method: "POST",
      cookie: who.cookie,
      body: JSON.stringify({ organizationId: org.id }),
    });
    const ws = (
      await db
        .insert(workspaces)
        .values({ orgId: org.id, name: "w" })
        .returning({ id: workspaces.id })
    )[0]!.id;
    return { orgId: org.id as string, ws };
  };
  const call = (who: Person | null, method: string, path: string, body?: unknown) =>
    send(path, {
      method,
      ...(who ? { cookie: who.cookie } : {}),
      ...(body ? { body: JSON.stringify(body) } : {}),
    });

  let owner: Person, member: Person, other: Person;
  let A = { orgId: "", ws: "" };

  beforeAll(async () => {
    owner = await person("owner");
    member = await person("member");
    other = await person("other");
    A = await makeOrg(owner, "a");
    await makeOrg(other, "b");
    await auth.api.addMember({
      body: { userId: member.id, role: "member", organizationId: A.orgId },
    });
    await send("/api/auth/organization/set-active", {
      method: "POST",
      cookie: member.cookie,
      body: JSON.stringify({ organizationId: A.orgId }),
    });
  });
  afterAll(async () => {
    await db.delete(organizations).where(inArray(organizations.id, orgIds));
    await db.delete(users).where(like(users.email, `${tag}-%`));
  });

  const KINDS = {
    teams: {
      body: { url: "https://contoso.webhook.office.com/webhookb2/abc" },
      stored: { url: "https://contoso.webhook.office.com/webhookb2/abc" },
      secret: "webhookb2/abc",
      summary: "contoso.webhook.office.com",
    },
    pagerduty: {
      body: { routingKey: "R0UT1NGK3Y0123456789abcdefghijkl" },
      stored: { routingKey: "R0UT1NGK3Y0123456789abcdefghijkl" },
      secret: "R0UT1NGK3Y0123456789abcdefghijkl",
      summary: "Events API v2, key ending ijkl",
    },
    opsgenie: {
      body: { apiKey: "abcdef12-3456-7890-abcd-ef1234567890", region: "eu" },
      stored: { apiKey: "abcdef12-3456-7890-abcd-ef1234567890", region: "eu" },
      secret: "abcdef12-3456-7890-abcd-ef1234567890",
      summary: "EU region, key ending 7890",
    },
    github: {
      body: { repo: "acme/web", token: "github_pat_11ABCDEFG0123456789abcdefghijklmnop" },
      stored: { repo: "acme/web", token: "github_pat_11ABCDEFG0123456789abcdefghijklmnop" },
      secret: "github_pat_11ABCDEFG0123456789abcdefghijklmnop",
      summary: "acme/web",
    },
  } as const;

  for (const [kind, spec] of Object.entries(KINDS)) {
    test(`${kind}: an admin can add it; the secret is stored encrypted and never returned`, async () => {
      const r = await call(owner, "POST", "/channel", {
        workspaceId: A.ws,
        name: `${kind} channel`,
        kind,
        ...spec.body,
      });
      expect(r.status).toBe(201);
      const created = await json(r);
      expect(created).toMatchObject({ kind, summary: spec.summary, enabled: true });
      const text = JSON.stringify(created);
      expect(text).not.toContain(spec.secret);

      const [row] = await db
        .select()
        .from(notificationChannels)
        .where(eq(notificationChannels.id, created.id));
      expect(row!.configEncrypted).not.toContain(spec.secret);
      expect(decryptJson(row!.configEncrypted, KEY)).toEqual(spec.stored);

      const list = await json(await call(owner, "GET", `/channel?workspaceId=${A.ws}`));
      const listed = list.find((c: any) => c.id === created.id);
      expect(listed.kind).toBe(kind);
      expect(JSON.stringify(list)).not.toContain(spec.secret);
    });
  }

  test("members can see channels but can't add them, and another organization sees none of them", async () => {
    const body = { workspaceId: A.ws, name: "x", kind: "pagerduty", routingKey: "a".repeat(32) };
    expect((await call(member, "POST", "/channel", body)).status).toBe(403);
    expect((await call(member, "GET", `/channel?workspaceId=${A.ws}`)).status).toBe(200);
    expect((await call(other, "POST", "/channel", body)).status).toBe(404);
    expect(await json(await call(other, "GET", "/channel"))).toEqual([]);
  });

  test("bad values are refused before anything is stored", async () => {
    const before = (
      await db.select().from(notificationChannels).where(eq(notificationChannels.workspaceId, A.ws))
    ).length;
    for (const bad of [
      { kind: "teams", url: "https://evil.example.com/x" },
      { kind: "teams", url: "http://contoso.webhook.office.com/x" },
      { kind: "pagerduty", routingKey: "short" },
      { kind: "opsgenie", apiKey: "abcdef12-3456-7890-abcd-ef1234567890", region: "mars" },
      {
        kind: "github",
        repo: "not-a-repo",
        token: "github_pat_11ABCDEFG0123456789abcdefghijklmnop",
      },
      { kind: "github", repo: "acme/web", token: "bad" },
    ]) {
      const r = await call(owner, "POST", "/channel", { workspaceId: A.ws, name: "bad", ...bad });
      expect(r.status, JSON.stringify(bad)).toBeGreaterThanOrEqual(400);
      expect(r.status).toBeLessThan(500);
    }
    const after = (
      await db.select().from(notificationChannels).where(eq(notificationChannels.workspaceId, A.ws))
    ).length;
    expect(after).toBe(before);
  });
});
