import { pgTable, primaryKey, text, timestamp } from "drizzle-orm/pg-core";

/**
 * Which lifecycle email (welcome, a fix nudge, a trial reminder) went to which user or organization. The primary key
 * is what makes sending idempotent: a second worker, or a restart, can never send the same one twice.
 */
export const lifecycleEmails = pgTable(
  "lifecycle_emails",
  {
    /** A user id for per-user emails, an organization id for per-organization ones. */
    subject: text("subject").notNull(),
    kind: text("kind").notNull(),
    sentAt: timestamp("sent_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.subject, t.kind] })],
);
