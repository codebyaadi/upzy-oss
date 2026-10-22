import type { Severity } from "./types";

const BASE: Record<Severity, number> = { critical: 90, high: 70, medium: 45, low: 20, info: 5 };

/**
 * Ranks findings by real-world risk: severity first, nudged up for CVEs that are known to be
 * exploited (CISA KEV) or likely to be (EPSS 0..1). KEV/EPSS arrive with the CVE checks.
 */
export function riskScore(severity: Severity, opts: { kev?: boolean; epss?: number } = {}): number {
  return Math.min(100, BASE[severity] + (opts.kev ? 10 : 0) + Math.round((opts.epss ?? 0) * 10));
}
