import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { createAuth } from "@upzy/auth/server";
import { createDb, schema } from "@upzy/db";
import { eq, like, sql } from "drizzle-orm";

import { createApp } from "../src/app";

// Real Postgres + real better-auth. Needs: DATABASE_URL=... bun test
const url = process.env.DATABASE_URL;
const run = url ? describe : describe.skip;

run("status pages (postgres)", () => {
  process.env.BETTER_AUTH_SECRET ??= "integration-test-secret-integration-test-secret";
  const db = createDb(url);
  const auth = createAuth(db, {
    sendEmail: async () => {},
    signup: { mode: "open", allowedEmails: [], allowedDomains: [] },
  });
  const tag = `sp${Date.now()}`;
  const origin = "http://localhost:3001";
  // What the test's "DNS" currently contains: name -> records.
  const dnsTxt = new Map<string, string[]>();
  const dnsA = new Map<string, string[]>();
  const dnsCname = new Map<string, string[]>();
  process.env.WEB_ORIGIN = "https://app.example.test";
  const app = createApp({
    db,
    auth,
    statusDns: {
      txt: async (n) => dnsTxt.get(n) ?? [],
      a: async (h) => dnsA.get(h) ?? [],
      cname: async (h) => dnsCname.get(h) ?? [],
    },
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
    return { cookie: cookieOf(r), id: (await json(r)).user.id as string };
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

  let owner: Awaited<ReturnType<typeof person>>, member: typeof owner, other: typeof owner;
  let A = { orgId: "", ws: "" },
    B = { orgId: "", ws: "" };
  const ids: Record<string, string> = {};
  const s = (n: string) => `${tag.toLowerCase()}-${n}`;

  const call = (who: { cookie: string } | null, method: string, path: string, body?: unknown) =>
    send(path, {
      method,
      ...(who ? { cookie: who.cookie } : {}),
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
  const make = (over: Record<string, unknown> = {}) => ({
    workspaceId: A.ws,
    title: "Acme status",
    slug: s("main"),
    description: "Live status of Acme services",
    components: [
      { monitorId: ids.api, displayName: "API" },
      { monitorId: ids.web, displayName: "Website" },
    ],
    ...over,
  });

  beforeAll(async () => {
    owner = await person("owner");
    member = await person("member");
    other = await person("other");
    A = await makeOrg(owner, "a");
    B = await makeOrg(other, "b");
    await auth.api.addMember({
      body: { userId: member.id, role: "member", organizationId: A.orgId },
    });
    await send("/api/auth/organization/set-active", {
      method: "POST",
      cookie: member.cookie,
      body: JSON.stringify({ organizationId: A.orgId }),
    });
    const mon = async (ws: string, name: string, target: string, over: object = {}) =>
      (
        await db
          .insert(schema.monitors)
          .values({
            workspaceId: ws,
            name,
            type: "http",
            target,
            interval: 60,
            active: true,
            ...over,
          })
          .returning({ id: schema.monitors.id })
      )[0]!.id;
    ids.api = await mon(A.ws, "internal-api-name", "https://secret-internal.example.com/health", {
      createdAt: new Date(Date.now() - 100 * 86_400_000),
    });
    ids.web = await mon(A.ws, "web", "https://www.example.com", {
      createdAt: new Date(Date.now() - 100 * 86_400_000),
    });
    ids.paused = await mon(A.ws, "paused", "https://paused.example.com", { active: false });
    ids.foreign = await mon(B.ws, "foreign", "https://b.example.com");
  });
  afterAll(async () => {
    await db.delete(schema.organizations).where(like(schema.organizations.slug, `${tag}-%`));
    await db.delete(schema.users).where(like(schema.users.email, `${tag}-%`));
  });

  test("anyone in the organization can see the pages, but only an admin changes them", async () => {
    expect((await call(member, "POST", "/status-page", make())).status).toBe(403);
    const created = await call(owner, "POST", "/status-page", make());
    expect(created.status).toBe(201);
    ids.page = (await json(created)).id;
    expect((await call(member, "PATCH", `/status-page/${ids.page}`, { title: "x" })).status).toBe(
      403,
    );
    expect((await call(member, "DELETE", `/status-page/${ids.page}`)).status).toBe(403);
    const list = await json(await call(member, "GET", `/status-page?workspaceId=${A.ws}`));
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ slug: s("main"), published: false });
    expect(list[0].components.map((c: { displayName: string }) => c.displayName)).toEqual([
      "API",
      "Website",
    ]);
    expect(await json(await call(other, "GET", "/status-page"))).toEqual([]); // another organization sees nothing
    expect(
      (await call(other, "PATCH", `/status-page/${ids.page}`, { title: "hijack" })).status,
    ).toBe(404);
  });

  test("addresses and components are validated", async () => {
    for (const slug of [
      "ab",
      "Bad Slug",
      "has_underscore",
      "-lead",
      "trail-",
      "double--hyphen",
      "login",
      "status",
    ])
      expect((await call(owner, "POST", "/status-page", make({ slug }))).status).toBe(400);
    expect((await call(owner, "POST", "/status-page", make())).status).toBe(409); // same address
    // Another team's monitor can't be put on this page, nor the same monitor twice, nor more than 25.
    expect(
      (
        await call(
          owner,
          "POST",
          "/status-page",
          make({ slug: s("x1"), components: [{ monitorId: ids.foreign, displayName: "Nope" }] }),
        )
      ).status,
    ).toBe(422);
    expect(
      (
        await call(
          owner,
          "POST",
          "/status-page",
          make({
            slug: s("x2"),
            components: [
              { monitorId: ids.api, displayName: "A" },
              { monitorId: ids.api, displayName: "B" },
            ],
          }),
        )
      ).status,
    ).toBe(400);
    expect(
      (await call(owner, "POST", "/status-page", make({ slug: s("x3"), title: "" }))).status,
    ).toBe(400);
    expect(
      (await call(owner, "POST", "/status-page", make({ slug: s("x4"), workspaceId: B.ws })))
        .status,
    ).toBe(404);
  });

  test("an unpublished page and an unknown address look the same from outside", async () => {
    const a = await call(null, "GET", `/public/status/${s("main")}`);
    const b = await call(null, "GET", `/public/status/${s("does-not-exist")}`);
    expect(a.status).toBe(404);
    expect(b.status).toBe(404);
    expect(await json(a)).toEqual(await json(b));
    expect((await call(null, "GET", "/public/status/AB")).status).toBe(400);
  });

  test("a published page shows the chosen names and status, and nothing internal", async () => {
    expect(
      (
        await call(owner, "PATCH", `/status-page/${ids.page}`, {
          published: true,
          notice: "Planned maintenance Friday 02:00 UTC",
          noticeKind: "maintenance",
        })
      ).status,
    ).toBe(200);
    const r = await call(null, "GET", `/public/status/${s("main")}`);
    expect(r.status).toBe(200);
    expect(r.headers.get("cache-control")).toContain("max-age=30");
    const body = await json(r);
    expect(body).toMatchObject({
      title: "Acme status",
      overall: "operational",
      notice: { text: "Planned maintenance Friday 02:00 UTC", kind: "maintenance" },
    });
    expect(
      body.components.map((c: { name: string; status: string }) => [c.name, c.status]),
    ).toEqual([
      ["API", "operational"],
      ["Website", "operational"],
    ]);
    expect(body.components[0].days).toHaveLength(90);
    expect(body.components[0].uptime).toBe(100);
    const raw = JSON.stringify(body);
    for (const secret of [
      "secret-internal",
      "internal-api-name",
      ids.api!,
      ids.page!,
      A.ws,
      A.orgId,
      "example.com/health",
    ])
      expect(raw).not.toContain(secret);
  });

  test("an open incident shows as an outage with a generic message; a resolved one appears with its duration", async () => {
    await db
      .update(schema.monitors)
      .set({ lastStatus: "down" })
      .where(eq(schema.monitors.id, ids.api!));
    const now = Date.now();
    await db.insert(schema.incidents).values([
      {
        workspaceId: A.ws,
        monitorId: ids.api!,
        type: "uptime",
        status: "open",
        title: "SECRET: Target address 10.0.0.5 refused connection",
        createdAt: new Date(now - 30 * 60_000),
      },
      {
        workspaceId: A.ws,
        monitorId: ids.web!,
        type: "uptime",
        status: "resolved",
        title: "web is down: ECONNRESET at db-3.internal",
        createdAt: new Date(now - 3 * 86_400_000),
        resolvedAt: new Date(now - 3 * 86_400_000 + 20 * 60_000),
      },
    ]);
    // Changing the page clears the cached copy at once.
    await call(owner, "PATCH", `/status-page/${ids.page}`, { notice: "" });
    const body = await json(await call(null, "GET", `/public/status/${s("main")}`));
    expect(body.overall).toBe("partial");
    expect(body.notice).toBeNull();
    expect(body.components.find((c: { name: string }) => c.name === "API").status).toBe("outage");
    expect(
      body.incidents.map((i: { title: string; status: string }) => [i.title, i.status]),
    ).toEqual([
      ["API is unavailable", "ongoing"],
      ["Website was unavailable", "resolved"],
    ]);
    expect(body.incidents[1].minutes).toBe(20);
    const web = body.components.find((c: { name: string }) => c.name === "Website");
    expect(web.uptime).toBeLessThan(100);
    const raw = JSON.stringify(body);
    for (const secret of ["SECRET", "10.0.0.5", "ECONNRESET", "db-3.internal"])
      expect(raw).not.toContain(secret);
  });

  test("posted incident updates appear on the public page, newest first, and only the author's organization can post them", async () => {
    const [inc] = await db
      .select({ id: schema.incidents.id })
      .from(schema.incidents)
      .where(eq(schema.incidents.monitorId, ids.api!));
    const path = `/incident/${inc!.id}/updates`;
    const first = await call(member, "POST", path, {
      status: "investigating",
      message: "We are looking into elevated errors.",
    });
    expect(first.status).toBe(201);
    // Cached copies are cleared at once, so the update is visible straight away.
    await call(null, "GET", `/public/status/${s("main")}`);
    const second = await json(
      await call(owner, "POST", path, {
        status: "identified",
        message: "A bad deploy. Rolling back.",
      }),
    );
    const open = (await json(await call(null, "GET", `/public/status/${s("main")}`))).incidents[0];
    expect(open.updates.map((u: { status: string }) => u.status)).toEqual([
      "identified",
      "investigating",
    ]);
    expect(open.updates[0].message).toBe("A bad deploy. Rolling back.");
    // The admin view lists them too.
    expect((await json(await call(owner, "GET", `/incident/${inc!.id}`))).updates).toHaveLength(2);

    // Empty messages, unknown statuses and strangers are refused.
    expect((await call(owner, "POST", path, { status: "update", message: "  " })).status).toBe(400);
    expect((await call(owner, "POST", path, { status: "resolved", message: "x" })).status).toBe(
      400,
    );
    expect((await call(other, "POST", path, { status: "update", message: "hi" })).status).toBe(404);
    expect((await call(null, "POST", path, { status: "update", message: "hi" })).status).toBe(401);
    expect((await call(other, "DELETE", `${path}/${second.id}`)).status).toBe(404);

    // Deleting one removes it from the public page at once.
    expect((await call(owner, "DELETE", `${path}/${second.id}`)).status).toBe(200);
    const after = (await json(await call(null, "GET", `/public/status/${s("main")}`))).incidents[0];
    expect(after.updates).toHaveLength(1);
    expect((await call(owner, "DELETE", `${path}/${second.id}`)).status).toBe(404);
  });

  test("subscribing needs the address owner's confirmation; links alone change nothing; unsubscribing removes the address", async () => {
    const mail = `reader-${tag}@example.com`;
    const sentTo = async (to: string) =>
      (
        await db
          .select({ p: schema.jobs.payload })
          .from(schema.jobs)
          .where(sql`${schema.jobs.queue} = 'email' and ${schema.jobs.payload}->>'to' = ${to}`)
      ).map((r) => r.p as { subject: string; text: string });
    const subscribe = (email: string, slug = s("main")) =>
      call(null, "POST", `/public/status/${slug}/subscribe`, { email });

    expect((await subscribe(mail)).status).toBe(202);
    const sent = await sentTo(mail);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.subject).toBe("Confirm updates from Acme status");
    const token = sent[0]!.text.match(/\/subscription\/([\w-]+)/)![1]!;

    // Asking again straight away doesn't mail the same address again, and looks identical from outside.
    expect((await subscribe(mail.toUpperCase())).status).toBe(202);
    expect(await sentTo(mail)).toHaveLength(1);

    // Nothing is sent to an unconfirmed address, and just opening the link changes nothing.
    expect(await json(await call(null, "GET", `/public/subscription/${token}`))).toEqual({
      pageTitle: "Acme status",
      confirmed: false,
    });
    expect(
      (await json(await call(owner, "GET", "/status-page"))).find((p: any) => p.id === ids.page)
        .subscribers,
    ).toBe(0);

    expect(await json(await call(null, "POST", `/public/subscription/${token}/confirm`))).toEqual({
      pageTitle: "Acme status",
      confirmed: true,
    });
    // Confirming twice is fine; the admin sees only a count.
    expect((await call(null, "POST", `/public/subscription/${token}/confirm`)).status).toBe(200);
    const listed = (await json(await call(owner, "GET", "/status-page"))).find(
      (p: any) => p.id === ids.page,
    );
    expect(listed.subscribers).toBe(1);
    expect(JSON.stringify(listed)).not.toContain(mail);
    // An already-confirmed address gets no new confirmation email.
    expect((await subscribe(mail)).status).toBe(202);
    expect(await sentTo(mail)).toHaveLength(1);

    expect((await call(null, "POST", `/public/subscription/${token}/unsubscribe`)).status).toBe(
      200,
    );
    expect((await call(null, "GET", `/public/subscription/${token}`)).status).toBe(404);
    expect((await call(null, "POST", `/public/subscription/${token}/unsubscribe`)).status).toBe(
      404,
    );
  });

  test("subscribe is refused for unknown pages and bad input, and one page can't be used to mail the world", async () => {
    const post = (email: unknown, slug = s("main")) =>
      call(null, "POST", `/public/status/${slug}/subscribe`, { email });
    expect((await post("a@b.co", s("nope"))).status).toBe(404);
    expect((await post("not-an-email")).status).toBe(400);
    expect((await call(null, "GET", "/public/subscription/short")).status).toBe(400);
    expect((await call(null, "GET", `/public/subscription/${"a".repeat(43)}`)).status).toBe(404);

    // 30 confirmation emails an hour per page, whoever asks.
    let refused = 0;
    for (let n = 0; n < 40; n++) {
      const r = await post(`bulk${n}-${tag}@example.com`);
      if (r.status === 429) refused++;
    }
    expect(refused).toBeGreaterThan(0);
    await db
      .delete(schema.jobs)
      .where(
        sql`${schema.jobs.queue} = 'email' and ${schema.jobs.payload}->>'to' like ${`%-${tag}@example.com`}`,
      );
  });

  test("the security grade is opt-in, shows only the letter, and can come only from the page's own workspace", async () => {
    const own = (
      await db
        .insert(schema.assets)
        .values({
          workspaceId: A.ws,
          kind: "domain",
          value: `${tag}-own.com`,
          verificationToken: "t",
        })
        .returning({ id: schema.assets.id })
    )[0]!.id;
    const foreign = (
      await db
        .insert(schema.assets)
        .values({
          workspaceId: B.ws,
          kind: "domain",
          value: `${tag}-foreign.com`,
          verificationToken: "t",
        })
        .returning({ id: schema.assets.id })
    )[0]!.id;
    const pub = async () => json(await call(null, "GET", `/public/status/${s("main")}`));
    const badgeOf = (type: string) =>
      call(null, "GET", `/public/status/${s("main")}/badge.svg?type=${type}`);

    // Off by default: no grade, and no security badge.
    expect((await pub()).security).toBeNull();
    expect((await badgeOf("security")).status).toBe(404);

    // Only an asset from this page's workspace can be chosen.
    expect(
      (await call(owner, "PATCH", `/status-page/${ids.page}`, { securityAssetId: foreign })).status,
    ).toBe(422);
    expect(
      (await call(member, "PATCH", `/status-page/${ids.page}`, { securityAssetId: own })).status,
    ).toBe(403);
    expect(
      (await call(owner, "PATCH", `/status-page/${ids.page}`, { securityAssetId: own })).status,
    ).toBe(200);

    // An asset that was never scanned has no grade to show.
    expect((await pub()).security).toBeNull();

    // Scanned, with an open medium finding: a B, shown as a letter and a date and nothing else.
    await db.update(schema.assets).set({ lastScanAt: new Date() }).where(eq(schema.assets.id, own));
    await db.insert(schema.findings).values({
      workspaceId: A.ws,
      assetId: own,
      checkKey: "headers.hsts_missing",
      fingerprint: `${tag}-sec`,
      severity: "medium",
      title: "SECRET finding title",
      description: "SECRET detail",
    });
    await call(owner, "PATCH", `/status-page/${ids.page}`, { notice: "" }); // clears the cached copy
    const body = await pub();
    expect(Object.keys(body.security).sort()).toEqual(["grade", "scannedAt"]);
    expect(body.security.grade).toBe("B");
    expect(JSON.stringify(body)).not.toContain("SECRET");
    expect(JSON.stringify(body)).not.toContain(`${tag}-own.com`);

    // The embeddable badges.
    const sec = await badgeOf("security");
    expect(sec.status).toBe(200);
    expect(sec.headers.get("content-type")).toContain("image/svg+xml");
    expect(sec.headers.get("content-security-policy")).toContain("default-src 'none'");
    const svg = await sec.text();
    expect(svg).toContain("security");
    expect(svg).toContain(">B<");
    expect(svg).not.toContain("SECRET");
    expect(await (await badgeOf("status")).text()).toMatch(/status/);
    expect((await badgeOf("nonsense")).status).toBe(400);

    // Turning it off removes it again at once.
    await call(owner, "PATCH", `/status-page/${ids.page}`, { securityAssetId: null });
    expect((await pub()).security).toBeNull();
    expect((await badgeOf("security")).status).toBe(404);
    // An unpublished page has no badge at all.
    const other2 = await json(
      await call(
        other,
        "POST",
        "/status-page",
        make({ workspaceId: B.ws, slug: s("unpub"), components: [] }),
      ),
    );
    expect((await call(null, "GET", `/public/status/${s("unpub")}/badge.svg`)).status).toBe(404);
    await call(other, "DELETE", `/status-page/${other2.id}`);
  });

  test("components can be reordered, renamed and paused monitors are shown as paused", async () => {
    await call(owner, "PATCH", `/status-page/${ids.page}`, {
      components: [
        { monitorId: ids.web, displayName: "Customer site" },
        { monitorId: ids.paused, displayName: "Batch jobs" },
        { monitorId: ids.api, displayName: "API" },
      ],
    });
    const body = await json(await call(null, "GET", `/public/status/${s("main")}`));
    expect(
      body.components.map((c: { name: string; status: string }) => [c.name, c.status]),
    ).toEqual([
      ["Customer site", "operational"],
      ["Batch jobs", "paused"],
      ["API", "outage"],
    ]);
    expect(body.overall).toBe("partial");
    // Editing one thing leaves the rest alone (no field silently falls back to a default).
    await call(owner, "PATCH", `/status-page/${ids.page}`, { title: "Acme (renamed)" });
    const after = await json(await call(null, "GET", `/public/status/${s("main")}`));
    expect(after.title).toBe("Acme (renamed)");
    expect(after.description).toBe("Live status of Acme services");
  });

  test("changing the address, unpublishing and deleting take effect immediately", async () => {
    expect(
      (await call(owner, "PATCH", `/status-page/${ids.page}`, { slug: s("renamed") })).status,
    ).toBe(200);
    expect((await call(null, "GET", `/public/status/${s("main")}`)).status).toBe(404);
    expect((await call(null, "GET", `/public/status/${s("renamed")}`)).status).toBe(200);
    await call(owner, "PATCH", `/status-page/${ids.page}`, { published: false });
    expect((await call(null, "GET", `/public/status/${s("renamed")}`)).status).toBe(404);
    await call(owner, "PATCH", `/status-page/${ids.page}`, { published: true });
    expect((await call(null, "GET", `/public/status/${s("renamed")}`)).status).toBe(200);
    expect((await call(owner, "DELETE", `/status-page/${ids.page}`)).status).toBe(200);
    expect((await call(null, "GET", `/public/status/${s("renamed")}`)).status).toBe(404);
    expect(await json(await call(owner, "GET", "/status-page"))).toEqual([]);
  });

  describe("custom domains", () => {
    const domain = `status.${tag.toLowerCase()}.example.test`;
    let page = "";
    const list = async (who: { cookie: string }) =>
      (await json(await call(who, "GET", `/status-page?workspaceId=${A.ws}`)))[0];

    test("a domain is claimed with a fresh proof; invalid or Upzy's own addresses are refused; only admins see the proof", async () => {
      const created = await call(
        owner,
        "POST",
        "/status-page",
        make({ slug: s("dom"), published: true }),
      );
      page = (await json(created)).id;
      for (const bad of ["not a domain", "https://status.acme.com", "localhost", "10.0.0.1"])
        expect(
          (await call(owner, "PATCH", `/status-page/${page}`, { customDomain: bad })).status,
        ).toBe(400);
      const own = await call(owner, "PATCH", `/status-page/${page}`, {
        customDomain: "app.example.test",
      });
      expect(own.status).toBe(422);
      expect(
        (await call(member, "PATCH", `/status-page/${page}`, { customDomain: domain })).status,
      ).toBe(403);

      expect(
        (await call(owner, "PATCH", `/status-page/${page}`, { customDomain: domain })).status,
      ).toBe(200);
      const asAdmin = await list(owner);
      expect(asAdmin).toMatchObject({
        customDomain: domain,
        domainVerified: false,
        domainTarget: "app.example.test",
      });
      expect(asAdmin.domainChallenge.name).toBe(`_upzy-challenge.${domain}`);
      expect(asAdmin.domainChallenge.value).toMatch(/^upzy-verify=[A-Za-z0-9_-]{20,}$/);
      expect(asAdmin.domainToken).toBeUndefined();
      const asMember = await list(member);
      expect(asMember.domainChallenge).toBeNull();
      expect(JSON.stringify(asMember)).not.toContain("upzy-verify");
    });

    test("nothing is served or certified for a domain until its ownership is verified", async () => {
      expect((await call(null, "GET", `/public/status-domain/${domain}`)).status).toBe(404);
      expect((await call(null, "GET", `/internal/tls-check?domain=${domain}`)).status).toBe(404);
      // Without the proof in DNS, verification says so.
      const miss = await json(await call(owner, "POST", `/status-page/${page}/verify-domain`));
      expect(miss).toMatchObject({ verified: false, txt: false });
      // A wrong value doesn't count either.
      dnsTxt.set(`_upzy-challenge.${domain}`, ["upzy-verify=somebody-elses-token"]);
      expect(
        (await json(await call(owner, "POST", `/status-page/${page}/verify-domain`))).verified,
      ).toBe(false);
      expect((await call(null, "GET", `/public/status-domain/${domain}`)).status).toBe(404);
    });

    test("with the right TXT record it is verified, then served and certified; it also reports whether the name points here", async () => {
      const proof = (await list(owner)).domainChallenge;
      dnsTxt.set(proof.name, ["v=spf1 -all", proof.value]);
      dnsCname.set(domain, ["app.example.test."]);
      const ok = await json(await call(owner, "POST", `/status-page/${page}/verify-domain`));
      expect(ok).toEqual({ verified: true, txt: true, pointsToUs: true });
      expect((await list(owner)).domainVerified).toBe(true);
      expect((await list(owner)).domainChallenge).toBeNull(); // the proof is no longer shown

      const pub = await call(null, "GET", `/public/status-domain/${domain}`);
      expect(pub.status).toBe(200);
      expect((await json(pub)).title).toBe("Acme status");
      expect((await call(null, "GET", `/internal/tls-check?domain=${domain}`)).status).toBe(200);
      // Caddy asks directly; anything that came through the proxy carries X-Forwarded-For and is refused.
      const viaProxy = await app.handle(
        new Request(`http://localhost/internal/tls-check?domain=${domain}`, {
          headers: { "x-forwarded-for": "203.0.113.9" },
        }),
      );
      expect(viaProxy.status).toBe(404);
      expect(
        (await call(null, "GET", "/internal/tls-check?domain=other.example.test")).status,
      ).toBe(404);
      expect((await call(null, "GET", "/internal/tls-check?domain=%3Cscript%3E")).status).toBe(404);
    });

    test("the name pointing at our IP instead of a CNAME also counts, and pointing elsewhere is reported", async () => {
      dnsCname.delete(domain);
      dnsA.set("app.example.test", ["203.0.113.10"]);
      dnsA.set(domain, ["203.0.113.10"]);
      expect(
        (await json(await call(owner, "POST", `/status-page/${page}/verify-domain`))).pointsToUs,
      ).toBe(true);
      dnsA.set(domain, ["198.51.100.7"]);
      expect(
        (await json(await call(owner, "POST", `/status-page/${page}/verify-domain`))).pointsToUs,
      ).toBe(false);
    });

    test("unpublishing or changing the domain stops serving it at once, and a new domain needs a new proof", async () => {
      await call(owner, "PATCH", `/status-page/${page}`, { published: false });
      expect((await call(null, "GET", `/public/status-domain/${domain}`)).status).toBe(404);
      expect((await call(null, "GET", `/internal/tls-check?domain=${domain}`)).status).toBe(404);
      await call(owner, "PATCH", `/status-page/${page}`, { published: true });
      expect((await call(null, "GET", `/public/status-domain/${domain}`)).status).toBe(200);

      const before = (await list(owner)).domainChallenge;
      const next = `status2.${tag.toLowerCase()}.example.test`;
      await call(owner, "PATCH", `/status-page/${page}`, { customDomain: next });
      expect((await call(null, "GET", `/public/status-domain/${domain}`)).status).toBe(404);
      const after = await list(owner);
      expect(after).toMatchObject({ customDomain: next, domainVerified: false });
      expect(after.domainChallenge.value).not.toBe(before ? before.value : "");
      expect((await call(null, "GET", `/public/status-domain/${next}`)).status).toBe(404); // not verified yet

      await call(owner, "PATCH", `/status-page/${page}`, { customDomain: null });
      expect(await list(owner)).toMatchObject({
        customDomain: null,
        domainVerified: false,
        domainChallenge: null,
      });
    });

    test("claiming someone's name doesn't block them: only one page can hold it verified", async () => {
      const d = `shared.${tag.toLowerCase()}.example.test`;
      // A second workspace in organization B tries the same name first (unverified claims may coexist)...
      const other2 = await json(
        await call(other, "POST", "/status-page", {
          workspaceId: B.ws,
          title: "B",
          slug: s("b"),
          components: [],
        }),
      );
      expect(
        (await call(other, "PATCH", `/status-page/${other2.id}`, { customDomain: d })).status,
      ).toBe(200);
      expect((await call(owner, "PATCH", `/status-page/${page}`, { customDomain: d })).status).toBe(
        200,
      );
      // ...but only whoever can publish *their* proof gets verified.
      const mine = (await list(owner)).domainChallenge;
      dnsTxt.set(mine.name, [mine.value]);
      expect(
        (await json(await call(owner, "POST", `/status-page/${page}/verify-domain`))).verified,
      ).toBe(true);
      // The other claimant cannot verify with a proof that isn't theirs, and cannot take the name.
      const theirs = await json(
        await call(other, "POST", `/status-page/${other2.id}/verify-domain`),
      );
      expect(theirs.verified).toBe(false);
      dnsTxt.set(mine.name, [mine.value]);
      const foreign = (await json(await call(other, "GET", `/status-page`)))[0].domainChallenge;
      dnsTxt.set(foreign.name, [foreign.value]);
      expect((await call(other, "POST", `/status-page/${other2.id}/verify-domain`)).status).toBe(
        409,
      );
    });
  });
});
