import type { CheckResult } from "@upzy/probes";

const human = (seconds: number) => {
  if (seconds < 90) return `${Math.round(seconds)} seconds`;
  if (seconds < 5400) return `${Math.round(seconds / 60)} minutes`;
  if (seconds < 172_800) return `${Math.round(seconds / 3600)} hours`;
  return `${Math.round(seconds / 86_400)} days`;
};

/**
 * Is a heartbeat monitor healthy right now? It is when the job checked in recently enough: within the period it
 * promised plus the grace. The clock counts from the last ping, or from when the monitor was created or resumed
 * (so a new monitor isn't "late" before its first period is over). A ping to the /fail address reports a failure
 * immediately, until the next ordinary ping clears it.
 */
export function heartbeatResult(
  m: {
    config: { expectEvery?: number; grace?: number };
    lastPingAt: Date | null;
    lastFailAt: Date | null;
    heartbeatSince: Date | null;
    createdAt: Date;
  },
  now: Date,
): CheckResult {
  const since = Math.max(m.heartbeatSince?.getTime() ?? 0, m.createdAt.getTime());
  const failedAt = m.lastFailAt?.getTime();
  if (failedAt !== undefined && failedAt >= since && failedAt > (m.lastPingAt?.getTime() ?? 0))
    return {
      status: "down",
      responseMs: null,
      error: "The job reported a failure",
      errorKind: "heartbeat",
    };

  const every = m.config.expectEvery ?? 3600;
  const grace = m.config.grace ?? 0;
  const base = Math.max(m.lastPingAt?.getTime() ?? 0, since);
  const lateBy = (now.getTime() - base) / 1000 - every - grace;
  if (lateBy > 0) {
    const silent = (now.getTime() - base) / 1000;
    return {
      status: "down",
      responseMs: null,
      error: `No ping for ${human(silent)} (expected every ${human(every)}${grace ? `, plus ${human(grace)} grace` : ""})`,
      errorKind: "heartbeat",
    };
  }
  return { status: "up", responseMs: null };
}
