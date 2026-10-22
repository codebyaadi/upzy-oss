import { schema, type Db } from "@upzy/db";
import { and, eq, gte, inArray, isNull, or, sql } from "drizzle-orm";

import { computeHealth, type Health } from "./health";

const { assets, findings, monitors, incidents, assetHealth } = schema;

const WINDOW_DAYS = 30;
const DAY = 86_400_000;

/** A monitor target is a URL or a "host:port"; either way, which host does it watch? */
export function hostOfTarget(target: string): string | null {
  try {
    return new URL(target).hostname.toLowerCase();
  } catch {
    const host = target.trim().split(/[:/]/)[0]?.toLowerCase();
    return host || null;
  }
}

const hostOfAsset = (a: { kind: string; value: string }) =>
  a.kind === "url" ? hostOfTarget(a.value) : a.value.toLowerCase();

/**
 * Health for several assets at once. Null for an asset that has never been scanned (nothing to grade yet).
 * Uptime comes from monitors in the same workspace that watch the same host, over the last 30 days.
 */
export async function healthFor(db: Db, assetIds: string[]): Promise<Map<string, Health | null>> {
  const out = new Map<string, Health | null>();
  if (assetIds.length === 0) return out;
  const rows = await db
    .select({
      id: assets.id,
      workspaceId: assets.workspaceId,
      kind: assets.kind,
      value: assets.value,
      lastScanAt: assets.lastScanAt,
    })
    .from(assets)
    .where(inArray(assets.id, assetIds));

  const open = await db
    .select({ assetId: findings.assetId, checkKey: findings.checkKey, severity: findings.severity })
    .from(findings)
    .where(and(inArray(findings.assetId, assetIds), eq(findings.status, "open")));

  const workspaceIds = [...new Set(rows.map((r) => r.workspaceId))];
  const mons = await db
    .select({
      id: monitors.id,
      workspaceId: monitors.workspaceId,
      target: monitors.target,
      createdAt: monitors.createdAt,
      active: monitors.active,
    })
    .from(monitors)
    .where(inArray(monitors.workspaceId, workspaceIds));

  const now = Date.now();
  const since = new Date(now - WINDOW_DAYS * DAY);
  const monIds = mons.map((m) => m.id);
  const outages = monIds.length
    ? await db
        .select({
          monitorId: incidents.monitorId,
          start: incidents.createdAt,
          end: incidents.resolvedAt,
        })
        .from(incidents)
        .where(
          and(
            inArray(incidents.monitorId, monIds),
            or(isNull(incidents.resolvedAt), gte(incidents.resolvedAt, since)),
          ),
        )
    : [];

  const uptimeOf = (m: (typeof mons)[number]): number | null => {
    const from = Math.max(since.getTime(), m.createdAt.getTime());
    const span = now - from;
    if (span < DAY / 2) return null; // too new to say anything
    const spans = outages
      .filter((o) => o.monitorId === m.id)
      .map(
        (o) =>
          [
            Math.max(o.start.getTime(), from),
            Math.min((o.end ?? new Date(now)).getTime(), now),
          ] as const,
      )
      .filter(([a, b]) => b > a)
      .sort((x, y) => x[0] - y[0]);
    let down = 0;
    let cursor = -Infinity;
    for (const [a, b] of spans) {
      const start = Math.max(a, cursor);
      if (b > start) down += b - start;
      cursor = Math.max(cursor, b);
    }
    return (1 - down / span) * 100;
  };

  for (const a of rows) {
    if (!a.lastScanAt) {
      out.set(a.id, null);
      continue;
    }
    const host = hostOfAsset(a);
    const ups = mons
      .filter((m) => m.workspaceId === a.workspaceId && m.active && hostOfTarget(m.target) === host)
      .map(uptimeOf)
      .filter((u): u is number => u !== null);
    out.set(
      a.id,
      computeHealth({
        open: open.filter((f) => f.assetId === a.id),
        kind: a.kind,
        uptime: ups.length ? ups.reduce((x, y) => x + y, 0) / ups.length : null,
      }),
    );
  }
  return out;
}

/** Stores today's point for the trend (the latest of the day wins). Call after a scan or a verified fix. */
export async function recordHealth(db: Db, assetId: string) {
  const health = (await healthFor(db, [assetId])).get(assetId);
  if (!health) return;
  const day = new Date().toISOString().slice(0, 10);
  await db
    .insert(assetHealth)
    .values({
      assetId,
      day,
      score: health.score,
      grade: health.grade,
      categories: health.categories,
    })
    .onConflictDoUpdate({
      target: [assetHealth.assetId, assetHealth.day],
      set: {
        score: health.score,
        grade: health.grade,
        categories: health.categories,
        recordedAt: sql`now()`,
      },
    });
}

/** Last 90 days of daily points, oldest first. */
export async function healthHistory(db: Db, assetId: string, days = 90) {
  const from = new Date(Date.now() - days * DAY).toISOString().slice(0, 10);
  return db
    .select({ day: assetHealth.day, score: assetHealth.score, grade: assetHealth.grade })
    .from(assetHealth)
    .where(and(eq(assetHealth.assetId, assetId), gte(assetHealth.day, from)))
    .orderBy(assetHealth.day);
}
