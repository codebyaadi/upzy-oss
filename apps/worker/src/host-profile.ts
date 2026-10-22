import type { HostProfile } from "@upzy/ai";
import { safeFetch } from "@upzy/probes";

export interface ProfileDeps {
  fetch: typeof safeFetch;
}
export const realProfileDeps: ProfileDeps = { fetch: safeFetch };

const clip = (s: string | null | undefined, n: number) =>
  s ? s.replace(/\s+/g, " ").trim().slice(0, n) || null : null;

/** The page title and the first visible text, from a (possibly huge, possibly hostile) HTML body. */
export function readPage(body: string): { title: string | null; snippet: string | null } {
  const title = /<title[^>]*>([\s\S]{0,300}?)<\/title>/i.exec(body)?.[1] ?? null;
  const text = body
    .replace(/<(script|style|noscript)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&[a-z#0-9]+;/gi, " ");
  return { title: clip(title, 160), snippet: clip(text, 300) };
}

/**
 * One anonymous GET to the front page through the SSRF guard (https first, then http), reduced to a few facts.
 * Never throws: a failure is itself a fact about the host.
 */
export async function profileHost(
  host: string,
  resolves: boolean,
  deps: ProfileDeps = realProfileDeps,
): Promise<HostProfile> {
  if (!resolves) return { host, resolves, http: { error: "The name does not resolve in DNS." } };
  let lastError = "no response";
  for (const scheme of ["https", "http"] as const) {
    try {
      const r = await deps.fetch(`${scheme}://${host}/`, {
        timeoutMs: 6000,
        maxRedirects: 3,
        maxBodyBytes: 20_000,
        headers: { "user-agent": "UpzyDiscovery/1.0 (+one anonymous request)" },
      });
      const final = new URL(r.finalUrl);
      const page = /html|text/i.test(r.headers["content-type"] ?? "")
        ? readPage(r.body)
        : { title: null, snippet: null };
      return {
        host,
        resolves,
        http: {
          status: r.status,
          scheme,
          redirectedTo: final.hostname !== host ? `${final.protocol}//${final.hostname}` : null,
          server: clip(r.headers["server"], 80),
          poweredBy: clip(r.headers["x-powered-by"], 80),
          contentType: clip(r.headers["content-type"], 60),
          ...page,
        },
      };
    } catch (e) {
      lastError = e instanceof Error ? e.message.slice(0, 120) : "request failed";
    }
  }
  return { host, resolves, http: { error: lastError } };
}
