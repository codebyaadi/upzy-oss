import { PLANS, entitlement, loadBillingConfig } from "@upzy/billing";
import { schema, type Db } from "@upzy/db";
import { and, eq, inArray, lt, sql } from "drizzle-orm";

const { monitorChecks, jobs, organizations, subscriptions, systemState } = schema;

const DAY = 86_400_000;

/**
 * Raw checks are what the recent-checks table and incident evidence read, and nothing longer: the charts, uptime and
 * reports read the five-minute rollups. A week is the least that still shows an incident's lead-up.
 */
export const MIN_CHECK_DAYS = 7;
/** The 30-day chart reads the rollups, so they must outlast it. */
export const MIN_ROLLUP_DAYS = 35;

export interface RetentionConfig {
  /** Delete raw monitor checks older than this many days. `null` keeps them forever. */
  checkDays: number | null;
  /**
   * How long the five-minute rollups (history for charts and reports) are kept where there are no plans, because
   * billing is off. With billing on, each organization's plan decides. `null` keeps them forever.
   */
  rollupDays: number | null;
  /** Billing is on, so each organization's plan sets its history. */
  billingEnabled: boolean;
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

const days = (
  name: string,
  raw: string | undefined,
  fallback: number,
  min: number,
): number | null => {
  const v = raw?.trim().toLowerCase();
  if (v === undefined || v === "") return fallback;
  if (v === "off" || v === "0") return null;
  return whole(name, v, min, 3650);
};

/**
 * CHECK_RETENTION_DAYS      raw checks, default 30 (7 or more); "off" (or "0") keeps them forever
 * ROLLUP_RETENTION_DAYS     history for charts and reports where billing is off, default 365 (35 or more); "off" keeps it
 * JOB_RETENTION_DAYS        default 14
 * FAILED_JOB_RETENTION_DAYS default 30
 * With billing on, each plan sets how long its history is kept (PLANS[...].limits.historyDays).
 */
export function parseRetention(
  env: Record<string, string | undefined> = process.env,
): RetentionConfig {
  return {
    checkDays: days("CHECK_RETENTION_DAYS", env.CHECK_RETENTION_DAYS, 30, MIN_CHECK_DAYS),
    rollupDays: days("ROLLUP_RETENTION_DAYS", env.ROLLUP_RETENTION_DAYS, 365, MIN_ROLLUP_DAYS),
    billingEnabled: loadBillingConfig(env).enabled,
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
  /** Five-minute rollup rows removed for being past their plan's history. */
  rollups: number;
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

/**
 * Which organizations keep how many days of rollups. With billing off that is everyone at `rollupDays`; with it on,
 * the plan they have right now (the same rule the rest of the app uses), so an organization whose trial ended or
 * whose subscription lapsed is held to Free's history from the next purge.
 */
export async function historyByOrganization(
  db: Db,
  config: RetentionConfig,
  now: Date,
): Promise<Map<number | null, string[]>> {
  const rows = await db
    .select({
      id: organizations.id,
      plan: subscriptions.plan,
      status: subscriptions.status,
      trialEndsAt: subscriptions.trialEndsAt,
    })
    .from(organizations)
    .leftJoin(subscriptions, eq(subscriptions.organizationId, organizations.id));
  const groups = new Map<number | null, string[]>();
  for (const r of rows) {
    const { plan } = entitlement({
      billingEnabled: config.billingEnabled,
      sub: r.status ? { plan: r.plan, status: r.status, trialEndsAt: r.trialEndsAt } : undefined,
      now,
    });
    const planDays = PLANS[plan].limits.historyDays;
    // No plan limit (billing off): the installation's own setting.
    const keep = Number.isFinite(planDays) ? planDays : config.rollupDays;
    const ids = groups.get(keep) ?? [];
    ids.push(r.id);
    groups.set(keep, ids);
  }
  return groups;
}

const ORG_CHUNK = 500;

/** Counts (when `dryRun`) or deletes rollup rows older than each organization's history. Returns the rows affected. */
async function purgeRollups(
  db: Db,
  config: RetentionConfig,
  now: Date,
  opts: { batch: number; pauseMs: number; dryRun: boolean },
): Promise<number> {
  let total = 0;
  for (const [keep, orgIds] of await historyByOrganization(db, config, now)) {
    if (keep === null) continue;
    const cutoff = new Date(now.getTime() - keep * DAY);
    for (let i = 0; i < orgIds.length; i += ORG_CHUNK) {
      const ids = sql.join(
        orgIds.slice(i, i + ORG_CHUNK).map((o) => sql`${o}`),
        sql`, `,
      );
      const old = sql`
        from monitor_check_rollups r
        join monitors m on m.id = r.monitor_id
        join workspaces w on w.id = m.workspace_id
        where w.org_id in (${ids}) and r.bucket_start < ${cutoff}`;
      if (opts.dryRun) {
        const [c] = [...(await db.execute<{ n: string }>(sql`select count(*) as n ${old}`))];
        total += Number(c?.n ?? 0);
        continue;
      }
      total += await inBatches(
        async () =>
          (
            await db.execute(sql`
              delete from monitor_check_rollups where ctid in (select r.ctid ${old} limit ${opts.batch})
              returning 1`)
          ).length,
        opts.batch,
        opts.pauseMs,
      );
    }
  }
  return total;
}

export async function purgeOldRows(
  db: Db,
  config: RetentionConfig,
  opts: {
    now?: Date;
    batch?: number;
    pauseMs?: number;
    /** Count what would be deleted from checks and rollups, and delete none of it. Jobs are always purged. */
    dryRun?: boolean;
  } = {},
): Promise<PurgeResult> {
  const now = opts.now ?? new Date();
  const batch = opts.batch ?? 5000;
  const pauseMs = opts.pauseMs ?? 100;
  const dryRun = opts.dryRun ?? false;
  const ago = (d: number) => new Date(now.getTime() - d * DAY);

  let checks = 0;
  if (config.checkDays !== null) {
    const cutoff = ago(config.checkDays);
    if (dryRun) {
      const [c] = await db
        .select({ n: sql<number>`count(*)::int` })
        .from(monitorChecks)
        .where(lt(monitorChecks.createdAt, cutoff));
      checks = c?.n ?? 0;
    } else
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
  const rollups = await purgeRollups(db, config, now, { batch, pauseMs, dryRun });

  const purgeJobs = (state: "done" | "failed", d: number) => {
    const cutoff = ago(d);
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
    rollups,
    jobs: await purgeJobs("done", config.jobDays),
    failedJobs: await purgeJobs("failed", config.failedJobDays),
  };
}

/** Resolves after `ms`, or as soon as the worker is told to stop, so shutdown never waits out a long sleep. */
export const sleepUnlessAborted = (ms: number, signal: AbortSignal) =>
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
 * The history limits (30 days of raw checks, plan-based history for the rest) were introduced after installations
 * already held more. So that nothing is removed by surprise, the first purge after the upgrade only reports how much
 * is past its limit and records that it did; deletion starts with the next one.
 */
export const HISTORY_POLICY_KEY = "retention.history_policy";
const HISTORY_POLICY_VERSION = 1;

export async function historyPolicyAnnounced(db: Db): Promise<boolean> {
  const [row] = await db.select().from(systemState).where(eq(systemState.key, HISTORY_POLICY_KEY));
  return Number(row?.value?.version ?? 0) >= HISTORY_POLICY_VERSION;
}

export async function markHistoryPolicyAnnounced(db: Db, counts: Record<string, number>) {
  const value = {
    version: HISTORY_POLICY_VERSION,
    announcedAt: new Date().toISOString(),
    ...counts,
  };
  await db
    .insert(systemState)
    .values({ key: HISTORY_POLICY_KEY, value })
    .onConflictDoUpdate({ target: systemState.key, set: { value, updatedAt: new Date() } });
}

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
      const announced = await historyPolicyAnnounced(db);
      const r = await purgeOldRows(db, config, { dryRun: !announced });
      if (!announced) {
        await markHistoryPolicyAnnounced(db, { checks: r.checks, rollups: r.rollups });
        console.log(
          `[retention] history limits now apply. Nothing was removed this time; the next run, in ${Math.round(intervalMs / 3_600_000)} hour(s), will remove ${r.checks} raw check(s) older than ${config.checkDays ?? "never"} days and ${r.rollups} history row(s) past their plan's limit. Set CHECK_RETENTION_DAYS and ROLLUP_RETENTION_DAYS to keep more.`,
        );
      } else if (r.checks || r.rollups || r.jobs || r.failedJobs)
        console.log(
          `[retention] removed ${r.checks} check(s), ${r.rollups} history row(s), ${r.jobs} finished and ${r.failedJobs} failed job(s)`,
        );
    } catch (e) {
      console.error("[retention]", e);
    }
    await sleepUnlessAborted(intervalMs, signal);
  }
}
