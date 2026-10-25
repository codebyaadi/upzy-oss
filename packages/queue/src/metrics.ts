import { sql } from "drizzle-orm";

import type { Executor } from "./index";

export interface JobEvent {
  queue: string;
  /** How long the job waited past its run time before a worker started it. */
  lagMs: number;
  durationMs: number;
  ok: boolean;
}

export interface QueueStats {
  queue: string;
  ran: number;
  failed: number;
  lagAvgMs: number;
  lagP95Ms: number;
  lagMaxMs: number;
  durationAvgMs: number;
}

/** Keeps the first samples of a window, so a burst cannot grow memory without bound. */
const MAX_SAMPLES = 5000;

const percentile = (sorted: number[], p: number) =>
  sorted.length === 0 ? 0 : sorted[Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)]!;

/** Counts jobs per queue and how late they started. `drain()` returns the window since the last drain. */
export class JobMetrics {
  private queues = new Map<
    string,
    { ran: number; failed: number; lagSum: number; lagMax: number; durSum: number; lags: number[] }
  >();

  record(e: JobEvent) {
    let q = this.queues.get(e.queue);
    if (!q) {
      q = { ran: 0, failed: 0, lagSum: 0, lagMax: 0, durSum: 0, lags: [] };
      this.queues.set(e.queue, q);
    }
    const lag = Math.max(0, e.lagMs);
    q.ran++;
    if (!e.ok) q.failed++;
    q.lagSum += lag;
    q.lagMax = Math.max(q.lagMax, lag);
    q.durSum += e.durationMs;
    if (q.lags.length < MAX_SAMPLES) q.lags.push(lag);
  }

  drain(): QueueStats[] {
    const out: QueueStats[] = [];
    for (const [queue, q] of this.queues) {
      const sorted = [...q.lags].sort((a, b) => a - b);
      out.push({
        queue,
        ran: q.ran,
        failed: q.failed,
        lagAvgMs: Math.round(q.lagSum / q.ran),
        lagP95Ms: Math.round(percentile(sorted, 0.95)),
        lagMaxMs: Math.round(q.lagMax),
        durationAvgMs: Math.round(q.durSum / q.ran),
      });
    }
    this.queues.clear();
    return out.sort((a, b) => a.queue.localeCompare(b.queue));
  }
}

/** Every `work()` loop in this process reports here. */
export const jobMetrics = new JobMetrics();

export interface QueueDepth {
  queue: string;
  /** Queued and already due: work that is waiting for a worker. */
  due: number;
  /** Queued for later (retries, scheduled runs). */
  scheduled: number;
  running: number;
}

export async function queueDepths(db: Executor): Promise<QueueDepth[]> {
  const rows = await db.execute<{
    queue: string;
    due: string;
    scheduled: string;
    running: string;
  }>(sql`
    select queue,
      count(*) filter (where state = 'queued' and run_at <= now()) as due,
      count(*) filter (where state = 'queued' and run_at > now()) as scheduled,
      count(*) filter (where state = 'running') as running
    from jobs
    where state in ('queued', 'running')
    group by queue
    order by queue`);
  return [...rows].map((r) => ({
    queue: r.queue,
    due: Number(r.due),
    scheduled: Number(r.scheduled),
    running: Number(r.running),
  }));
}

/** One line per queue, easy to read and to grep: `[metrics] check window=60s ran=412 failed=3 lag_avg=18ms ...`. */
export function formatMetrics(stats: QueueStats[], depths: QueueDepth[], windowSeconds: number) {
  const depth = new Map(depths.map((d) => [d.queue, d]));
  const names = [...new Set([...stats.map((s) => s.queue), ...depths.map((d) => d.queue)])].sort();
  return names.map((queue) => {
    const s = stats.find((x) => x.queue === queue);
    const d = depth.get(queue);
    return (
      `[metrics] ${queue} window=${windowSeconds}s ran=${s?.ran ?? 0} failed=${s?.failed ?? 0}` +
      ` lag_avg=${s?.lagAvgMs ?? 0}ms lag_p95=${s?.lagP95Ms ?? 0}ms lag_max=${s?.lagMaxMs ?? 0}ms` +
      ` run_avg=${s?.durationAvgMs ?? 0}ms due=${d?.due ?? 0} scheduled=${d?.scheduled ?? 0} running=${d?.running ?? 0}`
    );
  });
}

/**
 * Logs queue depth and start lag every `intervalMs` until `signal` aborts. A queue whose `due` count keeps growing, or
 * whose lag approaches a monitor's interval, is falling behind. An `intervalMs` of 0 turns it off.
 */
export async function logQueueMetrics(
  db: Executor,
  signal: AbortSignal,
  opts: { intervalMs?: number; log?: (line: string) => void } = {},
) {
  const { intervalMs = 60_000, log = console.log } = opts;
  if (intervalMs <= 0) return;
  jobMetrics.drain();
  while (!signal.aborted) {
    await Bun.sleep(intervalMs);
    if (signal.aborted) return;
    try {
      for (const line of formatMetrics(
        jobMetrics.drain(),
        await queueDepths(db),
        Math.round(intervalMs / 1000),
      ))
        log(line);
    } catch (e) {
      console.error("[metrics]", e);
    }
  }
}
