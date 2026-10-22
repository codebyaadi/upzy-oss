import { schema, type Db } from "@upzy/db";
import {
  CreateMaintenanceSchema,
  maintenancePhase,
  UpdateMaintenanceSchema,
  windowProblem,
} from "@upzy/validator";
import { and, desc, eq, gt, inArray } from "drizzle-orm";
import { Elysia } from "elysia";
import { z } from "zod";

import { orgWorkspaceIds, requireWorkspace } from "../lib/scope";
import { forgetAllStatusPages } from "../lib/status-cache";
import type { AuthPlugin } from "../plugins/auth";
import { HttpError } from "../plugins/errors";

const { maintenanceWindows, maintenanceWindowMonitors, monitors } = schema;
const Params = z.object({ id: z.uuid() });
const ListQuery = z.object({
  workspaceId: z.uuid().optional(),
  /** Past windows older than this many days are left out (default 30). */
  pastDays: z.coerce.number().int().min(0).max(365).default(30),
});

type Row = typeof maintenanceWindows.$inferSelect;

/**
 * Planned maintenance. During a window the covered monitors still run and are recorded, but no incident (so no
 * alert or email) opens for them; see apps/worker/src/evaluate.ts. Anyone in the organization can see the windows,
 * only admins change them, because a window silences alerts.
 */
export const maintenanceModule = (
  db: Db,
  authP: AuthPlugin,
  now: () => Date = () => new Date(),
) => {
  const owned = (orgId: string, userId: string, id: string) =>
    and(
      eq(maintenanceWindows.id, id),
      inArray(maintenanceWindows.workspaceId, orgWorkspaceIds(db, orgId, userId)),
    );

  const present = (row: Row, monitorIds: string[]) => ({
    ...row,
    monitorIds: row.allMonitors ? [] : monitorIds,
    phase: maintenancePhase(row, now()),
  });

  async function monitorIdsOf(windowIds: string[]) {
    const by = new Map<string, string[]>();
    if (windowIds.length === 0) return by;
    const rows = await db
      .select()
      .from(maintenanceWindowMonitors)
      .where(inArray(maintenanceWindowMonitors.windowId, windowIds));
    for (const r of rows) by.set(r.windowId, [...(by.get(r.windowId) ?? []), r.monitorId]);
    return by;
  }

  async function requireMonitors(workspaceId: string, ids: string[]) {
    if (ids.length === 0) return;
    const found = await db
      .select({ id: monitors.id })
      .from(monitors)
      .where(and(eq(monitors.workspaceId, workspaceId), inArray(monitors.id, ids)));
    if (found.length !== new Set(ids).size)
      throw new HttpError(422, "One of the chosen monitors isn't in this workspace.");
  }

  const check = (w: Parameters<typeof windowProblem>[0]) => {
    const problem = windowProblem(w, now());
    if (problem) throw new HttpError(422, problem);
  };

  return (
    new Elysia({ prefix: "/maintenance" })
      .use(authP)
      .get(
        "/",
        async ({ user, orgId, query }) => {
          const cutoff = new Date(now().getTime() - query.pastDays * 86_400_000);
          const rows = await db
            .select()
            .from(maintenanceWindows)
            .where(
              and(
                inArray(maintenanceWindows.workspaceId, orgWorkspaceIds(db, orgId, user.id)),
                query.workspaceId
                  ? eq(maintenanceWindows.workspaceId, query.workspaceId)
                  : undefined,
                gt(maintenanceWindows.endsAt, cutoff),
              ),
            )
            .orderBy(desc(maintenanceWindows.startsAt));
          const ids = await monitorIdsOf(rows.map((r) => r.id));
          const order = { active: 0, upcoming: 1, past: 2 } as const;
          return rows
            .map((r) => present(r, ids.get(r.id) ?? []))
            .sort(
              (a, b) =>
                order[a.phase] - order[b.phase] ||
                // Soonest first for what is still to come, most recent first for what is over.
                (a.phase === "past"
                  ? b.startsAt.getTime() - a.startsAt.getTime()
                  : a.startsAt.getTime() - b.startsAt.getTime()),
            );
        },
        { org: true, query: ListQuery },
      )
      .post(
        "/",
        async ({ user, body, orgId, set }) => {
          await requireWorkspace(db, orgId, body.workspaceId, user.id);
          const startsAt = new Date(body.startsAt);
          const endsAt = new Date(body.endsAt);
          const monitorIds = body.allMonitors ? [] : [...new Set(body.monitorIds)];
          check({ startsAt, endsAt, allMonitors: body.allMonitors, monitorIds });
          await requireMonitors(body.workspaceId, monitorIds);

          const created = await db.transaction(async (tx) => {
            const [row] = await tx
              .insert(maintenanceWindows)
              .values({
                workspaceId: body.workspaceId,
                name: body.name,
                startsAt,
                endsAt,
                allMonitors: body.allMonitors,
                showOnStatusPage: body.showOnStatusPage,
              })
              .returning();
            if (monitorIds.length)
              await tx
                .insert(maintenanceWindowMonitors)
                .values(monitorIds.map((monitorId) => ({ windowId: row!.id, monitorId })));
            return row!;
          });
          forgetAllStatusPages();
          set.status = 201;
          return present(created, monitorIds);
        },
        { org: "admin", body: CreateMaintenanceSchema },
      )
      .patch(
        "/:id",
        async ({ user, params, body, orgId }) => {
          const [row] = await db
            .select()
            .from(maintenanceWindows)
            .where(owned(orgId, user.id, params.id));
          if (!row) throw new HttpError(404, "Maintenance window not found");
          if (maintenancePhase(row, now()) === "past")
            throw new HttpError(409, "This window is over. Schedule a new one instead.");

          const current = (await monitorIdsOf([row.id])).get(row.id) ?? [];
          const next = {
            name: body.name ?? row.name,
            startsAt: body.startsAt ? new Date(body.startsAt) : row.startsAt,
            endsAt: body.endsAt ? new Date(body.endsAt) : row.endsAt,
            allMonitors: body.allMonitors ?? row.allMonitors,
            monitorIds: body.allMonitors
              ? []
              : body.monitorIds
                ? [...new Set(body.monitorIds)]
                : current,
            showOnStatusPage: body.showOnStatusPage ?? row.showOnStatusPage,
          };
          check(next);
          await requireMonitors(row.workspaceId, next.monitorIds);

          const updated = await db.transaction(async (tx) => {
            const [u] = await tx
              .update(maintenanceWindows)
              .set({
                name: next.name,
                startsAt: next.startsAt,
                endsAt: next.endsAt,
                allMonitors: next.allMonitors,
                showOnStatusPage: next.showOnStatusPage,
              })
              .where(eq(maintenanceWindows.id, row.id))
              .returning();
            if (body.monitorIds !== undefined || body.allMonitors !== undefined) {
              await tx
                .delete(maintenanceWindowMonitors)
                .where(eq(maintenanceWindowMonitors.windowId, row.id));
              if (next.monitorIds.length)
                await tx
                  .insert(maintenanceWindowMonitors)
                  .values(next.monitorIds.map((monitorId) => ({ windowId: row.id, monitorId })));
            }
            return u!;
          });
          forgetAllStatusPages();
          return present(updated, next.monitorIds);
        },
        { org: "admin", params: Params, body: UpdateMaintenanceSchema },
      )
      // Ends a window that is in progress right now, keeping it in the history. Monitors that are still down then
      // open their incident on the next failed check.
      .post(
        "/:id/end",
        async ({ user, params, orgId }) => {
          const [row] = await db
            .select()
            .from(maintenanceWindows)
            .where(owned(orgId, user.id, params.id));
          if (!row) throw new HttpError(404, "Maintenance window not found");
          const t = now();
          if (maintenancePhase(row, t) !== "active")
            throw new HttpError(409, "Only a window in progress can be ended.");
          const [u] = await db
            .update(maintenanceWindows)
            .set({ endsAt: t })
            .where(eq(maintenanceWindows.id, row.id))
            .returning();
          forgetAllStatusPages();
          return present(u!, (await monitorIdsOf([row.id])).get(row.id) ?? []);
        },
        { org: "admin", params: Params },
      )
      .delete(
        "/:id",
        async ({ user, params, orgId, set }) => {
          const [row] = await db
            .select()
            .from(maintenanceWindows)
            .where(owned(orgId, user.id, params.id));
          if (!row) throw new HttpError(404, "Maintenance window not found");
          await db.delete(maintenanceWindows).where(eq(maintenanceWindows.id, row.id));
          forgetAllStatusPages();
          set.status = 204;
        },
        { org: "admin", params: Params },
      )
  );
};
