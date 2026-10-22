export type IncidentAction = "open" | "resolve" | "none";

/** Slow checks in a row before a monitor is shown as degraded. A single slow response is just noise. */
export const DEGRADED_AFTER = 3;

export interface EvalInput {
  resultStatus: "up" | "down";
  consecutiveFailures: number;
  failureThreshold: number;
  hasOpenIncident: boolean;
  /** This check succeeded but took longer than the monitor's latency threshold. */
  slow?: boolean;
  consecutiveSlow?: number;
  /** A maintenance window covers this monitor right now: a failure is counted but does not open an incident. */
  inMaintenance?: boolean;
}

export interface EvalOutput {
  consecutiveFailures: number;
  consecutiveSlow: number;
  /**
   * Monitor state after this check. `unknown` is kept while a failure streak is below the threshold, and `degraded`
   * means up but slow for several checks in a row.
   */
  monitorStatus: "up" | "down" | "unknown" | "degraded";
  incident: IncidentAction;
  /** An incident would have opened, but a maintenance window covers the monitor. */
  suppressedByMaintenance: boolean;
}

/**
 * Pure state machine for a monitor. A monitor is only declared down after `failureThreshold` consecutive failures,
 * which filters one-off blips; any success resolves. Being slow never opens an incident: it only changes the state
 * shown (after `DEGRADED_AFTER` slow checks in a row, and until the first fast one). During maintenance the failure
 * streak keeps counting, so an outage that outlasts the window opens its incident on the next failed check.
 */
export function evaluate(i: EvalInput): EvalOutput {
  if (i.resultStatus === "up") {
    const slowStreak = i.slow ? (i.consecutiveSlow ?? 0) + 1 : 0;
    return {
      consecutiveFailures: 0,
      consecutiveSlow: slowStreak,
      monitorStatus: slowStreak >= DEGRADED_AFTER ? "degraded" : "up",
      incident: i.hasOpenIncident ? "resolve" : "none",
      suppressedByMaintenance: false,
    };
  }
  const failures = i.consecutiveFailures + 1;
  if (failures >= i.failureThreshold) {
    const wouldOpen = !i.hasOpenIncident;
    const hold = wouldOpen && !!i.inMaintenance;
    return {
      consecutiveFailures: failures,
      consecutiveSlow: 0,
      monitorStatus: "down",
      incident: wouldOpen && !hold ? "open" : "none",
      suppressedByMaintenance: hold,
    };
  }
  return {
    consecutiveFailures: failures,
    consecutiveSlow: 0,
    monitorStatus: "unknown",
    incident: "none",
    suppressedByMaintenance: false,
  };
}
