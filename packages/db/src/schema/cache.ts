import { index, pgTable, text, timestamp } from "drizzle-orm/pg-core";

import { jsonb } from "./_helpers";

/**
 * Cache for slow, rate-limited third-party lookups (NVD, OSV, EPSS, the CISA KEV catalogue).
 * Not tenant data: entries are keyed by what was asked, never by who asked.
 */
export const httpCache = pgTable(
  "http_cache",
  {
    key: text("key").primaryKey(),
    value: jsonb<unknown>("value").notNull(),
    fetchedAt: timestamp("fetched_at", { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  },
  (t) => [index("http_cache_expires_idx").on(t.expiresAt)],
);
