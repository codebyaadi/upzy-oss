import {
  boolean,
  date,
  index,
  bigint,
  integer,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

import { createdAt, id } from "./_helpers";
import { organizations, users } from "./auth";
import { workspaces } from "./workspaces";

/** AI is off until an admin turns it on for the organization. */
export const aiSettings = pgTable("ai_settings", {
  organizationId: text("organization_id")
    .primaryKey()
    .references(() => organizations.id, { onDelete: "cascade" }),
  enabled: boolean("enabled").notNull().default(false),
  /** "provider:model" chosen by an admin. Null means: follow the other role, or the provider of the saved key. */
  fastModel: text("fast_model"),
  smartModel: text("smart_model"),
  /** Tokens (input + output) the organization may use per UTC day. */
  dailyTokenBudget: integer("daily_token_budget").notNull().default(200_000),
  updatedBy: text("updated_by").references(() => users.id, { onDelete: "set null" }),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/** An organization's own provider API key, encrypted at rest. Only the last four characters are ever shown. */
export const aiCredentials = pgTable(
  "ai_credentials",
  {
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    provider: text("provider").notNull(),
    encryptedKey: text("encrypted_key").notNull(),
    keyHint: text("key_hint").notNull(),
    createdBy: text("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: createdAt(),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
  },
  (t) => [primaryKey({ columns: [t.organizationId, t.provider] })],
);

/** One row per (org, UTC day, provider, model, feature): counters are incremented, never inserted twice. */
export const aiUsage = pgTable(
  "ai_usage",
  {
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    day: date("day", { mode: "string" }).notNull(),
    provider: text("provider").notNull(),
    model: text("model").notNull(),
    feature: text("feature").notNull(),
    requests: integer("requests").notNull().default(0),
    inputTokens: integer("input_tokens").notNull().default(0),
    outputTokens: integer("output_tokens").notNull().default(0),
    failures: integer("failures").notNull().default(0),
    /** Estimated cost in millionths of a US dollar, from the price catalog at the time of the call. */
    costMicros: bigint("cost_micros", { mode: "number" }).notNull().default(0),
    /** Requests whose model has no known price, so the cost above undercounts them. */
    unpricedRequests: integer("unpriced_requests").notNull().default(0),
  },
  (t) => [
    primaryKey({ columns: [t.organizationId, t.day, t.provider, t.model, t.feature] }),
    index("ai_usage_org_day_idx").on(t.organizationId, t.day),
  ],
);

/** Guards the weekly digest: at most one per workspace per week, even with several workers. */
export const digestRuns = pgTable(
  "digest_runs",
  {
    id: id(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    /** Monday (UTC) of the week the digest covers. */
    weekStart: date("week_start", { mode: "string" }).notNull(),
    recipients: integer("recipients").notNull().default(0),
    usedAi: boolean("used_ai").notNull().default(false),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("digest_runs_workspace_week_key").on(t.workspaceId, t.weekStart)],
);
