import { sql } from "drizzle-orm";

import type { Db } from "./drizzle";

/**
 * Check rollups: every check is also counted into a five-minute bucket per monitor and region, in the same
 * transaction. Dashboards, charts, digests and reports read the buckets, which are five times fewer rows than the
 * checks of a monitor checked every minute (288 buckets a day against 1,440) and carry a latency histogram, so a
 * percentile over any range needs no sort. Raw checks stay for the recent-checks table and incident evidence.
 */

export const ROLLUP_BUCKET = "5 minutes";
export const ROLLUP_BUCKET_MS = 5 * 60_000;

/**
 * Upper edges, in milliseconds, of the latency histogram's buckets. A response of `ms` goes in the first bucket whose
 * edge is above it; anything slower than the last edge goes in the final bucket. 16 buckets, so a p95 over any range is
 * accurate to within one bucket.
 */
export const LATENCY_EDGES = [
  25, 50, 75, 100, 150, 200, 300, 400, 500, 750, 1000, 1500, 2000, 3000, 5000,
] as const;
export const LATENCY_BUCKETS = LATENCY_EDGES.length + 1;

/** 0-based histogram bucket for a response time. */
export function latencyBucket(ms: number): number {
  let i = 0;
  while (i < LATENCY_EDGES.length && ms >= LATENCY_EDGES[i]!) i++;
  return i;
}

export const emptyHistogram = () => Array.from({ length: LATENCY_BUCKETS }, () => 0);

/** Anything with an `execute`: a Db or a transaction. */
type Exec = Pick<Db, "execute">;

export interface RollupCheck {
  monitorId: string;
  /** `null` for checks from before regions existed. */
  region: string | null;
  status: string;
  responseMs: number | null;
}

/**
 * Counts one check into its bucket. Call it in the same transaction as the check's insert, so the two can never
 * disagree. The bucket is taken from the database's clock, which is also what stamps the check.
 */
export async function recordRollup(tx: Exec, c: RollupCheck): Promise<void> {
  const up = c.status === "up" ? 1 : 0;
  const degraded = c.status === "degraded" ? 1 : 0;
  const ms = c.responseMs;
  // Index (1-based, as Postgres arrays are) of the histogram bucket to bump; 0 means this check has no latency.
  const slot = ms == null ? 0 : latencyBucket(ms) + 1;
  await tx.execute(sql`
    insert into monitor_check_rollups as r
      (monitor_id, region, bucket_start, total, up, degraded, sum_ms, ms_count, min_ms, max_ms, latency_hist)
    values (
      ${c.monitorId}, ${c.region ?? ""}, date_bin(${ROLLUP_BUCKET}::interval, now(), timestamptz '2000-01-01 00:00:00+00'),
      1, ${up}, ${degraded}, ${ms ?? 0}, ${ms == null ? 0 : 1}, ${ms}, ${ms},
      (select array_agg(case when o = ${slot} then 1 else 0 end order by o)
         from generate_series(1, ${LATENCY_BUCKETS}) as o)
    )
    on conflict (monitor_id, region, bucket_start) do update set
      total = r.total + 1,
      up = r.up + ${up},
      degraded = r.degraded + ${degraded},
      sum_ms = r.sum_ms + ${ms ?? 0},
      ms_count = r.ms_count + ${ms == null ? 0 : 1},
      min_ms = least(r.min_ms, ${ms}),
      max_ms = greatest(r.max_ms, ${ms}),
      latency_hist = (select array_agg(case when o = ${slot} then v + 1 else v end order by o)
                        from unnest(r.latency_hist) with ordinality as t(v, o))`);
}

export interface RollupTotals {
  total: number;
  up: number;
  avgMs: number | null;
}

/** Checks, successes and average response time per monitor since `from` (and before `to`, if given). */
export async function rollupTotals(
  db: Exec,
  monitorIds: string[],
  from: Date,
  to?: Date,
): Promise<Map<string, RollupTotals>> {
  if (monitorIds.length === 0) return new Map();
  const rows = await db.execute<{
    monitor_id: string;
    total: number;
    up: number;
    avg_ms: number | null;
  }>(sql`
    select monitor_id,
           sum(total)::int as total,
           sum(up)::int as up,
           round(sum(sum_ms)::numeric / nullif(sum(ms_count), 0))::int as avg_ms
    from monitor_check_rollups
    where monitor_id in (${sql.join(
      monitorIds.map((m) => sql`${m}`),
      sql`, `,
    )})
      and bucket_start >= ${from}
      ${to ? sql`and bucket_start < ${to}` : sql``}
    group by monitor_id`);
  return new Map(
    [...rows].map((r) => [r.monitor_id, { total: r.total, up: r.up, avgMs: r.avg_ms }]),
  );
}

/**
 * The p-th percentile (0 to 1) of response times from histogram counts, by linear interpolation inside the bucket
 * that holds it. The first and last buckets are bounded by the observed minimum and maximum. Accurate to one bucket.
 */
export function histogramPercentile(
  counts: number[],
  p: number,
  min: number | null,
  max: number | null,
): number | null {
  const n = counts.reduce((a, b) => a + b, 0);
  if (n === 0) return null;
  const rank = Math.max(1, Math.ceil(p * n));
  let seen = 0;
  for (let i = 0; i < counts.length; i++) {
    const c = counts[i]!;
    if (c === 0) continue;
    if (seen + c >= rank) {
      const lo = i === 0 ? (min ?? 0) : Math.max(LATENCY_EDGES[i - 1]!, min ?? 0);
      const hi =
        i < LATENCY_EDGES.length ? Math.min(LATENCY_EDGES[i]!, max ?? Infinity) : (max ?? lo);
      const f = (rank - seen) / c;
      return Math.round(lo + (Math.max(hi, lo) - lo) * f);
    }
    seen += c;
  }
  return max;
}

export interface RollupSummary extends RollupTotals {
  p95Ms: number | null;
}

/** One monitor's totals and 95th percentile response time since `from`. */
export async function rollupSummary(
  db: Exec,
  monitorId: string,
  from: Date,
): Promise<RollupSummary> {
  const [t] = [
    ...(await db.execute<{
      total: number;
      up: number;
      avg_ms: number | null;
      min_ms: number | null;
      max_ms: number | null;
    }>(sql`
      select coalesce(sum(total), 0)::int as total,
             coalesce(sum(up), 0)::int as up,
             round(sum(sum_ms)::numeric / nullif(sum(ms_count), 0))::int as avg_ms,
             min(min_ms) as min_ms, max(max_ms) as max_ms
      from monitor_check_rollups
      where monitor_id = ${monitorId} and bucket_start >= ${from}`)),
  ];
  const hist = emptyHistogram();
  for (const r of await db.execute<{ o: number; v: number }>(sql`
    select o::int as o, sum(v)::int as v
    from monitor_check_rollups, unnest(latency_hist) with ordinality as t(v, o)
    where monitor_id = ${monitorId} and bucket_start >= ${from}
    group by o`))
    hist[r.o - 1] = r.v;
  return {
    total: t?.total ?? 0,
    up: t?.up ?? 0,
    avgMs: t?.avg_ms ?? null,
    p95Ms: histogramPercentile(hist, 0.95, t?.min_ms ?? null, t?.max_ms ?? null),
  };
}

export interface RollupPoint {
  t: Date;
  avgMs: number | null;
  up: number;
  total: number;
}

/** A monitor's history in `bin`-sized steps (a multiple of five minutes, such as "15 minutes"). */
export async function rollupSeries(
  db: Exec,
  monitorId: string,
  from: Date,
  bin: string,
): Promise<RollupPoint[]> {
  const rows = await db.execute<{
    t: Date;
    avg_ms: number | null;
    up: number;
    total: number;
  }>(sql`
    select date_bin(${bin}::interval, bucket_start, timestamptz '2000-01-01 00:00:00+00') as t,
           round(sum(sum_ms)::numeric / nullif(sum(ms_count), 0))::int as avg_ms,
           sum(up)::int as up,
           sum(total)::int as total
    from monitor_check_rollups
    where monitor_id = ${monitorId} and bucket_start >= ${from}
    group by 1 order by 1`);
  return [...rows].map((r) => ({ t: r.t, avgMs: r.avg_ms, up: r.up, total: r.total }));
}

/**
 * Rebuilds a monitor's rollups from its stored checks (all of them, or those since `from`). It is the repair tool if
 * rollups ever drift from the checks, and how tests that insert checks directly get their rollups. It replaces whole
 * buckets, so don't run it for a window that is still receiving checks.
 */
export async function rebuildRollups(db: Exec, monitorId: string, from?: Date): Promise<void> {
  const since = from ? sql`and created_at >= ${from}` : sql``;
  const sinceBucket = from ? sql`and bucket_start >= ${from}` : sql``;
  const hist = sql.join(
    Array.from({ length: LATENCY_BUCKETS }, (_, i) => {
      const lo = i === 0 ? null : LATENCY_EDGES[i - 1]!;
      const hi = i === LATENCY_EDGES.length ? null : LATENCY_EDGES[i]!;
      const parts = [
        ...(lo === null ? [] : [sql`response_ms >= ${lo}`]),
        ...(hi === null ? [] : [sql`response_ms < ${hi}`]),
      ];
      return sql`count(*) filter (where ${sql.join(parts, sql` and `)})::int`;
    }),
    sql`, `,
  );
  await db.execute(
    sql`delete from monitor_check_rollups where monitor_id = ${monitorId} ${sinceBucket}`,
  );
  await db.execute(sql`
    insert into monitor_check_rollups
      (monitor_id, region, bucket_start, total, up, degraded, sum_ms, ms_count, min_ms, max_ms, latency_hist)
    select monitor_id, coalesce(region, ''),
           date_bin(${ROLLUP_BUCKET}::interval, created_at, timestamptz '2000-01-01 00:00:00+00'),
           count(*)::int,
           count(*) filter (where status = 'up')::int,
           count(*) filter (where status = 'degraded')::int,
           coalesce(sum(response_ms), 0), count(response_ms)::int, min(response_ms), max(response_ms),
           array[${hist}]
    from monitor_checks
    where monitor_id = ${monitorId} ${since}
    group by 1, 2, 3`);
}
