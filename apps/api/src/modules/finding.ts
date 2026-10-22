import { schema, type Db } from "@upzy/db";
import { enqueue } from "@upzy/queue";
import { describeStack, fixFor, hostOfTarget, UNKNOWN_STACK, type Stack } from "@upzy/security";
import { UpdateFindingSchema } from "@upzy/validator";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { Elysia } from "elysia";
import { z } from "zod";

import { orgWorkspaceIds } from "../lib/scope";
import type { AuthPlugin } from "../plugins/auth";
import { HttpError } from "../plugins/errors";

const {
  findings,
  assets,
  notificationDeliveries: deliveries,
  notificationChannels: channels,
} = schema;
const Params = z.object({ id: z.uuid() });
const ListQuery = z.object({
  workspaceId: z.uuid().optional(),
  assetId: z.uuid().optional(),
  status: z.enum(["open", "resolved", "ignored", "all"]).default("open"),
  severity: z.enum(["critical", "high", "medium", "low", "info"]).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
});
const VERIFY_COOLDOWN_MS = 15_000;
const SummaryQuery = z.object({ workspaceId: z.uuid().optional() });

export const findingModule = (db: Db, authP: AuthPlugin) => {
  const inOrg = (orgId: string, userId: string) =>
    inArray(findings.workspaceId, orgWorkspaceIds(db, orgId, userId));

  return (
    new Elysia({ prefix: "/finding" })
      .use(authP)
      .get(
        "/",
        ({ user, orgId, query }) =>
          db
            .select({
              id: findings.id,
              assetId: findings.assetId,
              assetValue: assets.value,
              checkKey: findings.checkKey,
              severity: findings.severity,
              riskScore: findings.riskScore,
              title: findings.title,
              status: findings.status,
              firstSeen: findings.firstSeen,
              lastSeen: findings.lastSeen,
              resolvedAt: findings.resolvedAt,
            })
            .from(findings)
            .innerJoin(assets, eq(assets.id, findings.assetId))
            .where(
              and(
                inOrg(orgId, user.id),
                query.workspaceId ? eq(findings.workspaceId, query.workspaceId) : undefined,
                query.assetId ? eq(findings.assetId, query.assetId) : undefined,
                query.status === "all" ? undefined : eq(findings.status, query.status),
                query.severity ? eq(findings.severity, query.severity) : undefined,
              ),
            )
            .orderBy(desc(findings.riskScore), desc(findings.lastSeen))
            .limit(query.limit),
        { org: true, query: ListQuery },
      )
      // Registered before "/:id" so "summary" is not parsed as an id.
      .get(
        "/summary",
        async ({ user, orgId, query }) => {
          const rows = await db
            .select({ severity: findings.severity, n: sql<number>`count(*)::int` })
            .from(findings)
            .where(
              and(
                inOrg(orgId, user.id),
                eq(findings.status, "open"),
                query.workspaceId ? eq(findings.workspaceId, query.workspaceId) : undefined,
              ),
            )
            .groupBy(findings.severity);
          const bySeverity = { critical: 0, high: 0, medium: 0, low: 0, info: 0 };
          for (const r of rows) bySeverity[r.severity] = r.n;
          return { open: rows.reduce((a, r) => a + r.n, 0), bySeverity };
        },
        { org: true, query: SummaryQuery },
      )
      .get(
        "/:id",
        async ({ user, params, orgId }) => {
          const [row] = await db
            .select({
              finding: findings,
              assetValue: assets.value,
              assetKind: assets.kind,
              assetVerified: assets.verified,
              assetStack: assets.stack,
            })
            .from(findings)
            .innerJoin(assets, eq(assets.id, findings.assetId))
            .where(and(eq(findings.id, params.id), inOrg(orgId, user.id)));
          if (!row) throw new HttpError(404, "Finding not found");
          const sent = await db
            .select({
              id: deliveries.id,
              status: deliveries.status,
              error: deliveries.error,
              createdAt: deliveries.createdAt,
              channelName: channels.name,
              channelKind: channels.kind,
            })
            .from(deliveries)
            .innerJoin(channels, eq(channels.id, deliveries.channelId))
            .where(eq(deliveries.findingId, row.finding.id))
            .orderBy(desc(deliveries.createdAt));
          const stack = (row.assetStack as Stack | null) ?? UNKNOWN_STACK;
          const host =
            (row.assetKind === "url" ? hostOfTarget(row.assetValue) : row.assetValue) ??
            row.assetValue;
          return {
            ...row.finding,
            // Deterministic instructions for the stack we detected; null when there is no template for this check.
            fix: fixFor({
              checkKey: row.finding.checkKey,
              stack,
              host,
              evidence: row.finding.evidence,
            }),
            stackLabel: row.assetStack ? describeStack(stack) : null,
            asset: {
              id: row.finding.assetId,
              value: row.assetValue,
              kind: row.assetKind,
              verified: row.assetVerified,
            },
            deliveries: sent,
          };
        },
        { org: true, params: Params },
      )
      // "Verify fix": re-run just this finding's check now. The worker resolves the finding if the problem is gone.
      .post(
        "/:id/verify",
        async ({ user, params, orgId, set }) => {
          const [f] = await db
            .select({
              id: findings.id,
              status: findings.status,
              last: findings.lastVerifiedAt,
            })
            .from(findings)
            .where(and(eq(findings.id, params.id), inOrg(orgId, user.id)));
          if (!f) throw new HttpError(404, "Finding not found");
          if (f.status !== "open")
            throw new HttpError(409, "Only open findings can be re-checked.");
          if (f.last && Date.now() - f.last.getTime() < VERIFY_COOLDOWN_MS)
            throw new HttpError(429, "Checked a moment ago. Give it a few seconds.");
          await db
            .update(findings)
            .set({ verifyStatus: "pending", verifyError: null })
            .where(eq(findings.id, f.id));
          await enqueue(db, "verify-fix", { findingId: f.id }, { dedupeKey: f.id, maxAttempts: 2 });
          set.status = 202;
          return { status: "pending" as const };
        },
        { org: "member", params: Params },
      )
      .patch(
        "/:id",
        async ({ user, params, body, orgId }) => {
          const [current] = await db
            .select({ status: findings.status })
            .from(findings)
            .where(and(eq(findings.id, params.id), inOrg(orgId, user.id)));
          if (!current) throw new HttpError(404, "Finding not found");
          if (current.status === "resolved")
            throw new HttpError(409, "Resolved findings reopen on their own if the issue returns");
          const [row] = await db
            .update(findings)
            .set({ status: body.status })
            .where(eq(findings.id, params.id))
            .returning({ id: findings.id, status: findings.status });
          return row;
        },
        { org: "member", params: Params, body: UpdateFindingSchema },
      )
  );
};
