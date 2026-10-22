import { SQL } from "bun";
import { drizzle } from "drizzle-orm/bun-sql";

import * as schema from "./schema";

/**
 * Creates a Drizzle client backed by `Bun.SQL`.
 * @throws Error if no connection string is available.
 */
export const createDb = (databaseUrl = process.env.DATABASE_URL) => {
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is missing. Initialization aborted.");
  }
  // Pool size per process. Test files each open their own client, so the test scripts set a small DB_POOL_MAX.
  const max = Number(process.env.DB_POOL_MAX) || 10;
  return drizzle({ client: new SQL(databaseUrl, { max }), schema });
};

export type Db = ReturnType<typeof createDb>;
