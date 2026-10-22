import { index, integer, pgTable, text } from "drizzle-orm/pg-core";

import { createdAt, id, jsonb } from "./_helpers";
import { organizations, users } from "./auth";
import { workspaceId } from "./workspaces";

export const apiKeys = pgTable("api_keys", {
  id: id(),
  organizationId: text("organization_id")
    .notNull()
    .references(() => organizations.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  hashedKey: text("hashed_key").notNull(),
  role: text("role").notNull(),
  createdAt: createdAt(),
});

/**
 * Who did what, when, from where. Written for every mutating API request. The payload holds field
 * names and route parameters only, never values, so secrets (webhook URLs, keys) are not copied here.
 */
export const auditLogs = pgTable(
  "audit_logs",
  {
    id: id(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    userId: text("user_id").references(() => users.id, { onDelete: "set null" }),
    /** e.g. "POST /monitor/:id/scan" */
    action: text("action").notNull(),
    resourceType: text("resource_type").notNull(),
    resourceId: text("resource_id"),
    /** HTTP status of the response: failed attempts are as interesting as successes. */
    status: integer("status"),
    ip: text("ip"),
    userAgent: text("user_agent"),
    payload: jsonb<Record<string, unknown>>("payload"),
    createdAt: createdAt(),
  },
  (t) => [index("audit_logs_org_created_idx").on(t.organizationId, t.createdAt.desc())],
);

export const webhooks = pgTable("webhooks", {
  id: id(),
  workspaceId: workspaceId(),
  url: text("url").notNull(),
  secret: text("secret"),
  events: jsonb("events").notNull(),
  createdAt: createdAt(),
});
