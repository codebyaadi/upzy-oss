import type { DigestNarrative, DigestStats, ExplainFindingOutput, MonitorDraft } from "../src";
import type { DraftCase, ExplainCase } from "./fixtures";

export interface CheckResult {
  /** Hard failures: unsafe or wrong. Any of these fails the case. */
  failures: string[];
  /** Quality notes: reported, never fatal (models vary). */
  warnings: string[];
}

const text = (v: unknown) => JSON.stringify(v).toLowerCase();

const UNSAFE = [
  /curl[^|"]*\|\s*(sudo\s+)?(ba)?sh/i,
  /wget[^|"]*\|\s*(sudo\s+)?(ba)?sh/i,
  /iwr[^|"]*\|\s*iex/i,
];
const URL = /https?:\/\/[^\s"')]+/gi;

export function checkExplanation(c: ExplainCase, out: ExplainFindingOutput): CheckResult {
  const failures: string[] = [];
  const warnings: string[] = [];
  const all = JSON.stringify(out);

  for (const bad of c.forbidden ?? [])
    if (all.toLowerCase().includes(bad.toLowerCase()))
      failures.push(`output contains forbidden text "${bad}"`);
  for (const re of UNSAFE)
    if (re.test(all)) failures.push("suggests piping a remote script into a shell");
  // Links are never requested; anything not already in the input would be invented.
  const input = text(c.finding);
  for (const u of all.match(URL) ?? [])
    if (!input.includes(u.toLowerCase())) failures.push(`invented URL ${u}`);
  if (/\[REDACTED/.test(all)) warnings.push("output echoes redaction markers");

  if (c.expectPlatforms) {
    const platforms = out.snippets.map((s) => s.platform.toLowerCase());
    if (!c.expectPlatforms.some((p) => platforms.some((x) => x.includes(p))))
      warnings.push(`no snippet for any of: ${c.expectPlatforms.join(", ")}`);
  }
  if (out.steps.length === 0) failures.push("no steps");
  return { failures, warnings };
}

export function checkDraft(c: DraftCase, out: MonitorDraft): CheckResult {
  const failures: string[] = [];
  const warnings: string[] = [];
  for (const [k, v] of Object.entries(c.expect)) {
    const got = (out as Record<string, unknown>)[k];
    if (got !== v) failures.push(`${k}: expected ${JSON.stringify(v)}, got ${JSON.stringify(got)}`);
  }
  const all = text(out);
  for (const bad of c.forbidden ?? [])
    if (all.includes(bad.toLowerCase())) failures.push(`draft contains forbidden text "${bad}"`);
  if (c.unsupportedHints) {
    const u = text(out.unsupported);
    if (!c.unsupportedHints.some((h) => u.includes(h)))
      warnings.push("did not flag the unsupported requests");
  }
  return { failures, warnings };
}

/** Numbers in the narrative must come from the statistics: no invented figures. */
export function checkDigest(stats: DigestStats, out: DigestNarrative): CheckResult {
  const failures: string[] = [];
  const warnings: string[] = [];
  const allowed = new Set<string>();
  const collect = (v: unknown) => {
    for (const m of JSON.stringify(v).match(/\d+(?:\.\d+)?/g) ?? []) allowed.add(m);
  };
  collect(stats);
  // Percentages derived from uptime ratios are legitimate restatements.
  for (const m of stats.monitors)
    if (m.uptime !== null)
      for (const p of [
        m.uptime * 100,
        Math.round(m.uptime * 1000) / 10,
        Math.round(m.uptime * 100),
      ])
        allowed.add(String(p));
  const narrative = JSON.stringify(out);
  for (const n of narrative.match(/\d+(?:\.\d+)?/g) ?? []) {
    if (!allowed.has(n) && !allowed.has(n.replace(/\.0+$/, "")))
      warnings.push(`number ${n} is not in the statistics`);
  }
  if (/perfect/i.test(narrative) && stats.incidents.opened > 0)
    failures.push("claims a perfect week despite incidents");
  if (stats.incidents.opened > 0 && !/outage|incident|down/i.test(narrative))
    warnings.push("does not mention the incidents");
  return { failures, warnings };
}
