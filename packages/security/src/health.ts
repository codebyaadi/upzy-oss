import type { Severity } from "./types";

export type Category = "security" | "availability" | "email" | "hygiene";
export type Grade = "A" | "B" | "C" | "D" | "F";

export interface HealthFinding {
  checkKey: string;
  severity: Severity;
}

export interface Health {
  /** 0 to 100. */
  score: number;
  grade: Grade;
  /** Each category that applies, 0 to 100. */
  categories: Partial<Record<Category, number>>;
  /** Why the grade isn't higher than the average would suggest, if a cap applied. */
  cappedBy: "critical" | "high" | "medium" | null;
}

export const PENALTY: Record<Severity, number> = {
  critical: 40,
  high: 25,
  medium: 12,
  low: 5,
  info: 0,
};
const WEIGHT: Record<Category, number> = { security: 50, availability: 20, email: 20, hygiene: 10 };

/** Expiry, CAA and version banners are housekeeping; everything else about the site itself is security. */
const HYGIENE = new Set([
  "tls.cert_expiring",
  "dns.caa_missing",
  "headers.version_disclosed",
  "registration.expiring",
  "dnssec.not_enabled",
]);

export function categoryOf(checkKey: string): Category {
  if (checkKey.startsWith("email.")) return "email";
  if (HYGIENE.has(checkKey)) return "hygiene";
  return "security";
}

export const gradeOf = (score: number): Grade =>
  score >= 90 ? "A" : score >= 80 ? "B" : score >= 65 ? "C" : score >= 50 ? "D" : "F";

/** Uptime over the last 30 days to a 0-100 score: 99.95% is full marks, under 90% is zero. */
export function availabilityScore(uptimePercent: number): number {
  const pts: [number, number][] = [
    [90, 0],
    [95, 40],
    [99, 75],
    [99.9, 95],
    [99.95, 100],
  ];
  if (uptimePercent >= 99.95) return 100;
  if (uptimePercent <= 90) return 0;
  for (let i = 1; i < pts.length; i++) {
    const [x1, y1] = pts[i]!;
    const [x0, y0] = pts[i - 1]!;
    if (uptimePercent <= x1) return Math.round(y0 + ((uptimePercent - x0) / (x1 - x0)) * (y1 - y0));
  }
  return 100;
}

/**
 * One grade for a domain, from facts Upzy already has. `open` is the unresolved, un-ignored findings; `uptime` is
 * the 30-day uptime of the monitors watching it (omit when none). Email trust only applies to domains.
 * An open critical or high finding caps the grade however good the rest looks: a site with a takeover risk is not
 * "B" because its headers are fine. An "A" also needs no open medium findings.
 */
export function computeHealth(input: {
  open: HealthFinding[];
  kind: "domain" | "subdomain" | "url";
  uptime?: number | null;
}): Health {
  const loss: Record<Category, number> = { security: 0, availability: 0, email: 0, hygiene: 0 };
  for (const f of input.open) loss[categoryOf(f.checkKey)] += PENALTY[f.severity];

  const categories: Partial<Record<Category, number>> = {
    security: Math.max(0, 100 - loss.security),
    hygiene: Math.max(0, 100 - loss.hygiene),
  };
  if (input.kind === "domain") categories.email = Math.max(0, 100 - loss.email);
  if (input.uptime != null) categories.availability = availabilityScore(input.uptime);

  let total = 0;
  let weights = 0;
  for (const [c, v] of Object.entries(categories) as [Category, number][]) {
    total += v * WEIGHT[c];
    weights += WEIGHT[c];
  }
  let score = Math.round(total / weights);

  let cappedBy: Health["cappedBy"] = null;
  if (input.open.some((f) => f.severity === "critical")) {
    if (score > 59) cappedBy = "critical";
    score = Math.min(score, 59);
  } else if (input.open.some((f) => f.severity === "high")) {
    if (score > 79) cappedBy = "high";
    score = Math.min(score, 79);
  } else if (input.open.some((f) => f.severity === "medium")) {
    if (score > 89) cappedBy = "medium";
    score = Math.min(score, 89);
  }
  return { score, grade: gradeOf(score), categories, cappedBy };
}
