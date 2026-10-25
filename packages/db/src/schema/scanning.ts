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
import { workspaceId } from "./workspaces";

export const assetKind = pgEnum("asset_kind", ["domain", "subdomain", "url"]);
export const scanStatus = pgEnum("scan_status", ["queued", "running", "completed", "failed"]);
export const severity = pgEnum("severity", ["critical", "high", "medium", "low", "info"]);
export const findingStatus = pgEnum("finding_status", ["open", "resolved", "ignored"]);

/** Something on the internet the workspace wants checked: a domain, a subdomain, or a URL. */
export const assets = pgTable(
  "assets",
  {
    id: id(),
    workspaceId: workspaceId(),
    kind: assetKind("kind").notNull(),
    /** Lowercased hostname for domain/subdomain; full URL for `url`. */
    value: text("value").notNull(),
    source: text("source").notNull().default("manual"),
    verified: boolean("verified").notNull().default(false),
    verificationToken: text("verification_token").notNull(),
    verifiedAt: timestamp("verified_at", { withTimezone: true }),
    /** Ownership is re-checked weekly; this is when the next check is due. */
    verifyNextAt: timestamp("verify_next_at", { withTimezone: true }).notNull().defaultNow(),
    /** Consecutive failed re-checks. Three in a row (daily once one fails) withdraw the verification. */
    verifyFailures: integer("verify_failures").notNull().default(0),
    /** Set when a re-check withdrew the verification, so the person is told why active scans stopped. */
    verificationLostAt: timestamp("verification_lost_at", { withTimezone: true }),
    /** Third-party hosts the page has loaded scripts, frames and form actions from, and when each first appeared. */
    pageState: jsonb<{
      baselineAt: string;
      scriptHosts: Record<string, string>;
      frameHosts: Record<string, string>;
      formHosts: Record<string, string>;
    }>("page_state"),
    /** The scheduler enqueues a scan once this passes, then pushes it a day out. */
    nextScanAt: timestamp("next_scan_at", { withTimezone: true }).notNull().defaultNow(),
    lastScanAt: timestamp("last_scan_at", { withTimezone: true }),
    /** Domain assets only: when to next look for subdomains in certificate transparency logs. */
    nextDiscoveryAt: timestamp("next_discovery_at", { withTimezone: true }).notNull().defaultNow(),
    lastDiscoveryAt: timestamp("last_discovery_at", { withTimezone: true }),
    /** Why the last discovery run failed, if it did. Cleared on success. */
    discoveryError: text("discovery_error"),
    /** What the site runs on (platform, server, framework), read from its headers on each scan. Picks the fix instructions. */
    stack: jsonb<{ platform: string; server: string; framework: string }>("stack"),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("assets_workspace_kind_value_key").on(t.workspaceId, t.kind, t.value),
    index("assets_next_scan_idx").on(t.nextScanAt),
    index("assets_next_discovery_idx").on(t.nextDiscoveryAt),
  ],
);

/**
 * Software found on an asset's page by the last scan (a server header, a CMS, a front-end library). Kept so that when
 * a vulnerability is announced later, the assets running it can be found without scanning everything again.
 */
export const assetComponents = pgTable(
  "asset_components",
  {
    assetId: uuid("asset_id")
      .notNull()
      .references(() => assets.id, { onDelete: "cascade" }),
    /** Machine name and exact version, e.g. nginx / 1.18.0. */
    product: text("product").notNull(),
    version: text("version").notNull(),
    display: text("display").notNull(),
    /** What revealed it, e.g. `Server: nginx/1.18.0`. */
    detectedFrom: text("detected_from").notNull(),
    /** How its vulnerabilities are looked up (OSV package or NVD CPE). */
    lookup: jsonb<Record<string, unknown>>("lookup").notNull(),
    lastSeen: timestamp("last_seen", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.assetId, t.product, t.version] }),
    index("asset_components_product_idx").on(t.product),
  ],
);

export type CheckOutcome = "ok" | "error" | "skipped";

export const scans = pgTable(
  "scans",
  {
    id: id(),
    workspaceId: workspaceId(),
    assetId: uuid("asset_id")
      .notNull()
      .references(() => assets.id, { onDelete: "cascade" }),
    status: scanStatus("status").notNull().default("queued"),
    startedAt: timestamp("started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    triggeredBy: text("triggered_by"),
    /** Per check family: did it run to completion? Only completed families may auto-resolve findings. */
    checks: jsonb<Record<string, CheckOutcome>>("checks").notNull().default({}),
  },
  (t) => [index("scans_asset_idx").on(t.assetId, t.startedAt)],
);

export const findings = pgTable(
  "findings",
  {
    id: id(),
    workspaceId: workspaceId(),
    assetId: uuid("asset_id")
      .notNull()
      .references(() => assets.id, { onDelete: "cascade" }),
    /** Last scan that observed this finding. */
    scanId: uuid("scan_id").references(() => scans.id, { onDelete: "set null" }),
    /** e.g. "headers.hsts_missing". The prefix is the check family. */
    checkKey: text("check_key").notNull(),
    /** Stable identity across scans: sha256(checkKey | assetId | subject). Dedupes repeats. */
    fingerprint: text("fingerprint").notNull(),
    severity: severity("severity").notNull(),
    /** severity weighted by exposure and, later, KEV/EPSS. Findings list is ranked by this. */
    riskScore: integer("risk_score").notNull().default(0),
    title: text("title").notNull(),
    description: text("description").notNull(),
    remediation: text("remediation").notNull().default(""),
    evidence: jsonb<Record<string, unknown>>("evidence").notNull().default({}),
    status: findingStatus("status").notNull().default("open"),
    firstSeen: timestamp("first_seen", { withTimezone: true }).notNull().defaultNow(),
    lastSeen: timestamp("last_seen", { withTimezone: true }).notNull().defaultNow(),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    /** AI-written explanation (schema: @upzy/ai ExplainFindingOutput). Null until requested. */
    aiExplanation: jsonb<Record<string, unknown>>("ai_explanation"),
    aiExplainedAt: timestamp("ai_explained_at", { withTimezone: true }),
    /** Set while a request is queued, and to the reason if it failed. */
    aiExplainStatus: text("ai_explain_status").$type<"pending" | "failed">(),
    aiExplainError: text("ai_explain_error"),
    /** "Verify fix": re-run this finding's check family now. "pending" while queued, "failed" with the reason. */
    verifyStatus: text("verify_status").$type<"pending" | "failed">(),
    verifyError: text("verify_error"),
    lastVerifiedAt: timestamp("last_verified_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("findings_workspace_fingerprint_key").on(t.workspaceId, t.fingerprint),
    index("findings_workspace_status_risk_idx").on(
      t.workspaceId,
      t.status,
      sql`${t.riskScore} desc`,
    ),
  ],
);

/**
 * What an active scan actually did, kept so a customer (or we) can see exactly what was sent to a site, when, by which
 * engine and which templates. One row per scan result accepted from the scanner.
 */
export const scanProvenance = pgTable(
  "scan_provenance",
  {
    id: id(),
    workspaceId: workspaceId(),
    assetId: uuid("asset_id")
      .notNull()
      .references(() => assets.id, { onDelete: "cascade" }),
    scanId: uuid("scan_id").references(() => scans.id, { onDelete: "set null" }),
    /** The scanner (a probe_agents row of kind "scanner") that ran it. */
    scannerId: uuid("scanner_id"),
    engine: text("engine").notNull(),
    engineVersion: text("engine_version"),
    templateSet: text("template_set"),
    templatesRun: integer("templates_run").notNull().default(0),
    requests: integer("requests").notNull().default(0),
    rateLimitPerSecond: integer("rate_limit_per_second").notNull(),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
    finishedAt: timestamp("finished_at", { withTimezone: true }).notNull(),
    findings: integer("findings").notNull().default(0),
    error: text("error"),
    /** Ids of the templates that ran. */
    templates: jsonb<string[]>("templates").notNull().default([]),
    createdAt: createdAt(),
  },
  (t) => [index("scan_provenance_asset_idx").on(t.assetId, t.createdAt.desc())],
);

export const discoveryStatus = pgEnum("discovery_status", ["new", "accepted", "dismissed"]);

/**
 * A host found in certificate transparency logs that is not an asset yet. Discovered hosts are
 * suggestions: nothing is scanned until a person accepts it, so Upzy never starts probing
 * third-party infrastructure on its own.
 */
export const discoveredHosts = pgTable(
  "discovered_hosts",
  {
    id: id(),
    workspaceId: workspaceId(),
    /** The domain asset whose certificates revealed this host. */
    parentAssetId: uuid("parent_asset_id")
      .notNull()
      .references(() => assets.id, { onDelete: "cascade" }),
    host: text("host").notNull(),
    status: discoveryStatus("status").notNull().default("new"),
    /** Whether the name resolves in DNS right now. null = lookup error. */
    resolves: boolean("resolves"),
    source: text("source").notNull(),
    firstSeen: timestamp("first_seen", { withTimezone: true }).notNull().defaultNow(),
    lastSeen: timestamp("last_seen", { withTimezone: true }).notNull().defaultNow(),
    /** What one anonymous request to the host showed (status, title, server, redirect). Collected by Upzy, not the AI. */
    profile: jsonb<Record<string, unknown>>("profile"),
    /** AI reading of the host: what it probably is and whether it looks risky. A suggestion only. */
    aiClassification: jsonb<Record<string, unknown>>("ai_classification"),
    aiClassifiedAt: timestamp("ai_classified_at", { withTimezone: true }),
    aiStatus: text("ai_status").$type<"pending" | "failed">(),
    aiError: text("ai_error"),
  },
  (t) => [
    uniqueIndex("discovered_hosts_workspace_host_key").on(t.workspaceId, t.host),
    index("discovered_hosts_parent_idx").on(t.parentAssetId, t.status),
  ],
);

/** One health score per asset per day (the latest of the day), for the trend. */
export const assetHealth = pgTable(
  "asset_health",
  {
    assetId: uuid("asset_id")
      .notNull()
      .references(() => assets.id, { onDelete: "cascade" }),
    /** UTC calendar day, YYYY-MM-DD. */
    day: text("day").notNull(),
    score: integer("score").notNull(),
    grade: text("grade").notNull(),
    categories: jsonb<Record<string, number>>("categories").notNull().default({}),
    recordedAt: timestamp("recorded_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.assetId, t.day] })],
);
