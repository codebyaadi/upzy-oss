import { schema, similarIncidents, type Db } from "@upzy/db";
import { enqueue } from "@upzy/queue";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { Elysia } from "elysia";
import { z } from "zod";

import { orgWorkspaceIds } from "../lib/scope";
import { forgetAllStatusPages } from "../lib/status-cache";
import type { AuthPlugin } from "../plugins/auth";
import { HttpError } from "../plugins/errors";

const {
  incidents,
  monitors,
  monitorChecks,
  aiSettings,
  postmortems,
  incidentUpdates,
  incidentGroups,
  notificationDeliveries: deliveries,
  notificationChannels: channels,
} = schema;
const Params = z.object({ id: z.uuid() });
const Line = z.string().trim().min(1).max(600);
const PostmortemBody = z.object({
  customerUpdate: z.string().trim().max(1500),
  summary: z.string().trim().max(2000),
  impact: z.string().trim().max(2000),
  rootCause: z.string().trim().max(2000),
  timeline: z.array(z.object({ at: z.string().max(40), event: Line })).max(40),
  contributingFactors: z.array(Line).max(10),
  whatWentWell: z.array(Line).max(10),
  actionItems: z
    .array(
      z.object({ title: z.string().trim().min(1).max(200), detail: z.string().trim().max(800) }),
    )
    .max(15),
});
const UpdateBody = z.object({
  status: z.enum(incidentUpdates.status.enumValues),
  message: z.string().trim().min(1).max(2000),
});
const DraftBody = z
  .object({ notes: z.string().trim().max(2000).optional(), replace: z.boolean().optional() })
  .optional();
const ListQuery = z.object({
  workspaceId: z.uuid().optional(),
  monitorId: z.uuid().optional(),
  status: z.enum(["open", "acknowledged", "resolved", "active"]).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

export const incidentModule = (db: Db, authP: AuthPlugin) => {
  const owned = (orgId: string, userId: string, id: string) =>
    and(eq(incidents.id, id), inArray(incidents.workspaceId, orgWorkspaceIds(db, orgId, userId)));

  return (
    new Elysia({ prefix: "/incident" })
      .use(authP)
      .get(
        "/",
        ({ user, orgId, query }) =>
          db
            .select({
              id: incidents.id,
              workspaceId: incidents.workspaceId,
              monitorId: incidents.monitorId,
              monitorName: monitors.name,
              title: incidents.title,
              status: incidents.status,
              createdAt: incidents.createdAt,
              resolvedAt: incidents.resolvedAt,
              groupId: incidents.groupId,
            })
            .from(incidents)
            .leftJoin(monitors, eq(monitors.id, incidents.monitorId))
            .where(
              and(
                inArray(incidents.workspaceId, orgWorkspaceIds(db, orgId, user.id)),
                query.workspaceId ? eq(incidents.workspaceId, query.workspaceId) : undefined,
                query.monitorId ? eq(incidents.monitorId, query.monitorId) : undefined,
                query.status === "active"
                  ? inArray(incidents.status, ["open", "acknowledged"])
                  : query.status
                    ? eq(incidents.status, query.status)
                    : undefined,
              ),
            )
            .orderBy(desc(incidents.createdAt))
            .limit(query.limit),
        { org: true, query: ListQuery },
      )
      .get(
        "/group/:id",
        async ({ user, params, orgId }) => {
          const [g] = await db
            .select()
            .from(incidentGroups)
            .where(
              and(
                eq(incidentGroups.id, params.id),
                inArray(incidentGroups.workspaceId, orgWorkspaceIds(db, orgId, user.id)),
              ),
            );
          if (!g) throw new HttpError(404, "Group not found");
          const members = await db
            .select({
              id: incidents.id,
              title: incidents.title,
              status: incidents.status,
              createdAt: incidents.createdAt,
              resolvedAt: incidents.resolvedAt,
              monitorId: incidents.monitorId,
              monitorName: monitors.name,
            })
            .from(incidents)
            .leftJoin(monitors, eq(monitors.id, incidents.monitorId))
            .where(eq(incidents.groupId, g.id))
            .orderBy(incidents.createdAt);
          return { ...g, members };
        },
        { org: true, params: Params },
      )
      .post(
        "/group/:id/summary",
        async ({ user, params, orgId, set }) => {
          const [g] = await db
            .select({ id: incidentGroups.id, status: incidentGroups.summaryStatus })
            .from(incidentGroups)
            .where(
              and(
                eq(incidentGroups.id, params.id),
                inArray(incidentGroups.workspaceId, orgWorkspaceIds(db, orgId, user.id)),
              ),
            );
          if (!g) throw new HttpError(404, "Group not found");
          const [ai] = await db
            .select({ enabled: aiSettings.enabled })
            .from(aiSettings)
            .where(eq(aiSettings.organizationId, orgId));
          if (!ai?.enabled)
            throw new HttpError(403, "AI features are turned off for this organization.");
          if (g.status === "pending") return { status: "pending" as const };
          await db
            .update(incidentGroups)
            .set({ summaryStatus: "pending", summaryError: null })
            .where(eq(incidentGroups.id, g.id));
          await enqueue(
            db,
            "ai",
            { kind: "group-summary", groupId: g.id },
            { maxAttempts: 3, dedupeKey: `group:${g.id}:manual` },
          );
          set.status = 202;
          return { status: "pending" as const };
        },
        { org: "member", params: Params },
      )
      .get(
        "/:id/similar",
        async ({ user, params, orgId }) => {
          const [found] = await db
            .select({ id: incidents.id })
            .from(incidents)
            .where(owned(orgId, user.id, params.id));
          if (!found) throw new HttpError(404, "Incident not found");
          return similarIncidents(db, found.id);
        },
        { org: true, params: Params },
      )
      .get(
        "/:id",
        async ({ user, params, orgId }) => {
          const [incident] = await db
            .select()
            .from(incidents)
            .where(owned(orgId, user.id, params.id));
          if (!incident) throw new HttpError(404, "Incident not found");

          const [monitor] = incident.monitorId
            ? await db
                .select({
                  id: monitors.id,
                  name: monitors.name,
                  target: monitors.target,
                  type: monitors.type,
                })
                .from(monitors)
                .where(eq(monitors.id, incident.monitorId))
            : [];
          const sent = await db
            .select({
              id: deliveries.id,
              event: deliveries.event,
              status: deliveries.status,
              error: deliveries.error,
              createdAt: deliveries.createdAt,
              channelName: channels.name,
              channelKind: channels.kind,
            })
            .from(deliveries)
            .innerJoin(channels, eq(channels.id, deliveries.channelId))
            .where(eq(deliveries.incidentId, incident.id))
            .orderBy(deliveries.createdAt);
          // Failing checks from the incident window: the evidence behind "why".
          const checks = incident.monitorId
            ? await db
                .select()
                .from(monitorChecks)
                .where(eq(monitorChecks.monitorId, incident.monitorId))
                .orderBy(desc(monitorChecks.createdAt))
                .limit(10)
            : [];

          const [grp] = incident.groupId
            ? await db
                .select({ id: incidentGroups.id, sharedKey: incidentGroups.sharedKey })
                .from(incidentGroups)
                .where(eq(incidentGroups.id, incident.groupId))
            : [];
          const [size] = grp
            ? await db
                .select({ n: sql<number>`count(*)::int` })
                .from(incidents)
                .where(eq(incidents.groupId, grp.id))
            : [];
          const group = grp ? { ...grp, size: size?.n ?? 1 } : null;

          const updates = await db
            .select({
              id: incidentUpdates.id,
              status: incidentUpdates.status,
              message: incidentUpdates.message,
              createdAt: incidentUpdates.createdAt,
            })
            .from(incidentUpdates)
            .where(eq(incidentUpdates.incidentId, incident.id))
            .orderBy(desc(incidentUpdates.createdAt));

          return {
            ...incident,
            monitor: monitor ?? null,
            updates,
            deliveries: sent,
            recentChecks: checks,
            group,
          };
        },
        { org: true, params: Params },
      )
      // Customer-facing messages. They appear on any public status page that lists this incident's monitor.
      .post(
        "/:id/updates",
        async ({ params, body, orgId, user, set }) => {
          const [inc] = await db
            .select({ id: incidents.id })
            .from(incidents)
            .where(owned(orgId, user.id, params.id));
          if (!inc) throw new HttpError(404, "Incident not found");
          const [row] = await db
            .insert(incidentUpdates)
            .values({
              incidentId: inc.id,
              status: body.status,
              message: body.message,
              createdBy: user.id,
            })
            .returning({
              id: incidentUpdates.id,
              status: incidentUpdates.status,
              message: incidentUpdates.message,
              createdAt: incidentUpdates.createdAt,
            });
          forgetAllStatusPages();
          set.status = 201;
          return row!;
        },
        { org: "member", params: Params, body: UpdateBody },
      )
      .delete(
        "/:id/updates/:updateId",
        async ({ user, params, orgId }) => {
          const [inc] = await db
            .select({ id: incidents.id })
            .from(incidents)
            .where(owned(orgId, user.id, params.id));
          if (!inc) throw new HttpError(404, "Incident not found");
          const gone = await db
            .delete(incidentUpdates)
            .where(
              and(eq(incidentUpdates.id, params.updateId), eq(incidentUpdates.incidentId, inc.id)),
            )
            .returning({ id: incidentUpdates.id });
          if (gone.length === 0) throw new HttpError(404, "Update not found");
          forgetAllStatusPages();
          return { ok: true };
        },
        { org: "member", params: z.object({ id: z.uuid(), updateId: z.uuid() }) },
      )
      .post(
        "/:id/triage",
        async ({ user, params, orgId, set }) => {
          const [row] = await db
            .select({
              id: incidents.id,
              monitorId: incidents.monitorId,
              status: incidents.aiTriageStatus,
            })
            .from(incidents)
            .where(owned(orgId, user.id, params.id));
          if (!row) throw new HttpError(404, "Incident not found");
          if (!row.monitorId)
            throw new HttpError(
              409,
              "This incident has no monitor, so there is nothing to analyse.",
            );
          const [ai] = await db
            .select({ enabled: aiSettings.enabled })
            .from(aiSettings)
            .where(eq(aiSettings.organizationId, orgId));
          if (!ai?.enabled)
            throw new HttpError(403, "AI features are turned off for this organization.");
          if (row.status === "pending") return { status: "pending" as const };
          await db
            .update(incidents)
            .set({ aiTriageStatus: "pending", aiTriageError: null })
            .where(eq(incidents.id, row.id));
          await enqueue(
            db,
            "ai",
            { kind: "triage-incident", incidentId: row.id },
            { maxAttempts: 3, dedupeKey: `triage:${row.id}` },
          );
          set.status = 202;
          return { status: "pending" as const };
        },
        { org: "member", params: Params },
      )
      .get(
        "/:id/postmortem",
        async ({ user, params, orgId }) => {
          const [inc] = await db
            .select({ id: incidents.id })
            .from(incidents)
            .where(owned(orgId, user.id, params.id));
          if (!inc) throw new HttpError(404, "Incident not found");
          const [row] = await db
            .select()
            .from(postmortems)
            .where(eq(postmortems.incidentId, inc.id));
          return (
            row ?? {
              incidentId: inc.id,
              content: null,
              aiGenerated: false,
              model: null,
              status: null,
              error: null,
              editedBy: null,
              updatedAt: null,
            }
          );
        },
        { org: true, params: Params },
      )
      .post(
        "/:id/postmortem",
        async ({ user, params, body, orgId, set }) => {
          const [inc] = await db
            .select({ id: incidents.id, status: incidents.status, monitorId: incidents.monitorId })
            .from(incidents)
            .where(owned(orgId, user.id, params.id));
          if (!inc) throw new HttpError(404, "Incident not found");
          if (inc.status !== "resolved" || !inc.monitorId)
            throw new HttpError(409, "A postmortem can be drafted once the incident is resolved.");
          const [ai] = await db
            .select({ enabled: aiSettings.enabled })
            .from(aiSettings)
            .where(eq(aiSettings.organizationId, orgId));
          if (!ai?.enabled)
            throw new HttpError(403, "AI features are turned off for this organization.");
          const [existing] = await db
            .select()
            .from(postmortems)
            .where(eq(postmortems.incidentId, inc.id));
          if (existing?.status === "pending") return { status: "pending" as const };
          if (existing?.content && !existing.aiGenerated && !body?.replace)
            throw new HttpError(
              409,
              "This postmortem has been edited by hand. Drafting again would replace your changes.",
            );
          await db
            .insert(postmortems)
            .values({ incidentId: inc.id, status: "pending" })
            .onConflictDoUpdate({
              target: postmortems.incidentId,
              set: { status: "pending", error: null, updatedAt: new Date() },
            });
          await enqueue(
            db,
            "ai",
            {
              kind: "postmortem",
              incidentId: inc.id,
              ...(body?.notes ? { notes: body.notes } : {}),
            },
            { maxAttempts: 3, dedupeKey: `postmortem:${inc.id}` },
          );
          set.status = 202;
          return { status: "pending" as const };
        },
        { org: "member", params: Params, body: DraftBody },
      )
      .put(
        "/:id/postmortem",
        async ({ params, body, orgId, user }) => {
          const [inc] = await db
            .select({ id: incidents.id, status: incidents.status })
            .from(incidents)
            .where(owned(orgId, user.id, params.id));
          if (!inc) throw new HttpError(404, "Incident not found");
          if (inc.status !== "resolved")
            throw new HttpError(409, "A postmortem can be written once the incident is resolved.");
          const row = {
            content: body,
            aiGenerated: false,
            editedBy: user.id,
            status: null,
            error: null,
            updatedAt: new Date(),
          };
          await db
            .insert(postmortems)
            .values({ incidentId: inc.id, ...row })
            .onConflictDoUpdate({ target: postmortems.incidentId, set: row });
          return { ok: true as const };
        },
        { org: "member", params: Params, body: PostmortemBody },
      )
      .patch(
        "/:id/acknowledge",
        async ({ user, params, orgId }) => {
          const [row] = await db
            .update(incidents)
            .set({ status: "acknowledged" })
            .where(and(owned(orgId, user.id, params.id), eq(incidents.status, "open")))
            .returning();
          if (!row) throw new HttpError(409, "Only open incidents can be acknowledged");
          return row;
        },
        { org: "member", params: Params },
      )
  );
};
