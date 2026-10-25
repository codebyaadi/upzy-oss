import { sql } from "drizzle-orm";
import { index, integer, pgEnum, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";

import { createdAt, id, jsonb } from "./_helpers";

export const jobState = pgEnum("job_state", ["queued", "running", "done", "failed"]);

export const jobs = pgTable(
  "jobs",
  {
    id: id(),
    queue: text("queue").notNull(),
    payload: jsonb("payload").notNull(),
    state: jobState("state").notNull().default("queued"),
    attempts: integer("attempts").notNull().default(0),
    maxAttempts: integer("max_attempts").notNull().default(3),
    runAt: timestamp("run_at", { withTimezone: true }).notNull().defaultNow(),
    lockedAt: timestamp("locked_at", { withTimezone: true }),
    lastError: text("last_error"),
    /** While a job with this key is queued or running, enqueueing it again is a no-op. */
    dedupeKey: text("dedupe_key"),
    createdAt: createdAt(),
  },
  (t) => [
    // Only waiting jobs are looked up by queue and time, so the index holds only them: it stays small however many
    // finished jobs the table keeps.
    index("jobs_claim_idx")
      .on(t.queue, t.runAt)
      .where(sql`${t.state} = 'queued'`),
    // The sweep that returns jobs whose worker died finds them by lock time.
    index("jobs_running_idx")
      .on(t.lockedAt)
      .where(sql`${t.state} = 'running'`),
    uniqueIndex("jobs_dedupe_active_key")
      .on(t.queue, t.dedupeKey)
      .where(sql`${t.state} in ('queued', 'running')`),
  ],
);
