/**
 * First-line, static SSRF screen for user-supplied monitor targets. It rejects hosts that are
 * obviously internal. It does NOT replace the resolve-then-pin check the prober performs at
 * connect time (DNS can still point a public name at a private address).
 */
const BLOCKED_SUFFIXES = [".localhost", ".local", ".internal", ".lan", ".home.arpa"];

export function isBlockedHost(input: string): boolean {
  let host = input.trim().toLowerCase().replace(/\.$/, "");
  if (host.startsWith("[") && host.endsWith("]")) host = host.slice(1, -1);

  if (host === "localhost" || BLOCKED_SUFFIXES.some((s) => host.endsWith(s))) return true;
  if (host === "metadata.google.internal") return true;

  // IPv6 literals: loopback, unspecified, unique-local, link-local, IPv4-mapped.
  if (host.includes(":")) {
    if (host === "::" || host === "::1") return true;
    if (/^f[cd]/.test(host) || /^fe[89ab]/.test(host)) return true;
    const mapped = host.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    return mapped ? isBlockedHost(mapped[1]!) : false;
  }

  // Single-number / hex / octal IPv4 forms ("2130706433", "0x7f.1", "127.1") normalise to a
  // private address in browsers and many resolvers, so treat any all-numeric-ish host as an IP.
  if (/^[0-9a-fx.]+$/.test(host) && /\d/.test(host)) {
    const parts = host
      .split(".")
      .map((p) =>
        p.startsWith("0x") ? parseInt(p, 16) : /^0\d/.test(p) ? parseInt(p, 8) : Number(p),
      );
    if (parts.some((n) => !Number.isFinite(n))) return true;
    let n: number;
    if (parts.length === 1) n = parts[0]!;
    else if (parts.length === 2) n = parts[0]! * 2 ** 24 + parts[1]!;
    else if (parts.length === 3) n = parts[0]! * 2 ** 24 + parts[1]! * 2 ** 16 + parts[2]!;
    else if (parts.length === 4)
      n = parts[0]! * 2 ** 24 + parts[1]! * 2 ** 16 + parts[2]! * 256 + parts[3]!;
    else return true;
    const a = Math.floor(n / 2 ** 24) % 256;
    const b = Math.floor(n / 2 ** 16) % 256;
    return (
      n >= 2 ** 32 ||
      a === 0 ||
      a === 10 ||
      a === 127 ||
      a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168)
    );
  }
  return false;
}

export function hostOfTarget(target: string): string {
  try {
    return new URL(target).hostname;
  } catch {
    return target.replace(/:\d+$/, "");
  }
}
