import { schema, type Db } from "@upzy/db";
import { and, eq, inArray, lt } from "drizzle-orm";

const { monitorChecks, jobs } = schema;

const DAY = 86_400_000;

/**
 * The longest history any screen reads is the 30-day response chart, so keeping less than that would blank part of
 * it. Incidents, findings and status-page uptime are stored separately and are never purged here.
 */
export const MIN_CHECK_DAYS = 35;

export interface RetentionConfig {
  /** Delete monitor checks older than this many days. `null` keeps them forever. */
  checkDays: number | null;
  /** Delete finished queue jobs (emails, scans, AI jobs that succeeded) older than this. */
  jobDays: number;
  /** Failed jobs are kept longer, because they are what you read when something went wrong. */
  failedJobDays: number;
}

const whole = (name: string, raw: string, min: number, max: number) => {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max)
    throw new Error(`${name} must be a whole number from ${min} to ${max} (got "${raw}")`);
  return n;
};

/**
 * CHECK_RETENTION_DAYS   default 90; "off" (or "0") keeps every check forever
 * JOB_RETENTION_DAYS     default 14
 * FAILED_JOB_RETENTION_DAYS  default 30
 */
export function parseRetention(
  env: Record<string, string | undefined> = process.env,
): RetentionConfig {
  const raw = env.CHECK_RETENTION_DAYS?.trim().toLowerCase();
  const checkDays =
    raw === undefined || raw === ""
      ? 90
      : raw === "off" || raw === "0"
        ? null
        : whole("CHECK_RETENTION_DAYS", raw, MIN_CHECK_DAYS, 3650);
  return {
    checkDays,
    jobDays: whole("JOB_RETENTION_DAYS", env.JOB_RETENTION_DAYS?.trim() || "14", 1, 3650),
    failedJobDays: whole(
      "FAILED_JOB_RETENTION_DAYS",
      env.FAILED_JOB_RETENTION_DAYS?.trim() || "30",
      1,
      3650,
    ),
  };
}

export interface PurgeResult {
  checks: number;
  jobs: number;
  failedJobs: number;
}

/**
 * Deletes in batches so a long backlog never holds one huge transaction (or locks) open, and pauses between batches
 * so the probers sharing the database are not starved.
 */
async function inBatches(deleteBatch: () => Promise<number>, size: number, pauseMs: number) {
  let total = 0;
  for (;;) {
    const n = await deleteBatch();
    total += n;
    if (n < size) return total;
    if (pauseMs > 0) await Bun.sleep(pauseMs);
  }
}

export async function purgeOldRows(
  db: Db,
  config: RetentionConfig,
  opts: { now?: Date; batch?: number; pauseMs?: number } = {},
): Promise<PurgeResult> {
  const now = opts.now ?? new Date();
  const batch = opts.batch ?? 5000;
  const pauseMs = opts.pauseMs ?? 100;
  const ago = (days: number) => new Date(now.getTime() - days * DAY);

  let checks = 0;
  if (config.checkDays !== null) {
    const cutoff = ago(config.checkDays);
    checks = await inBatches(
      async () =>
        (
          await db
            .delete(monitorChecks)
            .where(
              inArray(
                monitorChecks.id,
                db
                  .select({ id: monitorChecks.id })
                  .from(monitorChecks)
                  .where(lt(monitorChecks.createdAt, cutoff))
                  .limit(batch),
              ),
            )
            .returning({ id: monitorChecks.id })
        ).length,
      batch,
      pauseMs,
    );
  }

  const purgeJobs = (state: "done" | "failed", days: number) => {
    const cutoff = ago(days);
    return inBatches(
      async () =>
        (
          await db
            .delete(jobs)
            .where(
              inArray(
                jobs.id,
                db
                  .select({ id: jobs.id })
                  .from(jobs)
                  .where(and(eq(jobs.state, state), lt(jobs.createdAt, cutoff)))
                  .limit(batch),
              ),
            )
            .returning({ id: jobs.id })
        ).length,
      batch,
      pauseMs,
    );
  };

  return {
    checks,
    jobs: await purgeJobs("done", config.jobDays),
    failedJobs: await purgeJobs("failed", config.failedJobDays),
  };
}

/** Resolves after `ms`, or as soon as the worker is told to stop, so shutdown never waits out a long sleep. */
const sleepUnlessAborted = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    if (signal.aborted) return resolve();
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", done);
  });

/**
 * Runs the purge a few minutes after start and then every few hours. Every run is idempotent, so several workers
 * doing it at once is harmless. A failure is logged and retried on the next round; it never affects monitoring.
 */
export async function runRetention(
  db: Db,
  signal: AbortSignal,
  config: RetentionConfig,
  opts: { firstDelayMs?: number; intervalMs?: number } = {},
) {
  const firstDelayMs = opts.firstDelayMs ?? 5 * 60_000;
  const intervalMs = opts.intervalMs ?? 6 * 3_600_000;
  await sleepUnlessAborted(firstDelayMs, signal);
  while (!signal.aborted) {
    try {
      const r = await purgeOldRows(db, config);
      if (r.checks || r.jobs || r.failedJobs)
        console.log(
          `[retention] removed ${r.checks} check(s), ${r.jobs} finished and ${r.failedJobs} failed job(s)`,
        );
    } catch (e) {
      console.error("[retention]", e);
    }
    await sleepUnlessAborted(intervalMs, signal);
  }
}
