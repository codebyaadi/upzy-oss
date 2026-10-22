import { sql } from "drizzle-orm";
import { customType, timestamp, uuid } from "drizzle-orm/pg-core";

/** uuidv7 primary key (native in Postgres 18). */
export const id = () =>
  uuid("id")
    .primaryKey()
    .default(sql`uuidv7()`);

export const createdAt = () =>
  timestamp("created_at", { withTimezone: true }).notNull().defaultNow();

export const updatedAt = () =>
  timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date());

/**
 * jsonb column that passes values straight to Bun.SQL. Drizzle's built-in `jsonb` stringifies
 * on write and Bun.SQL stringifies again, which stores a JSON *string* instead of an object.
 * Only objects and arrays round-trip: a bare number or string is sent as a non-jsonb parameter and
 * fails, so wrap scalars in an object.
 */
export const jsonb = <T = unknown>(name: string) =>
  customType<{ data: T; driverData: unknown }>({
    dataType: () => "jsonb",
    toDriver: (value) => value,
    fromDriver: (value) => (typeof value === "string" ? (JSON.parse(value) as T) : (value as T)),
  })(name);
