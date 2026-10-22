import { decrypt } from "@upzy/crypto";
import { schema, type Db } from "@upzy/db";
import { and, eq, sql } from "drizzle-orm";

import { parseModelSpec, type ModelSpec } from "./config";

export interface AiSettings {
  enabled: boolean;
  dailyTokenBudget: number;
  /** Chosen models; null means "follow the other role or the provider of the saved key". */
  models: { fast: ModelSpec | null; smart: ModelSpec | null };
}

export interface UsageEvent {
  organizationId: string;
  provider: string;
  model: string;
  feature: string;
  inputTokens: number;
  outputTokens: number;
  failed: boolean;
  /** Estimated cost in millionths of a dollar. Null when the model has no known price. */
  costMicros?: number | null;
}

export interface AiStores {
  settings: { get(organizationId: string): Promise<AiSettings> };
  credentials: {
    /** The organization's own API key for a provider, decrypted. Undefined when none is stored. */
    get(organizationId: string, provider: string): Promise<string | undefined>;
    /** Providers this organization has saved a key for, oldest first. */
    providers(organizationId: string): Promise<string[]>;
    /** Marks a key as just used, so the settings page can show when. Best effort. */
    touch?(organizationId: string, provider: string): Promise<void>;
  };
  usage: {
    tokensToday(organizationId: string): Promise<number>;
    record(event: UsageEvent): Promise<void>;
  };
  cache: {
    get<T>(key: string): Promise<T | undefined>;
    set(key: string, value: unknown, ttlMs: number): Promise<void>;
  };
}

export const utcDay = (d = new Date()) => d.toISOString().slice(0, 10);

/** Postgres-backed stores: settings and usage are per organization, the cache is shared and holds no tenant identifiers. */
export function createDbStores(
  db: Db,
  defaults: { dailyTokenBudget: number; encryptionKey?: string },
): AiStores {
  const { aiSettings, aiUsage, aiCredentials, httpCache } = schema;
  const spec = (raw: string | null) => {
    if (!raw) return null;
    try {
      return parseModelSpec(raw);
    } catch {
      return null;
    }
  };
  return {
    settings: {
      async get(organizationId) {
        const [row] = await db
          .select()
          .from(aiSettings)
          .where(eq(aiSettings.organizationId, organizationId));
        // No row means nobody ever turned AI on.
        return row
          ? {
              enabled: row.enabled,
              dailyTokenBudget: row.dailyTokenBudget,
              models: { fast: spec(row.fastModel), smart: spec(row.smartModel) },
            }
          : {
              enabled: false,
              dailyTokenBudget: defaults.dailyTokenBudget,
              models: { fast: null, smart: null },
            };
      },
    },
    credentials: {
      async providers(organizationId) {
        const rows = await db
          .select({ provider: aiCredentials.provider })
          .from(aiCredentials)
          .where(eq(aiCredentials.organizationId, organizationId))
          .orderBy(aiCredentials.createdAt);
        return rows.map((r) => r.provider);
      },
      async touch(organizationId, provider) {
        await db
          .update(aiCredentials)
          .set({ lastUsedAt: new Date() })
          .where(
            and(
              eq(aiCredentials.organizationId, organizationId),
              eq(aiCredentials.provider, provider),
            ),
          );
      },
      async get(organizationId, provider) {
        if (!defaults.encryptionKey) return undefined;
        const [row] = await db
          .select({ encryptedKey: aiCredentials.encryptedKey })
          .from(aiCredentials)
          .where(
            and(
              eq(aiCredentials.organizationId, organizationId),
              eq(aiCredentials.provider, provider),
            ),
          );
        if (!row) return undefined;
        try {
          return decrypt(row.encryptedKey, defaults.encryptionKey);
        } catch {
          // A key encrypted with a rotated-away secret is as good as missing.
          return undefined;
        }
      },
    },
    usage: {
      async tokensToday(organizationId) {
        const [row] = await db
          .select({
            n: sql<number>`coalesce(sum(${aiUsage.inputTokens} + ${aiUsage.outputTokens}), 0)::int`,
          })
          .from(aiUsage)
          .where(and(eq(aiUsage.organizationId, organizationId), eq(aiUsage.day, utcDay())));
        return row?.n ?? 0;
      },
      async record(e) {
        await db
          .insert(aiUsage)
          .values({
            organizationId: e.organizationId,
            day: utcDay(),
            provider: e.provider,
            model: e.model,
            feature: e.feature,
            requests: e.failed ? 0 : 1,
            failures: e.failed ? 1 : 0,
            inputTokens: e.inputTokens,
            outputTokens: e.outputTokens,
            costMicros: e.costMicros ?? 0,
            unpricedRequests: !e.failed && e.costMicros == null ? 1 : 0,
          })
          .onConflictDoUpdate({
            target: [
              aiUsage.organizationId,
              aiUsage.day,
              aiUsage.provider,
              aiUsage.model,
              aiUsage.feature,
            ],
            set: {
              requests: sql`${aiUsage.requests} + ${e.failed ? 0 : 1}`,
              failures: sql`${aiUsage.failures} + ${e.failed ? 1 : 0}`,
              inputTokens: sql`${aiUsage.inputTokens} + ${e.inputTokens}`,
              outputTokens: sql`${aiUsage.outputTokens} + ${e.outputTokens}`,
              costMicros: sql`${aiUsage.costMicros} + ${e.costMicros ?? 0}`,
              unpricedRequests: sql`${aiUsage.unpricedRequests} + ${!e.failed && e.costMicros == null ? 1 : 0}`,
            },
          });
      },
    },
    cache: {
      async get<T>(key: string) {
        const [row] = await db
          .select({ value: httpCache.value, expiresAt: httpCache.expiresAt })
          .from(httpCache)
          .where(eq(httpCache.key, `ai:${key}`));
        return row && row.expiresAt.getTime() > Date.now() ? (row.value as { v: T }).v : undefined;
      },
      async set(key, value, ttlMs) {
        const expiresAt = new Date(Date.now() + ttlMs);
        const wrapped = { v: value };
        await db
          .insert(httpCache)
          .values({ key: `ai:${key}`, value: wrapped, expiresAt })
          .onConflictDoUpdate({
            target: httpCache.key,
            set: { value: wrapped, expiresAt, fetchedAt: sql`now()` },
          });
      },
    },
  };
}
