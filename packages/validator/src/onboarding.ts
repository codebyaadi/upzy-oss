import { z } from "zod";

import { isBlockedHost } from "./ssrf";
import { isPublicHostname } from "./status-page";

/** Second-level suffixes where the registrable domain has three labels (acme.co.uk). Not the full public suffix list. */
const TWO_LEVEL = new Set([
  "co.uk",
  "org.uk",
  "ac.uk",
  "gov.uk",
  "me.uk",
  "com.au",
  "net.au",
  "org.au",
  "co.nz",
  "co.in",
  "net.in",
  "org.in",
  "co.jp",
  "ne.jp",
  "com.br",
  "com.mx",
  "com.ar",
  "com.cn",
  "com.tr",
  "com.sg",
  "com.hk",
  "co.za",
  "co.kr",
  "co.id",
]);

export interface ParsedSite {
  /** The monitored address, e.g. https://www.acme.com/ */
  url: string;
  /** The host to run SSL checks on. */
  host: string;
  /** What the security scan covers: the registrable domain, or the subdomain that was entered. */
  assetValue: string;
  assetKind: "domain" | "subdomain";
}

/**
 * What a person typed into "which site do you want to watch?": a bare domain, a www address, a subdomain or a full
 * URL. Returns null for anything that isn't a public website address (IPs, localhost, internal names, other schemes).
 */
export function parseSite(input: string): ParsedSite | null {
  const raw = input.trim();
  if (!raw || raw.length > 300 || /\s/.test(raw)) return null;
  let u: URL;
  try {
    u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`);
  } catch {
    return null;
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") return null;
  if (u.username || u.password) return null;
  const host = u.hostname.toLowerCase().replace(/\.$/, "");
  if (!isPublicHostname(host) || isBlockedHost(host)) return null;

  const stripped = host.replace(/^www\./, "");
  const labels = stripped.split(".");
  const suffixLabels = TWO_LEVEL.has(labels.slice(-2).join(".")) ? 2 : 1;
  const registrable = labels.slice(-(suffixLabels + 1)).join(".");
  const isApex = stripped === registrable;
  // A bare apex with no path: the normal case, so the address is just the origin.
  const path = u.pathname === "/" ? "/" : u.pathname.replace(/\/+$/, "") || "/";
  return {
    url: `${u.protocol}//${u.host}${path}`,
    host,
    assetValue: isApex ? registrable : stripped,
    assetKind: isApex ? "domain" : "subdomain",
  };
}

export const OnboardSiteSchema = z.object({
  workspaceId: z.uuid(),
  site: z
    .string()
    .trim()
    .min(1, "Enter your website")
    .max(300)
    .refine((v) => parseSite(v) !== null, "Enter a public website address like example.com"),
});
