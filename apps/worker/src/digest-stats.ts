import type { DigestStats } from "@upzy/ai";
import { schema, type Db } from "@upzy/db";
import { and, desc, eq, gte, inArray, lt, sql } from "drizzle-orm";

const { monitors, monitorChecks, incidents, findings, assets, workspaces } = schema;

/** Monday 00:00 UTC of the week containing `d`, as YYYY-MM-DD. */
export function weekStartOf(d: Date): string {
  const day = d.getUTCDay(); // 0 = Sunday
  const monday = new Date(
    Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - ((day + 6) % 7)),
  );
  return monday.toISOString().slice(0, 10);
}

const addDays = (isoDate: string, days: number) =>
  new Date(Date.parse(`${isoDate}T00:00:00Z`) + days * 86_400_000);

/** The previous full week (Mon..Sun) for the week that starts at `weekStart`. Pure SQL aggregates: the model never computes numbers. */
export const computeDigestStats = (db: Db, workspaceId: string, weekStart: string) =>
  computePeriodStats(db, workspaceId, addDays(weekStart, -7), addDays(weekStart, 0));

/** The same numbers for any period [from, to). */
export async function computePeriodStats(
  db: Db,
  workspaceId: string,
  from: Date,
  to: Date,
): Promise<DigestStats> {
  const [ws] = await db
    .select({ name: workspaces.name })
    .from(workspaces)
    .where(eq(workspaces.id, workspaceId));

  const monitorRows = await db
    .select({ id: monitors.id, name: monitors.name })
    .from(monitors)
    .where(eq(monitors.workspaceId, workspaceId));
  const ids = monitorRows.map((m) => m.id);
  const agg = ids.length
    ? await db
        .select({
          monitorId: monitorChecks.monitorId,
          total: sql<number>`count(*)::int`,
          up: sql<number>`count(*) filter (where ${monitorChecks.status} = 'up')::int`,
          avgMs: sql<number | null>`round(avg(${monitorChecks.responseMs}))::int`,
        })
        .from(monitorChecks)
        .where(
          and(
            inArray(monitorChecks.monitorId, ids),
            gte(monitorChecks.createdAt, from),
            lt(monitorChecks.createdAt, to),
          ),
        )
        .groupBy(monitorChecks.monitorId)
    : [];

  const inc = await db
    .select({
      opened: sql<number>`count(*) filter (where ${incidents.createdAt} >= ${from} and ${incidents.createdAt} < ${to})::int`,
      resolved: sql<number>`count(*) filter (where ${incidents.resolvedAt} >= ${from} and ${incidents.resolvedAt} < ${to})::int`,
      stillOpen: sql<number>`count(*) filter (where ${incidents.status} <> 'resolved')::int`,
      downtimeSeconds: sql<number>`coalesce(sum(extract(epoch from (least(coalesce(${incidents.resolvedAt}, ${to}), ${to}) - greatest(${incidents.createdAt}, ${from})))) filter (where ${incidents.createdAt} < ${to} and coalesce(${incidents.resolvedAt}, ${to}) > ${from}), 0)::int`,
    })
    .from(incidents)
    .where(eq(incidents.workspaceId, workspaceId));

  const fnd = await db
    .select({
      isNew: sql<number>`count(*) filter (where ${findings.firstSeen} >= ${from} and ${findings.firstSeen} < ${to})::int`,
      resolved: sql<number>`count(*) filter (where ${findings.resolvedAt} >= ${from} and ${findings.resolvedAt} < ${to})::int`,
      open: sql<number>`count(*) filter (where ${findings.status} = 'open')::int`,
    })
    .from(findings)
    .where(eq(findings.workspaceId, workspaceId));

  const top = await db
    .select({ title: findings.title, severity: findings.severity, asset: assets.value })
    .from(findings)
    .innerJoin(assets, eq(assets.id, findings.assetId))
    .where(and(eq(findings.workspaceId, workspaceId), eq(findings.status, "open")))
    .orderBy(desc(findings.riskScore))
    .limit(3);

  return {
    workspace: ws?.name ?? "Workspace",
    periodStart: from.toISOString().slice(0, 10),
    periodEnd: new Date(to.getTime() - 86_400_000).toISOString().slice(0, 10),
    monitors: monitorRows.map((m) => {
      const a = agg.find((x) => x.monitorId === m.id);
      return {
        name: m.name,
        uptime: a && a.total > 0 ? Math.round((a.up / a.total) * 10_000) / 10_000 : null,
        avgMs: a?.avgMs ?? null,
        checks: a?.total ?? 0,
      };
    }),
    incidents: {
      opened: inc[0]?.opened ?? 0,
      resolved: inc[0]?.resolved ?? 0,
      stillOpen: inc[0]?.stillOpen ?? 0,
      totalDowntimeMinutes: Math.round((inc[0]?.downtimeSeconds ?? 0) / 60),
    },
    findings: {
      new: fnd[0]?.isNew ?? 0,
      resolved: fnd[0]?.resolved ?? 0,
      open: fnd[0]?.open ?? 0,
      topOpen: top,
    },
  };
}
