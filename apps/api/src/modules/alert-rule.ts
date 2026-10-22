import { schema, type Db } from "@upzy/db";
import { CreateAlertRuleSchema, UpdateAlertRuleSchema } from "@upzy/validator";
import { and, eq, inArray } from "drizzle-orm";
import { Elysia } from "elysia";
import { z } from "zod";

import { orgWorkspaceIds, requireMonitorIn, requireWorkspace } from "../lib/scope";
import type { AuthPlugin } from "../plugins/auth";
import { HttpError } from "../plugins/errors";

const { alertRules: rules, notificationChannels: channels } = schema;
const Params = z.object({ id: z.uuid() });
const ListQuery = z.object({ workspaceId: z.uuid().optional() });

export const alertRuleModule = (db: Db, authP: AuthPlugin) => {
  const owned = (orgId: string, id: string) =>
    and(eq(rules.id, id), inArray(rules.workspaceId, orgWorkspaceIds(db, orgId)));

  return new Elysia({ prefix: "/alert-rule" })
    .use(authP)
    .post(
      "/",
      async ({ body, orgId, set }) => {
        await requireWorkspace(db, orgId, body.workspaceId);
        const [channel] = await db
          .select({ id: channels.id })
          .from(channels)
          .where(and(eq(channels.id, body.channelId), eq(channels.workspaceId, body.workspaceId)));
        if (!channel) throw new HttpError(404, "Channel not found");
        if (body.monitorId) await requireMonitorIn(db, body.workspaceId, body.monitorId);

        const [row] = await db
          .insert(rules)
          .values({
            workspaceId: body.workspaceId,
            channelId: body.channelId,
            monitorId: body.monitorId ?? null,
            events: body.events,
          })
          .returning();
        set.status = 201;
        return row;
      },
      { org: "admin", body: CreateAlertRuleSchema },
    )
    .get(
      "/",
      ({ orgId, query }) =>
        db
          .select()
          .from(rules)
          .where(
            and(
              inArray(rules.workspaceId, orgWorkspaceIds(db, orgId)),
              query.workspaceId ? eq(rules.workspaceId, query.workspaceId) : undefined,
            ),
          ),
      { org: true, query: ListQuery },
    )
    .patch(
      "/:id",
      async ({ params, body, orgId }) => {
        const [row] = await db.update(rules).set(body).where(owned(orgId, params.id)).returning();
        if (!row) throw new HttpError(404, "Alert rule not found");
        return row;
      },
      { org: "admin", params: Params, body: UpdateAlertRuleSchema },
    )
    .delete(
      "/:id",
      async ({ params, orgId, set }) => {
        const deleted = await db
          .delete(rules)
          .where(owned(orgId, params.id))
          .returning({ id: rules.id });
        if (deleted.length === 0) throw new HttpError(404, "Alert rule not found");
        set.status = 204;
      },
      { org: "admin", params: Params },
    );
};
