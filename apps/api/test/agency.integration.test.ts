import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { createAuth } from "@upzy/auth/server";
import { loadBillingConfig, type DodoClient } from "@upzy/billing";
import { createDb, schema } from "@upzy/db";
import { eq, inArray, like } from "drizzle-orm";

import { createApp } from "../src/app";
import { forgetAllStatusPages } from "../src/lib/status-cache";

// Real Postgres + real better-auth. Needs: DATABASE_URL=... bun test
const url = process.env.DATABASE_URL;
const run = url ? describe : describe.skip;

run("agency: overview and status page logos (postgres)", () => {
  process.env.BETTER_AUTH_SECRET ??= "integration-test-secret-integration-test-secret";
  const db = createDb(url);
  const { users, organizations, workspaces, monitors, incidents, findings, assets, statusPages } =
    schema;
  const auth = createAuth(db, {
    sendEmail: async () => {},
    signup: { mode: "open", allowedEmails: [], allowedDomains: [] },
  });
  const tag = `ag${Date.now()}`;
  const origin = "http://localhost:3001";
  const dodo: DodoClient = {
    createCheckout: async () => ({ url: "https://pay.example/1", sessionId: "s" }),
    createPortal: async () => ({ url: "https://portal.example/1" }),
    cancelSubscription: async () => {},
  };
  const billingConfig = loadBillingConfig({
    DODO_API_KEY: "sk_test",
    DODO_WEBHOOK_SECRET: "whsec_x",
  });
  const make = (billing: object) =>
    createApp({
      db,
      auth,
      webOrigin: origin,
      encryptionKey: Buffer.alloc(32, 4).toString("base64"),
      rateLimit: { rules: [{ match: () => true, bucket: "t", max: Infinity, windowMs: 1 }] },
      billing: billing as never,
    });
  const off = make({ config: loadBillingConfig({}) });
  const on = make({ config: billingConfig, dodo });

  const send = (app: typeof off, path: string, init: RequestInit & { cookie?: string } = {}) =>
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
    const r = await send(off, "/api/auth/sign-up/email", {
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
      await send(off, "/api/auth/organization/create", {
        method: "POST",
        cookie: who.cookie,
        body: JSON.stringify({ name: `${tag} ${slug}`, slug: `${tag}-${slug}` }),
      }),
    );
    orgIds.push(org.id);
    await send(off, "/api/auth/organization/set-active", {
      method: "POST",
      cookie: who.cookie,
      body: JSON.stringify({ organizationId: org.id }),
    });
    return org.id as string;
  };
  const space = async (orgId: string, name: string) =>
    (await db.insert(workspaces).values({ orgId, name }).returning({ id: workspaces.id }))[0]!.id;
  const call = (
    app: typeof off,
    who: Person | null,
    method: string,
    path: string,
    body?: unknown,
  ) =>
    send(app, path, {
      method,
      ...(who ? { cookie: who.cookie } : {}),
      ...(body ? { body: JSON.stringify(body) } : {}),
    });

  afterAll(async () => {
    await db.delete(organizations).where(inArray(organizations.id, orgIds));
    await db.delete(users).where(like(users.email, `${tag}-%`));
  });

  describe("overview", () => {
    let boss: Person, stranger: Person;
    let acme = "",
      globex = "",
      foreign = "";
    beforeAll(async () => {
      boss = await person("boss");
      stranger = await person("stranger");
      const org = await makeOrg(boss, "agency");
      const theirs = await makeOrg(stranger, "other");
      acme = await space(org, "Acme");
      globex = await space(org, "Globex");
      await space(org, "Initech");
      foreign = await space(theirs, "Not yours");

      const mon = (workspaceId: string, name: string, over: object = {}) =>
        db.insert(monitors).values({
          workspaceId,
          name,
          type: "http",
          target: `https://${name}.example.com`,
          interval: 60,
          active: true,
          ...over,
        });
      await mon(acme, "a1", { lastStatus: "up" });
      await mon(acme, "a2", { lastStatus: "up" });
      await mon(acme, "a3", { lastStatus: "down" });
      await mon(acme, "a4", { lastStatus: "degraded" });
      await mon(acme, "a5", { lastStatus: "up", active: false });
      await mon(globex, "g1", { lastStatus: "unknown" });
      await mon(foreign, "f1", { lastStatus: "down" });

      const [down] = await db.select().from(monitors).where(eq(monitors.name, "a3"));
      await db.insert(incidents).values([
        {
          workspaceId: acme,
          monitorId: down!.id,
          type: "uptime",
          status: "open",
          title: "a3 down",
        },
        {
          workspaceId: acme,
          monitorId: down!.id,
          type: "uptime",
          status: "resolved",
          resolvedAt: new Date(),
          title: "old",
        },
      ] as never);

      const asset = async (workspaceId: string, value: string) =>
        (
          await db
            .insert(assets)
            .values({
              workspaceId,
              kind: "domain",
              value,
              verificationToken: "t",
              lastScanAt: new Date(),
            })
            .returning({ id: assets.id })
        )[0]!.id;
      const good = await asset(acme, "good.example.com");
      const bad = await asset(acme, "bad.example.com");
      const finding = (assetId: string, severity: string, n: number) =>
        db.insert(findings).values({
          workspaceId: acme,
          assetId,
          checkKey: `headers.k${n}`,
          fingerprint: `${tag}-${assetId}-${n}`,
          severity: severity as never,
          riskScore: 10,
          title: "t",
          description: "d",
        });
      await finding(bad, "critical", 1);
      await finding(bad, "high", 2);
      await finding(bad, "high", 3);
      await finding(bad, "low", 4);
      void good;

      await db.insert(statusPages).values([
        { workspaceId: acme, slug: `${tag}-acme`, title: "Acme status", published: true },
        { workspaceId: globex, slug: `${tag}-draft`, title: "Draft", published: false },
      ]);
    });

    test("needs a session", async () => {
      expect((await call(off, null, "GET", "/overview")).status).toBe(401);
    });

    test("lists every client with its monitors, incidents, findings, grade and status page", async () => {
      const rows = await json(await call(off, boss, "GET", "/overview"));
      expect(rows.map((r: any) => r.name)).toEqual(["Acme", "Globex", "Initech"]);
      const a = rows.find((r: any) => r.name === "Acme");
      expect(a.monitors).toEqual({ total: 5, up: 2, down: 1, degraded: 1, unknown: 0, paused: 1 });
      expect(a.openIncidents).toBe(1);
      expect(a.openFindings).toEqual({ critical: 1, high: 2 });
      expect(["D", "F"]).toContain(a.grade);
      expect(a.statusPage).toEqual({ slug: `${tag}-acme`, title: "Acme status" });
    });

    test("a client with nothing yet is all zeros, and an unpublished page isn't offered", async () => {
      const rows = await json(await call(off, boss, "GET", "/overview"));
      const g = rows.find((r: any) => r.name === "Globex");
      expect(g.monitors).toEqual({ total: 1, up: 0, down: 0, degraded: 0, unknown: 1, paused: 0 });
      expect(g.grade).toBeNull();
      expect(g.statusPage).toBeNull();
      const e = rows.find((r: any) => r.name === "Initech");
      expect(e.monitors.total).toBe(0);
      expect(e.openIncidents).toBe(0);
      expect(e.openFindings).toEqual({ critical: 0, high: 0 });
    });

    test("never shows another organization's clients", async () => {
      const mine = await json(await call(off, boss, "GET", "/overview"));
      expect(mine.map((r: any) => r.id)).not.toContain(foreign);
      const theirs = await json(await call(off, stranger, "GET", "/overview"));
      expect(theirs.map((r: any) => r.name)).toEqual(["Not yours"]);
      expect(theirs[0].monitors.down).toBe(1);
      expect(JSON.stringify(theirs)).not.toContain("Acme");
    });
  });

  describe("custom logo on status pages", () => {
    let owner: Person,
      ws = "",
      org = "";
    let n = 0;
    const LOGO = "https://cdn.client.test/logo.png";
    const body = (over: Record<string, unknown> = {}) => ({
      workspaceId: ws,
      title: "Client status",
      slug: `${tag}-lg-${++n}`,
      published: true,
      components: [],
      ...over,
    });
    const publicPage = async (app: typeof off, slug: string) => {
      forgetAllStatusPages();
      return json(await send(app, `/public/status/${slug}`));
    };
    beforeAll(async () => {
      owner = await person("logoowner");
      org = await makeOrg(owner, "logo");
      ws = await space(org, "Client");
    });

    test("with billing off (self-hosted) anyone can set one, and it is shown", async () => {
      const r = await call(off, owner, "POST", "/status-page", body({ logoUrl: LOGO }));
      expect(r.status).toBe(201);
      const page = await json(r);
      expect(page.logoUrl).toBe(LOGO);
      expect((await publicPage(off, page.slug)).branding).toEqual({ logoUrl: LOGO });
    });

    test("a page without one has none", async () => {
      const page = await json(await call(off, owner, "POST", "/status-page", body()));
      expect(page.logoUrl).toBeNull();
      expect((await publicPage(off, page.slug)).branding).toEqual({ logoUrl: null });
    });

    test("there is no way to remove the Upzy credit: the setting does not exist", async () => {
      const r = await call(off, owner, "POST", "/status-page", body({ hideBranding: true }));
      expect(r.status).toBe(201);
      const page = await json(r);
      expect(page.hideBranding).toBeUndefined();
      const pub = await publicPage(off, page.slug);
      expect(Object.keys(pub.branding)).toEqual(["logoUrl"]);
    });

    test("on a plan without it (the Pro trial), setting one is a 402 that says what to buy", async () => {
      const a = await call(on, owner, "POST", "/status-page", body({ logoUrl: LOGO }));
      expect(a.status).toBe(402);
      expect((await json(a)).message).toContain("Agency");
      const ok = await call(on, owner, "POST", "/status-page", body());
      expect(ok.status).toBe(201);
      const page = await json(ok);
      expect(
        (await call(on, owner, "PATCH", `/status-page/${page.id}`, { logoUrl: LOGO })).status,
      ).toBe(402);
    });

    test("on the Agency plan it works; after a downgrade the logo goes, but the owner can still edit the page", async () => {
      await db
        .insert(schema.subscriptions)
        .values({ organizationId: org, plan: "agency", status: "active" })
        .onConflictDoUpdate({
          target: schema.subscriptions.organizationId,
          set: { plan: "agency", status: "active" },
        });
      const r = await call(on, owner, "POST", "/status-page", body({ logoUrl: LOGO }));
      expect(r.status).toBe(201);
      const page = await json(r);
      expect((await publicPage(on, page.slug)).branding).toEqual({ logoUrl: LOGO });

      // Cancelled with no trial left: back to Free.
      await db
        .update(schema.subscriptions)
        .set({ status: "cancelled", trialEndsAt: new Date(Date.now() - 86_400_000) })
        .where(eq(schema.subscriptions.organizationId, org));
      expect((await publicPage(on, page.slug)).branding).toEqual({ logoUrl: null });

      // Other edits with the same logo do not hit the paywall; changing it does; removing it never does.
      const edit = await call(on, owner, "PATCH", `/status-page/${page.id}`, {
        title: "Renamed",
        logoUrl: LOGO,
      });
      expect(edit.status).toBe(200);
      expect(
        (
          await call(on, owner, "PATCH", `/status-page/${page.id}`, {
            logoUrl: "https://cdn.client.test/new.png",
          })
        ).status,
      ).toBe(402);
      expect(
        (await call(on, owner, "PATCH", `/status-page/${page.id}`, { logoUrl: "" })).status,
      ).toBe(200);
      const [row] = await db.select().from(statusPages).where(eq(statusPages.id, page.id));
      expect(row!.logoUrl).toBeNull();
    });

    test("the logo must be a plain https address", async () => {
      for (const logoUrl of [
        "http://cdn.client.test/l.png",
        "javascript:alert(1)",
        "data:image/png;base64,AAAA",
        "//cdn.client.test/l.png",
        "https://user:pw@cdn.client.test/l.png",
        "not a url",
        `https://cdn.client.test/${"a".repeat(500)}`,
      ]) {
        const res = await call(off, owner, "POST", "/status-page", body({ logoUrl }));
        expect(res.status, logoUrl.slice(0, 40)).toBeGreaterThanOrEqual(400);
        expect(res.status).toBeLessThan(500);
      }
    });
  });
});
