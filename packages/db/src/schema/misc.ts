import { sql } from "drizzle-orm";
import { index, integer, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";

import { createdAt, id, jsonb } from "./_helpers";
import { organizations, users } from "./auth";
import { workspaceId } from "./workspaces";

/**
 * Small facts about the installation itself, such as "this one-time notice has been given". One row per key; the value
 * is JSON. Nothing a customer sets lives here.
 */
export const systemState = pgTable("system_state", {
  key: text("key").primaryKey(),
  value: jsonb<Record<string, unknown>>("value").notNull().default({}),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Keys for tools that act as a person without a browser session (the MCP server). Only the SHA-256 of the key is
 * kept; the key itself is shown once at creation. A key acts as the member who made it, so it can never see more than
 * they can (a member limited to some workspaces stays limited), and is further narrowed to its `scopes`.
 */
export const apiKeys = pgTable(
  "api_keys",
  {
    id: id(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    userId: text("user_id").references(() => users.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    hashedKey: text("hashed_key").notNull(),
    /** The start of the key, so a person can tell which one is which. Not enough to use it. */
    prefix: text("prefix").notNull().default(""),
    /** e.g. "monitors:read". See apps/api/src/lib/api-keys.ts. */
    scopes: text("scopes")
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    role: text("role").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("api_keys_hashed_key_key").on(t.hashedKey),
    index("api_keys_organization_idx").on(t.organizationId),
  ],
);

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
