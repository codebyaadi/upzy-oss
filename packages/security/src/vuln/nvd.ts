import type { Severity } from "../types";
import { HOUR, clip } from "./http";
import type { RawVuln, VulnDeps } from "./types";

interface NvdCve {
  id: string;
  vulnStatus?: string;
  descriptions?: { lang: string; value: string }[];
  metrics?: Record<
    string,
    { cvssData?: { baseScore?: number; baseSeverity?: string }; baseSeverity?: string }[]
  >;
}

const SEVERITY: Record<string, Severity> = {
  CRITICAL: "critical",
  HIGH: "high",
  MEDIUM: "medium",
  LOW: "low",
};

function cvssOf(c: NvdCve): { score: number | null; severity: Severity } {
  // Newest scoring system available wins.
  for (const k of ["cvssMetricV40", "cvssMetricV31", "cvssMetricV30", "cvssMetricV2"]) {
    const m = c.metrics?.[k]?.[0];
    const sev = SEVERITY[(m?.cvssData?.baseSeverity ?? m?.baseSeverity ?? "").toUpperCase()];
    if (m && sev) return { score: m.cvssData?.baseScore ?? null, severity: sev };
  }
  return { score: null, severity: "medium" };
}

/**
 * NVD allows 5 requests per 30s without an API key (50 with one). Requests that share a cache
 * (i.e. everything in one worker process) are serialised with a minimum gap, so concurrent scans
 * cannot trip the limit. Keyed on the cache object so independent setups do not wait on each other.
 */
const chains = new WeakMap<object, Promise<unknown>>();
function paced<T>(deps: VulnDeps, task: () => Promise<T>): Promise<T> {
  const gap = deps.nvdApiKey ? 700 : 6_500;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const run = (chains.get(deps.cache) ?? Promise.resolve()).then(task);
  chains.set(
    deps.cache,
    run.then(
      () => sleep(gap),
      () => sleep(gap),
    ),
  );
  return run;
}

/** CVEs that apply to a CPE (product + exact version), from the NVD. Cached for 24h. */
export async function queryNvd(deps: VulnDeps, cpe: string): Promise<RawVuln[]> {
  const key = `nvd:${cpe}`;
  const cached = await deps.cache.get<RawVuln[]>(key);
  if (cached) return cached;

  const all: NvdCve[] = [];
  let start = 0;
  for (let page = 0; page < 5; page++) {
    const url = `https://services.nvd.nist.gov/rest/json/cves/2.0?cpeName=${encodeURIComponent(cpe)}&resultsPerPage=2000&startIndex=${start}`;
    const res = (await paced(deps, () =>
      deps.http(url, {
        timeoutMs: 60_000,
        headers: deps.nvdApiKey ? { apiKey: deps.nvdApiKey } : undefined,
      }),
    )) as { totalResults?: number; vulnerabilities?: { cve: NvdCve }[] };
    const batch = (res.vulnerabilities ?? []).map((v) => v.cve);
    all.push(...batch);
    start += batch.length;
    if (batch.length === 0 || start >= (res.totalResults ?? 0)) break;
  }

  const result: RawVuln[] = all
    .filter((c) => c.vulnStatus !== "Rejected")
    .map((c) => {
      const { score, severity } = cvssOf(c);
      return {
        id: c.id,
        cve: c.id,
        summary: clip(c.descriptions?.find((d) => d.lang === "en")?.value ?? ""),
        severity,
        cvss: score,
        fixedIn: null,
      };
    });
  await deps.cache.set(key, result, 24 * HOUR);
  return result;
}
