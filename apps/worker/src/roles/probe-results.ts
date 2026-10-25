import { RESULT_QUEUE, regionsOf, schema, type Db } from "@upzy/db";
import type { runProbe } from "@upzy/probes";
import { work } from "@upzy/queue";
import type { AgentResult } from "@upzy/validator";
import { eq } from "drizzle-orm";

import { recordCheckResult } from "./prober";

export { RESULT_QUEUE };

/** A check an agent ran somewhere else, queued by the API for this worker to evaluate. */
export interface ResultJob {
  monitorId: string;
  region: string;
  result: AgentResult;
}

/**
 * Records a reported result exactly as if this process had run the check. The agent only measures; whether that makes
 * the monitor down, and every alert after it, is decided here by the same code as for a check run locally.
 */
export async function handleResult(db: Db, { monitorId, region, result }: ResultJob) {
  const [m] = await db.select().from(schema.monitors).where(eq(schema.monitors.id, monitorId));
  // The monitor was paused, deleted or moved away from that region while the check was in flight.
  if (!m || !m.active || !regionsOf(m).includes(region)) return;
  await recordCheckResult(db, m, region, result as Awaited<ReturnType<typeof runProbe>>);
}

export const runResultIngest = (db: Db, signal: AbortSignal) =>
  work<ResultJob>(db, RESULT_QUEUE, (payload) => handleResult(db, payload), {
    concurrency: 20,
    signal,
    discardWhenDone: true,
  });
