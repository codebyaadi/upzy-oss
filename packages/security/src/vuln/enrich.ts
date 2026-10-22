import type { Severity } from "../types";
import { HOUR } from "./http";
import { queryNvd } from "./nvd";
import { queryOsv } from "./osv";
import type { Assessment, Component, RawVuln, Vuln, VulnDeps } from "./types";

const RANK: Record<Severity, number> = { critical: 4, high: 3, medium: 2, low: 1, info: 0 };
const maxSeverity = (a: Severity, b: Severity) => (RANK[a] >= RANK[b] ? a : b);

/** CVE ids in CISA's Known Exploited Vulnerabilities catalogue. Cached for 12h. */
export async function loadKev(deps: VulnDeps): Promise<Set<string>> {
  const cached = await deps.cache.get<string[]>("kev:catalog");
  if (cached) return new Set(cached);
  const res = (await deps.http(
    "https://www.cisa.gov/sites/default/files/feeds/known_exploited_vulnerabilities.json",
    { timeoutMs: 60_000 },
  )) as { vulnerabilities?: { cveID: string }[] };
  const ids = (res.vulnerabilities ?? []).map((v) => v.cveID);
  if (ids.length === 0) throw new Error("KEV catalogue was empty");
  await deps.cache.set("kev:catalog", ids, 12 * HOUR);
  return new Set(ids);
}

/** EPSS exploitation probabilities (0..1) for the given CVEs. Cached per CVE for 12h; batches of 100. */
export async function loadEpss(deps: VulnDeps, cves: string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  const missing: string[] = [];
  for (const id of cves) {
    const hit = await deps.cache.get<number>(`epss:${id}`);
    if (hit === undefined) missing.push(id);
    else out.set(id, hit);
  }
  for (let i = 0; i < missing.length; i += 100) {
    const batch = missing.slice(i, i + 100);
    const res = (await deps.http(`https://api.first.org/data/v1/epss?cve=${batch.join(",")}`)) as {
      data?: { cve: string; epss: string }[];
    };
    for (const row of res.data ?? []) {
      const score = Number(row.epss);
      if (Number.isFinite(score)) {
        out.set(row.cve, score);
        await deps.cache.set(`epss:${row.cve}`, score, 12 * HOUR);
      }
    }
  }
  return out;
}

async function rawVulns(deps: VulnDeps, c: Component): Promise<RawVuln[]> {
  return c.lookup.kind === "osv"
    ? queryOsv(deps, c.lookup, c.version)
    : queryNvd(deps, c.lookup.cpe);
}

/** Highest-priority first: known-exploited, then likely-to-be-exploited, then by CVSS. */
export const byPriority = (a: Vuln, b: Vuln) =>
  Number(b.kev) - Number(a.kev) ||
  (b.epss ?? 0) - (a.epss ?? 0) ||
  (b.cvss ?? 0) - (a.cvss ?? 0) ||
  RANK[b.severity] - RANK[a.severity];

/**
 * Looks up and ranks the vulnerabilities of each component. A lookup failure for a component
 * throws, so the scan records the check as errored instead of reporting "no vulnerabilities".
 * KEV and EPSS are enrichment: if they are unavailable the findings still come out, un-boosted.
 */
export async function assessComponents(
  deps: VulnDeps,
  components: Component[],
): Promise<Assessment[]> {
  const raw: { component: Component; vulns: RawVuln[] }[] = [];
  for (const component of components)
    raw.push({ component, vulns: dedupe(await rawVulns(deps, component)) });
  const withVulns = raw.filter((r) => r.vulns.length > 0);
  if (withVulns.length === 0) return [];

  const cves = [
    ...new Set(withVulns.flatMap((r) => r.vulns.map((v) => v.cve).filter((c): c is string => !!c))),
  ];
  const [kev, epss] = await Promise.all([
    loadKev(deps).catch(() => new Set<string>()),
    loadEpss(deps, cves).catch(() => new Map<string, number>()),
  ]);

  return withVulns.map(({ component, vulns }) => {
    const enriched: Vuln[] = vulns
      .map((v) => ({
        ...v,
        kev: !!v.cve && kev.has(v.cve),
        epss: v.cve ? (epss.get(v.cve) ?? null) : null,
      }))
      .sort(byPriority);
    let severity = enriched.reduce<Severity>((s, v) => maxSeverity(s, v.severity), "info");
    if (enriched.some((v) => v.kev)) severity = maxSeverity(severity, "high");
    return { component, vulns: enriched, severity };
  });
}

/** The same CVE can arrive from several advisories; keep the richest record per id. */
function dedupe(vulns: RawVuln[]): RawVuln[] {
  const byId = new Map<string, RawVuln>();
  for (const v of vulns) {
    const prev = byId.get(v.id);
    byId.set(
      v.id,
      prev
        ? {
            ...prev,
            cvss: prev.cvss ?? v.cvss,
            fixedIn: prev.fixedIn ?? v.fixedIn,
            summary: prev.summary || v.summary,
          }
        : v,
    );
  }
  return [...byId.values()];
}
