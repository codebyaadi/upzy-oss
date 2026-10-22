export type IncidentAction = "open" | "resolve" | "none";

export interface EvalInput {
  resultStatus: "up" | "down";
  consecutiveFailures: number;
  failureThreshold: number;
  hasOpenIncident: boolean;
}

export interface EvalOutput {
  consecutiveFailures: number;
  /** Monitor state after this check. `unknown` is kept while a failure streak is below the threshold. */
  monitorStatus: "up" | "down" | "unknown";
  incident: IncidentAction;
}

/**
 * Pure state machine for a monitor. A monitor is only declared down after
 * `failureThreshold` consecutive failures, which filters one-off blips; any success resolves.
 */
export function evaluate(i: EvalInput): EvalOutput {
  if (i.resultStatus === "up") {
    return {
      consecutiveFailures: 0,
      monitorStatus: "up",
      incident: i.hasOpenIncident ? "resolve" : "none",
    };
  }
  const failures = i.consecutiveFailures + 1;
  if (failures >= i.failureThreshold) {
    return {
      consecutiveFailures: failures,
      monitorStatus: "down",
      incident: i.hasOpenIncident ? "none" : "open",
    };
  }
  return { consecutiveFailures: failures, monitorStatus: "unknown", incident: "none" };
}
