import { validReportUnsubscribeToken } from "@upzy/auth/unsubscribe";
import { PLANS } from "@upzy/billing";
import { schema, type Db } from "@upzy/db";
import { enqueue } from "@upzy/queue";
import { and, asc, eq, notInArray } from "drizzle-orm";
import { Elysia } from "elysia";
import { z } from "zod";

import type { Billing } from "../lib/billing";
import { requireWorkspace } from "../lib/scope";
import type { AuthPlugin } from "../plugins/auth";
import { HttpError } from "../plugins/errors";

const { reportSchedules, reportRecipients } = schema;

/** The worker's report queue (apps/worker/src/roles/reports.ts). */
const REPORT_QUEUE = "report";
const MAX_RECIPIENTS = 10;

const Query = z.object({ workspaceId: z.uuid() });
const Body = z.object({
  workspaceId: z.uuid(),
  enabled: z.boolean(),
  frequency: z.enum(["weekly", "monthly"]),
  recipients: z
    .array(z.email().max(254))
    .max(MAX_RECIPIENTS, `At most ${MAX_RECIPIENTS} recipients`),
});

const page = (title: string, body: string) =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${title}</title></head><body style="font-family:system-ui,sans-serif;max-width:32rem;margin:4rem auto;padding:0 1rem;line-height:1.5"><h1 style="font-size:1.25rem">${title}</h1><p>${body}</p></body></html>`;

/**
 * Scheduled reports an agency sends its clients. Admins set the schedule and who gets it; every recipient can opt out
 * with one click, and an address that opted out stays opted out even if an admin lists it again. The reports
 * themselves are built and sent by the worker.
 */
export const reportsModule = (
  db: Db,
  authP: AuthPlugin,
  billing: Billing,
  deps: { secret: string },
) => {
  async function assertPlan(orgId: string) {
    const { ent } = await billing.entitlementFor(db, orgId);
    if (!PLANS[ent.plan].limits.clientReports)
      throw new HttpError(
        402,
        `Scheduled client reports aren't included in the ${PLANS[ent.plan].name} plan. Upgrade to Agency under Settings → Billing.`,
      );
  }

  return (
    new Elysia({ prefix: "/reports" })
      .use(authP)
      // Public: the link in a report email.
      .get(
        "/unsubscribe",
        async ({ query, set }) => {
          set.headers["content-type"] = "text/html; charset=utf-8";
          if (!validReportUnsubscribeToken(deps.secret, query.w, query.e, query.t)) {
            set.status = 400;
            return page("This link isn't valid", "It may have been copied incorrectly.");
          }
          await db
            .update(reportRecipients)
            .set({ unsubscribedAt: new Date() })
            .where(
              and(
                eq(reportRecipients.workspaceId, query.w),
                eq(reportRecipients.email, query.e.trim().toLowerCase()),
              ),
            );
          return page(
            "You're unsubscribed",
            "You won't get this report any more. Tell whoever sends it to you if you change your mind.",
          );
        },
        {
          query: z.object({
            w: z.string().min(1).max(64),
            e: z.string().min(3).max(254),
            t: z.string().min(1).max(128),
          }),
        },
      )
      .get(
        "/",
        async ({ query, orgId, user }) => {
          await requireWorkspace(db, orgId, query.workspaceId, user.id);
          const [schedule] = await db
            .select()
            .from(reportSchedules)
            .where(eq(reportSchedules.workspaceId, query.workspaceId));
          const people = await db
            .select({
              email: reportRecipients.email,
              unsubscribed: reportRecipients.unsubscribedAt,
            })
            .from(reportRecipients)
            .where(eq(reportRecipients.workspaceId, query.workspaceId))
            .orderBy(asc(reportRecipients.createdAt));
          const { ent } = await billing.entitlementFor(db, orgId);
          return {
            enabled: schedule?.enabled ?? false,
            frequency: schedule?.frequency ?? ("monthly" as const),
            lastSentPeriod: schedule?.lastSentPeriod ?? null,
            recipients: people.map((p) => ({ email: p.email, unsubscribed: !!p.unsubscribed })),
            available: PLANS[ent.plan].limits.clientReports,
            maxRecipients: MAX_RECIPIENTS,
          };
        },
        { org: "admin", query: Query },
      )
      .put(
        "/",
        async ({ body, orgId, user }) => {
          await requireWorkspace(db, orgId, body.workspaceId, user.id);
          if (body.enabled) await assertPlan(orgId);
          const emails = [...new Set(body.recipients.map((e) => e.trim().toLowerCase()))];
          if (body.enabled && emails.length === 0)
            throw new HttpError(422, "Add at least one recipient to turn reports on.");

          await db.transaction(async (tx) => {
            await tx
              .insert(reportSchedules)
              .values({
                workspaceId: body.workspaceId,
                enabled: body.enabled,
                frequency: body.frequency,
              })
              .onConflictDoUpdate({
                target: reportSchedules.workspaceId,
                set: { enabled: body.enabled, frequency: body.frequency, updatedAt: new Date() },
              });
            // Dropped addresses go; kept ones keep their opt-out; new ones are added.
            await tx
              .delete(reportRecipients)
              .where(
                and(
                  eq(reportRecipients.workspaceId, body.workspaceId),
                  emails.length ? notInArray(reportRecipients.email, emails) : undefined,
                ),
              );
            if (emails.length)
              await tx
                .insert(reportRecipients)
                .values(emails.map((email) => ({ workspaceId: body.workspaceId, email })))
                .onConflictDoNothing();
          });
          return { ok: true as const };
        },
        { org: "admin", body: Body },
      )
      // Sends the most recent finished period's report to the person asking, so they can see what clients will get.
      .post(
        "/test",
        async ({ body, orgId, user }) => {
          await requireWorkspace(db, orgId, body.workspaceId, user.id);
          await assertPlan(orgId);
          const id = await enqueue(
            db,
            REPORT_QUEUE,
            { kind: "test", workspaceId: body.workspaceId, to: user.email },
            { maxAttempts: 2, dedupeKey: `report-test:${body.workspaceId}:${user.id}` },
          );
          if (!id) throw new HttpError(409, "A test report is already on its way.");
          return { to: user.email };
        },
        { org: "admin", body: Query },
      )
  );
};
