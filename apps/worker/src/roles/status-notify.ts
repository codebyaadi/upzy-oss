import { EMAIL_QUEUE, emails } from "@upzy/auth/email";
import { schema, type Db } from "@upzy/db";
import { enqueue } from "@upzy/queue";
import { and, eq, isNotNull } from "drizzle-orm";

export const STATUS_NOTIFY_QUEUE = "status-notify";

export type StatusNotifyJob =
  | { kind: "opened" | "resolved"; incidentId: string }
  | { kind: "update"; incidentId: string; updateId: string };

const STAGE = {
  investigating: "Investigating",
  identified: "Identified",
  monitoring: "Monitoring",
  update: "Update",
} as const;

/**
 * Emails the confirmed subscribers of every published status page that lists the incident's monitor. What goes out
 * is what the page itself would show: the public name, never the incident title or error text, plus the message a
 * person wrote for customers.
 */
export async function notifySubscribers(db: Db, appUrl: string, job: StatusNotifyJob) {
  const { incidents, statusPages, statusPageMonitors, statusSubscribers, incidentUpdates } = schema;
  const [incident] = await db.select().from(incidents).where(eq(incidents.id, job.incidentId));
  if (!incident?.monitorId) return 0;

  let update: { status: keyof typeof STAGE; message: string } | undefined;
  if (job.kind === "update") {
    [update] = await db
      .select({ status: incidentUpdates.status, message: incidentUpdates.message })
      .from(incidentUpdates)
      .where(eq(incidentUpdates.id, job.updateId));
    if (!update) return 0; // removed again before it went out
  }

  const pages = await db
    .select({
      id: statusPages.id,
      slug: statusPages.slug,
      title: statusPages.title,
      customDomain: statusPages.customDomain,
      verified: statusPages.domainVerifiedAt,
      name: statusPageMonitors.displayName,
    })
    .from(statusPageMonitors)
    .innerJoin(statusPages, eq(statusPages.id, statusPageMonitors.pageId))
    .where(
      and(eq(statusPageMonitors.monitorId, incident.monitorId), eq(statusPages.published, true)),
    );

  let queued = 0;
  for (const page of pages) {
    const subscribers = await db
      .select({
        id: statusSubscribers.id,
        email: statusSubscribers.email,
        token: statusSubscribers.token,
      })
      .from(statusSubscribers)
      .where(and(eq(statusSubscribers.pageId, page.id), isNotNull(statusSubscribers.confirmedAt)));
    const pageUrl =
      page.customDomain && page.verified
        ? `https://${page.customDomain}`
        : `${appUrl}/status/${page.slug}`;
    const headline =
      job.kind === "opened"
        ? `${page.name} is having problems`
        : job.kind === "resolved"
          ? `${page.name} is back to normal`
          : `${page.name}: ${STAGE[update!.status]}`;
    for (const s of subscribers) {
      await enqueue(
        db,
        EMAIL_QUEUE,
        emails.statusNotice({
          to: s.email,
          page: page.title,
          headline,
          ...(update ? { stage: STAGE[update.status], message: update.message } : {}),
          pageUrl,
          unsubscribeUrl: `${appUrl}/subscription/${s.token}`,
        }),
        {
          maxAttempts: 5,
          dedupeKey: `status:${s.id}:${job.incidentId}:${job.kind}:${"updateId" in job ? job.updateId : ""}`,
        },
      );
      queued++;
    }
  }
  return queued;
}
