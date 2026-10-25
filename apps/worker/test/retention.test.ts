import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { createDb, schema } from "@upzy/db";
import { eq, sql } from "drizzle-orm";

import {
  MIN_CHECK_DAYS,
  MIN_ROLLUP_DAYS,
  HISTORY_POLICY_KEY,
  historyByOrganization,
  historyPolicyAnnounced,
  markHistoryPolicyAnnounced,
  parseRetention,
  purgeOldRows,
  runRetention,
} from "../src/roles/retention";

const CONFIG = {
  checkDays: 90,
  rollupDays: 365,
  billingEnabled: false,
  jobDays: 14,
  failedJobDays: 30,
};

describe("retention settings", () => {
  test("defaults keep 30 days of raw checks, a year of history, 14 days of finished jobs and 30 of failed ones", () => {
    expect(parseRetention({})).toEqual({
      checkDays: 30,
      rollupDays: 365,
      billingEnabled: false,
      jobDays: 14,
      failedJobDays: 30,
    });
  });

  test("checks and history can be kept forever", () => {
    expect(parseRetention({ CHECK_RETENTION_DAYS: "off" }).checkDays).toBeNull();
    expect(parseRetention({ CHECK_RETENTION_DAYS: "0" }).checkDays).toBeNull();
    expect(parseRetention({ ROLLUP_RETENTION_DAYS: "off" }).rollupDays).toBeNull();
  });

  test("custom values are read", () => {
    expect(
      parseRetention({
        CHECK_RETENTION_DAYS: "180",
        ROLLUP_RETENTION_DAYS: "730",
        JOB_RETENTION_DAYS: "7",
        FAILED_JOB_RETENTION_DAYS: "60",
      }),
    ).toEqual({
      checkDays: 180,
      rollupDays: 730,
      billingEnabled: false,
      jobDays: 7,
      failedJobDays: 60,
    });
  });

  test("billing being on is read from the same keys the app uses", () => {
    expect(parseRetention({ DODO_API_KEY: "k", DODO_WEBHOOK_SECRET: "s" }).billingEnabled).toBe(
      true,
    );
  });

  test("history shorter than the 30-day chart needs, or raw checks shorter than a week, are refused", () => {
    expect(MIN_ROLLUP_DAYS).toBeGreaterThan(30);
    expect(() => parseRetention({ ROLLUP_RETENTION_DAYS: "30" })).toThrow(/from 35/);
    expect(() => parseRetention({ CHECK_RETENTION_DAYS: String(MIN_CHECK_DAYS - 1) })).toThrow(
      /from 7/,
    );
    expect(() => parseRetention({ CHECK_RETENTION_DAYS: "abc" })).toThrow(/whole number/);
    expect(() => parseRetention({ JOB_RETENTION_DAYS: "0" })).toThrow(/JOB_RETENTION_DAYS/);
  });
});

const url = process.env.DATABASE_URL;
const run = url ? describe : describe.skip;

run("purging old rows (postgres)", () => {
  const db = createDb(url);
  const { organizations, workspaces, monitors, monitorChecks, jobs } = schema;
  const tag = `ret${Date.now()}`;
  const orgId = `${tag}-org`;
  const NOW = new Date("2026-10-20T12:00:00Z");
  const daysAgo = (d: number) => new Date(NOW.getTime() - d * 86_400_000);
  const queue = `${tag}-queue`;
  let monitorId = "";

  const checkCount = async () =>
    (await db.select().from(monitorChecks).where(eq(monitorChecks.monitorId, monitorId))).length;
  const jobStates = async () =>
    (await db.select().from(jobs).where(eq(jobs.queue, queue))).map((j) => j.state).sort();

  beforeAll(async () => {
    await db
      .insert(organizations)
      .values({ id: orgId, name: "t", slug: orgId, createdAt: new Date() });
    const ws = (
      await db.insert(workspaces).values({ orgId, name: "w" }).returning({ id: workspaces.id })
    )[0]!.id;
    monitorId = (
      await db
        .insert(monitors)
        .values({
          workspaceId: ws,
          name: "m",
          type: "http",
          target: "https://example.com",
          interval: 60,
          active: true,
        })
        .returning({ id: monitors.id })
    )[0]!.id;
  });
  afterAll(async () => {
    await db.delete(organizations).where(eq(organizations.id, orgId));
    await db.delete(jobs).where(eq(jobs.queue, queue));
  });

  const seed = async () => {
    await db.delete(monitorChecks).where(eq(monitorChecks.monitorId, monitorId));
    await db.delete(jobs).where(eq(jobs.queue, queue));
    await db.insert(monitorChecks).values(
      [120, 95, 91, 89, 30, 1].map((d) => ({
        monitorId,
        status: "up" as const,
        responseMs: 100,
        createdAt: daysAgo(d),
      })),
    );
    const job = (state: "done" | "failed" | "queued" | "running", d: number) => ({
      queue,
      payload: {},
      state,
      createdAt: daysAgo(d),
    });
    await db
      .insert(jobs)
      .values([
        job("done", 20),
        job("done", 3),
        job("failed", 45),
        job("failed", 10),
        job("queued", 100),
        job("running", 100),
      ]);
  };

  test("removes checks older than the limit and keeps the rest", async () => {
    await seed();
    const r = await purgeOldRows(db, CONFIG, { now: NOW });
    expect(r.checks).toBeGreaterThanOrEqual(3); // 120, 95 and 91 days old
    expect(await checkCount()).toBe(3); // 89, 30 and 1 days old
  });

  test("finished and failed jobs have separate limits, and work in progress is never touched", async () => {
    await seed();
    await purgeOldRows(db, CONFIG, { now: NOW });
    // gone: the done job from 20 days ago and the failed one from 45. Kept: recent ones, and old queued/running.
    expect(await jobStates()).toEqual(["done", "failed", "queued", "running"]);
  });

  test("checks are kept when retention is off", async () => {
    await seed();
    const r = await purgeOldRows(db, { ...CONFIG, checkDays: null }, { now: NOW });
    expect(r.checks).toBe(0);
    expect(await checkCount()).toBe(6);
  });

  test("a backlog bigger than one batch is cleared completely", async () => {
    await seed();
    await db.insert(monitorChecks).values(
      Array.from({ length: 25 }, () => ({
        monitorId,
        status: "down" as const,
        createdAt: daysAgo(200),
      })),
    );
    const r = await purgeOldRows(db, CONFIG, { now: NOW, batch: 10, pauseMs: 0 });
    expect(r.checks).toBeGreaterThanOrEqual(28);
    expect(await checkCount()).toBe(3);
  });

  test("an index on created_at exists so the purge does not scan the table", async () => {
    const rows = await db.execute(
      sql`select 1 from pg_indexes where tablename = 'monitor_checks' and indexname = 'monitor_checks_created_at_idx'`,
    );
    expect(rows.length ?? (rows as { rowCount?: number }).rowCount).toBeGreaterThan(0);
  });
});

run("history by plan (postgres)", () => {
  const db = createDb(url);
  const { organizations, workspaces, monitors, monitorCheckRollups, subscriptions, systemState } =
    schema;
  const tag = `hp${Date.now()}`;
  const NOW = new Date("2026-10-20T12:00:00Z");
  const daysAgo = (d: number) => new Date(NOW.getTime() - d * 86_400_000);
  const AGES = [5, 20, 100, 200, 400];
  const billed = { ...CONFIG, billingEnabled: true };
  const orgIds: string[] = [];
  const monitorOf = new Map<string, string>();

  /** An organization with one monitor that has a rollup row at each of AGES days old. */
  async function org(
    name: string,
    sub?: Partial<typeof subscriptions.$inferInsert>,
  ): Promise<string> {
    const id = `${tag}-${name}`;
    orgIds.push(id);
    await db.insert(organizations).values({ id, name, slug: id, createdAt: new Date() });
    if (sub) await db.insert(subscriptions).values({ organizationId: id, ...sub });
    const [w] = await db
      .insert(workspaces)
      .values({ orgId: id, name: "w" })
      .returning({ id: workspaces.id });
    const [m] = await db
      .insert(monitors)
      .values({
        workspaceId: w!.id,
        name: "m",
        type: "http",
        target: "https://example.com",
        interval: 60,
        active: true,
      })
      .returning({ id: monitors.id });
    await db
      .insert(monitorCheckRollups)
      .values(
        AGES.map((d) => ({
          monitorId: m!.id,
          region: "",
          bucketStart: daysAgo(d),
          total: 1,
          up: 1,
        })),
      );
    monitorOf.set(id, m!.id);
    return id;
  }
  /** How many days old each of an organization's remaining rollup rows is. */
  const remaining = async (orgId: string) =>
    (
      await db
        .select({ b: monitorCheckRollups.bucketStart })
        .from(monitorCheckRollups)
        .where(eq(monitorCheckRollups.monitorId, monitorOf.get(orgId)!))
    )
      .map((r) => Math.round((NOW.getTime() - r.b.getTime()) / 86_400_000))
      .sort((a, b) => a - b);

  afterAll(async () => {
    for (const id of orgIds) await db.delete(organizations).where(eq(organizations.id, id));
    await db.delete(systemState).where(eq(systemState.key, HISTORY_POLICY_KEY));
  });

  test("each plan keeps its own history: Free 7 days, Starter 90, Pro and Agency a year", async () => {
    const free = await org("free");
    const starter = await org("starter", { plan: "starter", status: "active" });
    const pro = await org("pro", { plan: "pro", status: "active" });
    const agency = await org("agency", { plan: "agency", status: "active" });
    const r = await purgeOldRows(db, billed, { now: NOW });
    expect(r.rollups).toBeGreaterThanOrEqual(4 + 3 + 1 + 1);
    expect(await remaining(free)).toEqual([5]);
    expect(await remaining(starter)).toEqual([5, 20]);
    expect(await remaining(pro)).toEqual([5, 20, 100, 200]);
    expect(await remaining(agency)).toEqual([5, 20, 100, 200]);
  });

  test("a trial keeps a Pro year; a lapsed subscription falls back to Free's week", async () => {
    const trial = await org("trial", { trialEndsAt: new Date(NOW.getTime() + 5 * 86_400_000) });
    const ended = await org("ended", { trialEndsAt: new Date(NOW.getTime() - 5 * 86_400_000) });
    const lapsed = await org("lapsed", { plan: "pro", status: "cancelled" });
    await purgeOldRows(db, billed, { now: NOW });
    expect(await remaining(trial)).toEqual([5, 20, 100, 200]);
    expect(await remaining(ended)).toEqual([5]);
    expect(await remaining(lapsed)).toEqual([5]);
  });

  test("with billing off, everyone follows the installation's own setting", async () => {
    const a = await org("off-a");
    const b = await org("off-b", { plan: "starter", status: "active" });
    await purgeOldRows(db, { ...CONFIG, rollupDays: 150 }, { now: NOW });
    expect(await remaining(a)).toEqual([5, 20, 100]);
    expect(await remaining(b)).toEqual([5, 20, 100]);
    const forever = await org("off-forever");
    await purgeOldRows(db, { ...CONFIG, rollupDays: null }, { now: NOW });
    expect(await remaining(forever)).toEqual([5, 20, 100, 200, 400]);
  });

  test("the plans as grouped for deletion", async () => {
    const free = await org("g-free");
    const agency = await org("g-agency", { plan: "agency", status: "active" });
    const groups = await historyByOrganization(db, billed, NOW);
    expect(groups.get(7)).toContain(free);
    expect(groups.get(365)).toContain(agency);
  });

  test("a dry run counts what would go and removes nothing", async () => {
    const free = await org("dry");
    const r = await purgeOldRows(db, billed, { now: NOW, dryRun: true });
    expect(r.rollups).toBeGreaterThanOrEqual(4);
    expect(await remaining(free)).toEqual([5, 20, 100, 200, 400]);
  });

  test("the first purge after the upgrade only announces; the next one deletes", async () => {
    await db.delete(systemState).where(eq(systemState.key, HISTORY_POLICY_KEY));
    const free = await org("first-run");
    // This test runs the real loop, which uses the real clock: replace the rows with ones dated from now.
    const monitorId = monitorOf.get(free)!;
    await db.delete(monitorCheckRollups).where(eq(monitorCheckRollups.monitorId, monitorId));
    const realAgo = (d: number) => new Date(Date.now() - d * 86_400_000);
    await db
      .insert(monitorCheckRollups)
      .values(
        [3, 30, 200].map((d) => ({
          monitorId,
          region: "",
          bucketStart: realAgo(d),
          total: 1,
          up: 1,
        })),
      );
    const days = async () =>
      (
        await db
          .select({ b: monitorCheckRollups.bucketStart })
          .from(monitorCheckRollups)
          .where(eq(monitorCheckRollups.monitorId, monitorId))
      )
        .map((r) => Math.round((Date.now() - r.b.getTime()) / 86_400_000))
        .sort((x, y) => x - y);
    const controller = new AbortController();
    const logs: string[] = [];
    const log = console.log;
    console.log = (...a: unknown[]) => void logs.push(a.join(" "));
    const loop = runRetention(db, controller.signal, billed, { firstDelayMs: 0, intervalMs: 1500 });
    try {
      await Bun.sleep(700);
      // The first round has run: it said what it will remove, recorded that it did, and removed nothing.
      expect(await historyPolicyAnnounced(db)).toBe(true);
      expect(await days()).toEqual([3, 30, 200]);
      expect(logs.join(" ")).toContain("Nothing was removed this time");
      // The second round enforces the plan's history.
      await Bun.sleep(2200);
      expect(await days()).toEqual([3]);
    } finally {
      console.log = log;
      controller.abort();
      await loop;
    }
  });

  test("the notice is recorded once and read back", async () => {
    await db.delete(systemState).where(eq(systemState.key, HISTORY_POLICY_KEY));
    expect(await historyPolicyAnnounced(db)).toBe(false);
    await markHistoryPolicyAnnounced(db, { checks: 3, rollups: 9 });
    expect(await historyPolicyAnnounced(db)).toBe(true);
    const [row] = await db
      .select()
      .from(systemState)
      .where(eq(systemState.key, HISTORY_POLICY_KEY));
    expect(row!.value).toMatchObject({ version: 1, checks: 3, rollups: 9 });
  });
});
