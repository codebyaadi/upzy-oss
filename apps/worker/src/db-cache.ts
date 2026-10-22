import { schema, type Db } from "@upzy/db";
import type { Cache } from "@upzy/security";
import { eq, lt, sql } from "drizzle-orm";

/**
 * Postgres-backed cache for NVD/OSV/EPSS/KEV lookups, shared by every worker so the NVD rate
 * limit is spent once per product version instead of once per scan.
 */
export function dbCache(db: Db): Cache {
  const { httpCache } = schema;
  return {
    async get<T>(key: string) {
      const [row] = await db
        .select({ value: httpCache.value, expiresAt: httpCache.expiresAt })
        .from(httpCache)
        .where(eq(httpCache.key, key));
      return row && row.expiresAt.getTime() > Date.now() ? (row.value as { v: T }).v : undefined;
    },
    async set(key, value, ttlMs) {
      const expiresAt = new Date(Date.now() + ttlMs);
      // Wrapped in an object: the jsonb column helper only round-trips objects and arrays, not bare scalars.
      const wrapped = { v: value };
      await db
        .insert(httpCache)
        .values({ key, value: wrapped, expiresAt })
        .onConflictDoUpdate({
          target: httpCache.key,
          set: { value: wrapped, expiresAt, fetchedAt: sql`now()` },
        });
    },
  };
}

/** Drops expired entries so the table does not grow without bound. */
export async function pruneCache(db: Db) {
  await db.delete(schema.httpCache).where(lt(schema.httpCache.expiresAt, new Date()));
}
