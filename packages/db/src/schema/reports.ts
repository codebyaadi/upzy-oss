import { boolean, index, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";

import { createdAt, id } from "./_helpers";
import { workspaceId } from "./workspaces";

/**
 * A recurring report for one workspace (for an agency, one client), emailed to the addresses below. One row per
 * workspace; absent means no report.
 */
export const reportSchedules = pgTable("report_schedules", {
  workspaceId: workspaceId().primaryKey(),
  enabled: boolean("enabled").notNull().default(false),
  frequency: text("frequency").$type<"weekly" | "monthly">().notNull().default("monthly"),
  /** The period the last report covered ("2026-10-12" for the week starting then, "2026-09" for a month). */
  lastSentPeriod: text("last_sent_period"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/** Who gets it. These are usually the client's own people, typed in by an admin, so each can opt out by themselves. */
export const reportRecipients = pgTable(
  "report_recipients",
  {
    id: id(),
    workspaceId: workspaceId(),
    /** Lowercased. */
    email: text("email").notNull(),
    unsubscribedAt: timestamp("unsubscribed_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("report_recipients_workspace_email_key").on(t.workspaceId, t.email),
    index("report_recipients_workspace_idx").on(t.workspaceId),
  ],
);

export type ReportRecipient = typeof reportRecipients.$inferSelect;
