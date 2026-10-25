import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";

import { createDb, schema } from "@upzy/db";
import type { runProbe } from "@upzy/probes";
import { enqueue, jobMetrics, work } from "@upzy/queue";
import { eq, sql } from "drizzle-orm";

import { createGate } from "../src/gate";
import { handleCheck, parseProberConfig } from "../src/roles/prober";

setDefaultTimeout(60_000);

describe("prober settings (no database)", () => {
  test("many checks in flight by default, and a few database connections held back", () => {
    expect(parseProberConfig({})).toEqual({ concurrency: 200, dbConcurrency: 8 });
    expect(parseProberConfig({ PROBER_CONCURRENCY: "500", DB_POOL_MAX: "30" })).toEqual({
      concurrency: 500,
      dbConcurrency: 28,
    });
    // Never fewer than two, whatever the pool.
    expect(parseProberConfig({ DB_POOL_MAX: "3" }).dbConcurrency).toBe(2);
  });

  test("a setting that is not a sensible number stops the worker at start", () => {
    for (const bad of ["0", "-5", "abc", "2.5", "5000"])
      expect(() => parseProberConfig({ PROBER_CONCURRENCY: bad })).toThrow(/PROBER_CONCURRENCY/);
  });

  test("a gate never lets more than its limit run at once, and runs everyone eventually", async () => {
    const gate = createGate(3);
    let active = 0;
    let peak = 0;
    const done: number[] = [];
    await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        gate.run(async () => {
          active++;
          peak = Math.max(peak, active);
          await Bun.sleep(5);
          active--;
          done.push(i);
        }),
      ),
    );
    expect(peak).toBe(3);
    expect(done).toHaveLength(20);
  });

  test("a gate keeps working after a task throws", async () => {
    const gate = createGate(1);
    await expect(gate.run(async () => Promise.reject(new Error("boom")))).rejects.toThrow("boom");
    expect(await gate.run(async () => "fine")).toBe("fine");
  });
});

const url = process.env.DATABASE_URL;
const run = url ? describe : describe.skip;

run("many slow checks at once (postgres)", () => {
  const db = createDb(url);
  const { organizations, workspaces, monitors, jobs } = schema;
  const orgId = `pc-org-${Date.now()}`;
  const QUEUE = `check-pc-${Date.now()}`;
  const N = 300;
  const SLOW_MS = 1000; // stands for a probe that runs for its whole timeout
  let ids: string[] = [];

  beforeAll(async () => {
    await db
      .insert(organizations)
      .values({ id: orgId, name: "t", slug: orgId, createdAt: new Date() });
    const [ws] = await db
      .insert(workspaces)
      .values({ orgId, name: "w" })
      .returning({ id: workspaces.id });
    ids = (
      await db
        .insert(monitors)
        .values(
          Array.from({ length: N }, (_, i) => ({
            workspaceId: ws!.id,
            name: `m${i}`,
            type: "http" as const,
            target: "https://example.com",
            interval: 60,
            active: true,
          })),
        )
        .returning({ id: monitors.id })
    ).map((m) => m.id);
  });
  afterAll(async () => {
    await db.delete(jobs).where(eq(jobs.queue, QUEUE));
    await db.delete(organizations).where(eq(organizations.id, orgId));
  });

  const slow: typeof runProbe = async () => {
    await Bun.sleep(SLOW_MS);
    return { status: "up", responseMs: SLOW_MS };
  };

  /** Runs every queued check with `concurrency` in flight and returns how long that took. */
  async function drain(concurrency: number, dbConcurrency: number) {
    await db.delete(jobs).where(eq(jobs.queue, QUEUE));
    for (const monitorId of ids) await enqueue(db, QUEUE, { monitorId });
    const gate = createGate(dbConcurrency);
    const controller = new AbortController();
    jobMetrics.drain();
    const started = performance.now();
    const loop = work<{ monitorId: string }>(
      db,
      QUEUE,
      (payload) =>
        handleCheck(db, { monitorId: payload.monitorId, region: "local" }, { probe: slow, gate }),
      { concurrency, signal: controller.signal },
    );
    for (;;) {
      const [left] = [
        ...(await db.execute<{ n: string }>(
          sql`select count(*) as n from jobs where queue = ${QUEUE} and state <> 'done'`,
        )),
      ];
      if (Number(left!.n) === 0) break;
      await Bun.sleep(50);
    }
    const took = performance.now() - started;
    controller.abort();
    await loop;
    return { took, stats: jobMetrics.drain().find((s) => s.queue === QUEUE)! };
  }

  test("300 checks that each take a second finish in a few seconds, not in the 15 the old limit needed", async () => {
    const { took, stats } = await drain(200, 2);
    expect(stats.ran).toBe(N);
    expect(stats.failed).toBe(0);
    // Two rounds of one second plus the database work for 300 checks, with room for a slow machine. At 20 in flight
    // the same load takes 15 seconds.
    expect(took).toBeLessThan(9_000);
    // How late a check started stays well under a monitor's interval (60 s).
    expect(stats.lagMaxMs).toBeLessThan(5_000);
  });
});
