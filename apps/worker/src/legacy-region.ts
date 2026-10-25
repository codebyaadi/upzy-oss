import { PRIMARY_REGION, workerRegion } from "@upzy/db";

/**
 * A regional prober that reads the database itself (a worker with `WORKER_REGION` set to another region) needs
 * database access and the encryption key on a machine far from the server. The probe agent (agent/) replaces it: it
 * talks to the API with a token and gets secrets sealed to its own key. The old path still works for now, but only
 * when asked for, and it goes away on the date below.
 */
export const LEGACY_REGION_REMOVAL = "2027-03-01";

export interface LegacyRegionDecision {
  /** Whether this worker may run the prober role. */
  run: boolean;
  /** Something for the log, when there is something to say. */
  message?: string;
}

export function legacyRegionalProber(
  env: Record<string, string | undefined> = process.env,
): LegacyRegionDecision {
  if (workerRegion(env) === PRIMARY_REGION) return { run: true };
  if (env.ALLOW_DB_REGIONAL_PROBER?.trim().toLowerCase() === "true")
    return {
      run: true,
      message: `[prober] DEPRECATED: this worker checks region "${workerRegion(env)}" by reading the database directly. Move it to the probe agent (docs/guides/MULTI-REGION.md); ALLOW_DB_REGIONAL_PROBER stops working on ${LEGACY_REGION_REMOVAL}.`,
    };
  return {
    run: false,
    message: `[prober] not started: WORKER_REGION="${workerRegion(env)}" would have this worker read the database from a remote region, which is being retired. Run the probe agent there instead (docs/guides/MULTI-REGION.md). To keep the old setup until ${LEGACY_REGION_REMOVAL}, set ALLOW_DB_REGIONAL_PROBER=true.`,
  };
}
