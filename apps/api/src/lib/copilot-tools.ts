import { fence } from "@upzy/ai";
import { schema, type Db } from "@upzy/db";
import { tool, type ToolSet } from "ai";
import { and, desc, eq, gte, inArray, isNotNull, ne, sql } from "drizzle-orm";
import { z } from "zod";

import { orgWorkspaceIds } from "./scope";

const { workspaces, monitors, monitorChecks, incidents, incidentGroups, findings, assets } = schema;

export type RefType = "workspace" | "monitor" | "incident" | "finding" | "asset";
export type CitationType = Exclude<RefType, "workspace">;
export interface Seen {
  type: RefType;
  id: string;
  label: string;
}

const PREFIX: Record<RefType, string> = {
  workspace: "w",
  monitor: "m",
  incident: "i",
  finding: "f",
  asset: "a",
};

/**
 * Short handles ("m3", "i1") for the records the model has been shown. The model only ever sees and sends handles:
 * real ids never reach it (they look like tokens to the redactor, and a model has no business inventing them), a
 * record it hasn't been shown has no handle, and a citation can only name something a tool actually returned.
 */
export class Refs {
  private readonly byKey = new Map<string, string>();
  private readonly byRef = new Map<string, Seen>();
  private n = 0;

  ref(type: RefType, id: string, label: string): string {
    const key = `${type}:${id}`;
    const have = this.byKey.get(key);
    if (have) return have;
    const ref = `${PREFIX[type]}${++this.n}`;
    this.byKey.set(key, ref);
    this.byRef.set(ref, { type, id, label });
    return ref;
  }

  /** The record behind a handle, or undefined when the handle is unknown or of another type. */
  resolve(type: RefType, ref: string | undefined): Seen | undefined {
    const s = ref ? this.byRef.get(ref) : undefined;
    return s && s.type === type ? s : undefined;
  }
}

const handle = z
  .string()
  .regex(/^[wmifa]\d{1,4}$/, "Use the id exactly as a previous result gave it, like m3")
  .describe("The short id from an earlier result, such as m3 or i2");
const iso = (d: Date | null) => (d ? d.toISOString() : null);

/**
 * The copilot's tools. Every one is read-only, and every query is limited to the caller's organization in SQL: the
 * organization comes from the session, never from the model. Arguments are validated and bounded, results are
 * capped, and each result is wrapped as untrusted data (monitor names, error text and evidence come from outside).
 */
export function copilotTools(db: Db, orgId: string, refs: Refs): ToolSet {
  const mine = (col: Parameters<typeof inArray>[0]) => inArray(col, orgWorkspaceIds(db, orgId));
  const R = (type: RefType, id: string, label: string) => refs.ref(type, id, label);
  const out = (name: string, data: unknown) =>
    fence(name, JSON.stringify(data), { maxChars: 12_000 });
  // A failing query tells the model "that didn't work", not why.
  const safely =
    <A>(name: string, fn: (a: A) => Promise<unknown>) =>
    async (a: A) => {
      try {
        return out(name, await fn(a));
      } catch (e) {
        console.error(`[copilot:${name}]`, e);
        return out(name, { error: "The lookup failed." });
      }
    };
  const NONE = (what: string) => ({ error: `No such ${what}. Use an id from an earlier result.` });

  return {
    listWorkspaces: tool({
      description: "List the workspaces of this organization.",
      inputSchema: z.object({}),
      execute: safely("listWorkspaces", async () => {
        const rows = await db
          .select({ id: workspaces.id, name: workspaces.name })
          .from(workspaces)
          .where(eq(workspaces.orgId, orgId));
        return rows.map((w) => ({ id: R("workspace", w.id, w.name), name: w.name }));
      }),
    }),

    listMonitors: tool({
      description:
        "List monitors with their current status. Filter by status (up, down, degraded = up but slow, unknown) or workspace. Returns at most 50.",
      inputSchema: z.object({
        status: z.enum(["up", "down", "degraded", "unknown"]).optional(),
        workspaceId: handle.optional(),
        limit: z.number().int().min(1).max(50).default(30),
      }),
      execute: safely(
        "listMonitors",
        async (a: {
          status?: "up" | "down" | "degraded" | "unknown";
          workspaceId?: string;
          limit: number;
        }) => {
          const ws = a.workspaceId ? refs.resolve("workspace", a.workspaceId) : undefined;
          if (a.workspaceId && !ws) return NONE("workspace");
          const rows = await db
            .select({
              id: monitors.id,
              name: monitors.name,
              type: monitors.type,
              target: monitors.target,
              status: monitors.lastStatus,
              intervalSeconds: monitors.interval,
              active: monitors.active,
              workspaceId: monitors.workspaceId,
            })
            .from(monitors)
            .where(
              and(
                mine(monitors.workspaceId),
                a.status ? eq(monitors.lastStatus, a.status) : undefined,
                ws ? eq(monitors.workspaceId, ws.id) : undefined,
              ),
            )
            .orderBy(monitors.name)
            .limit(a.limit);
          return rows.map(({ workspaceId: _w, ...r }) => ({
            ...r,
            id: R("monitor", r.id, r.name),
          }));
        },
      ),
    }),

    monitorStats: tool({
      description:
        "Reliability numbers for one monitor over the last N days (1 to 30): uptime percentage, number of checks, average and 95th percentile response time, incident count and total downtime.",
      inputSchema: z.object({
        monitorId: handle,
        days: z.number().int().min(1).max(30).default(7),
      }),
      execute: safely("monitorStats", async (a: { monitorId: string; days: number }) => {
        const seen = refs.resolve("monitor", a.monitorId);
        if (!seen) return NONE("monitor");
        const [m] = await db
          .select({ id: monitors.id, name: monitors.name })
          .from(monitors)
          .where(and(eq(monitors.id, seen.id), mine(monitors.workspaceId)));
        if (!m) return NONE("monitor");
        const since = new Date(Date.now() - a.days * 86_400_000);
        const [c] = await db
          .select({
            checks: sql<number>`count(*)::int`,
            up: sql<number>`count(*) filter (where ${monitorChecks.status} = 'up')::int`,
            avgMs: sql<number | null>`round(avg(${monitorChecks.responseMs}))::int`,
            p95Ms: sql<
              number | null
            >`round(percentile_cont(0.95) within group (order by ${monitorChecks.responseMs}))::int`,
          })
          .from(monitorChecks)
          .where(and(eq(monitorChecks.monitorId, m.id), gte(monitorChecks.createdAt, since)));
        const inc = await db
          .select({ createdAt: incidents.createdAt, resolvedAt: incidents.resolvedAt })
          .from(incidents)
          .where(and(eq(incidents.monitorId, m.id), gte(incidents.createdAt, since)));
        const downMin = Math.round(
          inc.reduce(
            (n, i) => n + ((i.resolvedAt ?? new Date()).getTime() - i.createdAt.getTime()),
            0,
          ) / 60_000,
        );
        return {
          monitor: { id: a.monitorId, name: m.name },
          periodDays: a.days,
          checks: c?.checks ?? 0,
          uptimePercent: c && c.checks ? Math.round((c.up / c.checks) * 10_000) / 100 : null,
          avgResponseMs: c?.avgMs ?? null,
          p95ResponseMs: c?.p95Ms ?? null,
          incidents: inc.length,
          downtimeMinutes: downMin,
        };
      }),
    }),

    listIncidents: tool({
      description:
        "List incidents, newest first. Filter by status (open, acknowledged, resolved, or active = open or acknowledged), by monitor, and by how many days back (1 to 90). Returns at most 20.",
      inputSchema: z.object({
        status: z.enum(["open", "acknowledged", "resolved", "active"]).optional(),
        monitorId: handle.optional(),
        sinceDays: z.number().int().min(1).max(90).default(30),
        limit: z.number().int().min(1).max(20).default(10),
      }),
      execute: safely(
        "listIncidents",
        async (a: {
          status?: "open" | "acknowledged" | "resolved" | "active";
          monitorId?: string;
          sinceDays: number;
          limit: number;
        }) => {
          const mon = a.monitorId ? refs.resolve("monitor", a.monitorId) : undefined;
          if (a.monitorId && !mon) return NONE("monitor");
          const rows = await db
            .select({
              id: incidents.id,
              title: incidents.title,
              status: incidents.status,
              openedAt: incidents.createdAt,
              resolvedAt: incidents.resolvedAt,
              monitorId: incidents.monitorId,
              monitorName: monitors.name,
              groupId: incidents.groupId,
            })
            .from(incidents)
            .leftJoin(monitors, eq(monitors.id, incidents.monitorId))
            .where(
              and(
                mine(incidents.workspaceId),
                gte(incidents.createdAt, new Date(Date.now() - a.sinceDays * 86_400_000)),
                a.status === "active"
                  ? inArray(incidents.status, ["open", "acknowledged"])
                  : a.status
                    ? eq(incidents.status, a.status)
                    : undefined,
                mon ? eq(incidents.monitorId, mon.id) : undefined,
              ),
            )
            .orderBy(desc(incidents.createdAt))
            .limit(a.limit);
          return rows.map((r) => ({
            id: R("incident", r.id, r.title),
            title: r.title,
            status: r.status,
            openedAt: iso(r.openedAt),
            resolvedAt: iso(r.resolvedAt),
            monitor: r.monitorId
              ? { id: R("monitor", r.monitorId, r.monitorName ?? "monitor"), name: r.monitorName }
              : null,
            inGroupOfRelatedIncidents: !!r.groupId,
          }));
        },
      ),
    }),

    getIncident: tool({
      description:
        "Details of one incident: monitor, timing, the latest checks, whether it belongs to a group of related incidents, and the AI analysis if one exists (marked as AI-written and unverified).",
      inputSchema: z.object({ incidentId: handle }),
      execute: safely("getIncident", async (a: { incidentId: string }) => {
        const seen = refs.resolve("incident", a.incidentId);
        if (!seen) return NONE("incident");
        const [i] = await db
          .select()
          .from(incidents)
          .where(and(eq(incidents.id, seen.id), mine(incidents.workspaceId)));
        if (!i) return NONE("incident");
        const [m] = i.monitorId
          ? await db
              .select({
                id: monitors.id,
                name: monitors.name,
                target: monitors.target,
                type: monitors.type,
              })
              .from(monitors)
              .where(eq(monitors.id, i.monitorId))
          : [];
        const checks = i.monitorId
          ? await db
              .select({
                at: monitorChecks.createdAt,
                status: monitorChecks.status,
                error: monitorChecks.error,
                kind: monitorChecks.errorKind,
                code: monitorChecks.statusCode,
                ms: monitorChecks.responseMs,
              })
              .from(monitorChecks)
              .where(eq(monitorChecks.monitorId, i.monitorId))
              .orderBy(desc(monitorChecks.createdAt))
              .limit(5)
          : [];
        const [group] = i.groupId
          ? await db
              .select({
                n: sql<number>`count(*)::int`,
                key: sql<string>`max(${incidentGroups.sharedKey})`,
              })
              .from(incidents)
              .innerJoin(incidentGroups, eq(incidentGroups.id, incidents.groupId))
              .where(eq(incidents.groupId, i.groupId))
          : [];
        const triage = i.aiTriage as {
          summary?: string;
          likelyCause?: string;
          confidence?: string;
        } | null;
        return {
          id: a.incidentId,
          title: i.title,
          status: i.status,
          openedAt: iso(i.createdAt),
          resolvedAt: iso(i.resolvedAt),
          monitor: m
            ? { id: R("monitor", m.id, m.name), name: m.name, target: m.target, type: m.type }
            : null,
          latestChecks: checks.map((c) => ({ ...c, at: iso(c.at) })),
          relatedIncidents: group ? { count: group.n, sharedKey: group.key } : null,
          aiAnalysis: triage?.summary
            ? {
                writtenByAi: true,
                verified: false,
                likelyCause: triage.likelyCause,
                confidence: triage.confidence,
                summary: triage.summary,
              }
            : null,
        };
      }),
    }),

    listFindings: tool({
      description:
        "List security findings ranked by risk. Filter by severity (critical, high, medium, low, info), status (open by default, resolved, ignored) or asset. Returns at most 25.",
      inputSchema: z.object({
        severity: z.enum(["critical", "high", "medium", "low", "info"]).optional(),
        status: z.enum(["open", "resolved", "ignored"]).default("open"),
        assetId: handle.optional(),
        limit: z.number().int().min(1).max(25).default(15),
      }),
      execute: safely(
        "listFindings",
        async (a: {
          severity?: "critical" | "high" | "medium" | "low" | "info";
          status: "open" | "resolved" | "ignored";
          assetId?: string;
          limit: number;
        }) => {
          const asset = a.assetId ? refs.resolve("asset", a.assetId) : undefined;
          if (a.assetId && !asset) return NONE("asset");
          const rows = await db
            .select({
              id: findings.id,
              title: findings.title,
              severity: findings.severity,
              status: findings.status,
              check: findings.checkKey,
              assetId: findings.assetId,
              asset: assets.value,
              firstSeen: findings.firstSeen,
            })
            .from(findings)
            .innerJoin(assets, eq(assets.id, findings.assetId))
            .where(
              and(
                mine(findings.workspaceId),
                eq(findings.status, a.status),
                a.severity ? eq(findings.severity, a.severity) : undefined,
                asset ? eq(findings.assetId, asset.id) : undefined,
              ),
            )
            .orderBy(desc(findings.riskScore))
            .limit(a.limit);
          return rows.map((r) => ({
            id: R("finding", r.id, r.title),
            title: r.title,
            severity: r.severity,
            status: r.status,
            check: r.check,
            asset: { id: R("asset", r.assetId, r.asset), name: r.asset },
            firstSeen: iso(r.firstSeen),
          }));
        },
      ),
    }),

    getFinding: tool({
      description:
        "Details of one security finding: description, built-in remediation advice and (trimmed) evidence.",
      inputSchema: z.object({ findingId: handle }),
      execute: safely("getFinding", async (a: { findingId: string }) => {
        const seen = refs.resolve("finding", a.findingId);
        if (!seen) return NONE("finding");
        const [f] = await db
          .select({ f: findings, asset: assets.value })
          .from(findings)
          .innerJoin(assets, eq(assets.id, findings.assetId))
          .where(and(eq(findings.id, seen.id), mine(findings.workspaceId)));
        if (!f) return NONE("finding");
        return {
          id: a.findingId,
          title: f.f.title,
          severity: f.f.severity,
          status: f.f.status,
          check: f.f.checkKey,
          asset: { id: R("asset", f.f.assetId, f.asset), name: f.asset },
          description: f.f.description,
          remediation: f.f.remediation,
          evidence: JSON.stringify(f.f.evidence).slice(0, 1500),
          firstSeen: iso(f.f.firstSeen),
          lastSeen: iso(f.f.lastSeen),
        };
      }),
    }),

    listAssets: tool({
      description:
        "List assets (domains, subdomains, URLs) with whether they are verified, when they were last scanned and their open findings by severity.",
      inputSchema: z.object({
        workspaceId: handle.optional(),
        limit: z.number().int().min(1).max(50).default(30),
      }),
      execute: safely("listAssets", async (a: { workspaceId?: string; limit: number }) => {
        const ws = a.workspaceId ? refs.resolve("workspace", a.workspaceId) : undefined;
        if (a.workspaceId && !ws) return NONE("workspace");
        const rows = await db
          .select({
            id: assets.id,
            kind: assets.kind,
            value: assets.value,
            verified: assets.verified,
            lastScanAt: assets.lastScanAt,
          })
          .from(assets)
          .where(and(mine(assets.workspaceId), ws ? eq(assets.workspaceId, ws.id) : undefined))
          .orderBy(assets.value)
          .limit(a.limit);
        const counts = rows.length
          ? await db
              .select({
                assetId: findings.assetId,
                severity: findings.severity,
                n: sql<number>`count(*)::int`,
              })
              .from(findings)
              .where(
                and(
                  inArray(
                    findings.assetId,
                    rows.map((r) => r.id),
                  ),
                  eq(findings.status, "open"),
                ),
              )
              .groupBy(findings.assetId, findings.severity)
          : [];
        return rows.map((r) => ({
          id: R("asset", r.id, r.value),
          kind: r.kind,
          value: r.value,
          verified: r.verified,
          lastScanAt: iso(r.lastScanAt),
          openFindings: Object.fromEntries(
            counts.filter((c) => c.assetId === r.id).map((c) => [c.severity, c.n]),
          ),
        }));
      }),
    }),

    expiringCertificates: tool({
      description:
        "Monitors whose TLS certificate (as seen by the latest check) expires within N days (1 to 90, default 30), soonest first.",
      inputSchema: z.object({ withinDays: z.number().int().min(1).max(90).default(30) }),
      execute: safely("expiringCertificates", async (a: { withinDays: number }) => {
        const rows = await db
          .select({
            id: monitors.id,
            name: monitors.name,
            target: monitors.target,
            daysLeft: sql<number>`(array_agg(${monitorChecks.tlsDaysLeft} order by ${monitorChecks.createdAt} desc))[1]`,
          })
          .from(monitors)
          .innerJoin(monitorChecks, eq(monitorChecks.monitorId, monitors.id))
          .where(
            and(
              mine(monitors.workspaceId),
              isNotNull(monitorChecks.tlsDaysLeft),
              eq(monitors.active, true),
              ne(monitors.type, "dns"),
            ),
          )
          .groupBy(monitors.id)
          .limit(200);
        return rows
          .filter((r) => r.daysLeft <= a.withinDays)
          .sort((x, y) => x.daysLeft - y.daysLeft)
          .slice(0, 25)
          .map((r) => ({
            id: R("monitor", r.id, r.name),
            name: r.name,
            target: r.target,
            daysLeft: r.daysLeft,
          }));
      }),
    }),
  };
}
