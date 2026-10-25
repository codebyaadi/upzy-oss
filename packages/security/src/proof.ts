import type { SafeFetchOptions, SafeFetchResult } from "@upzy/probes";

import type { Deps } from "./types";

/** One request a check made, as far as it proves a finding. Secrets are never kept: no cookie values, no bodies. */
export interface ProofRequest {
  method: string;
  url: string;
  /** Where it ended up after redirects, when that differs. */
  finalUrl?: string;
  status: number;
  /** The response headers that matter for security findings, lowercase. */
  headers: Record<string, string>;
  /** Cookies the response set, as `name; Secure; HttpOnly; SameSite=Lax`: attributes only, never the value. */
  cookies?: string[];
}

/** Attached to every finding as `evidence.proof`, so the finding can be checked by hand. */
export interface Proof {
  checkedAt: string;
  requests?: ProofRequest[];
  /** Set when the finding was seen again by a second, independent run before it was reported. */
  confirmedAt?: string;
}

const KEEP_HEADERS = new Set([
  "server",
  "x-powered-by",
  "content-type",
  "content-length",
  "location",
  "cache-control",
  "strict-transport-security",
  "content-security-policy",
  "x-frame-options",
  "x-content-type-options",
  "referrer-policy",
  "permissions-policy",
  "cross-origin-opener-policy",
  "cross-origin-resource-policy",
  "access-control-allow-origin",
  "access-control-allow-credentials",
  "www-authenticate",
  "x-generator",
]);

const clip = (s: string, n = 300) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** `session=abc123; Path=/; Secure; HttpOnly` -> `session; Secure; HttpOnly`. */
export function cookieShape(setCookie: string): string {
  const [pair, ...attrs] = setCookie.split(";").map((p) => p.trim());
  const name = pair?.split("=")[0] ?? "";
  const keep = attrs.filter((a) =>
    /^(secure|httponly|samesite=|domain=|max-age=|expires=)/i.test(a),
  );
  return [name, ...keep].join("; ");
}

export function proofRequest(
  url: string,
  opts: SafeFetchOptions | undefined,
  res: SafeFetchResult,
): ProofRequest {
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(res.headers)) if (KEEP_HEADERS.has(k)) headers[k] = clip(v);
  return {
    method: opts?.method ?? "GET",
    url,
    ...(res.finalUrl && res.finalUrl !== url ? { finalUrl: res.finalUrl } : {}),
    status: res.status,
    headers,
    ...(res.setCookies.length ? { cookies: res.setCookies.slice(0, 10).map(cookieShape) } : {}),
  };
}

/** Query strings can carry API keys and tokens, so a recorded address keeps the path and says a query was there. */
export function redactUrl(u: string): string {
  const i = u.indexOf("?");
  return i === -1 ? u : `${u.slice(0, i)}?…`;
}

const onHost = (url: string, host: string) => {
  try {
    const h = new URL(url).hostname;
    return h === host || h.endsWith(`.${host}`);
  } catch {
    return false;
  }
};

/**
 * Wraps `fetch` so the requests a check makes to the asset itself are noted, for the proof attached to what it finds.
 * Lookups at third parties (RDAP, Safe Browsing, CT logs) are not the evidence and may carry keys, so they are skipped.
 */
export function recordFetches(deps: Deps, host: string): { deps: Deps; requests: ProofRequest[] } {
  const requests: ProofRequest[] = [];
  return {
    requests,
    deps: {
      ...deps,
      fetch: async (url, opts) => {
        const res = await deps.fetch(url, opts);
        if (requests.length < 8 && onHost(url, host)) {
          const r = proofRequest(url, opts, res);
          requests.push({
            ...r,
            url: redactUrl(r.url),
            ...(r.finalUrl ? { finalUrl: redactUrl(r.finalUrl) } : {}),
          });
        }
        return res;
      },
    },
  };
}
