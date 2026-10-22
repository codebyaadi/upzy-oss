import type { Severity } from "../types";
import { HOUR, clip } from "./http";
import type { RawVuln, VulnDeps } from "./types";

interface OsvVuln {
  id: string;
  aliases?: string[];
  summary?: string;
  details?: string;
  database_specific?: { severity?: string };
  affected?: { ranges?: { type?: string; events?: Record<string, string>[] }[] }[];
}

const SEVERITY: Record<string, Severity> = {
  CRITICAL: "critical",
  HIGH: "high",
  MODERATE: "medium",
  MEDIUM: "medium",
  LOW: "low",
};

/** Compares dotted numeric versions. Non-numeric parts compare as 0. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split(/[.-]/).map((p) => parseInt(p, 10) || 0);
  const pb = b.split(/[.-]/).map((p) => parseInt(p, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  return 0;
}

/** Smallest "fixed" version above `version` across all affected ranges, if the advisory names one. */
function fixedAfter(v: OsvVuln, version: string): string | null {
  const fixes = (v.affected ?? [])
    .flatMap((a) => a.ranges ?? [])
    .flatMap((r) => (r.events ?? []).map((e) => e.fixed))
    .filter((f): f is string => !!f && compareVersions(f, version) > 0);
  return fixes.sort(compareVersions)[0] ?? null;
}

function normalize(v: OsvVuln, version: string): RawVuln {
  const cve = [v.id, ...(v.aliases ?? [])].find((i) => /^CVE-\d{4}-\d+$/.test(i)) ?? null;
  return {
    id: cve ?? v.id,
    cve,
    summary: clip(v.summary ?? v.details ?? ""),
    severity: SEVERITY[(v.database_specific?.severity ?? "").toUpperCase()] ?? "medium",
    cvss: null,
    fixedIn: fixedAfter(v, version),
  };
}

/** Known vulnerabilities for an exact package version, from OSV.dev (npm advisories). Cached for 24h. */
export async function queryOsv(
  deps: VulnDeps,
  pkg: { ecosystem: string; name: string },
  version: string,
): Promise<RawVuln[]> {
  const key = `osv:${pkg.ecosystem}:${pkg.name}@${version}`;
  const cached = await deps.cache.get<RawVuln[]>(key);
  if (cached) return cached;

  const found: OsvVuln[] = [];
  let pageToken: string | undefined;
  for (let page = 0; page < 10; page++) {
    const res = (await deps.http("https://api.osv.dev/v1/query", {
      method: "POST",
      body: JSON.stringify({
        version,
        package: pkg,
        ...(pageToken ? { page_token: pageToken } : {}),
      }),
    })) as { vulns?: OsvVuln[]; next_page_token?: string };
    found.push(...(res.vulns ?? []));
    pageToken = res.next_page_token;
    if (!pageToken) break;
  }
  const result = found.map((v) => normalize(v, version));
  await deps.cache.set(key, result, 24 * HOUR);
  return result;
}
