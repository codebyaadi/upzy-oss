import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import {
  LATENCY_EDGES,
  createDb,
  histogramPercentile,
  latencyBucket,
  rebuildRollups,
  rollupSeries,
  rollupSummary,
  rollupTotals,
  schema,
} from "@upzy/db";
import type { runProbe } from "@upzy/probes";
import { eq, sql } from "drizzle-orm";

import { handleCheck } from "../src/roles/prober";
import { parseRetention, purgeOldRows } from "../src/roles/retention";

type Probe = typeof runProbe;
const answering =
  (ms: number | null): Probe =>
  async () =>
    ms === null
      ? { status: "down", responseMs: null, error: "refused", errorKind: "refused" }
      : { status: "up", responseMs: ms };

describe("latency histogram (no database)", () => {
  test("a response goes in the first bucket whose edge is above it", () => {
    expect(latencyBucket(0)).toBe(0);
    expect(latencyBucket(24)).toBe(0);
    expect(latencyBucket(25)).toBe(1);
    expect(latencyBucket(4999)).toBe(LATENCY_EDGES.length - 1);
    expect(latencyBucket(5000)).toBe(LATENCY_EDGES.length);
    expect(latencyBucket(120_000)).toBe(LATENCY_EDGES.length);
  });

  test("the percentile lands in the right bucket and stays inside what was observed", () => {
    const counts = new Array(16).fill(0);
    // 95 fast responses (60 to 70 ms) and 5 slow ones (600 to 700 ms).
    counts[latencyBucket(65)] = 95;
    counts[latencyBucket(650)] = 5;
    const p95 = histogramPercentile(counts, 0.95, 60, 700)!;
    expect(p95).toBeGreaterThanOrEqual(50);
    expect(p95).toBeLessThanOrEqual(75);
    const p99 = histogramPercentile(counts, 0.99, 60, 700)!;
    expect(p99).toBeGreaterThanOrEqual(500);
    expect(p99).toBeLessThanOrEqual(700);
    expect(histogramPercentile(new Array(16).fill(0), 0.95, null, null)).toBeNull();
  });

  test("the slowest bucket is bounded by the observed maximum", () => {
    const counts = new Array(16).fill(0);
    counts[15] = 4;
    expect(histogramPercentile(counts, 0.95, 7000, 9000)).toBeLessThanOrEqual(9000);
    expect(histogramPercentile(counts, 0.95, 7000, 9000)).toBeGreaterThanOrEqual(5000);
  });
});

const url = process.env.DATABASE_URL;
const run = url ? describe : describe.skip;

run("check rollups (postgres)", () => {
  const db = createDb(url);
  const { organizations, workspaces, monitors, monitorChecks, monitorCheckRollups } = schema;
  const orgId = `ru-org-${Date.now()}`;
  let ws = "";

  beforeAll(async () => {
    await db
      .insert(organizations)
      .values({ id: orgId, name: "t", slug: orgId, createdAt: new Date() });
    ws = (
      await db.insert(workspaces).values({ orgId, name: "w" }).returning({ id: workspaces.id })
    )[0]!.id;
  });
  afterAll(async () => {
    await db.delete(organizations).where(eq(organizations.id, orgId));
  });

  const make = async (over: Partial<typeof monitors.$inferInsert> = {}) =>
    (
      await db
        .insert(monitors)
        .values({
          workspaceId: ws,
          name: "m",
          type: "http",
          target: "https://example.com",
          interval: 60,
          active: true,
          failureThreshold: 2,
          regions: ["eu-west", "us-east"],
          ...over,
        })
        .returning()
    )[0]!;

  /** What a query over the raw checks says, to compare the rollups against. */
  const raw = async (monitorId: string) => {
    const [r] = [
      ...(await db.execute<{
        total: number;
        up: number;
        avg_ms: number | null;
        p95: number | null;
      }>(
        sql`select count(*)::int as total, count(*) filter (where status = 'up')::int as up,
                   round(avg(response_ms))::int as avg_ms,
                   percentile_cont(0.95) within group (order by response_ms) as p95
            from monitor_checks where monitor_id = ${monitorId}`,
      )),
    ];
    return r!;
  };

  test("every check the prober stores is counted, and the totals match the raw checks", async () => {
    const m = await make();
    const latencies = [30, 45, 80, 120, 120, 180, 250, 350, 480, 900, 1200, 2500, null, 40, 60];
    for (const [i, ms] of latencies.entries())
      await handleCheck(
        db,
        { monitorId: m.id, region: i % 2 ? "eu-west" : "us-east" },
        {
          probe: answering(ms),
        },
      );

    const r = await raw(m.id);
    const t = (await rollupTotals(db, [m.id], new Date(Date.now() - 3_600_000))).get(m.id)!;
    expect(t.total).toBe(r.total);
    expect(t.up).toBe(r.up);
    expect(t.avgMs).toBe(r.avg_ms);

    const s = await rollupSummary(db, m.id, new Date(Date.now() - 3_600_000));
    expect(s.total).toBe(15);
    // Percentile definitions differ (the database interpolates, the histogram counts ranks), and the histogram is only
    // as fine as its buckets: the two agree to within the bucket either side of the exact value.
    const exact = Number(r.p95);
    const bucket = latencyBucket(exact);
    const lo = bucket <= 1 ? 0 : LATENCY_EDGES[bucket - 2]!;
    const hi = bucket + 1 < LATENCY_EDGES.length ? LATENCY_EDGES[bucket + 1]! : 99_999;
    expect(s.p95Ms!).toBeGreaterThanOrEqual(lo);
    expect(s.p95Ms!).toBeLessThanOrEqual(hi);

    const series = await rollupSeries(db, m.id, new Date(Date.now() - 3_600_000), "15 minutes");
    expect(series.reduce((n, p) => n + p.total, 0)).toBe(15);
  });

  test("each region has its own bucket, and the monitor remembers when it was last checked", async () => {
    const m = await make();
    await handleCheck(db, { monitorId: m.id, region: "eu-west" }, { probe: answering(100) });
    await handleCheck(db, { monitorId: m.id, region: "us-east" }, { probe: answering(100) });
    const rows = await db
      .select()
      .from(monitorCheckRollups)
      .where(eq(monitorCheckRollups.monitorId, m.id));
    expect(rows.map((r) => r.region).sort()).toEqual(["eu-west", "us-east"]);
    const [fresh] = await db.select().from(monitors).where(eq(monitors.id, m.id));
    expect(fresh!.lastCheckAt).not.toBeNull();
    expect(Date.now() - fresh!.lastCheckAt!.getTime()).toBeLessThan(10_000);
  });

  test("a failed check counts toward the total but not toward uptime or latency", async () => {
    const m = await make({ regions: [] });
    await handleCheck(db, { monitorId: m.id }, { probe: answering(100) });
    await handleCheck(db, { monitorId: m.id }, { probe: answering(null) });
    const t = (await rollupTotals(db, [m.id], new Date(Date.now() - 3_600_000))).get(m.id)!;
    expect(t).toEqual({ total: 2, up: 1, avgMs: 100 });
  });

  test("rebuilding from the stored checks gives exactly the rollups the prober wrote", async () => {
    const m = await make();
    for (const ms of [20, 70, 70, 400, 1800, null, 60])
      await handleCheck(db, { monitorId: m.id, region: "eu-west" }, { probe: answering(ms) });
    const before = await db
      .select()
      .from(monitorCheckRollups)
      .where(eq(monitorCheckRollups.monitorId, m.id));
    await rebuildRollups(db, m.id);
    const after = await db
      .select()
      .from(monitorCheckRollups)
      .where(eq(monitorCheckRollups.monitorId, m.id));
    expect(after).toEqual(before);
  });

  test("the monitor keeps its last response time, and the last certificate days-left any check saw", async () => {
    const m = await make({ regions: [] });
    const withCert: Probe = async () => ({ status: "up", responseMs: 120, tlsDaysLeft: 41 });
    const withoutCert: Probe = async () => ({ status: "up", responseMs: 80 });
    await handleCheck(db, { monitorId: m.id }, { probe: withCert });
    await handleCheck(db, { monitorId: m.id }, { probe: withoutCert });
    const [row] = await db.select().from(monitors).where(eq(monitors.id, m.id));
    expect(row!.lastResponseMs).toBe(80);
    expect(row!.lastTlsDaysLeft).toBe(41);
    expect(row!.lastCheckAt).not.toBeNull();
  });

  test("a check that changes nothing about the monitor's state leaves its state columns alone", async () => {
    const m = await make({ regions: [], consecutiveFailures: 0, lastStatus: "up" });
    await handleCheck(db, { monitorId: m.id }, { probe: answering(50) });
    const [row] = await db.select().from(monitors).where(eq(monitors.id, m.id));
    expect(row!.consecutiveFailures).toBe(0);
    expect(row!.lastStatus).toBe("up");
    // A failure still changes the streak, and a recovery clears it.
    await handleCheck(db, { monitorId: m.id }, { probe: answering(null) });
    expect(
      (await db.select().from(monitors).where(eq(monitors.id, m.id)))[0]!.consecutiveFailures,
    ).toBe(1);
    await handleCheck(db, { monitorId: m.id }, { probe: answering(50) });
    expect(
      (await db.select().from(monitors).where(eq(monitors.id, m.id)))[0]!.consecutiveFailures,
    ).toBe(0);
  });

  test("a monitor with no checks has empty stats", async () => {
    const m = await make();
    expect((await rollupSummary(db, m.id, new Date(0))).total).toBe(0);
    expect((await rollupSummary(db, m.id, new Date(0))).p95Ms).toBeNull();
    expect((await rollupTotals(db, [m.id], new Date(0))).size).toBe(0);
  });

  test("retention removes old buckets along with old checks, and keeps recent ones", async () => {
    const m = await make();
    await db.insert(monitorChecks).values({
      monitorId: m.id,
      status: "up",
      responseMs: 50,
      createdAt: new Date(Date.now() - 200 * 86_400_000),
    });
    await rebuildRollups(db, m.id);
    await handleCheck(db, { monitorId: m.id, region: "eu-west" }, { probe: answering(50) });
    expect(
      (await db.select().from(monitorCheckRollups).where(eq(monitorCheckRollups.monitorId, m.id)))
        .length,
    ).toBe(2);
    await purgeOldRows(db, parseRetention({ ROLLUP_RETENTION_DAYS: "100" }));
    expect(
      (await db.select().from(monitorCheckRollups).where(eq(monitorCheckRollups.monitorId, m.id)))
        .length,
    ).toBe(1);
  });
});
