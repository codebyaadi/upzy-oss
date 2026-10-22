import { randomBytes } from "node:crypto";

import { hasRole } from "@upzy/auth/roles";
import { decryptJson, encryptJson } from "@upzy/crypto";
import { activeMaintenance, schema, type Db } from "@upzy/db";
import {
  CreateMonitorSchema,
  UpdateMonitorSchema,
  referencesProblem,
  type Step,
} from "@upzy/validator";
import { and, desc, eq, gte, inArray, sql } from "drizzle-orm";
import { Elysia } from "elysia";
import { z } from "zod";

import type { Billing } from "../lib/billing";
import { present } from "../lib/monitor-present";
import type { AuthPlugin } from "../plugins/auth";
import { HttpError } from "../plugins/errors";

const { monitors, monitorChecks, workspaces } = schema;
const Params = z.object({ id: z.uuid() });
const ListQuery = z.object({ workspaceId: z.uuid().optional() });
const RANGES = {
  "24h": { hours: 24, bin: "15 minutes" },
  "7d": { hours: 24 * 7, bin: "2 hours" },
  "30d": { hours: 24 * 30, bin: "6 hours" },
} as const;
const StatsQuery = z.object({ range: z.enum(["24h", "7d", "30d"]).default("24h") });
const ChecksQuery = z.object({ limit: z.coerce.number().int().min(1).max(200).default(50) });

const newToken = () => randomBytes(24).toString("base64url");

const maintenanceOf = (w?: { id: string; name: string; endsAt: Date }) =>
  w ? { id: w.id, name: w.name, endsAt: w.endsAt } : null;

export const monitorModule = (
  db: Db,
  authP: AuthPlugin,
  billing: Billing,
  opts: { encryptionKey: string; apiOrigin: string },
) => {
  const show = (row: typeof monitors.$inferSelect, role: Parameters<typeof hasRole>[0]) =>
    present(row, {
      key: opts.encryptionKey,
      apiOrigin: opts.apiOrigin,
      canSeePing: hasRole(role, "member"),
    });

  /** Monitors only ever resolve through workspaces owned by the caller's organization. */
  const orgWorkspaceIds = (orgId: string) =>
    db.select({ id: workspaces.id }).from(workspaces).where(eq(workspaces.orgId, orgId));

  const owned = (orgId: string, id: string) =>
    and(eq(monitors.id, id), inArray(monitors.workspaceId, orgWorkspaceIds(orgId)));

  return (
    new Elysia({ prefix: "/monitor" })
      .use(authP)
      .post(
        "/",
        async ({ body, orgId, role, set }) => {
          const [ws] = await db
            .select({ id: workspaces.id })
            .from(workspaces)
            .where(and(eq(workspaces.id, body.workspaceId), eq(workspaces.orgId, orgId)));
          if (!ws) throw new HttpError(404, "Workspace not found");
          await billing.assertCanCreate(db, orgId, "monitors");

          // A heartbeat is pinged by the job, so how often we look is our business, not a plan limit.
          const heartbeat = body.type === "heartbeat";
          if (!heartbeat) await billing.assertInterval(db, orgId, body.interval);
          const target =
            body.type === "flow"
              ? body.config.steps![0]!.url
              : heartbeat
                ? "heartbeat"
                : body.target;
          if (!target) throw new HttpError(422, "A target is required");

          const config = { ...body.config };
          if (heartbeat)
            config.grace ??= Math.min(3600, Math.max(60, Math.round(config.expectEvery! * 0.1)));
          const hasSecrets = Object.keys(body.secrets).length > 0;

          const [row] = await db
            .insert(monitors)
            .values({
              workspaceId: body.workspaceId,
              name: body.name,
              type: body.type,
              target,
              interval: heartbeat ? 60 : body.interval,
              active: body.active,
              config,
              failureThreshold: heartbeat ? 1 : body.failureThreshold,
              latencyThresholdMs: body.latencyThresholdMs,
              secretsEncrypted: hasSecrets ? encryptJson(body.secrets, opts.encryptionKey) : null,
              ...(heartbeat ? { heartbeatToken: newToken(), heartbeatSince: new Date() } : {}),
            })
            .returning();
          set.status = 201;
          return show(row!, role);
        },
        { org: "member", body: CreateMonitorSchema },
      )
      .get(
        "/",
        async ({ orgId, role, query }) => {
          const rows = await db
            .select()
            .from(monitors)
            .where(
              and(
                inArray(monitors.workspaceId, orgWorkspaceIds(orgId)),
                query.workspaceId ? eq(monitors.workspaceId, query.workspaceId) : undefined,
              ),
            )
            .orderBy(desc(monitors.createdAt));
          if (rows.length === 0) return [];

          const since = new Date(Date.now() - 24 * 3600_000);
          const agg = await db
            .select({
              monitorId: monitorChecks.monitorId,
              total: sql<number>`count(*)::int`,
              up: sql<number>`count(*) filter (where ${monitorChecks.status} = 'up')::int`,
              avgMs: sql<number | null>`round(avg(${monitorChecks.responseMs}))::int`,
              lastCheckAt: sql<Date | null>`max(${monitorChecks.createdAt})`,
            })
            .from(monitorChecks)
            .where(
              and(
                inArray(
                  monitorChecks.monitorId,
                  rows.map((r) => r.id),
                ),
                gte(monitorChecks.createdAt, since),
              ),
            )
            .groupBy(monitorChecks.monitorId);
          const byId = new Map(agg.map((a) => [a.monitorId, a]));
          const inMaintenance = await activeMaintenance(
            db,
            rows.map((r) => r.id),
          );

          return rows.map((m) => {
            const a = byId.get(m.id);
            return {
              ...show(m, role),
              // The window covering this monitor right now, if any.
              maintenance: maintenanceOf(inMaintenance.get(m.id)),
              // A heartbeat only records changes of state, so a percentage of rows would mislead.
              uptime24h: m.type !== "heartbeat" && a && a.total > 0 ? a.up / a.total : null,
              avgMs24h: a?.avgMs ?? null,
              lastCheckAt: a?.lastCheckAt ?? null,
            };
          });
        },
        { org: true, query: ListQuery },
      )
      .get(
        "/:id",
        async ({ params, orgId, role }) => {
          const [row] = await db.select().from(monitors).where(owned(orgId, params.id));
          if (!row) throw new HttpError(404, "Monitor not found");
          return {
            ...show(row, role),
            maintenance: maintenanceOf((await activeMaintenance(db, [row.id])).get(row.id)),
          };
        },
        { org: true, params: Params },
      )
      .patch(
        "/:id",
        async ({ params, body, orgId, role }) => {
          const [cur] = await db.select().from(monitors).where(owned(orgId, params.id));
          if (!cur) throw new HttpError(404, "Monitor not found");
          const heartbeat = cur.type === "heartbeat";
          // Speeding a monitor up is what a plan limits; slowing it down never is.
          if (!heartbeat && body.interval !== undefined && body.interval < cur.interval)
            await billing.assertInterval(db, orgId, body.interval);

          const { secrets, config, interval, ...plain } = body;
          const patch: Partial<typeof monitors.$inferInsert> = { ...plain };
          if (!heartbeat && interval !== undefined) patch.interval = interval;

          // Secrets: names sent are kept (null) or replaced (a value); names left out are deleted.
          let names = Object.keys(
            cur.secretsEncrypted
              ? decryptJson<Record<string, string>>(cur.secretsEncrypted, opts.encryptionKey)
              : {},
          );
          if (secrets) {
            const stored = cur.secretsEncrypted
              ? decryptJson<Record<string, string>>(cur.secretsEncrypted, opts.encryptionKey)
              : {};
            const next: Record<string, string> = {};
            for (const [name, value] of Object.entries(secrets)) {
              const v = value ?? stored[name];
              if (v === undefined)
                throw new HttpError(
                  422,
                  `There is no stored secret named ${name} to keep: give it a value.`,
                );
              next[name] = v;
            }
            patch.secretsEncrypted = Object.keys(next).length
              ? encryptJson(next, opts.encryptionKey)
              : null;
            names = Object.keys(next);
          }

          if (config) {
            if (cur.type === "flow" && !config.steps?.length)
              throw new HttpError(422, "A flow needs at least one step.");
            if (cur.type !== "flow" && config.steps)
              throw new HttpError(422, "Steps are only for flows.");
            if (heartbeat && !config.expectEvery)
              throw new HttpError(422, "Say how often the job should check in.");
            if (!heartbeat && (config.expectEvery !== undefined || config.grace !== undefined))
              throw new HttpError(422, "Check-in timing is only for heartbeats.");
            if (
              !["http", "flow"].includes(cur.type) &&
              (config.headers || config.body !== undefined || config.assertions)
            )
              throw new HttpError(
                422,
                "Headers, body and JSON checks are for HTTP monitors and flows.",
              );
            patch.config = config;
            if (heartbeat)
              patch.config = {
                ...config,
                grace:
                  config.grace ??
                  Math.min(3600, Math.max(60, Math.round(config.expectEvery! * 0.1))),
              };
            if (cur.type === "flow") patch.target = config.steps![0]!.url;
          }
          // Whatever the combination, every {{secret.X}} and {{variable}} must still resolve.
          const finalConfig = (patch.config ?? cur.config) as {
            headers?: Record<string, string>;
            body?: string;
            steps?: Step[];
          };
          if (config || secrets) {
            const problem = referencesProblem(
              finalConfig,
              names,
              cur.type === "http" ? cur.target : undefined,
            );
            if (problem) throw new HttpError(422, problem);
          }
          // Resuming a heartbeat starts its clock again, so it isn't late for the time it was paused.
          if (heartbeat && body.active === true && !cur.active) patch.heartbeatSince = new Date();

          const [row] = await db
            .update(monitors)
            .set(patch)
            .where(owned(orgId, params.id))
            .returning();
          return show(row!, role);
        },
        { org: "member", params: Params, body: UpdateMonitorSchema },
      )
      // A new ping address: the old one stops working at once. For when it was shared by mistake.
      .post(
        "/:id/rotate-token",
        async ({ params, orgId, role }) => {
          const [cur] = await db.select().from(monitors).where(owned(orgId, params.id));
          if (!cur) throw new HttpError(404, "Monitor not found");
          if (cur.type !== "heartbeat")
            throw new HttpError(409, "Only heartbeat monitors have a ping address.");
          const [row] = await db
            .update(monitors)
            .set({ heartbeatToken: newToken() })
            .where(eq(monitors.id, cur.id))
            .returning();
          return show(row!, role);
        },
        { org: "member", params: Params },
      )
      .get(
        "/:id/checks",
        async ({ params, query, orgId }) => {
          const [m] = await db
            .select({ id: monitors.id })
            .from(monitors)
            .where(owned(orgId, params.id));
          if (!m) throw new HttpError(404, "Monitor not found");
          return db
            .select()
            .from(monitorChecks)
            .where(eq(monitorChecks.monitorId, params.id))
            .orderBy(desc(monitorChecks.createdAt))
            .limit(query.limit);
        },
        { org: true, params: Params, query: ChecksQuery },
      )
      .get(
        "/:id/stats",
        async ({ params, query, orgId }) => {
          const [m] = await db
            .select({ id: monitors.id })
            .from(monitors)
            .where(owned(orgId, params.id));
          if (!m) throw new HttpError(404, "Monitor not found");
          const { hours, bin } = RANGES[query.range];
          const since = new Date(Date.now() - hours * 3600_000);

          const [summary] = [
            ...(await db.execute<{
              total: number;
              up: number;
              avg_ms: number | null;
              p95_ms: number | null;
            }>(sql`
            select count(*)::int as total,
                   count(*) filter (where status = 'up')::int as up,
                   round(avg(response_ms))::int as avg_ms,
                   round(percentile_cont(0.95) within group (order by response_ms))::int as p95_ms
            from monitor_checks where monitor_id = ${params.id} and created_at >= ${since}`)),
          ];
          const series = await db.execute<{
            t: Date;
            avg_ms: number | null;
            up: number;
            total: number;
          }>(sql`
          select date_bin(${bin}::interval, created_at, timestamptz '2000-01-01 00:00:00+00') as t,
                 round(avg(response_ms))::int as avg_ms,
                 count(*) filter (where status = 'up')::int as up,
                 count(*)::int as total
          from monitor_checks where monitor_id = ${params.id} and created_at >= ${since}
          group by 1 order by 1`);

          return {
            range: query.range,
            checks: summary?.total ?? 0,
            uptime: summary && summary.total > 0 ? summary.up / summary.total : null,
            avgMs: summary?.avg_ms ?? null,
            p95Ms: summary?.p95_ms ?? null,
            series: [...series].map((r) => ({ t: r.t, avgMs: r.avg_ms, up: r.up, total: r.total })),
          };
        },
        { org: true, params: Params, query: StatsQuery },
      )
      .delete(
        "/:id",
        async ({ params, orgId, set }) => {
          const rows = await db
            .delete(monitors)
            .where(owned(orgId, params.id))
            .returning({ id: monitors.id });
          if (rows.length === 0) throw new HttpError(404, "Monitor not found");
          set.status = 204;
        },
        { org: "member", params: Params },
      )
  );
};
