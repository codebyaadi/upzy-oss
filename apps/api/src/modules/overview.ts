import { schema, type Db } from "@upzy/db";
import { healthFor, type Grade } from "@upzy/security";
import { and, asc, count, eq, inArray, isNull } from "drizzle-orm";
import { Elysia } from "elysia";

import { orgWorkspaceIds } from "../lib/scope";
import type { AuthPlugin } from "../plugins/auth";

const { workspaces, monitors, incidents, findings, assets, statusPages } = schema;

const GRADE_ORDER: Grade[] = ["A", "B", "C", "D", "F"];

export interface WorkspaceOverview {
  id: string;
  name: string;
  monitors: {
    total: number;
    up: number;
    down: number;
    degraded: number;
    unknown: number;
    paused: number;
  };
  openIncidents: number;
  openFindings: { critical: number; high: number };
  /** The worst security grade among the workspace's scanned assets, or null when none has been scanned yet. */
  grade: Grade | null;
  /** The first published status page, for a quick link to what the client sees. */
  statusPage: { slug: string; title: string } | null;
}

/**
 * Every workspace of the organization at a glance. For an agency a workspace is a client, so this is the "which of my
 * clients needs me right now" screen. Anyone in the organization can read it; it holds counts and names only.
 */
export const overviewModule = (db: Db, authP: AuthPlugin) =>
  new Elysia({ prefix: "/overview" }).use(authP).get(
    "/",
    async ({ orgId, user }): Promise<WorkspaceOverview[]> => {
      const spaces = await db
        .select({ id: workspaces.id, name: workspaces.name })
        .from(workspaces)
        .where(inArray(workspaces.id, orgWorkspaceIds(db, orgId, user.id)))
        .orderBy(asc(workspaces.name));
      if (spaces.length === 0) return [];
      const ids = spaces.map((s) => s.id);

      const monRows = await db
        .select({
          workspaceId: monitors.workspaceId,
          status: monitors.lastStatus,
          active: monitors.active,
          n: count(),
        })
        .from(monitors)
        .where(inArray(monitors.workspaceId, ids))
        .groupBy(monitors.workspaceId, monitors.lastStatus, monitors.active);

      const incRows = await db
        .select({ workspaceId: incidents.workspaceId, n: count() })
        .from(incidents)
        .where(and(inArray(incidents.workspaceId, ids), isNull(incidents.resolvedAt)))
        .groupBy(incidents.workspaceId);

      const findRows = await db
        .select({ workspaceId: findings.workspaceId, severity: findings.severity, n: count() })
        .from(findings)
        .where(
          and(
            inArray(findings.workspaceId, ids),
            eq(findings.status, "open"),
            inArray(findings.severity, ["critical", "high"]),
          ),
        )
        .groupBy(findings.workspaceId, findings.severity);

      const assetRows = await db
        .select({ id: assets.id, workspaceId: assets.workspaceId })
        .from(assets)
        .where(and(inArray(assets.workspaceId, ids)));
      const health = await healthFor(
        db,
        assetRows.map((a) => a.id),
      );

      const pageRows = await db
        .select({
          workspaceId: statusPages.workspaceId,
          slug: statusPages.slug,
          title: statusPages.title,
        })
        .from(statusPages)
        .where(and(inArray(statusPages.workspaceId, ids), eq(statusPages.published, true)))
        .orderBy(asc(statusPages.createdAt));

      return spaces.map((s) => {
        const m = { total: 0, up: 0, down: 0, degraded: 0, unknown: 0, paused: 0 };
        for (const r of monRows.filter((row) => row.workspaceId === s.id)) {
          m.total += r.n;
          if (!r.active) m.paused += r.n;
          else if (r.status === "up") m.up += r.n;
          else if (r.status === "down") m.down += r.n;
          else if (r.status === "degraded") m.degraded += r.n;
          else m.unknown += r.n;
        }
        const grades = assetRows
          .filter((a) => a.workspaceId === s.id)
          .map((a) => health.get(a.id)?.grade)
          .filter((g): g is Grade => !!g);
        const worst = grades.sort((a, b) => GRADE_ORDER.indexOf(b) - GRADE_ORDER.indexOf(a))[0];
        const page = pageRows.find((p) => p.workspaceId === s.id);
        const sev = (v: string) =>
          findRows.find((f) => f.workspaceId === s.id && f.severity === v)?.n ?? 0;
        return {
          id: s.id,
          name: s.name,
          monitors: m,
          openIncidents: incRows.find((i) => i.workspaceId === s.id)?.n ?? 0,
          openFindings: { critical: sev("critical"), high: sev("high") },
          grade: worst ?? null,
          statusPage: page ? { slug: page.slug, title: page.title } : null,
        };
      });
    },
    { org: true },
  );
