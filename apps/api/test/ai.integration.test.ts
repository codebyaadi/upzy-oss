import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { createDbStores, createGateway, type AiConfig } from "@upzy/ai";
import { createAuth } from "@upzy/auth/server";
import { createDb, schema } from "@upzy/db";
import { APICallError, type LanguageModel } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { eq, like, sql } from "drizzle-orm";

import { createApp } from "../src/app";

// Real Postgres + real better-auth + the real AI gateway with a scripted model. Needs: DATABASE_URL=... bun test
const url = process.env.DATABASE_URL;
const run = url ? describe : describe.skip;

const usage = {
  inputTokens: { total: 40, noCache: 40, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 10, text: 10, reasoning: undefined },
};

run("AI endpoints (postgres)", () => {
  process.env.BETTER_AUTH_SECRET ??= "integration-test-secret-integration-test-secret";
  const db = createDb(url);
  const auth = createAuth(db, { sendEmail: async () => {} });
  const tag = `ai${Date.now()}`;
  const origin = "http://localhost:3001";

  const config: AiConfig = { rpm: 1000, defaultDailyTokenBudget: 5000 };
  let reply: () => string | Error = () => "{}";
  const model = new MockLanguageModelV4({
    doGenerate: async () => {
      const r = reply();
      if (r instanceof Error) throw r;
      return {
        content: [{ type: "text" as const, text: r }],
        finishReason: { unified: "stop" as const, raw: undefined },
        usage,
        warnings: [],
      };
    },
  }) as LanguageModel;
  const encryptionKey = Buffer.alloc(32, 5).toString("base64");
  const stores = createDbStores(db, {
    dailyTokenBudget: config.defaultDailyTokenBudget,
    encryptionKey,
  });
  // Keys the "provider" was called with; keys starting "bad" are rejected like a real 401.
  const keysSeen: string[] = [];
  const rejecting = new MockLanguageModelV4({
    doGenerate: async () => {
      throw new APICallError({
        message: "Invalid API key",
        url: "https://provider.test",
        requestBodyValues: {},
        statusCode: 401,
      });
    },
  }) as LanguageModel;
  const modelFactory = (_spec: { provider: string }, key: string) => {
    keysSeen.push(key);
    return key.startsWith("bad") ? rejecting : model;
  };
  // Stands in for the provider's "list models" call: keys starting "bad" are refused, and Anthropic keys can only
  // use one of the models we offer.
  const verifyKey = async (provider: string, key: string) => {
    if (key.startsWith("bad"))
      return {
        ok: false as const,
        reason: "rejected" as const,
        message: "The provider didn't accept this key.",
      };
    return { ok: true as const, models: provider === "anthropic" ? ["claude-haiku-4-5"] : [] };
  };
  const gateway = createGateway({ config, stores, modelFactory });
  const app = (cfg: AiConfig = config) =>
    createApp({
      db,
      auth,
      webOrigin: origin,
      encryptionKey,
      rateLimit: { rules: [{ match: () => true, bucket: "t", max: Infinity, windowMs: 1 }] },
      ai: { config: cfg, stores, gateway, verifyKey },
    });
  const main = app();

  const send = (
    a: ReturnType<typeof app>,
    path: string,
    init: RequestInit & { cookie?: string } = {},
  ) =>
    a.handle(
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
    const res = await send(main, "/api/auth/sign-up/email", {
      method: "POST",
      body: JSON.stringify({
        email: `${tag}-${name}@example.com`,
        password: "supersecret123",
        name,
      }),
    });
    return { cookie: cookieOf(res), id: (await json(res)).user.id as string };
  };
  const activate = (who: { cookie: string }, orgId: string) =>
    send(main, "/api/auth/organization/set-active", {
      method: "POST",
      cookie: who.cookie,
      body: JSON.stringify({ organizationId: orgId }),
    });

  let owner: Awaited<ReturnType<typeof person>>,
    viewer: typeof owner,
    member: typeof owner,
    outsider: typeof owner;
  let orgId = "",
    ws = "",
    findingId = "";

  beforeAll(async () => {
    owner = await person("owner");
    orgId = (
      await json(
        await send(main, "/api/auth/organization/create", {
          method: "POST",
          cookie: owner.cookie,
          body: JSON.stringify({ name: "AI", slug: `${tag}-org` }),
        }),
      )
    ).id;
    await activate(owner, orgId);
    for (const role of ["viewer", "member"] as const) {
      const u = await person(role);
      await auth.api.addMember({ body: { userId: u.id, role, organizationId: orgId } });
      await activate(u, orgId);
      if (role === "viewer") viewer = u;
      else member = u;
    }
    outsider = await person("outsider");
    const other = await json(
      await send(main, "/api/auth/organization/create", {
        method: "POST",
        cookie: outsider.cookie,
        body: JSON.stringify({ name: "Other", slug: `${tag}-other` }),
      }),
    );
    await activate(outsider, other.id);

    ws = (
      await json(
        await send(main, "/workspace", {
          method: "POST",
          cookie: owner.cookie,
          body: JSON.stringify({ name: "Prod" }),
        }),
      )
    ).id;
    const asset = (
      await db
        .insert(schema.assets)
        .values({
          workspaceId: ws,
          kind: "domain",
          value: "ai.example.com",
          verificationToken: "t",
        })
        .returning({ id: schema.assets.id })
    )[0]!;
    findingId = (
      await db
        .insert(schema.findings)
        .values({
          workspaceId: ws,
          assetId: asset.id,
          checkKey: "headers.csp_missing",
          fingerprint: `${tag}-f`,
          severity: "medium",
          title: "CSP missing",
          description: "d",
          remediation: "r",
        })
        .returning({ id: schema.findings.id })
    )[0]!.id;
  });
  afterAll(async () => {
    await db.delete(schema.organizations).where(like(schema.organizations.slug, `${tag}-%`));
    await db.delete(schema.users).where(like(schema.users.email, `${tag}-%`));
    await db.delete(schema.jobs).where(sql`${schema.jobs.payload}::text like ${`%${findingId}%`}`);
  });

  const settings = async (who = owner) =>
    json(await send(main, "/ai/settings", { cookie: who.cookie }));
  const patch = (who: typeof owner, body: object, a = main) =>
    send(a, "/ai/settings", { method: "PATCH", cookie: who.cookie, body: JSON.stringify(body) });

  test("AI is off by default and nothing is set up: everyone can see where things stand", async () => {
    const s = await settings(viewer);
    expect(s).toMatchObject({
      enabled: false,
      dailyTokenBudget: 5000,
      usedToday: 0,
      credentials: [],
      active: { fast: { model: null, ready: false }, smart: { model: null, ready: false } },
    });
    // The server holds no provider keys, so there is nothing about "shared" providers to show.
    expect(s.providers).toBeUndefined();
    expect(s.catalog.providers.map((p: { id: string }) => p.id)).toContain("anthropic");
  });

  test("only an admin can change settings; AI can't be turned on without a key; changes are audited without values", async () => {
    expect((await patch(member, { enabled: true })).status).toBe(403);
    expect((await patch(viewer, { enabled: true })).status).toBe(403);
    const noKey = await patch(owner, { enabled: true });
    expect(noKey.status).toBe(409);
    expect((await json(noKey)).message).toContain("API key");
    reply = () => "ok";
    expect((await putKey(owner, "groq", "gsk_live_abcdef1234")).status).toBe(200);
    expect((await patch(owner, { enabled: true, dailyTokenBudget: 3000 })).status).toBe(200);
    expect(await settings(viewer)).toMatchObject({
      enabled: true,
      dailyTokenBudget: 3000,
      active: {
        smart: { model: "groq:llama-3.3-70b-versatile", ready: true },
        fast: { model: "groq:llama-3.1-8b-instant", ready: true },
      },
    });
    await Bun.sleep(150);
    const rows = await db
      .select()
      .from(schema.auditLogs)
      .where(eq(schema.auditLogs.organizationId, orgId));
    const entry = rows.find((r) => r.action === "PATCH /ai/settings" && r.status === 200);
    expect(entry).toBeDefined();
    expect(entry!.payload).toEqual({ params: {}, fields: ["enabled", "dailyTokenBudget"] });
    expect(JSON.stringify(rows)).not.toContain("gsk_live");
  });

  test("monitor draft: a good suggestion is validated, snapped and returned for confirmation", async () => {
    reply = () =>
      JSON.stringify({
        name: "Checkout",
        type: "http",
        target: "https://shop.example.com/checkout",
        intervalSeconds: 90,
        failureThreshold: 2,
        keyword: "Order",
        unsupported: ["alert Slack if slower than 2s"],
        rationale: "ok",
      });
    const res = await send(main, "/ai/monitor-draft", {
      method: "POST",
      cookie: member.cookie,
      body: JSON.stringify({
        workspaceId: ws,
        text: "check shop.example.com/checkout every 90s for the word Order",
      }),
    });
    expect(res.status).toBe(200);
    expect(await json(res)).toMatchObject({
      draft: {
        name: "Checkout",
        type: "http",
        target: "https://shop.example.com/checkout",
        interval: 60,
        failureThreshold: 2,
        config: { keyword: "Order" },
      },
      unsupported: ["alert Slack if slower than 2s"],
      model: "groq/llama-3.1-8b-instant",
    });
  });

  test("monitor draft: the real schema rejects what the model proposes if it is unsafe (internal host)", async () => {
    reply = () =>
      JSON.stringify({
        name: "x",
        type: "http",
        target: "http://169.254.169.254/latest/meta-data",
        intervalSeconds: 60,
        failureThreshold: 1,
        unsupported: [],
        rationale: "r",
      });
    const res = await send(main, "/ai/monitor-draft", {
      method: "POST",
      cookie: member.cookie,
      body: JSON.stringify({ workspaceId: ws, text: "monitor the metadata service" }),
    });
    expect(res.status).toBe(422);
    expect((await json(res)).message).toContain("public host");
  });

  test("monitor draft: viewers, other organizations' workspaces and a down provider are handled", async () => {
    const body = JSON.stringify({ workspaceId: ws, text: "check example.com" });
    expect(
      (await send(main, "/ai/monitor-draft", { method: "POST", cookie: viewer.cookie, body }))
        .status,
    ).toBe(403);
    expect(
      (await send(main, "/ai/monitor-draft", { method: "POST", cookie: outsider.cookie, body }))
        .status,
    ).toBe(404);
    reply = () =>
      new APICallError({
        message: "x",
        url: "https://p",
        requestBodyValues: {},
        statusCode: 503,
        isRetryable: true,
      });
    const down = await send(main, "/ai/monitor-draft", {
      method: "POST",
      cookie: member.cookie,
      body,
    });
    expect(down.status).toBe(503);
    expect((await json(down)).message).toContain("unavailable");
  });

  test("usage is counted per feature and shown in the settings", async () => {
    const s = await settings(owner);
    // Two model calls succeeded (the unsafe-host one too: the tokens were spent before the schema rejected it): 2 x (40 + 10).
    expect(s.usedToday).toBe(100);
    expect(
      s.byFeature.find((f: { feature: string }) => f.feature === "monitor-draft"),
    ).toMatchObject({ requests: 2, tokens: 100, failures: 1 });
  });

  test("the daily budget is enforced with a clear 429", async () => {
    await patch(owner, { dailyTokenBudget: 1000 });
    await stores.usage.record({
      organizationId: orgId,
      provider: "groq",
      model: "fast",
      feature: "test-fill",
      inputTokens: 2000,
      outputTokens: 0,
      failed: false,
    });
    const res = await send(main, "/ai/monitor-draft", {
      method: "POST",
      cookie: member.cookie,
      body: JSON.stringify({ workspaceId: ws, text: "check example.com" }),
    });
    expect(res.status).toBe(429);
    expect((await json(res)).message).toContain("budget");
    await patch(owner, { dailyTokenBudget: 5_000_000 });
  });

  test("explain: queues one background job, is idempotent, and respects tenancy and roles", async () => {
    const explain = (who: typeof owner, body: object = {}) =>
      send(main, `/ai/finding/${findingId}/explain`, {
        method: "POST",
        cookie: who.cookie,
        body: JSON.stringify(body),
      });
    expect((await explain(viewer)).status).toBe(403);
    expect((await explain(outsider)).status).toBe(404);

    const first = await explain(member);
    expect(first.status).toBe(202);
    expect(await json(first)).toEqual({ status: "pending" });
    const jobs = () =>
      db
        .execute<{ n: number }>(
          sql`select count(*)::int n from jobs where queue = 'ai' and payload->>'findingId' = ${findingId}`,
        )
        .then((r) => [...r][0]!.n);
    expect(await jobs()).toBe(1);
    expect((await json(await explain(member))).status).toBe("pending");
    expect(await jobs()).toBe(1);
    const [f] = await db.select().from(schema.findings).where(eq(schema.findings.id, findingId));
    expect(f!.aiExplainStatus).toBe("pending");

    // Once explained it is "ready" until someone asks to regenerate.
    await db
      .update(schema.findings)
      .set({ aiExplanation: { summary: "s" }, aiExplainedAt: new Date(), aiExplainStatus: null })
      .where(eq(schema.findings.id, findingId));
    expect((await json(await explain(member))).status).toBe("ready");
    await db.execute(
      sql`update jobs set state = 'done' where queue = 'ai' and payload->>'findingId' = ${findingId}`,
    );
    expect((await explain(member, { force: true })).status).toBe(202);
  });

  test("explain is refused while the organization has AI turned off", async () => {
    await patch(owner, { enabled: false });
    const res = await send(main, `/ai/finding/${findingId}/explain`, {
      method: "POST",
      cookie: member.cookie,
      body: "{}",
    });
    expect(res.status).toBe(403);
    expect((await json(res)).message).toContain("turned off");
  });

  const putKey = (who: typeof owner, provider: string, apiKey: string, extra: object = {}) =>
    send(main, `/ai/credentials/${provider}`, {
      method: "PUT",
      cookie: who.cookie,
      body: JSON.stringify({ apiKey, ...extra }),
    });
  const draftReply = () =>
    JSON.stringify({
      name: "Home",
      type: "http",
      target: "https://home.example.com",
      intervalSeconds: 300,
      failureThreshold: 2,
      unsupported: [],
      rationale: "ok",
    });
  const askDraft = () =>
    send(main, "/ai/monitor-draft", {
      method: "POST",
      cookie: member.cookie,
      body: JSON.stringify({ workspaceId: ws, text: "watch home.example.com every five minutes" }),
    });

  test("a bad key is refused and not stored; a good one is encrypted and never echoed", async () => {
    reply = () => "ok";
    expect((await putKey(member, "openai", "sk-member-tries-this")).status).toBe(403);
    expect((await putKey(owner, "nope", "sk-whatever-key")).status).toBe(400);
    const bad = await putKey(owner, "openai", "bad-key-12345678");
    expect(bad.status).toBe(422);
    expect((await json(bad)).message).toContain("accept");
    const before = (await settings(owner)).credentials.map((c: { provider: string }) => c.provider);
    expect(before).toEqual(["groq"]);

    const ok = await putKey(owner, "openai", "sk-live-abcdef9876");
    expect(await json(ok)).toEqual({
      provider: "openai",
      hint: "9876",
      availableModels: 0,
      unavailable: [],
      automatic: { fast: "openai:gpt-4.1-nano", smart: "openai:gpt-4.1-mini" },
    });
    const s = await settings(viewer);
    expect(JSON.stringify(s)).not.toContain("sk-live-abcdef");
    expect(JSON.stringify(s)).not.toContain("gsk_live");
    const rows = await db
      .select()
      .from(schema.aiCredentials)
      .where(eq(schema.aiCredentials.organizationId, orgId));
    expect(rows.every((r) => !r.encryptedKey.includes("live"))).toBe(true);
    expect(await stores.credentials.get(orgId, "openai")).toBe("sk-live-abcdef9876");
  });

  test("saving a key reports which of our models it can't use", async () => {
    const ok = await putKey(owner, "anthropic", "sk-ant-live-abcdef5555");
    expect(ok.status).toBe(200);
    expect(await json(ok)).toEqual({
      provider: "anthropic",
      hint: "5555",
      availableModels: 1,
      unavailable: ["claude-sonnet-4-5"],
      automatic: { fast: "anthropic:claude-haiku-4-5", smart: "anthropic:claude-haiku-4-5" },
    });
    await send(main, "/ai/credentials/anthropic", { method: "DELETE", cookie: owner.cookie });
  });

  test("choosing a model uses that provider's saved key, and calls are priced", async () => {
    expect((await patch(owner, { smartModel: "nonsense" })).status).toBe(400);
    await patch(owner, { enabled: true });
    expect(
      (await patch(owner, { smartModel: "openai:gpt-4.1-mini", fastModel: "openai:gpt-4.1-nano" }))
        .status,
    ).toBe(200);
    expect(await settings(viewer)).toMatchObject({
      smartModel: "openai:gpt-4.1-mini",
      active: { smart: { model: "openai:gpt-4.1-mini", ready: true } },
    });

    reply = draftReply;
    keysSeen.length = 0;
    expect((await askDraft()).status).toBe(200);
    expect(keysSeen.at(-1)).toBe("sk-live-abcdef9876");

    const report = await json(await send(main, "/ai/usage?days=7", { cookie: owner.cookie }));
    const row = report.byModel.find((m: { key: string }) => m.key === "openai:gpt-4.1-nano");
    // The draft uses the quick model: 40 in x $0.10/M + 10 out x $0.40/M = 4 + 4 micros.
    expect(row).toMatchObject({
      requests: 1,
      inputTokens: 40,
      outputTokens: 10,
      costMicros: 8,
      known: true,
    });
    expect(report.perDay).toHaveLength(7);
    // Today's calls land on today's bar (a Date-vs-string key mismatch once left it empty).
    expect(report.perDay.at(-1)).toMatchObject({ day: new Date().toISOString().slice(0, 10) });
    expect(report.perDay.at(-1).requests).toBeGreaterThan(0);
  });

  test("a chosen provider without a saved key never borrows another one", async () => {
    await patch(owner, {
      smartModel: "anthropic:claude-sonnet-4-5",
      fastModel: "anthropic:claude-haiku-4-5",
    });
    expect((await settings(owner)).active.smart.ready).toBe(false);
    reply = draftReply;
    keysSeen.length = 0;
    expect((await askDraft()).status).toBe(503);
    expect(keysSeen).toEqual([]); // no key for anthropic: no provider was contacted at all
    // And AI can't be switched on again while it points at a provider with no key.
    await patch(owner, { enabled: false });
    const again = await patch(owner, { enabled: true });
    expect(again.status).toBe(409);
    expect((await json(again)).message).toContain("anthropic");
    await patch(owner, { smartModel: "openai:gpt-4.1-mini", fastModel: "openai:gpt-4.1-nano" });
    expect((await patch(owner, { enabled: true })).status).toBe(200);
  });

  test("a key AI is running on can't be deleted; others can", async () => {
    const del = (p: string) =>
      send(main, `/ai/credentials/${p}`, { method: "DELETE", cookie: owner.cookie });
    expect((await del("openai")).status).toBe(409);
    expect((await del("groq")).status).toBe(200); // unused by the chosen models
    expect(
      (await settings(owner)).credentials.map((c: { provider: string }) => c.provider),
    ).toEqual(["openai"]);
    await patch(owner, { enabled: false });
    expect((await del("openai")).status).toBe(200);
    expect((await settings(owner)).credentials).toEqual([]);
    expect((await settings(owner)).enabled).toBe(false);
  });

  test("Automatic follows what the key can use now, without writing anything to the settings", async () => {
    await patch(owner, { smartModel: null, fastModel: null });
    // Sonnet (the catalog's main model) isn't on this key; Haiku is, so that is what runs.
    await putKey(owner, "anthropic", "sk-ant-live-abcdef7777");
    const s = await settings(owner);
    expect(s).toMatchObject({
      smartModel: null,
      active: {
        smart: { model: "anthropic:claude-haiku-4-5", ready: true },
        fast: { model: "anthropic:claude-haiku-4-5", ready: true },
      },
    });
    const live = await json(await send(main, "/ai/models", { cookie: viewer.cookie }));
    expect(live).toEqual({ anthropic: ["claude-haiku-4-5"] });
    await send(main, "/ai/credentials/anthropic", { method: "DELETE", cookie: owner.cookie });
    expect(await json(await send(main, "/ai/models", { cookie: viewer.cookie }))).toEqual({});
  });

  test("usage window is validated", async () => {
    expect((await send(main, "/ai/usage?days=0", { cookie: owner.cookie })).status).toBe(400);
    expect((await send(main, "/ai/usage?days=500", { cookie: owner.cookie })).status).toBe(400);
    expect((await send(main, "/ai/usage", { cookie: outsider.cookie })).status).toBe(200);
  });

  test("incident triage: members can request it, it needs AI on, queues one job and respects tenancy", async () => {
    const [mon] = await db
      .insert(schema.monitors)
      .values({
        workspaceId: ws,
        name: "T",
        type: "http",
        target: "https://t.example.com",
        interval: 60,
        active: true,
      })
      .returning({ id: schema.monitors.id });
    const [inc] = await db
      .insert(schema.incidents)
      .values({
        workspaceId: ws,
        monitorId: mon!.id,
        type: "uptime",
        status: "open",
        title: "T down",
      })
      .returning({ id: schema.incidents.id });
    const triage = (who: typeof owner) =>
      send(main, `/incident/${inc!.id}/triage`, { method: "POST", cookie: who.cookie, body: "{}" });
    const jobsFor = () =>
      db
        .select()
        .from(schema.jobs)
        .where(sql`${schema.jobs.payload}::text like ${`%${inc!.id}%`}`);

    await patch(owner, { enabled: false });
    const off = await triage(member);
    expect(off.status).toBe(403);
    reply = () => "ok";
    await patch(owner, { smartModel: null, fastModel: null });
    await putKey(owner, "groq", "gsk_live_abcdef1234");
    expect((await patch(owner, { enabled: true })).status).toBe(200);

    expect((await triage(viewer)).status).toBe(403);
    expect((await triage(outsider)).status).toBe(404);
    const ok = await triage(member);
    expect(ok.status).toBe(202);
    expect(await json(ok)).toEqual({ status: "pending" });
    expect((await triage(member)).status).toBe(200); // already pending: no second job
    expect(await jobsFor()).toHaveLength(1);

    const detail = await json(await send(main, `/incident/${inc!.id}`, { cookie: viewer.cookie }));
    expect(detail.aiTriageStatus).toBe("pending");
    await db.delete(schema.jobs).where(sql`${schema.jobs.payload}::text like ${`%${inc!.id}%`}`);
  });

  test("postmortem: only for resolved incidents, can be written by hand without AI, and drafting never silently replaces edits", async () => {
    const [mon] = await db
      .insert(schema.monitors)
      .values({
        workspaceId: ws,
        name: "P",
        type: "http",
        target: "https://p.example.com",
        interval: 60,
        active: true,
      })
      .returning({ id: schema.monitors.id });
    const [inc] = await db
      .insert(schema.incidents)
      .values({
        workspaceId: ws,
        monitorId: mon!.id,
        type: "uptime",
        status: "open",
        title: "P down",
      })
      .returning({ id: schema.incidents.id });
    const path = `/incident/${inc!.id}/postmortem`;
    const call = (who: typeof owner, method: string, body?: object) =>
      send(main, path, {
        method,
        cookie: who.cookie,
        ...(body ? { body: JSON.stringify(body) } : { body: method === "GET" ? undefined : "{}" }),
      });
    const content = {
      customerUpdate: "We had an outage and it is fixed.",
      summary: "s",
      impact: "i",
      rootCause: "Not determined",
      timeline: [{ at: "2026-01-01T00:00:00Z", event: "Started" }],
      contributingFactors: [],
      whatWentWell: [],
      actionItems: [{ title: "Add logs", detail: "d" }],
    };

    expect((await call(member, "POST")).status).toBe(409); // still open
    expect((await call(member, "PUT", content)).status).toBe(409);
    await db
      .update(schema.incidents)
      .set({ status: "resolved", resolvedAt: new Date() })
      .where(eq(schema.incidents.id, inc!.id));

    expect((await call(viewer, "PUT", content)).status).toBe(403);
    expect((await call(outsider, "GET")).status).toBe(404);
    expect((await json(await call(viewer, "GET"))).content).toBeNull();

    // Writing by hand needs no AI at all.
    await patch(owner, { enabled: false });
    expect((await call(member, "PUT", content)).status).toBe(200);
    const saved = await json(await call(viewer, "GET"));
    expect(saved).toMatchObject({
      aiGenerated: false,
      editedBy: member.id,
      content: { summary: "s" },
    });

    expect((await call(member, "POST")).status).toBe(403); // drafting needs AI on
    await patch(owner, { enabled: true });
    const guarded = await call(member, "POST");
    expect(guarded.status).toBe(409);
    expect((await json(guarded)).message).toContain("edited by hand");

    const go = await call(member, "POST", { replace: true, notes: "A deploy went out at 10:00" });
    expect(go.status).toBe(202);
    expect((await json(await call(viewer, "GET"))).status).toBe("pending");
    expect((await call(member, "POST", { replace: true })).status).toBe(200); // already pending
    const queued = await db
      .select()
      .from(schema.jobs)
      .where(sql`${schema.jobs.payload}::text like ${`%${inc!.id}%`}`);
    expect(queued).toHaveLength(1);
    expect(queued[0]!.payload).toEqual({
      kind: "postmortem",
      incidentId: inc!.id,
      notes: "A deploy went out at 10:00",
    });
    // The previous text is still there while the draft is being written.
    expect((await json(await call(viewer, "GET"))).content.summary).toBe("s");
    await db.delete(schema.jobs).where(sql`${schema.jobs.payload}::text like ${`%${inc!.id}%`}`);
  });

  test("incident groups: visible to the organization only; a summary can be requested by members when AI is on", async () => {
    const mk = async (name: string) => {
      const [m] = await db
        .insert(schema.monitors)
        .values({
          workspaceId: ws,
          name,
          type: "http",
          target: `https://${name}.g.example.com`,
          interval: 60,
          active: true,
        })
        .returning({ id: schema.monitors.id });
      return m!.id;
    };
    const [g] = await db
      .insert(schema.incidentGroups)
      .values({ workspaceId: ws, sharedKey: "domain:g.example.com" })
      .returning({ id: schema.incidentGroups.id });
    const ids: string[] = [];
    for (const n of ["g1", "g2"]) {
      const [i] = await db
        .insert(schema.incidents)
        .values({
          workspaceId: ws,
          monitorId: await mk(n),
          type: "uptime",
          status: "open",
          title: `${n} down`,
          groupId: g!.id,
        })
        .returning({ id: schema.incidents.id });
      ids.push(i!.id);
    }
    const get = (who: typeof owner) =>
      send(main, `/incident/group/${g!.id}`, { cookie: who.cookie });
    const body = await json(await get(viewer));
    expect(body).toMatchObject({ sharedKey: "domain:g.example.com" });
    expect(body.members.map((m: { title: string }) => m.title)).toEqual(["g1 down", "g2 down"]);
    expect((await get(outsider)).status).toBe(404);
    const detail = await json(await send(main, `/incident/${ids[0]}`, { cookie: viewer.cookie }));
    expect(detail.group).toMatchObject({ id: g!.id, size: 2 });

    const ask = (who: typeof owner) =>
      send(main, `/incident/group/${g!.id}/summary`, {
        method: "POST",
        cookie: who.cookie,
        body: "{}",
      });
    expect((await ask(viewer)).status).toBe(403);
    await patch(owner, { enabled: false });
    expect((await ask(member)).status).toBe(403);
    await patch(owner, { enabled: true });
    expect((await ask(member)).status).toBe(202);
    expect((await ask(member)).status).toBe(200); // already pending
    await db.delete(schema.jobs).where(sql`${schema.jobs.payload}::text like ${`%${g!.id}%`}`);
  });

  test("discovery classify: needs AI on and the member role, marks live new hosts pending and queues one job", async () => {
    const [asset] = await db
      .insert(schema.assets)
      .values({
        workspaceId: ws,
        kind: "domain",
        value: "disc.example.com",
        verificationToken: "t",
      })
      .returning({ id: schema.assets.id });
    await db.insert(schema.discoveredHosts).values(
      [
        { host: "live.disc.example.com", resolves: true },
        { host: "dead.disc.example.com", resolves: false },
      ].map((h) => ({ workspaceId: ws, parentAssetId: asset!.id, source: "test", ...h })),
    );
    const ask = (who: typeof owner, workspaceId = ws) =>
      send(main, "/discovery/classify", {
        method: "POST",
        cookie: who.cookie,
        body: JSON.stringify({ workspaceId }),
      });
    expect((await ask(viewer)).status).toBe(403);
    expect((await ask(outsider)).status).toBe(404);
    await patch(owner, { enabled: false });
    expect((await ask(member)).status).toBe(403);
    await patch(owner, { enabled: true });
    const res = await ask(member);
    expect(res.status).toBe(202);
    expect(await json(res)).toEqual({ queued: 1 });
    const list = await json(
      await send(main, `/discovery?workspaceId=${ws}`, { cookie: viewer.cookie }),
    );
    const byHost = Object.fromEntries(list.map((h: { host: string }) => [h.host, h]));
    expect(byHost["live.disc.example.com"].aiStatus).toBe("pending");
    expect(byHost["dead.disc.example.com"].aiStatus).toBeNull();
    const jobs = await db
      .select()
      .from(schema.jobs)
      .where(sql`${schema.jobs.payload}::text like ${`%${ws}%`} and ${schema.jobs.queue} = 'ai'`);
    expect(jobs.filter((j) => (j.payload as any).kind === "classify-hosts")).toHaveLength(1);
    await db.delete(schema.jobs).where(sql`${schema.jobs.payload}::text like ${`%${ws}%`}`);
  });
});
