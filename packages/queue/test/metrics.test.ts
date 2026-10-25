import { afterAll, describe, expect, test } from "bun:test";

import { createDb } from "@upzy/db";
import { sql } from "drizzle-orm";

import { claim, enqueue, formatMetrics, JobMetrics, queueDepths } from "../src";

describe("job metrics", () => {
  test("counts runs and failures and reports how late jobs started", () => {
    const m = new JobMetrics();
    for (let i = 1; i <= 100; i++)
      m.record({ queue: "check", lagMs: i * 10, durationMs: 200, ok: i !== 7 });
    m.record({ queue: "notify", lagMs: 5, durationMs: 40, ok: true });
    const [check, notify] = m.drain();
    expect(check).toEqual({
      queue: "check",
      ran: 100,
      failed: 1,
      lagAvgMs: 505,
      lagP95Ms: 950,
      lagMaxMs: 1000,
      durationAvgMs: 200,
    });
    expect(notify).toMatchObject({ queue: "notify", ran: 1, lagMaxMs: 5 });
  });

  test("a drain starts a new window, and a negative lag (clock jitter) counts as zero", () => {
    const m = new JobMetrics();
    m.record({ queue: "q", lagMs: -30, durationMs: 1, ok: true });
    expect(m.drain()[0]).toMatchObject({ lagMaxMs: 0 });
    expect(m.drain()).toEqual([]);
  });

  test("the log line has one entry per queue, including queues that only have a backlog", () => {
    const lines = formatMetrics(
      [
        {
          queue: "check",
          ran: 3,
          failed: 0,
          lagAvgMs: 10,
          lagP95Ms: 20,
          lagMaxMs: 30,
          durationAvgMs: 100,
        },
      ],
      [{ queue: "scan", due: 4, scheduled: 1, running: 2 }],
      60,
    );
    expect(lines).toEqual([
      "[metrics] check window=60s ran=3 failed=0 lag_avg=10ms lag_p95=20ms lag_max=30ms run_avg=100ms due=0 scheduled=0 running=0",
      "[metrics] scan window=60s ran=0 failed=0 lag_avg=0ms lag_p95=0ms lag_max=0ms run_avg=0ms due=4 scheduled=1 running=2",
    ]);
  });
});

const url = process.env.DATABASE_URL;
const run = url ? describe : describe.skip;

run("queue metrics (postgres)", () => {
  const db = createDb(url);
  const Q = "metrics-test";
  afterAll(async () => {
    await db.execute(sql`delete from jobs where queue = ${Q}`);
  });

  test("a claimed job reports how long it waited past its run time", async () => {
    await db.execute(sql`delete from jobs where queue = ${Q}`);
    await enqueue(db, Q, {}, { runAt: new Date(Date.now() - 5_000) });
    const [job] = await claim(db, Q, 1);
    expect(job!.lagMs).toBeGreaterThan(4_500);
    expect(job!.lagMs).toBeLessThan(15_000);
  });

  test("depth separates due, scheduled and running work", async () => {
    await db.execute(sql`delete from jobs where queue = ${Q}`);
    await enqueue(db, Q, {});
    await enqueue(db, Q, {}, { runAt: new Date(Date.now() + 3_600_000) });
    await enqueue(db, Q, {});
    await claim(db, Q, 1);
    const depth = (await queueDepths(db)).find((d) => d.queue === Q);
    expect(depth).toEqual({ queue: Q, due: 1, scheduled: 1, running: 1 });
  });
});
