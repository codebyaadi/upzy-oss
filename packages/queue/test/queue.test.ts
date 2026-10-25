import { afterAll, beforeEach, describe, expect, test } from "bun:test";

import { createDb } from "@upzy/db";
import { sql } from "drizzle-orm";

import { claim, complete, enqueue, enqueueMany, fail, work } from "../src";

// Needs a migrated Postgres: DATABASE_URL=... bun test
const url = process.env.DATABASE_URL;
const run = url ? describe : describe.skip;

run("queue (postgres)", () => {
  const db = createDb(url);
  const Q = "queue-test";
  beforeEach(async () => {
    await db.execute(sql`delete from jobs where queue = ${Q}`);
  });
  afterAll(async () => {
    await db.execute(sql`delete from jobs where queue = ${Q}`);
  });

  test("dedupeKey blocks duplicates while active, allows after completion", async () => {
    expect(await enqueue(db, Q, { n: 1 }, { dedupeKey: "k" })).not.toBeNull();
    expect(await enqueue(db, Q, { n: 2 }, { dedupeKey: "k" })).toBeNull();
    const [job] = await claim(db, Q, 1);
    await complete(db, job!.id);
    expect(await enqueue(db, Q, { n: 3 }, { dedupeKey: "k" })).not.toBeNull();
  });

  test("concurrent claimers never receive the same job", async () => {
    for (let i = 0; i < 20; i++) await enqueue(db, Q, { i });
    const batches = await Promise.all(Array.from({ length: 5 }, () => claim(db, Q, 10)));
    const ids = batches.flat().map((j) => j.id);
    expect(ids.length).toBe(20);
    expect(new Set(ids).size).toBe(20);
  });

  test("payload round-trips as an object", async () => {
    await enqueue(db, Q, { a: 1, nested: { b: [1, 2] } });
    const [job] = await claim(db, Q, 1);
    expect(job!.payload).toEqual({ a: 1, nested: { b: [1, 2] } });
  });

  test("failures retry with backoff, then fail permanently", async () => {
    await enqueue(db, Q, {}, { maxAttempts: 2 });
    const [first] = await claim(db, Q, 1);
    await fail(db, first!, new Error("boom"));
    expect(await claim(db, Q, 1)).toHaveLength(0); // backoff: not due yet
    await db.execute(sql`update jobs set run_at = now() where queue = ${Q}`);
    const [second] = await claim(db, Q, 1);
    expect(second!.attempts).toBe(2);
    await fail(db, second!, new Error("boom again"));
    const rows = await db.execute<{ state: string; last_error: string }>(
      sql`select state, last_error from jobs where queue = ${Q}`,
    );
    expect([...rows][0]).toEqual({ state: "failed", last_error: "boom again" });
  });

  test("enqueueMany inserts a batch in one go and skips jobs whose key is already active", async () => {
    await enqueue(db, Q, { n: 0 }, { dedupeKey: "k0" });
    const inserted = await enqueueMany(db, [
      { queue: Q, payload: { n: 0 }, dedupeKey: "k0" }, // already queued
      { queue: Q, payload: { n: 1 }, dedupeKey: "k1" },
      { queue: Q, payload: { n: 2 }, dedupeKey: "k2", maxAttempts: 1 },
      { queue: Q, payload: { n: 3 } },
    ]);
    expect(inserted).toBe(3);
    expect(await enqueueMany(db, [])).toBe(0);
    const rows = await db.execute<{ n: string }>(
      sql`select count(*) as n from jobs where queue = ${Q}`,
    );
    expect(Number([...rows][0]!.n)).toBe(4);
  });

  test("a queue that discards finished jobs leaves none behind, and still keeps the ones that fail", async () => {
    for (let i = 0; i < 6; i++) await enqueue(db, Q, { i }, { maxAttempts: 1 });
    const controller = new AbortController();
    const loop = work<{ i: number }>(
      db,
      Q,
      async (p) => {
        if (p.i === 5) throw new Error("only this one fails");
      },
      { concurrency: 3, pollMs: 20, signal: controller.signal, discardWhenDone: true },
    );
    for (let tries = 0; tries < 100; tries++) {
      const [left] = [
        ...(await db.execute<{ n: string }>(
          sql`select count(*) as n from jobs where queue = ${Q} and state in ('queued', 'running')`,
        )),
      ];
      if (Number(left!.n) === 0) break;
      await Bun.sleep(20);
    }
    controller.abort();
    await loop;
    const rows = await db.execute<{ state: string; last_error: string | null }>(
      sql`select state, last_error from jobs where queue = ${Q}`,
    );
    expect([...rows]).toEqual([{ state: "failed", last_error: "only this one fails" }]);
  });
});
