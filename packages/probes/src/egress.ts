import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

export class BlockedTargetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BlockedTargetError";
  }
}

function ipv4ToInt(ip: string): number {
  return ip.split(".").reduce((n, p) => n * 256 + Number(p), 0);
}

const V4_BLOCKS: [string, number][] = [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10], // CGNAT
  ["127.0.0.0", 8],
  ["169.254.0.0", 16], // link-local + cloud metadata
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["224.0.0.0", 3], // multicast + reserved + broadcast
];

function isBlockedV4(ip: string): boolean {
  const n = ipv4ToInt(ip);
  return V4_BLOCKS.some(([base, bits]) => {
    const size = 2 ** (32 - bits);
    const start = ipv4ToInt(base);
    return n >= start && n < start + size;
  });
}

/** Expands an IPv6 literal to 8 16-bit groups, or null if malformed. */
function expandV6(ip: string): number[] | null {
  let s = ip.toLowerCase().split("%")[0]!;
  const tail = s.match(/(\d+\.\d+\.\d+\.\d+)$/);
  if (tail) {
    const n = ipv4ToInt(tail[1]!);
    s =
      s.slice(0, -tail[1]!.length) +
      ((n >>> 16) & 0xffff).toString(16) +
      ":" +
      (n & 0xffff).toString(16);
  }
  const halves = s.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const rest = halves[1] ? halves[1].split(":") : [];
  const fill = halves.length === 2 ? 8 - head.length - rest.length : 0;
  if (fill < 0 || (halves.length === 1 && head.length !== 8)) return null;
  const groups = [...head, ...Array(fill).fill("0"), ...rest].map((g) => parseInt(g, 16));
  return groups.length === 8 && groups.every((g) => Number.isInteger(g)) ? groups : null;
}

function isBlockedV6(ip: string): boolean {
  const g = expandV6(ip);
  if (!g) return true; // unparsable: fail closed
  const [a, b, c, d, e, f, h, i] = g as [
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
  ];
  if (g.every((x) => x === 0)) return true; // ::
  if (g.slice(0, 7).every((x) => x === 0) && i === 1) return true; // ::1
  if ((a & 0xfe00) === 0xfc00) return true; // fc00::/7 unique local
  if ((a & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  if ((a & 0xff00) === 0xff00) return true; // multicast
  // IPv4 embedded in ::ffff:0:0/96 (mapped), ::/96 (compat), 64:ff9b::/96 (NAT64)
  const embedded = `${h >> 8}.${h & 255}.${i >> 8}.${i & 255}`;
  const hi = [a, b, c, d, e];
  if (hi.every((x) => x === 0) && (f === 0xffff || f === 0)) return isBlockedV4(embedded);
  if (a === 0x64 && b === 0xff9b && hi.slice(2).every((x) => x === 0) && f === 0)
    return isBlockedV4(embedded);
  if (a === 0x2002) return isBlockedV4(`${b >> 8}.${b & 255}.${c >> 8}.${c & 255}`); // 6to4
  return false;
}

/** True when the address is not publicly routable. Unparsable input is treated as blocked. */
export function isBlockedIp(ip: string): boolean {
  const v = isIP(ip);
  if (v === 4) return isBlockedV4(ip);
  if (v === 6) return isBlockedV6(ip);
  return true;
}

export interface ResolvedTarget {
  hostname: string;
  address: string;
  family: 4 | 6;
}

/**
 * Resolves `hostname` and returns an address that is safe to connect to. Every resolved
 * address must be public; one private record rejects the whole name. Callers must connect to
 * the returned address (not re-resolve), which defeats DNS rebinding.
 */
export async function resolvePublic(hostname: string): Promise<ResolvedTarget> {
  const host = hostname.startsWith("[") ? hostname.slice(1, -1) : hostname;
  if (isIP(host)) {
    if (isBlockedIp(host))
      throw new BlockedTargetError(`Target address ${host} is not publicly routable`);
    return { hostname: host, address: host, family: isIP(host) as 4 | 6 };
  }
  if (host === "localhost" || host.endsWith(".localhost"))
    throw new BlockedTargetError("Target resolves to a private address");
  const records = await lookup(host, { all: true });
  if (records.length === 0)
    throw Object.assign(new Error(`ENOTFOUND ${host}`), { code: "ENOTFOUND" });
  if (records.some((r) => isBlockedIp(r.address))) {
    throw new BlockedTargetError("Target resolves to a private address");
  }
  const first = records[0]!;
  return { hostname: host, address: first.address, family: first.family as 4 | 6 };
}

export interface SafeFetchOptions {
  method?: "GET" | "HEAD" | "POST" | "PATCH";
  /** Request body, POST only. Redirects are never followed for POST. */
  body?: string;
  timeoutMs?: number;
  maxRedirects?: number;
  maxBodyBytes?: number;
  headers?: Record<string, string>;
}

/**
 * How Upzy introduces itself to the sites it checks. The link goes to a page on this installation that says who is
 * asking and how to stop it (WEB_ORIGIN is the app's public address).
 */
export function botUserAgent(): string {
  const origin = process.env.WEB_ORIGIN?.replace(/\/$/, "");
  return origin?.startsWith("https://") ? `UpzyBot/1.0 (+${origin}/bot)` : "UpzyBot/1.0";
}

export interface SafeFetchResult {
  status: number;
  /** Response headers, lowercased names. Multiple values are joined with ", " (except set-cookie). */
  headers: Record<string, string>;
  setCookies: string[];
  finalUrl: string;
  body: string;
  ttfbMs: number;
  totalMs: number;
}

const bracket = (addr: string, family: number) => (family === 6 ? `[${addr}]` : addr);

/**
 * SSRF-safe HTTP(S) request: resolves and validates the host, connects to the pinned IP (TLS
 * verified against the original hostname), follows at most `maxRedirects` redirects and
 * re-validates every hop. The body is capped.
 */
export async function safeFetch(
  rawUrl: string,
  opts: SafeFetchOptions = {},
): Promise<SafeFetchResult> {
  const {
    method = "GET",
    body: requestBody,
    timeoutMs = 10_000,
    maxRedirects = 5,
    maxBodyBytes = 1_000_000,
    headers = {},
  } = opts;
  const started = performance.now();
  const deadline = AbortSignal.timeout(timeoutMs);
  let url = new URL(rawUrl);

  for (let hop = 0; hop <= maxRedirects; hop++) {
    if (url.protocol !== "http:" && url.protocol !== "https:")
      throw new BlockedTargetError(`Unsupported scheme ${url.protocol}`);
    const target = await resolvePublic(url.hostname);
    const port = url.port ? `:${url.port}` : "";
    const pinned = `${url.protocol}//${bracket(target.address, target.family)}${port}${url.pathname}${url.search}`;

    const sent = performance.now();
    const res = await fetch(pinned, {
      method,
      body: method === "POST" || method === "PATCH" ? requestBody : undefined,
      redirect: "manual",
      signal: deadline,
      headers: { host: url.host, "user-agent": botUserAgent(), ...headers },
      tls: { serverName: target.hostname },
    } as RequestInit);
    const ttfbMs = Math.round(performance.now() - sent);

    const location = res.headers.get("location");
    if (
      (method === "GET" || method === "HEAD") &&
      res.status >= 300 &&
      res.status < 400 &&
      location
    ) {
      await res.body?.cancel();
      url = new URL(location, url);
      continue;
    }

    let body = "";
    if (method !== "HEAD" && res.body) {
      const reader = res.body.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      while (size < maxBodyBytes) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        size += value.byteLength;
      }
      await reader.cancel().catch(() => {});
      body = new TextDecoder().decode(Buffer.concat(chunks).subarray(0, maxBodyBytes));
    }
    const responseHeaders: Record<string, string> = {};
    res.headers.forEach((v, k) => {
      if (k !== "set-cookie") responseHeaders[k] = v;
    });
    return {
      status: res.status,
      headers: responseHeaders,
      setCookies: res.headers.getSetCookie(),
      finalUrl: url.toString(),
      body,
      ttfbMs,
      totalMs: Math.round(performance.now() - started),
    };
  }
  throw new Error(`Too many redirects (>${maxRedirects})`);
}
