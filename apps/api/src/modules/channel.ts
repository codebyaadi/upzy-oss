import { decryptJson, encryptJson, generateSecret } from "@upzy/crypto";
import { schema, type Db } from "@upzy/db";
import { deliver, type ChannelConfig } from "@upzy/notify";
import { enqueue } from "@upzy/queue";
import { CreateChannelSchema, UpdateChannelSchema } from "@upzy/validator";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { Elysia } from "elysia";
import { z } from "zod";

import { orgWorkspaceIds, requireWorkspace } from "../lib/scope";
import type { AuthPlugin } from "../plugins/auth";
import { HttpError } from "../plugins/errors";

const {
  notificationChannels: channels,
  notificationDeliveries: deliveries,
  incidents,
  findings,
} = schema;
const Params = z.object({ id: z.uuid() });
const ListQuery = z.object({ workspaceId: z.uuid().optional() });

/** Never selects the encrypted config: secrets are not returned after creation. */
const publicColumns = {
  id: channels.id,
  workspaceId: channels.workspaceId,
  name: channels.name,
  kind: channels.kind,
  summary: channels.summary,
  enabled: channels.enabled,
  createdAt: channels.createdAt,
};

const host = (u: string) => new URL(u).host;

export const channelModule = (db: Db, authP: AuthPlugin, encryptionKey: string) => {
  const owned = (orgId: string, userId: string, id: string) =>
    and(eq(channels.id, id), inArray(channels.workspaceId, orgWorkspaceIds(db, orgId, userId)));

  return new Elysia({ prefix: "/channel" })
    .use(authP)
    .post(
      "/",
      async ({ user, body, orgId, set }) => {
        await requireWorkspace(db, orgId, body.workspaceId, user.id);
        let config: Record<string, string>;
        let summary: string;
        let secret: string | undefined;
        switch (body.kind) {
          case "email":
            config = { to: body.to };
            summary = body.to;
            break;
          case "webhook":
            secret = generateSecret();
            config = { url: body.url, secret };
            summary = host(body.url);
            break;
          default:
            config = { url: body.url };
            summary = host(body.url);
        }
        const [row] = await db
          .insert(channels)
          .values({
            workspaceId: body.workspaceId,
            name: body.name,
            kind: body.kind,
            configEncrypted: encryptJson(config, encryptionKey),
            summary,
          })
          .returning(publicColumns);
        set.status = 201;
        // The signing secret is shown exactly once.
        return secret ? { ...row, secret } : row;
      },
      { org: "admin", body: CreateChannelSchema },
    )
    .get(
      "/",
      ({ user, orgId, query }) =>
        db
          .select(publicColumns)
          .from(channels)
          .where(
            and(
              inArray(channels.workspaceId, orgWorkspaceIds(db, orgId, user.id)),
              query.workspaceId ? eq(channels.workspaceId, query.workspaceId) : undefined,
            ),
          )
          .orderBy(desc(channels.createdAt)),
      { org: true, query: ListQuery },
    )
    .patch(
      "/:id",
      async ({ user, params, body, orgId }) => {
        const [row] = await db
          .update(channels)
          .set(body)
          .where(owned(orgId, user.id, params.id))
          .returning(publicColumns);
        if (!row) throw new HttpError(404, "Channel not found");
        return row;
      },
      { org: "admin", params: Params, body: UpdateChannelSchema },
    )
    .delete(
      "/:id",
      async ({ user, params, orgId, set }) => {
        const rows = await db
          .delete(channels)
          .where(owned(orgId, user.id, params.id))
          .returning({ id: channels.id });
        if (rows.length === 0) throw new HttpError(404, "Channel not found");
        set.status = 204;
      },
      { org: "admin", params: Params },
    )
    .post(
      "/:id/test",
      async ({ user, params, orgId, set }) => {
        const [row] = await db
          .select()
          .from(channels)
          .where(owned(orgId, user.id, params.id));
        if (!row) throw new HttpError(404, "Channel not found");
        const config = {
          kind: row.kind,
          ...decryptJson<object>(row.configEncrypted, encryptionKey),
        } as ChannelConfig;

        if (config.kind === "email") {
          // The API has no SMTP access; the worker sends it.
          await enqueue(db, "deliver", { test: true, channelId: row.id });
          set.status = 202;
          return { queued: true };
        }
        try {
          await deliver(config, {
            event: "incident.opened",
            incident: {
              id: "test",
              title: "Test notification from Upzy",
              openedAt: new Date().toISOString(),
              resolvedAt: null,
            },
            monitor: { id: "test", name: "Test monitor", target: "https://example.com" },
            url: "https://upzy.dev",
          });
          return { ok: true };
        } catch (e) {
          set.status = 502;
          return { ok: false, error: e instanceof Error ? e.message : "Delivery failed" };
        }
      },
      { org: "admin", params: Params },
    )
    .get(
      "/:id/deliveries",
      async ({ user, params, orgId }) => {
        const [row] = await db
          .select({ id: channels.id })
          .from(channels)
          .where(owned(orgId, user.id, params.id));
        if (!row) throw new HttpError(404, "Channel not found");
        return db
          .select({
            id: deliveries.id,
            incidentId: deliveries.incidentId,
            findingId: deliveries.findingId,
            subjectTitle: sql<string>`coalesce(${incidents.title}, ${findings.title})`,
            event: deliveries.event,
            status: deliveries.status,
            error: deliveries.error,
            createdAt: deliveries.createdAt,
          })
          .from(deliveries)
          .leftJoin(incidents, eq(incidents.id, deliveries.incidentId))
          .leftJoin(findings, eq(findings.id, deliveries.findingId))
          .where(eq(deliveries.channelId, params.id))
          .orderBy(desc(deliveries.createdAt))
          .limit(50);
      },
      { org: true, params: Params },
    );
};
