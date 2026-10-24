import type { Db } from "@upzy/db";
import { BROWSER_QUEUE, browserEndpoint, checkQueue, regionsOf, schema } from "@upzy/db";
import { enqueue } from "@upzy/queue";
import { and, eq, lte, ne, sql } from "drizzle-orm";

export const CHECK_QUEUE = "check";
export interface CheckJob {
  monitorId: string;
  /** Which region's prober runs it. Absent on jobs queued before regions existed: the main server. */
  region?: string;
}

/**
 * Claims monitors whose `next_run` is due (FOR UPDATE SKIP LOCKED, so several schedulers can
 * run side by side), pushes next_run forward by the monitor's interval and enqueues a check
 * job, all in one transaction. Returns how many monitors were scheduled.
 */
export async function scheduleDue(db: Db, batch = 200): Promise<number> {
  const { monitors } = schema;
  return db.transaction(async (tx) => {
    const due = await tx
      .select({
        id: monitors.id,
        interval: monitors.interval,
        regions: monitors.regions,
        type: monitors.type,
      })
      .from(monitors)
      .where(
        and(
          eq(monitors.active, true),
          lte(monitors.nextRun, sql`now()`),
          // Browser monitors wait until this installation has a browser to run them in.
          browserEndpoint() ? undefined : ne(monitors.type, "synthetic"),
        ),
      )
      .orderBy(monitors.nextRun)
      .limit(batch)
      .for("update", { skipLocked: true });

    for (const m of due) {
      await tx
        .update(monitors)
        .set({ nextRun: sql`now() + ${`${m.interval} seconds`}::interval` })
        .where(eq(monitors.id, m.id));
      // A browser check runs where the browser is, not per region.
      if (m.type === "synthetic") {
        await enqueue<CheckJob>(
          tx,
          BROWSER_QUEUE,
          { monitorId: m.id, region: "local" },
          { dedupeKey: `${m.id}:browser`, maxAttempts: 1 },
        );
        continue;
      }
      // One job per region, each on its own queue so only that region's probers pick it up.
      for (const region of regionsOf(m))
        await enqueue<CheckJob>(
          tx,
          checkQueue(region),
          { monitorId: m.id, region },
          { dedupeKey: `${m.id}:${region}`, maxAttempts: 2 },
        );
    }
    return due.length;
  });
}

export async function runScheduler(db: Db, signal: AbortSignal, tickMs = 1000) {
  while (!signal.aborted) {
    try {
      const n = await scheduleDue(db);
      if (n > 0) console.log(`[scheduler] queued ${n} check(s)`);
      if (n >= 200) continue; // backlog: keep draining without waiting
    } catch (e) {
      console.error("[scheduler]", e);
    }
    await Bun.sleep(tickMs);
  }
}
