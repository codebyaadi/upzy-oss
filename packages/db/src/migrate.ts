/**
 * Applies the SQL migrations in ./drizzle. Used by the production `migrate` container (drizzle-kit is a dev tool and
 * isn't installed there). Safe to run on every deploy: already-applied migrations are skipped.
 */
import { migrate } from "drizzle-orm/bun-sql/migrator";

import { createDb } from "./drizzle";

const db = createDb();
await migrate(db, { migrationsFolder: new URL("../drizzle", import.meta.url).pathname });
console.log("migrations applied");
process.exit(0);
