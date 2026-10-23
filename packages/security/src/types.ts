import type { SafeFetchOptions, SafeFetchResult } from "@upzy/probes";

import type { VulnDeps } from "./vuln/types";

export type Severity = "critical" | "high" | "medium" | "low" | "info";
export type AssetKind = "domain" | "subdomain" | "url";

export interface FindingDraft {
  /** `<family>.<slug>`, e.g. "headers.hsts_missing". */
  checkKey: string;
  severity: Severity;
  title: string;
  description: string;
  remediation: string;
  /** Distinguishes several findings of one checkKey on an asset (e.g. a cookie name). */
  subject?: string;
  /** Observable facts only. Never secrets such as cookie values. */
  evidence?: Record<string, unknown>;
  /** Exploitation signals that raise the risk score above what severity alone gives. */
  risk?: { kev?: boolean; epss?: number };
}

export interface TlsInfo {
  protocol: string | null;
  authorized: boolean;
  authorizationError: string | null;
  validTo: Date | null;
  keyBits: number | null;
  keyType: string | null;
}

/** Everything a check touches on the network, injectable so checks are testable offline. */
export interface Deps {
  fetch: (url: string, opts?: SafeFetchOptions) => Promise<SafeFetchResult>;
  resolveTxt: (host: string) => Promise<string[][]>;
  resolveMx: (host: string) => Promise<{ exchange: string; priority: number }[]>;
  resolveCname: (host: string) => Promise<string[]>;
  resolveAddresses: (host: string) => Promise<string[]>;
  resolveCaa: (host: string) => Promise<unknown[]>;
  tls: (host: string) => Promise<TlsInfo>;
  /** Whether the server completes a handshake when the client offers only this old protocol version. */
  tlsLegacy: (host: string, version: "TLSv1" | "TLSv1.1") => Promise<boolean>;
  /** Whether a TCP connection to this port of the host's public address succeeds. */
  tcpOpen: (host: string, port: number) => Promise<boolean>;
  /** Google Safe Browsing key. The reputation check does nothing without it. */
  safeBrowsingKey?: string;
  vuln: VulnDeps;
}

export interface AssetRef {
  kind: AssetKind;
  /** Hostname for domain/subdomain, full URL for url. */
  value: string;
}

export interface CheckContext {
  asset: AssetRef;
  host: string;
  /** Page to inspect over HTTPS. */
  url: string;
  deps: Deps;
}

export interface Check {
  family: string;
  appliesTo: readonly AssetKind[];
  /** Sends more than a normal visit would (probing paths and ports), so it runs only for verified assets. */
  active?: boolean;
  /** Overrides the scan-wide per-check timeout (slow, rate-limited lookups need longer). */
  timeoutMs?: number;
  run(ctx: CheckContext): Promise<FindingDraft[]>;
}
