import { botUserAgent } from "@upzy/probes";

/**
 * Subdomain discovery from Certificate Transparency logs. Every publicly trusted certificate is
 * logged, so the names on certificates for a domain reveal hosts that were never announced.
 * This is passive: it reads public logs and sends nothing to the target.
 */

export type JsonFetcher = (url: string, timeoutMs: number) => Promise<unknown>;

const MAX_BYTES = 30 * 1024 * 1024;
export const MAX_HOSTS = 1000;

/** Plain HTTP GET returning parsed JSON. The hosts are fixed CT services, never user-supplied. */
export const httpJson: JsonFetcher = async (url, timeoutMs) => {
  const res = await fetch(url, {
    signal: AbortSignal.timeout(timeoutMs),
    headers: { accept: "application/json", "user-agent": botUserAgent() },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const length = Number(res.headers.get("content-length") ?? 0);
  if (length > MAX_BYTES) throw new Error("Response too large");

  const reader = res.body!.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_BYTES) {
      await reader.cancel();
      throw new Error("Response too large");
    }
    chunks.push(value);
  }
  const text = new TextDecoder().decode(Buffer.concat(chunks));
  try {
    return JSON.parse(text);
  } catch {
    throw new Error("Response was not JSON");
  }
};

const LABEL = "[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?";
const HOSTNAME = new RegExp(`^${LABEL}(?:\\.${LABEL})+$`);

/**
 * Normalises raw certificate names into distinct, valid subdomains of `domain`. Wildcards are
 * stripped to their base, the apex and unrelated names are dropped, and the result is capped.
 */
export function extractSubdomains(domain: string, rawNames: string[]): string[] {
  const apex = domain.toLowerCase().replace(/\.$/, "");
  const found = new Set<string>();
  for (const raw of rawNames) {
    for (const part of raw.split(/\s+/)) {
      const name = part.trim().toLowerCase().replace(/^\*\./, "").replace(/\.$/, "");
      if (!name || name.length > 253 || name.includes("*") || !HOSTNAME.test(name)) continue;
      if (name !== apex && name.endsWith(`.${apex}`)) found.add(name);
    }
  }
  return [...found].sort().slice(0, MAX_HOSTS);
}

export interface DiscoverySource {
  name: string;
  url: (domain: string) => string;
  names: (payload: unknown) => string[];
}

const arrayOf = (payload: unknown): Record<string, unknown>[] => {
  if (!Array.isArray(payload)) throw new Error("Unexpected response shape");
  return payload as Record<string, unknown>[];
};

const crtshNames = (payload: unknown) =>
  arrayOf(payload).flatMap((r) => [String(r.name_value ?? ""), String(r.common_name ?? "")]);

export const SOURCES: DiscoverySource[] = [
  {
    name: "crt.sh",
    url: (d) => `https://crt.sh/?q=${encodeURIComponent(`%.${d}`)}&output=json`,
    names: crtshNames,
  },
  // crt.sh is frequently overloaded; the bare-name query takes a different path and often succeeds.
  {
    name: "crt.sh (identity)",
    url: (d) => `https://crt.sh/?q=${encodeURIComponent(d)}&output=json`,
    names: crtshNames,
  },
  {
    name: "certspotter",
    url: (d) =>
      `https://api.certspotter.com/v1/issuances?domain=${encodeURIComponent(d)}&include_subdomains=true&expand=dns_names`,
    names: (payload) =>
      arrayOf(payload).flatMap((r) => (Array.isArray(r.dns_names) ? r.dns_names.map(String) : [])),
  },
];

export interface DiscoveryResult {
  hosts: string[];
  source: string;
  /** Sources that failed before one succeeded. */
  errors: string[];
}

/**
 * Tries each source in order and returns the first that answers. If every source fails it throws,
 * so the job retries later, rather than reporting "no subdomains" for what was an outage.
 */
export async function discoverSubdomains(
  domain: string,
  opts: { json?: JsonFetcher; sources?: DiscoverySource[]; timeoutMs?: number } = {},
): Promise<DiscoveryResult> {
  const json = opts.json ?? httpJson;
  const errors: string[] = [];
  for (const source of opts.sources ?? SOURCES) {
    try {
      const payload = await json(source.url(domain), opts.timeoutMs ?? 60_000);
      return {
        hosts: extractSubdomains(domain, source.names(payload)),
        source: source.name,
        errors,
      };
    } catch (e) {
      errors.push(`${source.name}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  throw new Error(`All certificate transparency sources failed (${errors.join("; ")})`);
}

/** Resolves hosts with bounded concurrency. `true`/`false` = resolves or not; `null` = lookup error. */
export async function checkResolves(
  hosts: string[],
  resolve: (host: string) => Promise<string[]>,
  concurrency = 25,
): Promise<Map<string, boolean | null>> {
  const out = new Map<string, boolean | null>();
  let next = 0;
  const worker = async () => {
    while (next < hosts.length) {
      const host = hosts[next++]!;
      // One retry: resolvers drop queries under load, and a false "unknown" hides a live host.
      const attempt = () => resolve(host).then((a) => a.length > 0);
      out.set(
        host,
        await attempt()
          .catch(() => Bun.sleep(150).then(attempt))
          .catch(() => null),
      );
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, hosts.length) }, worker));
  return out;
}
