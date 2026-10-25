import { schema, type Db } from "@upzy/db";
import {
  describeStack,
  dnsRecordValue,
  headersBundle,
  healthFor,
  healthHistory,
  hostOfTarget,
  UNKNOWN_STACK,
  verifyOwnership,
  wellKnownPath,
  type Stack,
} from "@upzy/security";
import { CreateAssetSchema } from "@upzy/validator";
import { and, desc, eq, inArray, like, sql } from "drizzle-orm";
import { Elysia } from "elysia";
import { z } from "zod";

import { createAsset } from "../lib/assets";
import type { Billing } from "../lib/billing";
import { orgWorkspaceIds, requireWorkspace } from "../lib/scope";
import type { AuthPlugin } from "../plugins/auth";
import { HttpError } from "../plugins/errors";

const { assets, findings, scans, discoveredHosts } = schema;
const Params = z.object({ id: z.uuid() });
const ListQuery = z.object({ workspaceId: z.uuid().optional() });
const SCAN_COOLDOWN_MS = 5 * 60_000;
const DISCOVERY_COOLDOWN_MS = 60 * 60_000;

const publicColumns = {
  id: assets.id,
  workspaceId: assets.workspaceId,
  kind: assets.kind,
  value: assets.value,
  source: assets.source,
  verified: assets.verified,
  verifiedAt: assets.verifiedAt,
  verificationLostAt: assets.verificationLostAt,
  lastScanAt: assets.lastScanAt,
  lastDiscoveryAt: assets.lastDiscoveryAt,
  discoveryError: assets.discoveryError,
  stack: assets.stack,
  createdAt: assets.createdAt,
};

const instructions = (token: string) => ({
  dns: { type: "TXT", name: "@ (or _upzy)", value: dnsRecordValue(token) },
  file: { path: wellKnownPath, content: token },
});

export const assetModule = (db: Db, authP: AuthPlugin, billing: Billing) => {
  const owned = (orgId: string, userId: string, id: string) =>
    and(eq(assets.id, id), inArray(assets.workspaceId, orgWorkspaceIds(db, orgId, userId)));

  async function getOwned(orgId: string, userId: string, id: string) {
    const [row] = await db
      .select()
      .from(assets)
      .where(owned(orgId, userId, id));
    if (!row) throw new HttpError(404, "Asset not found");
    return row;
  }

  return (
    new Elysia({ prefix: "/asset" })
      .use(authP)
      .post(
        "/",
        async ({ user, body, orgId, set }) => {
          await requireWorkspace(db, orgId, body.workspaceId, user.id);
          await billing.assertCanCreate(db, orgId, "assets");
          const { row, token } = await createAsset(db, body);
          set.status = 201;
          return { ...row, verification: instructions(token) };
        },
        { org: "member", body: CreateAssetSchema },
      )
      .get(
        "/",
        async ({ user, orgId, query }) => {
          const rows = await db
            .select(publicColumns)
            .from(assets)
            .where(
              and(
                inArray(assets.workspaceId, orgWorkspaceIds(db, orgId, user.id)),
                query.workspaceId ? eq(assets.workspaceId, query.workspaceId) : undefined,
              ),
            )
            .orderBy(desc(assets.createdAt));
          if (rows.length === 0) return [];

          const counts = await db
            .select({
              assetId: findings.assetId,
              severity: findings.severity,
              n: sql<number>`count(*)::int`,
            })
            .from(findings)
            .where(
              and(
                inArray(
                  findings.assetId,
                  rows.map((r) => r.id),
                ),
                eq(findings.status, "open"),
              ),
            )
            .groupBy(findings.assetId, findings.severity);
          const suggestions = await db
            .select({ parentAssetId: discoveredHosts.parentAssetId, n: sql<number>`count(*)::int` })
            .from(discoveredHosts)
            .where(
              and(
                inArray(
                  discoveredHosts.parentAssetId,
                  rows.map((r) => r.id),
                ),
                eq(discoveredHosts.status, "new"),
              ),
            )
            .groupBy(discoveredHosts.parentAssetId);
          const health = await healthFor(
            db,
            rows.map((r) => r.id),
          );
          return rows.map((r) => ({
            ...r,
            health: health.get(r.id) ?? null,
            stackLabel: r.stack ? describeStack(r.stack as Stack) : null,
            newDiscoveries: suggestions.find((x) => x.parentAssetId === r.id)?.n ?? 0,
            openFindings: Object.fromEntries(
              counts.filter((c) => c.assetId === r.id).map((c) => [c.severity, c.n]),
            ) as Partial<Record<"critical" | "high" | "medium" | "low" | "info", number>>,
          }));
        },
        { org: true, query: ListQuery },
      )
      .get(
        "/:id",
        async ({ user, params, orgId }) => {
          const row = await getOwned(orgId, user.id, params.id);
          const [lastScan] = await db
            .select()
            .from(scans)
            .where(eq(scans.assetId, row.id))
            .orderBy(desc(scans.startedAt))
            .limit(1);
          const { verificationToken, nextScanAt: _n, ...rest } = row;
          return {
            ...rest,
            verification: row.verified ? null : instructions(verificationToken),
            lastScan: lastScan ?? null,
          };
        },
        { org: true, params: Params },
      )
      // The grade with its breakdown and trend, plus one snippet that fixes every missing header at once.
      .get(
        "/:id/health",
        async ({ user, params, orgId }) => {
          const row = await getOwned(orgId, user.id, params.id);
          const health = (await healthFor(db, [row.id])).get(row.id) ?? null;
          const open = await db
            .select({ checkKey: findings.checkKey })
            .from(findings)
            .where(and(eq(findings.assetId, row.id), eq(findings.status, "open")));
          const stack = (row.stack as Stack | null) ?? UNKNOWN_STACK;
          const host = (row.kind === "url" ? hostOfTarget(row.value) : row.value) ?? row.value;
          return {
            health,
            history: await healthHistory(db, row.id),
            stackLabel: row.stack ? describeStack(stack) : null,
            headersFix: headersBundle(
              stack,
              host,
              open.map((f) => f.checkKey),
            ),
          };
        },
        { org: true, params: Params },
      )
      .post(
        "/:id/verify",
        async ({ user, params, orgId }) => {
          const row = await getOwned(orgId, user.id, params.id);
          if (row.verified) return { verified: true };
          const result = await verifyOwnership(
            { kind: row.kind, value: row.value },
            row.verificationToken,
          );
          if (!result.verified) return { verified: false, checked: ["dns", "file"] };

          await db
            .update(assets)
            .set({
              verified: true,
              verifiedAt: new Date(),
              verifyFailures: 0,
              verificationLostAt: null,
              verifyNextAt: sql`now() + interval '7 days'`,
            })
            .where(eq(assets.id, row.id));
          if (row.kind === "domain") {
            // Subdomains of a verified domain are covered too.
            await db
              .update(assets)
              .set({
                verified: true,
                verifiedAt: new Date(),
                verifyFailures: 0,
                verificationLostAt: null,
                verifyNextAt: sql`now() + interval '7 days'`,
              })
              .where(
                and(
                  eq(assets.workspaceId, row.workspaceId),
                  eq(assets.kind, "subdomain"),
                  eq(assets.verified, false),
                  like(assets.value, `%.${row.value}`),
                ),
              );
          }
          return { verified: true, method: result.method };
        },
        { org: "member", params: Params },
      )
      .post(
        "/:id/scan",
        async ({ user, params, orgId, set }) => {
          const row = await getOwned(orgId, user.id, params.id);
          if (row.lastScanAt && Date.now() - row.lastScanAt.getTime() < SCAN_COOLDOWN_MS) {
            set.status = 429;
            return { message: "This asset was scanned a moment ago. Try again in a few minutes." };
          }
          await db.update(assets).set({ nextScanAt: new Date() }).where(eq(assets.id, row.id));
          set.status = 202;
          return { queued: true };
        },
        { org: "member", params: Params },
      )
      .post(
        "/:id/discover",
        async ({ user, params, orgId, set }) => {
          const row = await getOwned(orgId, user.id, params.id);
          if (row.kind !== "domain")
            throw new HttpError(400, "Subdomain discovery runs on domains");
          if (
            row.lastDiscoveryAt &&
            Date.now() - row.lastDiscoveryAt.getTime() < DISCOVERY_COOLDOWN_MS
          ) {
            set.status = 429;
            return { message: "Subdomains were looked up recently. Try again in an hour." };
          }
          await db.update(assets).set({ nextDiscoveryAt: new Date() }).where(eq(assets.id, row.id));
          set.status = 202;
          return { queued: true };
        },
        { org: "member", params: Params },
      )
      .delete(
        "/:id",
        async ({ user, params, orgId, set }) => {
          const rows = await db
            .delete(assets)
            .where(owned(orgId, user.id, params.id))
            .returning({ id: assets.id });
          if (rows.length === 0) throw new HttpError(404, "Asset not found");
          set.status = 204;
        },
        { org: "member", params: Params },
      )
  );
};
