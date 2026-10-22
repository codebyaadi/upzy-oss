import { sql } from "drizzle-orm";
import {
  boolean,
  index,
  integer,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

import { createdAt, id, jsonb } from "./_helpers";
import { assets } from "./scanning";
import { workspaceId } from "./workspaces";

export const monitorType = pgEnum("monitor_type", [
  "http",
  "tcp",
  "dns",
  "ssl",
  "synthetic",
  "flow",
  "heartbeat",
]);
export const errorKind = pgEnum("error_kind", [
  "dns",
  "timeout",
  "tls",
  "http",
  "refused",
  "blocked",
  "assertion",
  "heartbeat",
  "other",
]);
// "degraded" is a monitor state only (up, but slower than its latency threshold for several checks in a row).
// A single check result is always up, down or unknown.
export const checkStatus = pgEnum("check_status", ["up", "down", "unknown", "degraded"]);

export interface MonitorAssertion {
  path: string;
  op: "equals" | "not_equals" | "contains" | "exists" | "not_exists" | "gt" | "lt";
  value?: string;
}
export interface MonitorStep {
  name: string;
  method: "GET" | "HEAD" | "POST";
  url: string;
  headers: Record<string, string>;
  body?: string;
  expectedStatus?: number[];
  assertions: MonitorAssertion[];
  extract: Record<string, string>;
}

export interface MonitorConfig {
  method?: "GET" | "HEAD" | "POST";
  expectedStatus?: number[];
  keyword?: string;
  timeoutMs?: number;
  /** Non-secret request headers. Secrets are referenced as {{secret.NAME}} and live in `secretsEncrypted`. */
  headers?: Record<string, string>;
  body?: string;
  assertions?: MonitorAssertion[];
  /** Flow monitors: requests run in order, each able to use values extracted from earlier responses. */
  steps?: MonitorStep[];
  /** Heartbeat monitors: how often a ping is expected, and how many seconds late it may be. */
  expectEvery?: number;
  grace?: number;
}

export const monitors = pgTable(
  "monitors",
  {
    id: id(),
    workspaceId: workspaceId(),
    name: text("name").notNull(),
    type: monitorType("type").notNull(),
    target: text("target").notNull(),
    interval: integer("interval").notNull(),
    active: boolean("active").notNull(),
    nextRun: timestamp("next_run", { withTimezone: true }).notNull().defaultNow(),
    bucket: integer("bucket").notNull().default(0),
    lastStatus: checkStatus("last_status").notNull().default("unknown"),
    /** Per-type options: method, expectedStatus, keyword, timeoutMs. Validated by @upzy/validator. */
    config: jsonb<MonitorConfig>("config").notNull().default({}),
    latencyThresholdMs: integer("latency_threshold_ms"),
    /** Consecutive failed checks before the monitor is declared down. */
    failureThreshold: integer("failure_threshold").notNull().default(2),
    consecutiveFailures: integer("consecutive_failures").notNull().default(0),
    /** Consecutive successful checks slower than `latencyThresholdMs`; three in a row make the monitor "degraded". */
    consecutiveSlow: integer("consecutive_slow").notNull().default(0),
    /** Named secrets (JSON object, encrypted at rest) the monitor may use as {{secret.NAME}}. Write-only. */
    secretsEncrypted: text("secrets_encrypted"),
    /** Heartbeat monitors: the secret in the ping address, and when the job last checked in or reported failure. */
    heartbeatToken: text("heartbeat_token"),
    lastPingAt: timestamp("last_ping_at", { withTimezone: true }),
    lastFailAt: timestamp("last_fail_at", { withTimezone: true }),
    /** Where "how long since the last ping" counts from: creation, or the moment the monitor was last resumed. */
    heartbeatSince: timestamp("heartbeat_since", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("monitors_heartbeat_token_key")
      .on(t.heartbeatToken)
      .where(sql`${t.heartbeatToken} is not null`),
    index("monitors_active_bucket_next_run_idx").on(t.active, t.bucket, t.nextRun),
    index("monitors_workspace_id_idx").on(t.workspaceId),
  ],
);

export const monitorChecks = pgTable(
  "monitor_checks",
  {
    id: id(),
    monitorId: uuid("monitor_id")
      .notNull()
      .references(() => monitors.id, { onDelete: "cascade" }),
    status: checkStatus("status").notNull(),
    responseMs: integer("response_ms"),
    createdAt: createdAt(),
    region: text("region"),
    statusCode: integer("status_code"),
    error: text("error"),
    errorKind: errorKind("error_kind"),
    ttfbMs: integer("ttfb_ms"),
    tlsDaysLeft: integer("tls_days_left"),
  },
  (t) => [
    index("monitor_checks_monitor_id_created_at_idx").on(t.monitorId, t.createdAt.desc()),
    // Lets the retention job find old rows without scanning the whole table.
    index("monitor_checks_created_at_idx").on(t.createdAt),
  ],
);

export type StatusNoticeKind = "info" | "maintenance" | "incident";

/**
 * A public status page: anyone with the link can see whether the chosen monitors are up. Nothing else is exposed (no
 * targets, no error text). `published` is off until an admin turns it on.
 */
export const statusPages = pgTable(
  "status_pages",
  {
    id: id(),
    workspaceId: workspaceId(),
    /** The public address: /status/<slug>. Lowercase letters, digits and hyphens. */
    slug: text("slug").notNull(),
    title: text("title").notNull(),
    description: text("description").notNull().default(""),
    published: boolean("published").notNull().default(false),
    /** A short message pinned above the components: planned maintenance, a known issue. Plain text. */
    notice: text("notice").notNull().default(""),
    noticeKind: text("notice_kind").$type<StatusNoticeKind>().notNull().default("info"),
    /** Optional own address, e.g. status.acme.com. Only served once ownership is verified. */
    customDomain: text("custom_domain"),
    /** The secret the owner puts in a DNS TXT record to prove they control the domain. */
    domainToken: text("domain_token"),
    domainVerifiedAt: timestamp("domain_verified_at", { withTimezone: true }),
    /** Opt-in: the asset whose health grade the public page shows ("Security: A"). Null means the page shows none. */
    securityAssetId: uuid("security_asset_id").references(() => assets.id, {
      onDelete: "set null",
    }),
    /** Agency plan: the customer's own logo above the title (an https image URL). Upzy's credit always stays. */
    logoUrl: text("logo_url"),
    createdAt: createdAt(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("status_pages_slug_key").on(t.slug),
    index("status_pages_workspace_idx").on(t.workspaceId),
    // Anyone can *claim* a name, but only one page can have it *verified*: a squatter can't block the real owner.
    uniqueIndex("status_pages_verified_domain_key")
      .on(t.customDomain)
      .where(sql`${t.domainVerifiedAt} is not null`),
  ],
);

/** Which monitors a page shows, under which public name, in which order. */
export const statusPageMonitors = pgTable(
  "status_page_monitors",
  {
    pageId: uuid("page_id")
      .notNull()
      .references(() => statusPages.id, { onDelete: "cascade" }),
    monitorId: uuid("monitor_id")
      .notNull()
      .references(() => monitors.id, { onDelete: "cascade" }),
    displayName: text("display_name").notNull(),
    position: integer("position").notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.pageId, t.monitorId] })],
);

/**
 * A planned period during which expected downtime is not an incident. Checks keep running and are recorded, but no
 * incident (and so no alert or email) is opened for the covered monitors until it ends. It never closes an incident
 * that is already open.
 */
export const maintenanceWindows = pgTable(
  "maintenance_windows",
  {
    id: id(),
    workspaceId: workspaceId(),
    name: text("name").notNull(),
    startsAt: timestamp("starts_at", { withTimezone: true }).notNull(),
    endsAt: timestamp("ends_at", { withTimezone: true }).notNull(),
    /** True: every monitor in the workspace. False: only those in `maintenance_window_monitors`. */
    allMonitors: boolean("all_monitors").notNull().default(false),
    /** Show the window (its name and times, never internal monitor names) on public status pages it affects. */
    showOnStatusPage: boolean("show_on_status_page").notNull().default(true),
    createdAt: createdAt(),
  },
  (t) => [index("maintenance_windows_workspace_id_ends_at_idx").on(t.workspaceId, t.endsAt)],
);

export const maintenanceWindowMonitors = pgTable(
  "maintenance_window_monitors",
  {
    windowId: uuid("window_id")
      .notNull()
      .references(() => maintenanceWindows.id, { onDelete: "cascade" }),
    monitorId: uuid("monitor_id")
      .notNull()
      .references(() => monitors.id, { onDelete: "cascade" }),
  },
  (t) => [
    primaryKey({ columns: [t.windowId, t.monitorId] }),
    index("maintenance_window_monitors_monitor_id_idx").on(t.monitorId),
  ],
);

/**
 * Someone who asked to be emailed about incidents on a status page. Double opt-in: nothing is sent to an address
 * until its owner follows the link in the confirmation email. `token` is the only credential (confirm and
 * unsubscribe), so it is long and random and never shown anywhere but that person's own emails.
 */
export const statusSubscribers = pgTable(
  "status_subscribers",
  {
    id: id(),
    pageId: uuid("page_id")
      .notNull()
      .references(() => statusPages.id, { onDelete: "cascade" }),
    email: text("email").notNull(),
    token: text("token").notNull(),
    confirmedAt: timestamp("confirmed_at", { withTimezone: true }),
    /** When the last confirmation email went out, to avoid mailing the same address over and over. */
    confirmationSentAt: timestamp("confirmation_sent_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("status_subscribers_page_email_key").on(t.pageId, t.email),
    uniqueIndex("status_subscribers_token_key").on(t.token),
  ],
);
