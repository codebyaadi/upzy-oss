import { isIP } from "node:net";

/**
 * What a page loads from other sites, remembered between scans so a change can be noticed. A script, frame or form
 * target that was not there when Upzy first looked is the classic sign of a compromised site (a card skimmer is one
 * added script), and the thing a person most wants to hear about.
 */
export interface PageState {
  /** When the page was first seen. */
  baselineAt: string;
  /** host -> when it first appeared, or "baseline" for what was there at the first look (not news) */
  scriptHosts: Record<string, string>;
  frameHosts: Record<string, string>;
  formHosts: Record<string, string>;
}

export const BASELINE = "baseline";

export interface PageHosts {
  scripts: string[];
  frames: string[];
  forms: string[];
}

const SECOND_LEVEL = new Set(["co", "com", "org", "net", "gov", "edu", "ac"]);

/** The part of a host that identifies the site (example.com, example.co.uk). Close enough without a public suffix list. */
export function siteOf(host: string): string {
  if (isIP(host)) return host;
  const parts = host.split(".");
  if (parts.length <= 2) return host;
  const tld = parts.at(-1)!;
  const second = parts.at(-2)!;
  return tld.length === 2 && SECOND_LEVEL.has(second)
    ? parts.slice(-3).join(".")
    : parts.slice(-2).join(".");
}

const ATTR = (tag: string, attr: string) =>
  new RegExp(String.raw`<${tag}\b[^>]*\b${attr}\s*=\s*["']([^"']+)["']`, "gi");

/** The hosts, other than the page's own site, that the page loads scripts and frames from or posts forms to. */
export function extractHosts(body: string, pageUrl: string, ownHost: string): PageHosts {
  const own = siteOf(ownHost.toLowerCase());
  const hostsOf = (tag: string, attr: string) => {
    const out = new Set<string>();
    for (const m of body.matchAll(ATTR(tag, attr))) {
      try {
        const u = new URL(m[1]!.trim(), pageUrl);
        if (u.protocol !== "http:" && u.protocol !== "https:") continue;
        const h = u.hostname.toLowerCase();
        if (h && siteOf(h) !== own) out.add(h);
      } catch {
        // not a URL
      }
    }
    return [...out].sort();
  };
  return {
    scripts: hostsOf("script", "src"),
    frames: hostsOf("iframe", "src"),
    forms: hostsOf("form", "action"),
  };
}

const CAP = 200;

function mergeKind(prev: Record<string, string> | undefined, now: string[], at: string) {
  const out: Record<string, string> = { ...prev };
  for (const h of now) out[h] ??= at;
  // A page can accumulate hosts forever (rotating ad servers). Keep the ones on the page now, then the newest.
  const keys = Object.keys(out);
  if (keys.length <= CAP) return out;
  const present = new Set(now);
  return Object.fromEntries(
    keys
      .sort(
        (a, b) => Number(present.has(b)) - Number(present.has(a)) || out[b]!.localeCompare(out[a]!),
      )
      .slice(0, CAP)
      .map((k) => [k, out[k]!]),
  );
}

/** Folds this scan's hosts into what was remembered. On the first scan everything is the baseline. */
export function mergePageState(
  prev: PageState | null | undefined,
  now: PageHosts,
  at: Date = new Date(),
): PageState {
  const when = at.toISOString();
  const baselineAt = prev?.baselineAt ?? when;
  // Whatever the first look finds is the baseline; anything that shows up afterwards is dated.
  const stamp = prev ? when : BASELINE;
  return {
    baselineAt,
    scriptHosts: mergeKind(prev?.scriptHosts, now.scripts, stamp),
    frameHosts: mergeKind(prev?.frameHosts, now.frames, stamp),
    formHosts: mergeKind(prev?.formHosts, now.forms, stamp),
  };
}
