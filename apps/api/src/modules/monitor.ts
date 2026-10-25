import { randomBytes } from "node:crypto";

import { hasRole } from "@upzy/auth/roles";
import { PLANS } from "@upzy/billing";
import { decryptJson, encryptJson } from "@upzy/crypto";
import {
  BROWSER_MIN_INTERVAL,
  activeMaintenance,
  browserEndpoint,
  offeredRegions,
  rollupSeries,
  rollupSummary,
  rollupTotals,
  schema,
  type Db,
} from "@upzy/db";
import {
  CreateMonitorSchema,
  UpdateMonitorSchema,
  referencesProblem,
  type Step,
} from "@upzy/validator";
import { and, desc, eq, inArray } from "drizzle-orm";
import { Elysia } from "elysia";
import { z } from "zod";

import type { Billing } from "../lib/billing";
import { present } from "../lib/monitor-present";
import { orgWorkspaceIds, requireWorkspace } from "../lib/scope";
import type { AuthPlugin } from "../plugins/auth";
import { HttpError } from "../plugins/errors";

const { monitors, monitorChecks, monitorRegionState } = schema;
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

  /** The regions asked for, if this installation offers them and the plan allows that many. */
  const chosenRegions = async (orgId: string, asked: string[]) => {
    const regions = [...new Set(asked)];
    const offered = offeredRegions();
    const unknown = regions.filter((r) => !offered.includes(r));
    if (unknown.length)
      throw new HttpError(422, `This installation doesn't offer the region ${unknown.join(", ")}.`);
    await billing.assertRegions(db, orgId, Math.max(regions.length, 1));
    return regions;
  };

  /** Monitors only ever resolve through the workspaces this person may see in their organization. */
  const owned = (orgId: string, userId: string, id: string) =>
    and(eq(monitors.id, id), inArray(monitors.workspaceId, orgWorkspaceIds(db, orgId, userId)));

  return (
    new Elysia({ prefix: "/monitor" })
      .use(authP)
      .post(
        "/",
        async ({ user, body, orgId, role, set }) => {
          await requireWorkspace(db, orgId, body.workspaceId, user.id);
          await billing.assertCanCreate(db, orgId, "monitors");

          // A heartbeat is pinged by the job, so how often we look is our business, not a plan limit.
          const heartbeat = body.type === "heartbeat";
          if (!heartbeat) await billing.assertInterval(db, orgId, body.interval);
          const browser = body.type === "synthetic";
          if (browser) {
            if (!browserEndpoint())
              throw new HttpError(422, "Browser monitors aren't set up on this installation.");
            if (body.interval < BROWSER_MIN_INTERVAL)
              throw new HttpError(422, "Browser monitors check at most every 5 minutes.");
            await billing.assertBrowserMonitor(db, orgId);
          }
          const target =
            body.type === "flow"
              ? body.config.steps![0]!.url
              : heartbeat
                ? "heartbeat"
                : body.target;
          if (!target) throw new HttpError(422, "A target is required");

          // Checked from the main server unless regions are chosen. A heartbeat has nothing to check from anywhere.
          const regions = heartbeat || browser ? [] : await chosenRegions(orgId, body.regions);

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
              regions,
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
        async ({ user, orgId, role, query }) => {
          const rows = await db
            .select()
            .from(monitors)
            .where(
              and(
                inArray(monitors.workspaceId, orgWorkspaceIds(db, orgId, user.id)),
                query.workspaceId ? eq(monitors.workspaceId, query.workspaceId) : undefined,
              ),
            )
            .orderBy(desc(monitors.createdAt));
          if (rows.length === 0) return [];

          // From the five-minute rollups, not the raw checks: 300 monitors is 86k buckets a day instead of 432k rows.
          const byId = await rollupTotals(
            db,
            rows.map((r) => r.id),
            new Date(Date.now() - 24 * 3600_000),
          );
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
              lastCheckAt: m.lastCheckAt,
            };
          });
        },
        { org: true, query: ListQuery },
      )
      .get(
        "/regions",
        async ({ orgId }) => {
          const { ent } = await billing.entitlementFor(db, orgId);
          const max = PLANS[ent.plan].limits.regions;
          const browserMax = PLANS[ent.plan].limits.browserMonitors;
          return {
            regions: offeredRegions(),
            max: Number.isFinite(max) ? max : null,
            browser: {
              enabled: browserEndpoint() !== null,
              max: Number.isFinite(browserMax) ? browserMax : null,
            },
          };
        },
        { org: true },
      )
      .get(
        "/:id",
        async ({ user, params, orgId, role }) => {
          const [row] = await db
            .select()
            .from(monitors)
            .where(owned(orgId, user.id, params.id));
          if (!row) throw new HttpError(404, "Monitor not found");
          const states = row.regions.length
            ? await db
                .select({
                  region: monitorRegionState.region,
                  status: monitorRegionState.lastStatus,
                  lastCheckAt: monitorRegionState.lastCheckAt,
                })
                .from(monitorRegionState)
                .where(eq(monitorRegionState.monitorId, row.id))
            : [];
          return {
            ...show(row, role),
            maintenance: maintenanceOf((await activeMaintenance(db, [row.id])).get(row.id)),
            regionStates: states,
          };
        },
        { org: true, params: Params },
      )
      .patch(
        "/:id",
        async ({ user, params, body, orgId, role }) => {
          const [cur] = await db
            .select()
            .from(monitors)
            .where(owned(orgId, user.id, params.id));
          if (!cur) throw new HttpError(404, "Monitor not found");
          const heartbeat = cur.type === "heartbeat";
          // Speeding a monitor up is what a plan limits; slowing it down never is.
          if (!heartbeat && body.interval !== undefined && body.interval < cur.interval)
            await billing.assertInterval(db, orgId, body.interval);

          const { secrets, config, interval, regions, ...plain } = body;
          const patch: Partial<typeof monitors.$inferInsert> = { ...plain };
          if (regions !== undefined && !heartbeat)
            patch.regions = await chosenRegions(orgId, regions);
          if (!heartbeat && interval !== undefined) {
            if (cur.type === "synthetic" && interval < BROWSER_MIN_INTERVAL)
              throw new HttpError(422, "Browser monitors check at most every 5 minutes.");
            patch.interval = interval;
          }

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
            if (cur.type !== "synthetic" && config.browser)
              throw new HttpError(422, "Browser steps are only for browser monitors.");
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
            browser?: { do: string; value?: string }[];
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
            .where(owned(orgId, user.id, params.id))
            .returning();
          return show(row!, role);
        },
        { org: "member", params: Params, body: UpdateMonitorSchema },
      )
      // A new ping address: the old one stops working at once. For when it was shared by mistake.
      .post(
        "/:id/rotate-token",
        async ({ user, params, orgId, role }) => {
          const [cur] = await db
            .select()
            .from(monitors)
            .where(owned(orgId, user.id, params.id));
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
        async ({ user, params, query, orgId }) => {
          const [m] = await db
            .select({ id: monitors.id })
            .from(monitors)
            .where(owned(orgId, user.id, params.id));
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
        async ({ user, params, query, orgId }) => {
          const [m] = await db
            .select({ id: monitors.id })
            .from(monitors)
            .where(owned(orgId, user.id, params.id));
          if (!m) throw new HttpError(404, "Monitor not found");
          const { hours, bin } = RANGES[query.range];
          const since = new Date(Date.now() - hours * 3600_000);

          const summary = await rollupSummary(db, params.id, since);
          const series = await rollupSeries(db, params.id, since, bin);

          return {
            range: query.range,
            checks: summary.total,
            uptime: summary.total > 0 ? summary.up / summary.total : null,
            avgMs: summary.avgMs,
            p95Ms: summary.p95Ms,
            series,
          };
        },
        { org: true, params: Params, query: StatsQuery },
      )
      .delete(
        "/:id",
        async ({ user, params, orgId, set }) => {
          const rows = await db
            .delete(monitors)
            .where(owned(orgId, user.id, params.id))
            .returning({ id: monitors.id });
          if (rows.length === 0) throw new HttpError(404, "Monitor not found");
          set.status = 204;
        },
        { org: "member", params: Params },
      )
  );
};
