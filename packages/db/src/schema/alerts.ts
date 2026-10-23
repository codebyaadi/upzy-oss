import { sql } from "drizzle-orm";
import {
  boolean,
  index,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  vector,
} from "drizzle-orm/pg-core";

import { createdAt, id, jsonb } from "./_helpers";
import { users } from "./auth";
import { monitors } from "./monitoring";
import { findings } from "./scanning";
import { workspaceId } from "./workspaces";

export const incidentType = pgEnum("incident_type", ["uptime", "security", "custom"]);
export const incidentStatus = pgEnum("incident_status", ["open", "acknowledged", "resolved"]);

/**
 * Incidents that opened close together and share something checkable (same site, same IP address). Grouping is
 * rule-based; AI only writes the explanation of what the group likely has in common.
 */
export const incidentGroups = pgTable("incident_groups", {
  id: id(),
  workspaceId: workspaceId(),
  /** The shared fact, e.g. "domain:example.com" or "ip:203.0.113.7". */
  sharedKey: text("shared_key").notNull(),
  createdAt: createdAt(),
  summary: jsonb<Record<string, unknown>>("summary"),
  summaryAt: timestamp("summary_at", { withTimezone: true }),
  summaryStatus: text("summary_status").$type<"pending" | "failed">(),
  summaryError: text("summary_error"),
});

export const incidents = pgTable(
  "incidents",
  {
    id: id(),
    workspaceId: workspaceId(),
    monitorId: uuid("monitor_id").references(() => monitors.id, { onDelete: "cascade" }),
    title: text("title").notNull().default(""),
    type: incidentType("type").notNull(),
    status: incidentStatus("status").notNull(),
    createdAt: createdAt(),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    /** AI triage: the evidence collected by Upzy plus the model's reading of it. Always a suggestion. */
    aiTriage: jsonb<Record<string, unknown>>("ai_triage"),
    aiTriagedAt: timestamp("ai_triaged_at", { withTimezone: true }),
    aiTriageStatus: text("ai_triage_status").$type<"pending" | "failed">(),
    aiTriageError: text("ai_triage_error"),
    /** What this incident shares with others that opened around the same time (set by the correlator). */
    correlationKeys: jsonb<string[]>("correlation_keys"),
    groupId: uuid("group_id").references(() => incidentGroups.id, { onDelete: "set null" }),
  },
  (t) => [
    // At most one unresolved incident per monitor.
    uniqueIndex("incidents_one_open_per_monitor")
      .on(t.monitorId)
      .where(sql`${t.status} <> 'resolved'`),
  ],
);

/**
 * A vector describing how an incident failed, for finding earlier incidents that look alike. One per incident;
 * `model` says which embedder made it, so vectors from a replaced one are ignored until recomputed.
 */
export const incidentEmbeddings = pgTable(
  "incident_embeddings",
  {
    incidentId: uuid("incident_id")
      .primaryKey()
      .references(() => incidents.id, { onDelete: "cascade" }),
    workspaceId: workspaceId(),
    model: text("model").notNull(),
    embedding: vector("embedding", { dimensions: 384 }).notNull(),
    createdAt: createdAt(),
  },
  (t) => [index("incident_embeddings_workspace_idx").on(t.workspaceId, t.model)],
);

export const channelKind = pgEnum("channel_kind", [
  "email",
  "slack",
  "discord",
  "webhook",
  "teams",
  "pagerduty",
  "opsgenie",
  "github",
]);

/** Where notifications go. `configEncrypted` holds the target (address / URL / signing secret). */
export const notificationChannels = pgTable("notification_channels", {
  id: id(),
  workspaceId: workspaceId(),
  name: text("name").notNull(),
  kind: channelKind("kind").notNull(),
  configEncrypted: text("config_encrypted").notNull(),
  /** Non-secret hint shown in the UI, e.g. an email address or webhook host. */
  summary: text("summary").notNull().default(""),
  enabled: boolean("enabled").notNull().default(true),
  createdAt: createdAt(),
});

export type IncidentEvent = "incident.opened" | "incident.resolved";
/** Everything a rule can subscribe to. `finding.opened` fires for new or regressed critical/high findings. */
export type NotifyEvent = IncidentEvent | "finding.opened";

/** Routes incident events to a channel. `monitorId` null means every monitor in the workspace. */
export const alertRules = pgTable(
  "alert_rules",
  {
    id: id(),
    workspaceId: workspaceId(),
    channelId: uuid("channel_id")
      .notNull()
      .references(() => notificationChannels.id, { onDelete: "cascade" }),
    monitorId: uuid("monitor_id").references(() => monitors.id, { onDelete: "cascade" }),
    events: jsonb<NotifyEvent[]>("events")
      .notNull()
      .default(["incident.opened", "incident.resolved"]),
    enabled: boolean("enabled").notNull().default(true),
    createdAt: createdAt(),
  },
  (t) => [index("alert_rules_workspace_idx").on(t.workspaceId)],
);

export const deliveryStatus = pgEnum("delivery_status", ["sent", "failed"]);

/**
 * One row per (subject, channel, event, occurrence): the delivery log and the idempotency guard.
 * The subject is an incident or a finding. `occurrence` separates repeats of the same event, e.g.
 * a finding that is fixed and later comes back (keyed by the scan that reopened it).
 */
export const notificationDeliveries = pgTable(
  "notification_deliveries",
  {
    id: id(),
    incidentId: uuid("incident_id").references(() => incidents.id, { onDelete: "cascade" }),
    findingId: uuid("finding_id").references(() => findings.id, { onDelete: "cascade" }),
    channelId: uuid("channel_id")
      .notNull()
      .references(() => notificationChannels.id, { onDelete: "cascade" }),
    event: text("event").notNull(),
    occurrence: text("occurrence").notNull().default(""),
    status: deliveryStatus("status").notNull(),
    error: text("error"),
    /** What the provider made of it (a GitHub issue number), so the recovery can find the same one. */
    externalId: text("external_id"),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("deliveries_once").on(
      sql`coalesce(${t.incidentId}, ${t.findingId})`,
      t.channelId,
      t.event,
      t.occurrence,
    ),
  ],
);

export interface PostmortemContent {
  /** Short, public-facing message for customers. */
  customerUpdate: string;
  summary: string;
  impact: string;
  rootCause: string;
  timeline: { at: string; event: string }[];
  contributingFactors: string[];
  whatWentWell: string[];
  actionItems: { title: string; detail: string }[];
}

/**
 * A written account of an incident. Always starts as an AI draft that a person edits; `aiGenerated`
 * says whether the current text still came from a model, `editedBy` who last changed it by hand.
 */
export const postmortems = pgTable("postmortems", {
  incidentId: uuid("incident_id")
    .primaryKey()
    .references(() => incidents.id, { onDelete: "cascade" }),
  content: jsonb<PostmortemContent>("content"),
  aiGenerated: boolean("ai_generated").notNull().default(false),
  model: text("model"),
  /** "pending" while a draft is being written, "failed" with the reason in `error`. */
  status: text("status").$type<"pending" | "failed">(),
  error: text("error"),
  editedBy: text("edited_by").references(() => users.id, { onDelete: "set null" }),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const incidentUpdateStatus = pgEnum("incident_update_status", [
  "investigating",
  "identified",
  "monitoring",
  "update",
]);

/**
 * Messages a person writes about an incident, in their own words. They are shown on public status pages for the
 * incident's monitor, so they are written for customers (unlike the title and AI triage, which are internal).
 */
export const incidentUpdates = pgTable(
  "incident_updates",
  {
    id: id(),
    incidentId: uuid("incident_id")
      .notNull()
      .references(() => incidents.id, { onDelete: "cascade" }),
    status: incidentUpdateStatus("status").notNull(),
    message: text("message").notNull(),
    createdBy: text("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: createdAt(),
  },
  (t) => [index("incident_updates_incident_idx").on(t.incidentId, t.createdAt)],
);
