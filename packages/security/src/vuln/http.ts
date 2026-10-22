import { botUserAgent } from "@upzy/probes";

import type { Cache, HttpInit } from "./types";

/** JSON over HTTP with a timeout. Third-party APIs only: callers pass fixed, trusted URLs. */
export async function httpJson(url: string, init: HttpInit = {}): Promise<unknown> {
  const res = await fetch(url, {
    method: init.method ?? "GET",
    body: init.body,
    signal: AbortSignal.timeout(init.timeoutMs ?? 30_000),
    headers: {
      accept: "application/json",
      "user-agent": botUserAgent(),
      ...(init.body ? { "content-type": "application/json" } : {}),
      ...init.headers,
    },
  });
  if (!res.ok)
    throw Object.assign(new Error(`HTTP ${res.status} from ${new URL(url).host}`), {
      status: res.status,
    });
  try {
    return await res.json();
  } catch {
    throw new Error(`Invalid JSON from ${new URL(url).host}`);
  }
}

/** In-process cache, used when no shared (database) cache is supplied. */
export function memoryCache(): Cache {
  const store = new Map<string, { value: unknown; expires: number }>();
  return {
    async get<T>(key: string) {
      const hit = store.get(key);
      if (!hit || hit.expires < Date.now()) return undefined;
      return hit.value as T;
    },
    async set(key, value, ttlMs) {
      store.set(key, { value, expires: Date.now() + ttlMs });
    },
  };
}

export const HOUR = 3_600_000;

/** Shortens text at a word boundary and marks the cut, so summaries never end mid-word. */
export function clip(text: string, max = 300): string {
  const t = text.replace(/\s+/g, " ").trim();
  if (t.length <= max) return t;
  const cut = t.slice(0, max);
  return `${cut.slice(0, Math.max(cut.lastIndexOf(" "), max - 40))}…`;
}
