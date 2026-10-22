import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { createDb, schema } from "@upzy/db";
import { eq, sql } from "drizzle-orm";

import { MIN_CHECK_DAYS, parseRetention, purgeOldRows } from "../src/roles/retention";

describe("retention settings", () => {
  test("defaults keep 90 days of checks, 14 of finished jobs and 30 of failed ones", () => {
    expect(parseRetention({})).toEqual({ checkDays: 90, jobDays: 14, failedJobDays: 30 });
  });

  test("checks can be kept forever", () => {
    expect(parseRetention({ CHECK_RETENTION_DAYS: "off" }).checkDays).toBeNull();
    expect(parseRetention({ CHECK_RETENTION_DAYS: "0" }).checkDays).toBeNull();
  });

  test("custom values are read", () => {
    expect(
      parseRetention({
        CHECK_RETENTION_DAYS: "180",
        JOB_RETENTION_DAYS: "7",
        FAILED_JOB_RETENTION_DAYS: "60",
      }),
    ).toEqual({ checkDays: 180, jobDays: 7, failedJobDays: 60 });
  });

  test("less history than the 30-day chart needs is refused", () => {
    expect(MIN_CHECK_DAYS).toBeGreaterThan(30);
    expect(() => parseRetention({ CHECK_RETENTION_DAYS: "30" })).toThrow(/at least|from 35/);
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
    const r = await purgeOldRows(
      db,
      { checkDays: 90, jobDays: 14, failedJobDays: 30 },
      { now: NOW },
    );
    expect(r.checks).toBeGreaterThanOrEqual(3); // 120, 95 and 91 days old
    expect(await checkCount()).toBe(3); // 89, 30 and 1 days old
  });

  test("finished and failed jobs have separate limits, and work in progress is never touched", async () => {
    await seed();
    await purgeOldRows(db, { checkDays: 90, jobDays: 14, failedJobDays: 30 }, { now: NOW });
    // gone: the done job from 20 days ago and the failed one from 45. Kept: recent ones, and old queued/running.
    expect(await jobStates()).toEqual(["done", "failed", "queued", "running"]);
  });

  test("checks are kept when retention is off", async () => {
    await seed();
    const r = await purgeOldRows(
      db,
      { checkDays: null, jobDays: 14, failedJobDays: 30 },
      { now: NOW },
    );
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
    const r = await purgeOldRows(
      db,
      { checkDays: 90, jobDays: 14, failedJobDays: 30 },
      { now: NOW, batch: 10, pauseMs: 0 },
    );
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
