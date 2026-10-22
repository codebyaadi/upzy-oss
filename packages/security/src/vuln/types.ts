import type { Severity } from "../types";

export interface Cache {
  get<T>(key: string): Promise<T | undefined>;
  set(key: string, value: unknown, ttlMs: number): Promise<void>;
}

export interface HttpInit {
  method?: "GET" | "POST";
  body?: string;
  timeoutMs?: number;
  headers?: Record<string, string>;
}

/** Everything the vulnerability lookups need from the outside world. */
export interface VulnDeps {
  http: (url: string, init?: HttpInit) => Promise<unknown>;
  cache: Cache;
  /** Optional NVD API key: raises the NVD rate limit from 5 to 50 requests per 30s. */
  nvdApiKey?: string;
  sleep?: (ms: number) => Promise<void>;
}

/** Software detected on a page, and how to look its vulnerabilities up. */
export interface Component {
  product: string;
  display: string;
  version: string;
  /** What revealed it, e.g. `Server: nginx/1.18.0`. Shown as evidence. */
  detectedFrom: string;
  lookup: { kind: "osv"; ecosystem: string; name: string } | { kind: "nvd"; cpe: string };
}

export interface Vuln {
  /** CVE id when one exists, otherwise the advisory id (e.g. GHSA-...). */
  id: string;
  cve: string | null;
  summary: string;
  severity: Severity;
  cvss: number | null;
  kev: boolean;
  /** Probability of exploitation in the next 30 days (0..1). CVEs only. */
  epss: number | null;
  fixedIn: string | null;
}

export type RawVuln = Omit<Vuln, "kev" | "epss">;

export interface Assessment {
  component: Component;
  vulns: Vuln[];
  /** Worst CVSS severity, raised to at least "high" if anything is known to be exploited. */
  severity: Severity;
}
