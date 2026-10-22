import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { createDbStores, createGateway } from "@upzy/ai";
import { createDb, schema } from "@upzy/db";
import type { LanguageModel } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { eq, sql } from "drizzle-orm";

import { handleGroupSummary } from "../src/roles/agent";
import { correlationKeys, handleCorrelate, sharedKey, WINDOW_MS } from "../src/roles/correlator";
import { CONFIG, ENC_KEY, saveGroqKey } from "./ai-helpers";

// Needs a migrated Postgres: DATABASE_URL=... bun test
const url = process.env.DATABASE_URL;
const run = url ? describe : describe.skip;

describe("correlation keys", () => {
  test("addresses come first, then the site", () => {
    expect(correlationKeys("api.shop.example.com", ["1.1.1.1", "2.2.2.2"])).toEqual([
      "ip:1.1.1.1",
      "ip:2.2.2.2",
      "domain:example.com",
    ]);
    expect(correlationKeys(null, ["1.1.1.1"])).toEqual([]);
    expect(correlationKeys("x.example.com", [])).toEqual(["domain:example.com"]);
  });

  test("the shared key is the most specific one in common", () => {
    expect(sharedKey(["ip:1.1.1.1", "domain:a.com"], ["domain:a.com", "ip:1.1.1.1"])).toBe(
      "ip:1.1.1.1",
    );
    expect(sharedKey(["domain:a.com"], ["domain:b.com"])).toBeUndefined();
  });
});

run("correlator (postgres)", () => {
  const db = createDb(url);
  const {
    organizations,
    workspaces,
    monitors,
    incidents,
    incidentGroups,
    aiSettings,
    jobs,
    monitorChecks,
  } = schema;
  const tag = `co${Date.now()}`;
  const orgId = `${tag}-org`;
  let ws = "";
  const base = Date.now() - 60 * 60_000;
  const addrs: Record<string, string[]> = {};
  const deps = { addresses: async (h: string) => addrs[h] ?? [] };
  let seq = 0;

  const open = async (
    host: string,
    ip: string[] | null,
    minutesAfter: number,
    status: "open" | "resolved" = "open",
  ) => {
    addrs[host] = ip ?? [];
    const [m] = await db
      .insert(monitors)
      .values({
        workspaceId: ws,
        name: host,
        type: "http",
        target: `https://${host}`,
        interval: 60,
        active: true,
      })
      .returning({ id: monitors.id });
    const [i] = await db
      .insert(incidents)
      .values({
        workspaceId: ws,
        monitorId: m!.id,
        type: "uptime",
        status,
        title: `${host} down`,
        createdAt: new Date(base + minutesAfter * 60_000 + seq++),
        ...(status === "resolved" ? { resolvedAt: new Date() } : {}),
      })
      .returning({ id: incidents.id });
    await db.insert(monitorChecks).values({
      monitorId: m!.id,
      status: "down",
      errorKind: "timeout",
      error: "Request timed out",
    });
    return i!.id;
  };
  const group = async (id: string) =>
    (await db.select({ g: incidents.groupId }).from(incidents).where(eq(incidents.id, id)))[0]!.g;

  beforeAll(async () => {
    await db
      .insert(organizations)
      .values({ id: orgId, name: "Co", slug: orgId, createdAt: new Date() });
    await saveGroqKey(db, orgId);
    ws = (
      await db.insert(workspaces).values({ orgId, name: "Prod" }).returning({ id: workspaces.id })
    )[0]!.id;
  });
  afterAll(async () => {
    await db.delete(organizations).where(eq(organizations.id, orgId));
    await db.delete(jobs).where(sql`${jobs.payload}::text like ${`%${ws}%`}`);
  });

  test("a lone incident is not grouped, but its keys are stored", async () => {
    const a = await open("lone.alone-example.org", ["9.9.9.9"], 0);
    expect(await handleCorrelate(db, a, deps)).toBeNull();
    expect(await group(a)).toBeNull();
    const [r] = await db
      .select({ k: incidents.correlationKeys })
      .from(incidents)
      .where(eq(incidents.id, a));
    expect(r!.k).toEqual(["ip:9.9.9.9", "domain:alone-example.org"]);
  });

  test("incidents on one site that open together are grouped, and a third joins the same group", async () => {
    const a = await open("a.shop-example.com", ["1.1.1.1"], 10);
    const b = await open("b.shop-example.com", ["2.2.2.2"], 11);
    expect(await handleCorrelate(db, a, deps)).toBeNull();
    const first = await handleCorrelate(db, b, deps);
    expect(first).toMatchObject({ size: 2, reason: "domain:shop-example.com" });
    const c = await open("c.shop-example.com", ["3.3.3.3"], 12);
    const second = await handleCorrelate(db, c, deps);
    expect(second).toMatchObject({ size: 3, groupId: first!.groupId });
    expect(await group(a)).toBe(first!.groupId);
  });

  test("sharing an IP address groups different sites, and the address is the stated reason", async () => {
    const a = await open("one.cdn-a-example.com", ["5.5.5.5"], 20);
    const b = await open("two.cdn-b-example.net", ["5.5.5.5"], 21);
    await handleCorrelate(db, a, deps);
    expect(await handleCorrelate(db, b, deps)).toMatchObject({ size: 2, reason: "ip:5.5.5.5" });
  });

  test("outside the window, resolved, or unrelated incidents are not pulled in", async () => {
    const late = await open("late.late-example.com", ["7.7.7.7"], 30);
    const stale = await open("stale.late-example.com", ["7.7.7.7"], 30 + WINDOW_MS / 60_000 + 3);
    const done = await open("done.late-example.com", ["7.7.7.7"], 31, "resolved");
    const other = await open("other.else-example.com", ["8.8.8.8"], 31);
    await handleCorrelate(db, done, deps);
    await handleCorrelate(db, other, deps);
    expect(await handleCorrelate(db, late, deps)).toBeNull();
    expect(await handleCorrelate(db, stale, deps)).toBeNull();
    for (const id of [late, stale, other]) expect(await group(id)).toBeNull();
  });

  test("two incidents correlated at the same moment end up in exactly one group", async () => {
    const a = await open("a.race-example.com", ["4.4.4.4"], 40);
    const b = await open("b.race-example.com", ["4.4.4.5"], 40);
    await Promise.all([handleCorrelate(db, a, deps), handleCorrelate(db, b, deps)]);
    const ga = await group(a);
    expect(ga).not.toBeNull();
    expect(await group(b)).toBe(ga);
    const groups = await db.select().from(incidentGroups).where(eq(incidentGroups.id, ga!));
    expect(groups).toHaveLength(1);
  });

  test("a new incident that links two existing groups folds them into the oldest", async () => {
    const x1 = await open("x1.fold-x-example.com", ["10.0.0.1"], 50);
    const x2 = await open("x2.fold-x-example.com", ["10.0.0.2"], 50);
    const y1 = await open("y1.fold-y-example.com", ["10.0.1.1"], 51);
    const y2 = await open("y2.fold-y-example.com", ["10.0.1.2"], 51);
    await handleCorrelate(db, x1, deps);
    const gx = await handleCorrelate(db, x2, deps);
    await handleCorrelate(db, y1, deps);
    const gy = await handleCorrelate(db, y2, deps);
    expect(gx!.groupId).not.toBe(gy!.groupId);
    // Bridges both: shares the X site's address and the Y site's address.
    const z = await open("z.fold-z-example.com", ["10.0.0.1", "10.0.1.1"], 52);
    const merged = await handleCorrelate(db, z, deps);
    expect(merged).toMatchObject({ size: 5, groupId: gx!.groupId });
    for (const id of [x1, x2, y1, y2, z]) expect(await group(id)).toBe(gx!.groupId);
  });

  describe("AI summary", () => {
    const SUMMARY = {
      headline: "Three services on one site are down",
      summary: "All three failed with timeouts at the same time.",
      likelyCause: "network",
      confidence: "high",
      evidence: [
        { ref: "E1", note: "grouped by shared site" },
        { ref: "E2", note: "same timeout" },
      ],
      suggestedActions: [{ title: "Check the shared host", detail: "Is it reachable?" }],
      unknowns: [],
    };
    const gatewayFor = (reply: () => string) =>
      createGateway({
        config: CONFIG,
        stores: createDbStores(db, { dailyTokenBudget: 1000, encryptionKey: ENC_KEY }),
        modelFactory: () =>
          new MockLanguageModelV4({
            doGenerate: async () => ({
              content: [{ type: "text" as const, text: reply() }],
              finishReason: { unified: "stop" as const, raw: undefined },
              usage: {
                inputTokens: { total: 5, noCache: 5, cacheRead: undefined, cacheWrite: undefined },
                outputTokens: { total: 5, text: 5, reasoning: undefined },
              },
              warnings: [],
            }),
          }) as LanguageModel,
      });
    const newGroup = async (suffix: string) => {
      const a = await open(`a.sum-${suffix}.com`, [], 100);
      const b = await open(`b.sum-${suffix}.com`, [], 100);
      await handleCorrelate(db, a, deps);
      const r = await handleCorrelate(db, b, deps);
      return r!.groupId;
    };
    const aiJobs = (id: string) =>
      db
        .select()
        .from(jobs)
        .where(sql`${jobs.queue} = 'ai' and ${jobs.payload}::text like ${`%${id}%`}`);

    test("no job is queued while AI is off; one is queued per group size once it is on", async () => {
      const off = await newGroup("off");
      expect(await aiJobs(off)).toHaveLength(0);
      await db.insert(aiSettings).values({ organizationId: orgId, enabled: true });
      const on = await newGroup("on");
      const queued = await aiJobs(on);
      expect(queued).toHaveLength(1);
      expect(queued[0]!.payload).toEqual({ kind: "group-summary", groupId: on });
      const [g] = await db.select().from(incidentGroups).where(eq(incidentGroups.id, on));
      expect(g!.summaryStatus).toBe("pending");
    });

    test("the summary is stored with the facts it cited", async () => {
      const id = await newGroup("store");
      await handleGroupSummary(
        db,
        gatewayFor(() => JSON.stringify(SUMMARY)),
        id,
        false,
      );
      const [g] = await db.select().from(incidentGroups).where(eq(incidentGroups.id, id));
      expect(g!.summaryStatus).toBeNull();
      const s = g!.summary as any;
      expect(s.headline).toBe(SUMMARY.headline);
      expect(s.size).toBe(2);
      expect(s.facts.map((f: { kind: string }) => f.kind)).toEqual([
        "grouping",
        "member",
        "member",
        "workspace",
      ]);
      expect(s.facts[1].text).toContain("timeout");
    });

    test("a provider failure is recorded on the group on the last attempt", async () => {
      const id = await newGroup("fail");
      await handleGroupSummary(
        db,
        gatewayFor(() => "nope"),
        id,
        true,
      );
      const [g] = await db.select().from(incidentGroups).where(eq(incidentGroups.id, id));
      expect(g!.summaryStatus).toBe("failed");
      expect(g!.summaryError).toContain("unavailable");
    });
  });
});
