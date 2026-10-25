import { schema, type Db } from "@upzy/db";
import { sql } from "drizzle-orm";
import type { PgDatabase } from "drizzle-orm/pg-core";

import { jobMetrics } from "./metrics";

export * from "./metrics";

const { jobs } = schema;

/** A Db or a transaction handle, so jobs can be enqueued atomically with other writes. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Executor = PgDatabase<any, any, any>;

export interface EnqueueOptions {
  runAt?: Date;
  maxAttempts?: number;
  /** Skips the insert while a queued/running job with the same key exists in this queue. */
  dedupeKey?: string;
}

export interface Job<T = unknown> {
  id: string;
  queue: string;
  payload: T;
  attempts: number;
  maxAttempts: number;
  /** Milliseconds this job waited past its run time before it was claimed (the database's clock). */
  lagMs: number;
}

export async function enqueue<T>(
  db: Executor,
  queue: string,
  payload: T,
  opts: EnqueueOptions = {},
) {
  const rows = await db
    .insert(jobs)
    .values({
      queue,
      payload: payload as object,
      runAt: opts.runAt,
      maxAttempts: opts.maxAttempts,
      dedupeKey: opts.dedupeKey,
    })
    .onConflictDoNothing()
    .returning({ id: jobs.id });
  return rows[0]?.id ?? null;
}

/** One job to enqueue in a batch. */
export interface NewJob<T = unknown> extends EnqueueOptions {
  queue: string;
  payload: T;
}

/**
 * Enqueues many jobs in one statement. Jobs whose dedupe key is already queued or running are skipped, as with
 * `enqueue`. Returns how many were actually inserted.
 */
export async function enqueueMany<T>(db: Executor, items: NewJob<T>[]): Promise<number> {
  if (items.length === 0) return 0;
  const rows = await db
    .insert(jobs)
    .values(
      items.map((i) => ({
        queue: i.queue,
        payload: i.payload as object,
        runAt: i.runAt,
        maxAttempts: i.maxAttempts,
        dedupeKey: i.dedupeKey,
      })),
    )
    .onConflictDoNothing()
    .returning({ id: jobs.id });
  return rows.length;
}

export const backoffMs = (attempt: number) => Math.min(5 * 60_000, 2 ** attempt * 1000);

/** Atomically claims up to `limit` due jobs. Concurrent workers never receive the same row. */
export async function claim(db: Executor, queue: string, limit: number): Promise<Job[]> {
  const rows = await db.execute<{
    id: string;
    queue: string;
    payload: unknown;
    attempts: number;
    max_attempts: number;
    lag_ms: number;
  }>(sql`
    update jobs set state = 'running', attempts = attempts + 1, locked_at = now()
    where id in (
      select id from jobs
      where queue = ${queue} and state = 'queued' and run_at <= now()
      order by run_at
      limit ${limit}
      for update skip locked
    )
    returning id, queue, payload, attempts, max_attempts,
      extract(epoch from (now() - run_at)) * 1000 as lag_ms`);
  return [...rows].map((r) => ({
    id: r.id,
    queue: r.queue,
    payload: r.payload,
    attempts: r.attempts,
    maxAttempts: r.max_attempts,
    lagMs: Number(r.lag_ms),
  }));
}

export async function complete(db: Executor, id: string) {
  await db.execute(sql`update jobs set state = 'done', locked_at = null where id = ${id}`);
}

/** Removes a finished job. For queues whose history nobody reads (checks): one fewer row to update and to keep. */
export async function discard(db: Executor, id: string) {
  await db.execute(sql`delete from jobs where id = ${id}`);
}

/** Retries with exponential backoff until `maxAttempts`, then marks the job failed. */
export async function fail(db: Executor, job: Job, error: unknown) {
  const message = (error instanceof Error ? error.message : String(error)).slice(0, 2000);
  if (job.attempts >= job.maxAttempts) {
    await db.execute(
      sql`update jobs set state = 'failed', locked_at = null, last_error = ${message} where id = ${job.id}`,
    );
  } else {
    const delay = `${backoffMs(job.attempts)} milliseconds`;
    await db.execute(
      sql`update jobs set state = 'queued', locked_at = null, last_error = ${message}, run_at = now() + ${delay}::interval where id = ${job.id}`,
    );
  }
}

/** Returns jobs whose worker died mid-run (locked too long) to the queue. */
export async function requeueStale(db: Executor, staleAfterMs = 5 * 60_000) {
  await db.execute(
    sql`update jobs set state = 'queued', locked_at = null where state = 'running' and locked_at < now() - ${`${staleAfterMs} milliseconds`}::interval`,
  );
}

export interface WorkOptions {
  /** Delete a job when it succeeds instead of keeping it as `done`. Failed jobs are always kept. */
  discardWhenDone?: boolean;
  concurrency?: number;
  pollMs?: number;
  signal?: AbortSignal;
}

/** Polls `queue` and runs `handler` for each job until `signal` aborts. Resolves once in-flight jobs drain. */
export async function work<T>(
  db: Db,
  queue: string,
  handler: (payload: T, job: Job<T>) => Promise<void>,
  opts: WorkOptions = {},
) {
  const { concurrency = 5, pollMs = 1000, signal, discardWhenDone = false } = opts;
  const inFlight = new Set<Promise<void>>();
  let lastSweep = 0;

  while (!signal?.aborted) {
    if (Date.now() - lastSweep > 60_000) {
      lastSweep = Date.now();
      await requeueStale(db).catch((e) => console.error("requeueStale", e));
    }

    const free = concurrency - inFlight.size;
    let claimed: Job[] = [];
    if (free > 0) {
      claimed = await claim(db, queue, free).catch((e) => {
        console.error(`claim(${queue})`, e);
        return [];
      });
    }
    for (const job of claimed) {
      const p = (async () => {
        const started = performance.now();
        let ok = true;
        try {
          await handler(job.payload as T, job as Job<T>);
          await (discardWhenDone ? discard(db, job.id) : complete(db, job.id));
        } catch (e) {
          ok = false;
          await fail(db, job, e).catch((err) => console.error("fail()", err));
        }
        jobMetrics.record({
          queue,
          lagMs: job.lagMs,
          durationMs: performance.now() - started,
          ok,
        });
      })().finally(() => inFlight.delete(p));
      inFlight.add(p);
    }

    // Poll again immediately if the batch was full, otherwise wait.
    if (claimed.length < free || free === 0) {
      await Promise.race([Bun.sleep(pollMs), ...inFlight]);
    }
  }
  await Promise.all(inFlight);
}
