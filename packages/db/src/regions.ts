/*
 * Where checks run from. The main server is always the region "local". An operator can add more by running a
 * prober on another machine with WORKER_REGION=<name>, and listing the names in PROBE_REGIONS on the main server so
 * people can pick them. A monitor with no regions is checked from the main server only.
 */

export const PRIMARY_REGION = "local";

/** Names that mean the main server. Installations before regions labelled it "primary", so that still works. */
const MAIN_NAMES = new Set(["", "local", "primary", "main"]);

/** Short, lowercase and safe to use in a queue name. */
export const REGION_PATTERN = /^[a-z0-9][a-z0-9-]{1,23}$/;

/** The regions this installation offers, main server first. Names that aren't valid are ignored. */
export function offeredRegions(env: Record<string, string | undefined> = process.env): string[] {
  const extra = (env.PROBE_REGIONS ?? "")
    .split(",")
    .map((r) => r.trim().toLowerCase())
    .filter((r) => REGION_PATTERN.test(r) && !MAIN_NAMES.has(r));
  return [PRIMARY_REGION, ...new Set(extra)];
}

/** The region this process runs checks for. */
export function workerRegion(env: Record<string, string | undefined> = process.env): string {
  const r = env.WORKER_REGION?.trim().toLowerCase() ?? "";
  return MAIN_NAMES.has(r) ? PRIMARY_REGION : r;
}

/** The job queue for a region. The main server keeps the original name so nothing queued before an upgrade is lost. */
export const checkQueue = (region: string) =>
  region === PRIMARY_REGION ? "check" : `check.${region}`;

/** Where a monitor is checked from: its chosen regions, or the main server when it has none. */
export const regionsOf = (m: { regions: string[] }) =>
  m.regions.length ? m.regions : [PRIMARY_REGION];

/**
 * A multi-region monitor is down when more than half of the regions that have reported recently see it failing for
 * `failureThreshold` checks in a row. A region that has stopped reporting (its machine is off) is left out of the
 * count rather than counted as up or down, so one dead prober can't hide an outage or cause one.
 */
export function regionalVerdict(
  states: { region: string; consecutiveFailures: number; lastCheckAt: Date }[],
  opts: { failureThreshold: number; intervalSeconds: number; now: Date },
): { down: boolean; failing: string[]; considered: number } {
  const staleAfter = Math.max(opts.intervalSeconds * 3, 300) * 1000;
  const fresh = states.filter((s) => opts.now.getTime() - s.lastCheckAt.getTime() <= staleAfter);
  const failing = fresh
    .filter((s) => s.consecutiveFailures >= opts.failureThreshold)
    .map((s) => s.region)
    .sort();
  return { down: failing.length * 2 > fresh.length, failing, considered: fresh.length };
}

/** Results that probe agents have reported, waiting for the main server's worker to record them. */
export const RESULT_QUEUE = "check.result";

/** Verified assets waiting for the active scanner, and the scanner's results waiting for the worker to record. */
export const ACTIVE_SCAN_QUEUE = "scan.active";
export const SCAN_RESULT_QUEUE = "scan.result";
