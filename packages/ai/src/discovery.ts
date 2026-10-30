import type { ModelRole, ModelSpec, ProviderName } from "./config";
import { tierModel } from "./providers";
import { verifyCredential } from "./verify";

/** A numeric version like "3.8" or "4-5" as a comparable list. */
const version = (v: string) => v.split(/[.-]/).map((n) => parseInt(n, 10) || 0);
const newer = (a: string, b: string) => {
  const x = version(a);
  const y = version(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d !== 0) return d > 0;
  }
  return false;
};

function newest(ids: string[], pattern: RegExp): string | null {
  let best: { id: string; v: string } | null = null;
  for (const id of ids) {
    const m = pattern.exec(id);
    if (!m) continue;
    const v = m[1]!;
    // Prefer the newest version; between an alias and a dated copy of it, the shorter alias.
    if (!best || newer(v, best.v) || (v === best.v && id.length < best.id.length)) best = { id, v };
  }
  return best?.id ?? null;
}

/**
 * Picks the model "Automatic" should use, from what a key can really use right now. Providers retire and rename
 * models (Gemini 2.5 Flash closed to new users while this was being built), so a fixed list goes stale: the newest
 * model of the right family and size wins. Null when nothing matches, and the caller falls back to the catalog.
 */
export function chooseLiveModel(
  provider: ProviderName,
  tier: ModelRole,
  ids: string[],
): ModelSpec | null {
  const pick = (id: string | null) => (id ? { provider, model: id } : null);
  switch (provider) {
    case "google": {
      // The "-latest" aliases are the stable choice: a numbered preview can be overloaded or closed to new keys.
      const alias = tier === "fast" ? "gemini-flash-lite-latest" : "gemini-flash-latest";
      if (ids.includes(alias)) return pick(alias);
      const lite = newest(ids, /^gemini-(\d+(?:\.\d+)?)-flash-lite$/);
      const flash = newest(ids, /^gemini-(\d+(?:\.\d+)?)-flash$/);
      const pro = newest(ids, /^gemini-(\d+(?:\.\d+)?)-pro$/);
      return pick(tier === "fast" ? (lite ?? flash) : (flash ?? pro ?? lite));
    }
    case "openai": {
      const nano = newest(ids, /^gpt-(\d+(?:\.\d+)?)-nano$/);
      const mini = newest(ids, /^gpt-(\d+(?:\.\d+)?)-mini$/);
      const base = newest(ids, /^gpt-(\d+(?:\.\d+)?)$/);
      return pick(tier === "fast" ? (nano ?? mini) : (mini ?? base ?? nano));
    }
    case "anthropic": {
      const part = (family: string) =>
        newest(ids, new RegExp(`^claude-${family}-(\\d+(?:-\\d+)?)(?:-\\d{8})?$`));
      const haiku = part("haiku");
      const sonnet = part("sonnet");
      return pick(tier === "fast" ? (haiku ?? sonnet) : (sonnet ?? haiku));
    }
    default: {
      // Groq and OpenRouter: the catalog's choice, if the key can use it.
      const t = tierModel(provider, tier);
      return t && ids.includes(t.model) ? t : null;
    }
  }
}

const TTL_MS = 10 * 60_000;
const FAILED_TTL_MS = 60_000;

export type ModelLister = (provider: ProviderName, apiKey: string) => Promise<string[]>;

/** Asks a provider which models a key can use, remembering the answer for a few minutes. */
export function createModelDiscovery(list?: ModelLister) {
  const lister: ModelLister =
    list ??
    (async (provider, apiKey) => {
      const r = await verifyCredential(provider, apiKey);
      if (!r.ok) throw new Error(r.message);
      return r.models;
    });
  const cache = new Map<string, { at: number; ttl: number; models: string[] }>();
  const k = (org: string, provider: string) => `${org}:${provider}`;
  return {
    /** What the key can use, or [] when that can't be found out right now. */
    async models(org: string, provider: ProviderName, apiKey: string): Promise<string[]> {
      const hit = cache.get(k(org, provider));
      if (hit && Date.now() - hit.at < hit.ttl) return hit.models;
      try {
        const models = await lister(provider, apiKey);
        cache.set(k(org, provider), { at: Date.now(), ttl: TTL_MS, models });
        return models;
      } catch {
        cache.set(k(org, provider), { at: Date.now(), ttl: FAILED_TTL_MS, models: [] });
        return [];
      }
    },
    prime(org: string, provider: ProviderName, models: string[]) {
      cache.set(k(org, provider), { at: Date.now(), ttl: TTL_MS, models });
    },
    forget(org: string, provider: string) {
      cache.delete(k(org, provider));
    },
  };
}
export type ModelDiscovery = ReturnType<typeof createModelDiscovery>;
