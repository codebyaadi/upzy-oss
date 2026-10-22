import { afterAll, describe, expect, test } from "bun:test";

import { createDb, schema } from "@upzy/db";
import { like } from "drizzle-orm";

import { dbCache, pruneCache } from "../src/db-cache";

const url = process.env.DATABASE_URL;
const run = url ? describe : describe.skip;

run("dbCache (postgres)", () => {
  const db = createDb(url);
  const cache = dbCache(db);
  const p = `test:${Date.now()}:`;
  afterAll(async () => {
    await db.delete(schema.httpCache).where(like(schema.httpCache.key, `${p}%`));
  });

  test("round-trips structured values and misses unknown keys", async () => {
    await cache.set(`${p}a`, { ids: ["CVE-1"], n: 2 }, 60_000);
    expect(await cache.get(`${p}a`)).toEqual({ ids: ["CVE-1"], n: 2 });
    expect(await cache.get(`${p}missing`)).toBeUndefined();
  });

  test("set overwrites, and arrays/numbers survive (not double-encoded)", async () => {
    await cache.set(`${p}b`, [1, 2, 3], 60_000);
    await cache.set(`${p}b`, [4], 60_000);
    expect(await cache.get(`${p}b`)).toEqual([4]);
    await cache.set(`${p}n`, 0.25, 60_000);
    expect(await cache.get(`${p}n`)).toBe(0.25);
  });

  test("expired entries are not returned and are pruned", async () => {
    await cache.set(`${p}old`, "x", -1000);
    expect(await cache.get(`${p}old`)).toBeUndefined();
    await pruneCache(db);
    const rows = await db
      .select()
      .from(schema.httpCache)
      .where(like(schema.httpCache.key, `${p}old`));
    expect(rows).toHaveLength(0);
  });
});
