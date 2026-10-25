import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { createDbStores, createGateway } from "@upzy/ai";
import { createDb, rebuildRollups, schema } from "@upzy/db";
import { APICallError, type LanguageModel } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { and, eq, sql } from "drizzle-orm";

import { computeDigestStats, weekStartOf } from "../src/digest-stats";
import { handleDigest, handleExplain, renderDigest, scheduleDigests } from "../src/roles/agent";
import { CONFIG, ENC_KEY, saveGroqKey } from "./ai-helpers";

// Needs a migrated Postgres: DATABASE_URL=... bun test
const url = process.env.DATABASE_URL;
const run = url ? describe : describe.skip;

const EXPLANATION = {
  summary: "No HSTS.",
  impact: "Downgrade attacks.",
  exploitability: "Needs a network position.",
  steps: [{ title: "Add header", detail: "Send HSTS." }],
  snippets: [],
  caveats: [],
  confidence: "high",
};
const NARRATIVE = {
  headline: "Quiet week",
  summary: "All good.",
  highlights: ["No outages"],
  actions: [],
};

const usage = {
  inputTokens: { total: 50, noCache: 50, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 25, text: 25, reasoning: undefined },
};
const model = (reply: (n: number) => string | Error) => {
  let n = 0;
  const calls: string[] = [];
  const m = new MockLanguageModelV4({
    doGenerate: async (o) => {
      const r = reply(n++);
      calls.push(JSON.stringify(o.prompt));
      if (r instanceof Error) throw r;
      return {
        content: [{ type: "text" as const, text: r }],
        finishReason: { unified: "stop" as const, raw: undefined },
        usage,
        warnings: [],
      };
    },
  });
  return { m: m as LanguageModel, calls };
};

run("AI agent (postgres)", () => {
  const db = createDb(url);
  const {
    organizations,
    users,
    members,
    workspaces,
    assets,
    findings,
    monitors,
    monitorChecks,
    incidents,
    aiSettings,
    aiUsage,
    digestRuns,
    jobs,
  } = schema;
  const tag = `ag${Date.now()}`;
  const orgId = `${tag}-org`;
  let ws = "",
    assetId = "",
    findingId = "",
    monitorId = "";
  const gatewayFor = (reply: (n: number) => string | Error) => {
    const { m, calls } = model(reply);
    return {
      calls,
      gateway: createGateway({
        config: CONFIG,
        stores: createDbStores(db, { dailyTokenBudget: 1000, encryptionKey: ENC_KEY }),
        modelFactory: (s) => (s.provider === "groq" ? m : null),
      }),
    };
  };
  const finding = async () =>
    (await db.select().from(findings).where(eq(findings.id, findingId)))[0]!;

  beforeAll(async () => {
    await db
      .insert(organizations)
      .values({ id: orgId, name: "Agent Org", slug: orgId, createdAt: new Date() });
    await saveGroqKey(db, orgId);
    for (const [name, role] of [
      ["owner", "owner"],
      ["admin", "admin"],
      ["member", "member"],
      ["viewer", "viewer"],
    ] as const) {
      await db
        .insert(users)
        .values({ id: `${tag}-${name}`, name, email: `${tag}-${name}@example.com` });
      await db.insert(members).values({
        id: `${tag}-m-${name}`,
        organizationId: orgId,
        userId: `${tag}-${name}`,
        role,
        createdAt: new Date(),
      });
    }
    ws = (
      await db.insert(workspaces).values({ orgId, name: "Prod" }).returning({ id: workspaces.id })
    )[0]!.id;
    assetId = (
      await db
        .insert(assets)
        .values({
          workspaceId: ws,
          kind: "domain",
          value: "agent.example.com",
          verificationToken: "t",
        })
        .returning({ id: assets.id })
    )[0]!.id;
    findingId = (
      await db
        .insert(findings)
        .values({
          workspaceId: ws,
          assetId,
          checkKey: "headers.hsts_missing",
          fingerprint: `${tag}-fp`,
          severity: "medium",
          title: `HSTS missing ${tag}`,
          description: "d",
          remediation: "r",
          evidence: { note: tag },
          aiExplainStatus: "pending",
        })
        .returning({ id: findings.id })
    )[0]!.id;
    monitorId = (
      await db
        .insert(monitors)
        .values({
          workspaceId: ws,
          name: "API",
          type: "http",
          target: "https://agent.example.com",
          interval: 60,
          active: true,
        })
        .returning({ id: monitors.id })
    )[0]!.id;
  });
  afterAll(async () => {
    await db.delete(organizations).where(eq(organizations.id, orgId));
    await db.delete(users).where(sql`${users.id} like ${`${tag}-%`}`);
    await db.delete(jobs).where(sql`${jobs.payload}::text like ${`%${ws}%`}`);
  });

  const enable = (over: Partial<typeof aiSettings.$inferInsert> = {}) =>
    db
      .insert(aiSettings)
      .values({ organizationId: orgId, enabled: true, ...over })
      .onConflictDoUpdate({
        target: aiSettings.organizationId,
        set: { enabled: true, dailyTokenBudget: 200_000, ...over },
      });
  const disable = () =>
    db.update(aiSettings).set({ enabled: false }).where(eq(aiSettings.organizationId, orgId));

  describe("explain finding", () => {
    test("off by default: the failure is recorded on the finding and nothing is sent", async () => {
      const { gateway, calls } = gatewayFor(() => JSON.stringify(EXPLANATION));
      await handleExplain(db, gateway, findingId, false);
      const f = await finding();
      expect(f.aiExplainStatus).toBe("failed");
      expect(f.aiExplainError).toContain("turned off");
      expect(f.aiExplanation).toBeNull();
      expect(calls).toHaveLength(0);
    });

    test("stores the explanation, clears the pending flag and records usage", async () => {
      await enable();
      const { gateway, calls } = gatewayFor(() => JSON.stringify(EXPLANATION));
      await handleExplain(db, gateway, findingId, false);
      const f = await finding();
      expect(f.aiExplainStatus).toBeNull();
      expect(f.aiExplanation).toMatchObject({
        summary: "No HSTS.",
        model: "groq/llama-3.3-70b-versatile",
        cached: false,
      });
      expect(f.aiExplainedAt).not.toBeNull();
      expect(calls).toHaveLength(1);
      const [u] = await db
        .select()
        .from(aiUsage)
        .where(and(eq(aiUsage.organizationId, orgId), eq(aiUsage.feature, "explain-finding")));
      expect(u).toMatchObject({
        provider: "groq",
        model: "llama-3.3-70b-versatile",
        requests: 1,
        inputTokens: 50,
        outputTokens: 25,
      });
    });

    test("an identical finding is answered from the cache without a provider call", async () => {
      const { gateway, calls } = gatewayFor(() => JSON.stringify(EXPLANATION));
      await handleExplain(db, gateway, findingId, false);
      expect(calls).toHaveLength(0);
      expect((await finding()).aiExplanation).toMatchObject({ cached: true });
    });

    test("provider trouble retries while attempts remain, then records a friendly failure", async () => {
      await enable();
      await db
        .update(findings)
        .set({
          aiExplanation: null,
          aiExplainStatus: "pending",
          title: `HSTS missing ${tag} (second)`,
        })
        .where(eq(findings.id, findingId));
      const down = () =>
        new APICallError({
          message: "x",
          url: "https://p",
          requestBodyValues: {},
          statusCode: 503,
          isRetryable: true,
        });
      const { gateway } = gatewayFor(() => down());
      await expect(handleExplain(db, gateway, findingId, false)).rejects.toThrow();
      expect((await finding()).aiExplainStatus).toBe("pending");
      await handleExplain(db, gateway, findingId, true);
      const f = await finding();
      expect(f.aiExplainStatus).toBe("failed");
      expect(f.aiExplainError).toContain("unavailable");
    });

    test("an exhausted daily budget is a permanent failure with a clear message", async () => {
      await enable({ dailyTokenBudget: 1 });
      await db
        .update(findings)
        .set({ aiExplainStatus: "pending", title: `HSTS missing ${tag} (third)` })
        .where(eq(findings.id, findingId));
      const { gateway, calls } = gatewayFor(() => JSON.stringify(EXPLANATION));
      await handleExplain(db, gateway, findingId, false);
      expect((await finding()).aiExplainError).toContain("budget");
      expect(calls).toHaveLength(0);
      await enable({ dailyTokenBudget: 200_000 });
    });

    test("KEV/EPSS from CVE evidence reach the prompt", async () => {
      await db
        .update(findings)
        .set({
          aiExplanation: null,
          title: `nginx has CVEs ${tag}`,
          evidence: { run: tag, cves: [{ id: "CVE-1", kev: true, epss: 0.91 }] },
        })
        .where(eq(findings.id, findingId));
      const { gateway, calls } = gatewayFor(() => JSON.stringify(EXPLANATION));
      await handleExplain(db, gateway, findingId, false);
      expect(calls[0]).toContain("Known Exploited");
      expect(calls[0]).toContain("91.0%");
    });
  });

  describe("weekly digest", () => {
    const monday = weekStartOf(new Date("2026-10-14T12:00:00Z")); // Wednesday -> Monday 2026-10-12
    const at = (d: string) => new Date(`${d}Z`);

    test("weekStartOf finds the Monday for any weekday", () => {
      expect(monday).toBe("2026-10-12");
      expect(weekStartOf(new Date("2026-10-12T00:00:00Z"))).toBe("2026-10-12");
      expect(weekStartOf(new Date("2026-10-18T23:59:59Z"))).toBe("2026-10-12");
      expect(weekStartOf(new Date("2026-10-19T00:00:00Z"))).toBe("2026-10-19");
    });

    test("statistics cover the previous full week and nothing outside it", async () => {
      await db.insert(monitorChecks).values([
        { monitorId, status: "up", responseMs: 100, createdAt: at("2026-10-06T10:00:00") },
        { monitorId, status: "up", responseMs: 300, createdAt: at("2026-10-07T10:00:00") },
        { monitorId, status: "down", responseMs: null, createdAt: at("2026-10-08T10:00:00") },
        { monitorId, status: "up", responseMs: 200, createdAt: at("2026-10-09T10:00:00") },
        { monitorId, status: "down", responseMs: null, createdAt: at("2026-09-30T10:00:00") }, // before the window
        { monitorId, status: "down", responseMs: null, createdAt: at("2026-10-12T10:00:00") }, // after the window
      ]);
      await rebuildRollups(db, monitorId);
      await db.insert(incidents).values({
        workspaceId: ws,
        monitorId,
        type: "uptime",
        status: "resolved",
        title: "down",
        createdAt: at("2026-10-08T09:50:00"),
        resolvedAt: at("2026-10-08T10:20:00"),
      });
      const stats = await computeDigestStats(db, ws, monday);
      expect(stats.periodStart).toBe("2026-10-05");
      expect(stats.periodEnd).toBe("2026-10-11");
      expect(stats.monitors).toEqual([{ name: "API", uptime: 0.75, avgMs: 200, checks: 4 }]);
      expect(stats.incidents).toMatchObject({ opened: 1, resolved: 1, totalDowntimeMinutes: 30 });
      expect(stats.findings.open).toBeGreaterThanOrEqual(1);
      expect(stats.findings.topOpen[0]).toMatchObject({ asset: "agent.example.com" });
    });

    test("nothing is scheduled for organizations without AI, or before Monday 07:00 UTC", async () => {
      await disable();
      expect(await scheduleDigests(db, at("2026-10-14T09:00:00"))).toBe(0);
      await enable();
      expect(await scheduleDigests(db, at("2026-10-12T06:59:00"))).toBe(0);
    });

    test("one digest per workspace per week, even when scheduled repeatedly", async () => {
      expect(await scheduleDigests(db, at("2026-10-14T09:00:00"))).toBe(1);
      expect(await scheduleDigests(db, at("2026-10-14T09:10:00"))).toBe(0);
      expect(await db.select().from(digestRuns).where(eq(digestRuns.workspaceId, ws))).toHaveLength(
        1,
      );
      expect(await scheduleDigests(db, at("2026-10-20T09:00:00"))).toBe(1); // next week
    });

    const emailsFor = async () =>
      (
        await db.execute<{ payload: { to: string; subject: string; text: string } }>(
          sql`select payload from jobs where queue = 'email' and payload->>'subject' like 'Your weekly Upzy summary%' and payload->>'to' like ${`${tag}-%`}`,
        )
      ).map((r) => r.payload);

    test("goes to owners and admins only, with the AI narrative and the real numbers", async () => {
      const { gateway, calls } = gatewayFor(() => JSON.stringify(NARRATIVE));
      await handleDigest(db, gateway, "http://app.test", ws, monday);
      const mails = await emailsFor();
      expect(mails.map((m) => m.to).sort()).toEqual([
        `${tag}-admin@example.com`,
        `${tag}-owner@example.com`,
      ]);
      expect(mails[0]!.text).toContain("Quiet week");
      expect(mails[0]!.text).toContain("API: 75.00%");
      expect(mails[0]!.text).toContain("http://app.test/monitors");
      expect(calls).toHaveLength(1);
      expect(calls[0]).toContain("untrusted_data");
      const [run] = await db
        .select()
        .from(digestRuns)
        .where(and(eq(digestRuns.workspaceId, ws), eq(digestRuns.weekStart, monday)));
      expect(run).toMatchObject({ recipients: 2, usedAi: true });
    });

    test("fails soft: with AI unavailable the digest still goes out, without prose", async () => {
      await db.delete(jobs).where(sql`queue = 'email' and payload->>'to' like ${`${tag}-%`}`);
      const { gateway } = gatewayFor(
        () =>
          new APICallError({
            message: "x",
            url: "https://p",
            requestBodyValues: {},
            statusCode: 500,
            isRetryable: true,
          }),
      );
      await handleDigest(db, gateway, "http://app.test", ws, monday);
      const mails = await emailsFor();
      expect(mails).toHaveLength(2);
      expect(mails[0]!.text).not.toContain("Quiet week");
      expect(mails[0]!.text).toContain("API: 75.00%");
      const [run] = await db
        .select()
        .from(digestRuns)
        .where(and(eq(digestRuns.workspaceId, ws), eq(digestRuns.weekStart, monday)));
      expect(run!.usedAi).toBe(false);
    });
  });
});

describe("renderDigest", () => {
  const stats = {
    workspace: "Prod",
    periodStart: "2026-10-05",
    periodEnd: "2026-10-11",
    monitors: [{ name: "API", uptime: null, avgMs: null, checks: 0 }],
    incidents: { opened: 0, resolved: 0, stillOpen: 0, totalDowntimeMinutes: 0 },
    findings: { new: 0, resolved: 0, open: 0, topOpen: [] },
  };
  test("works with no narrative and no data", () => {
    const t = renderDigest(stats, null, "https://app");
    expect(t).toContain("API: no data");
    expect(t).toContain("0 opened");
    expect(t).not.toContain("Worth doing");
  });
  test("includes highlights and actions when present", () => {
    const t = renderDigest(
      stats,
      { headline: "H", summary: "S", highlights: ["a"], actions: ["do x"] },
      "https://app",
    );
    expect(t).toContain("- a");
    expect(t).toContain("Worth doing:\n- do x");
  });
});
