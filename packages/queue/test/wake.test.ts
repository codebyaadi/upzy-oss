import { afterAll, describe, expect, test } from "bun:test";

import { createDb } from "@upzy/db";
import { sql } from "drizzle-orm";

import { Waker, enqueue, enqueueMany, work } from "../src";

describe("waker (no database)", () => {
  test("a notification wakes a waiting loop at once", async () => {
    const w = new Waker();
    const t = performance.now();
    const waiting = w.wait("q", 10_000);
    w.notify("q");
    await waiting;
    expect(performance.now() - t).toBeLessThan(100);
  });

  test("a notification that arrives while the loop is busy is not lost", async () => {
    const w = new Waker();
    w.notify("q");
    const t = performance.now();
    await w.wait("q", 10_000);
    expect(performance.now() - t).toBeLessThan(100);
    // It was used up: the next wait really waits.
    const t2 = performance.now();
    await w.wait("q", 60);
    expect(performance.now() - t2).toBeGreaterThanOrEqual(50);
  });

  test("another queue's notification does not wake it, and the fallback still does", async () => {
    const w = new Waker();
    const t = performance.now();
    const waiting = w.wait("a", 80);
    w.notify("b");
    await waiting;
    expect(performance.now() - t).toBeGreaterThanOrEqual(70);
  });

  test("aborting ends the wait", async () => {
    const w = new Waker();
    const c = new AbortController();
    const t = performance.now();
    const waiting = w.wait("q", 10_000, c.signal);
    c.abort();
    await waiting;
    expect(performance.now() - t).toBeLessThan(100);
  });
});

const url = process.env.DATABASE_URL;
const run = url ? describe : describe.skip;

run("waking workers (postgres)", () => {
  const db = createDb(url);
  const Q = `wake-test-${Date.now()}`;
  afterAll(async () => {
    await db.execute(sql`delete from jobs where queue like ${"wake-test-%"}`);
  });

  /** Starts a worker that records when each job starts, and returns how long the first took to start. */
  async function startLatency(
    opts: { wake?: boolean; pollMs: number },
    queue: string,
    enqueueIt: () => Promise<unknown>,
  ) {
    const started: number[] = [];
    const controller = new AbortController();
    const loop = work<{ n: number }>(
      db,
      queue,
      async () => {
        started.push(performance.now());
      },
      { concurrency: 2, signal: controller.signal, ...opts },
    );
    await Bun.sleep(300); // the loop has looked once and is now waiting
    const t = performance.now();
    await enqueueIt();
    for (let i = 0; i < 200 && started.length === 0; i++) await Bun.sleep(5);
    controller.abort();
    await loop;
    return started.length ? started[0]! - t : Infinity;
  }

  test("a job starts within moments of being queued, with polling set to ten seconds", async () => {
    const q = `${Q}-a`;
    const ms = await startLatency({ pollMs: 10_000 }, q, () => enqueue(db, q, { n: 1 }));
    expect(ms).toBeLessThan(200);
  });

  test("so does a batch queued in one statement", async () => {
    const q = `${Q}-b`;
    const ms = await startLatency({ pollMs: 10_000 }, q, () =>
      enqueueMany(db, [
        { queue: q, payload: { n: 1 } },
        { queue: q, payload: { n: 2 } },
      ]),
    );
    expect(ms).toBeLessThan(200);
  });

  test("without wake-ups the job waits for the next poll, which is the safety net", async () => {
    const q = `${Q}-c`;
    const ms = await startLatency({ wake: false, pollMs: 400 }, q, () => enqueue(db, q, { n: 1 }));
    expect(ms).toBeGreaterThan(50);
    expect(ms).toBeLessThan(1500);
  });

  test("a job queued for later runs when it falls due, found by the poll", async () => {
    const q = `${Q}-d`;
    const ms = await startLatency({ pollMs: 300 }, q, () =>
      enqueue(db, q, { n: 1 }, { runAt: new Date(Date.now() + 500) }),
    );
    expect(ms).toBeGreaterThan(400);
    expect(ms).toBeLessThan(1500);
  });
});
