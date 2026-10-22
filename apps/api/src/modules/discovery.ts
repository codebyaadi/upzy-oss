import { schema, type Db } from "@upzy/db";
import { enqueue } from "@upzy/queue";
import { DiscoverySelectionSchema } from "@upzy/validator";
import { and, eq, inArray, sql } from "drizzle-orm";
import { Elysia } from "elysia";
import { z } from "zod";

import { createAsset } from "../lib/assets";
import type { Billing } from "../lib/billing";
import { orgWorkspaceIds, requireWorkspace } from "../lib/scope";
import type { AuthPlugin } from "../plugins/auth";
import { HttpError } from "../plugins/errors";

const { discoveredHosts: hosts, assets, aiSettings } = schema;
const ListQuery = z.object({
  workspaceId: z.uuid().optional(),
  status: z.enum(["new", "accepted", "dismissed"]).default("new"),
  limit: z.coerce.number().int().min(1).max(1000).default(500),
});

export const discoveryModule = (db: Db, authP: AuthPlugin, billing: Billing) => {
  const inOrg = (orgId: string, userId: string) =>
    inArray(hosts.workspaceId, orgWorkspaceIds(db, orgId, userId));

  return new Elysia({ prefix: "/discovery" })
    .use(authP)
    .get(
      "/",
      ({ user, orgId, query }) =>
        db
          .select({
            id: hosts.id,
            workspaceId: hosts.workspaceId,
            host: hosts.host,
            status: hosts.status,
            resolves: hosts.resolves,
            source: hosts.source,
            firstSeen: hosts.firstSeen,
            lastSeen: hosts.lastSeen,
            parentAssetId: hosts.parentAssetId,
            parent: assets.value,
            profile: hosts.profile,
            aiClassification: hosts.aiClassification,
            aiStatus: hosts.aiStatus,
            aiError: hosts.aiError,
          })
          .from(hosts)
          .innerJoin(assets, eq(assets.id, hosts.parentAssetId))
          .where(
            and(
              inOrg(orgId, user.id),
              eq(hosts.status, query.status),
              query.workspaceId ? eq(hosts.workspaceId, query.workspaceId) : undefined,
            ),
          )
          // Live hosts first (they are the ones worth scanning), then unknown, then names with no DNS.
          .orderBy(
            sql`case when ${hosts.resolves} then 0 when ${hosts.resolves} is null then 1 else 2 end`,
            hosts.host,
          )
          .limit(query.limit),
      { org: true, query: ListQuery },
    )
    .post(
      "/accept",
      async ({ user, body, orgId }) => {
        const selected = await db
          .select({
            id: hosts.id,
            workspaceId: hosts.workspaceId,
            host: hosts.host,
            status: hosts.status,
          })
          .from(hosts)
          .where(and(inOrg(orgId, user.id), inArray(hosts.id, body.ids)));

        let accepted = 0;
        for (const h of selected) {
          if (h.status === "accepted") continue;
          const [existing] = await db
            .select({ id: assets.id })
            .from(assets)
            .where(and(eq(assets.workspaceId, h.workspaceId), eq(assets.value, h.host)));
          if (!existing) await billing.assertCanCreate(db, orgId, "assets");
          if (!existing)
            await createAsset(db, { workspaceId: h.workspaceId, kind: "subdomain", value: h.host });
          await db.update(hosts).set({ status: "accepted" }).where(eq(hosts.id, h.id));
          accepted++;
        }
        return { accepted, skipped: body.ids.length - accepted };
      },
      { org: "member", body: DiscoverySelectionSchema },
    )
    .post(
      "/classify",
      async ({ user, body, orgId, set }) => {
        await requireWorkspace(db, orgId, body.workspaceId, user.id);
        const [ai] = await db
          .select({ enabled: aiSettings.enabled })
          .from(aiSettings)
          .where(eq(aiSettings.organizationId, orgId));
        if (!ai?.enabled)
          throw new HttpError(403, "AI features are turned off for this organization.");
        const pending = await db
          .update(hosts)
          .set({ aiStatus: "pending", aiError: null })
          .where(
            and(
              eq(hosts.workspaceId, body.workspaceId),
              eq(hosts.status, "new"),
              eq(hosts.resolves, true),
              sql`${hosts.aiClassifiedAt} is null`,
            ),
          )
          .returning({ id: hosts.id });
        if (pending.length === 0) return { queued: 0 };
        await enqueue(
          db,
          "ai",
          { kind: "classify-hosts", workspaceId: body.workspaceId },
          { maxAttempts: 3, dedupeKey: `classify:${body.workspaceId}` },
        );
        set.status = 202;
        return { queued: pending.length };
      },
      { org: "member", body: z.object({ workspaceId: z.uuid() }) },
    )
    .post(
      "/dismiss",
      async ({ user, body, orgId }) => {
        const rows = await db
          .update(hosts)
          .set({ status: "dismissed" })
          .where(and(inOrg(orgId, user.id), inArray(hosts.id, body.ids), eq(hosts.status, "new")))
          .returning({ id: hosts.id });
        return { dismissed: rows.length };
      },
      { org: "member", body: DiscoverySelectionSchema },
    );
};
