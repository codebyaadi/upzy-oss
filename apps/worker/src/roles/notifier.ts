import { EMAIL_QUEUE, type Email } from "@upzy/auth/email";
import { decryptJson } from "@upzy/crypto";
import { schema, type Db } from "@upzy/db";
import {
  deliver,
  type ChannelConfig,
  type EmailSender,
  type IncidentEventName,
  type Notification,
} from "@upzy/notify";
import { enqueue, work, type Job } from "@upzy/queue";
import { renderHtml, type TemplateName } from "@upzy/transactional";
import { and, eq, isNull, or } from "drizzle-orm";
import nodemailer from "nodemailer";

import { notifySubscribers, STATUS_NOTIFY_QUEUE, type StatusNotifyJob } from "./status-notify";

export const NOTIFY_QUEUE = "notify";
export const DELIVER_QUEUE = "deliver";

export interface IncidentNotifyJob {
  incidentId: string;
  event: IncidentEventName;
}
/** Fired for a new (or regressed) critical/high finding. `occurrence` is the scan that surfaced it. */
export interface FindingNotifyJob {
  findingId: string;
  event: "finding.opened";
  occurrence: string;
}
export type NotifyJob = IncidentNotifyJob | FindingNotifyJob;
export type DeliverJob = NotifyJob & { channelId: string };
/** Sample notification triggered from the API; no incident or delivery row involved. */
export interface TestDeliverJob {
  test: true;
  channelId: string;
}

export interface NotifierEnv {
  encryptionKey: string;
  appUrl: string;
  smtpUrl?: string;
  /** Sends through Resend's API instead of SMTP when set. */
  resendApiKey?: string;
  mailFrom: string;
}

type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

/** Resend: https://resend.com/docs/api-reference/emails/send-email. The key is the only credential. */
export function resendSender(apiKey: string, from: string, fetchImpl: Fetch = fetch): EmailSender {
  return async (m) => {
    const res = await fetchImpl("https://api.resend.com/emails", {
      method: "POST",
      headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({
        from,
        to: [m.to],
        subject: m.subject,
        text: m.text,
        ...(m.html ? { html: m.html } : {}),
        ...(m.headers ? { headers: m.headers } : {}),
      }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
      const detail = (await res.text().catch(() => "")).slice(0, 300);
      throw new Error(`Resend refused the email (${res.status}) ${detail}`.trim());
    }
  };
}

/** Resend when RESEND_API_KEY is set, else SMTP (SMTP_URL), else nothing: email is off. */
export function makeEmailSender(env: NotifierEnv): EmailSender | undefined {
  if (env.resendApiKey) return resendSender(env.resendApiKey, env.mailFrom);
  if (!env.smtpUrl) return undefined;
  const transport = nodemailer.createTransport(env.smtpUrl);
  return async (m) => void (await transport.sendMail({ from: env.mailFrom, ...m }));
}

/** Finds the channels subscribed to this event and enqueues one delivery job each. */
export async function fanOut(db: Db, job: NotifyJob): Promise<number> {
  const { incidents, findings, alertRules, notificationChannels } = schema;

  let workspaceId: string;
  let monitorId: string | null = null;
  if ("incidentId" in job) {
    const [incident] = await db.select().from(incidents).where(eq(incidents.id, job.incidentId));
    if (!incident) return 0;
    workspaceId = incident.workspaceId;
    monitorId = incident.monitorId;
  } else {
    const [finding] = await db
      .select({ workspaceId: findings.workspaceId })
      .from(findings)
      .where(eq(findings.id, job.findingId));
    if (!finding) return 0;
    workspaceId = finding.workspaceId;
  }

  const rules = await db
    .select({ channelId: alertRules.channelId, events: alertRules.events })
    .from(alertRules)
    .innerJoin(notificationChannels, eq(notificationChannels.id, alertRules.channelId))
    .where(
      and(
        eq(alertRules.workspaceId, workspaceId),
        eq(alertRules.enabled, true),
        eq(notificationChannels.enabled, true),
        // Findings are not tied to a monitor, so only workspace-wide rules apply to them.
        monitorId
          ? or(isNull(alertRules.monitorId), eq(alertRules.monitorId, monitorId))
          : isNull(alertRules.monitorId),
      ),
    );

  const channelIds = new Set(
    rules.filter((r) => r.events.includes(job.event)).map((r) => r.channelId),
  );
  const subject = "incidentId" in job ? job.incidentId : job.findingId;
  const occurrence = "occurrence" in job ? job.occurrence : "";
  for (const channelId of channelIds) {
    await enqueue<DeliverJob>(
      db,
      DELIVER_QUEUE,
      { ...job, channelId },
      { dedupeKey: `${subject}:${channelId}:${job.event}:${occurrence}`, maxAttempts: 5 },
    );
  }
  return channelIds.size;
}

async function handleTestDeliver(
  db: Db,
  env: NotifierEnv,
  email: EmailSender | undefined,
  { channelId }: TestDeliverJob,
) {
  const { notificationChannels } = schema;
  const [channel] = await db
    .select()
    .from(notificationChannels)
    .where(eq(notificationChannels.id, channelId));
  if (!channel) return;
  const config = {
    kind: channel.kind,
    ...decryptJson<object>(channel.configEncrypted, env.encryptionKey),
  } as ChannelConfig;
  await deliver(
    config,
    {
      event: "incident.opened",
      incident: {
        id: "test",
        title: "Test notification from Upzy",
        openedAt: new Date().toISOString(),
        resolvedAt: null,
      },
      monitor: { id: "test", name: "Test monitor", target: "https://example.com" },
      url: env.appUrl,
    },
    { email },
  );
  console.log(`[notifier] test -> ${channel.name}`);
}

/** Loads what a notification needs. Returns null if the subject or channel was deleted meanwhile. */
async function loadNotification(db: Db, env: NotifierEnv, payload: DeliverJob) {
  const { incidents, monitors, findings, assets, notificationChannels } = schema;
  const [channel] = await db
    .select()
    .from(notificationChannels)
    .where(eq(notificationChannels.id, payload.channelId));
  if (!channel) return null;

  if ("findingId" in payload) {
    const [row] = await db
      .select({ finding: findings, assetValue: assets.value })
      .from(findings)
      .innerJoin(assets, eq(assets.id, findings.assetId))
      .where(eq(findings.id, payload.findingId));
    if (!row) return null;
    const notification: Notification = {
      event: "finding.opened",
      finding: {
        id: row.finding.id,
        title: row.finding.title,
        severity: row.finding.severity,
        checkKey: row.finding.checkKey,
        firstSeen: row.finding.firstSeen.toISOString(),
      },
      asset: { id: row.finding.assetId, value: row.assetValue },
      url: `${env.appUrl}/findings/${row.finding.id}`,
    };
    return { channel, notification };
  }

  const [row] = await db
    .select({ incident: incidents, monitor: monitors })
    .from(incidents)
    .innerJoin(monitors, eq(monitors.id, incidents.monitorId))
    .where(eq(incidents.id, payload.incidentId));
  if (!row) return null;
  const notification: Notification = {
    event: payload.event,
    incident: {
      id: row.incident.id,
      title: row.incident.title,
      openedAt: row.incident.createdAt.toISOString(),
      resolvedAt: row.incident.resolvedAt?.toISOString() ?? null,
    },
    monitor: { id: row.monitor.id, name: row.monitor.name, target: row.monitor.target },
    url: `${env.appUrl}/incidents/${row.incident.id}`,
  };
  return { channel, notification };
}

export async function handleDeliver(
  db: Db,
  env: NotifierEnv,
  email: EmailSender | undefined,
  payload: DeliverJob | TestDeliverJob,
  job: Pick<Job, "attempts" | "maxAttempts">,
) {
  if ("test" in payload) return handleTestDeliver(db, env, email, payload);
  const { notificationDeliveries: d } = schema;

  const occurrence = "occurrence" in payload ? payload.occurrence : "";
  const subjectColumn = "findingId" in payload ? d.findingId : d.incidentId;
  const subjectId = "findingId" in payload ? payload.findingId : payload.incidentId;

  const [already] = await db
    .select({ status: d.status })
    .from(d)
    .where(
      and(
        eq(subjectColumn, subjectId),
        eq(d.channelId, payload.channelId),
        eq(d.event, payload.event),
        eq(d.occurrence, occurrence),
      ),
    );
  if (already?.status === "sent") return;

  const loaded = await loadNotification(db, env, payload);
  if (!loaded) return;
  const { channel, notification } = loaded;

  const record = async (status: "sent" | "failed", error?: string) => {
    // The unique index is an expression index (coalesce), which Drizzle can't target in
    // ON CONFLICT, so insert-if-absent and then set the final state.
    await db
      .insert(d)
      .values({
        incidentId: "incidentId" in payload ? payload.incidentId : null,
        findingId: "findingId" in payload ? payload.findingId : null,
        channelId: payload.channelId,
        event: payload.event,
        occurrence,
        status,
        error,
      })
      .onConflictDoNothing();
    await db
      .update(d)
      .set({ status, error: error ?? null })
      .where(
        and(
          eq(subjectColumn, subjectId),
          eq(d.channelId, payload.channelId),
          eq(d.event, payload.event),
          eq(d.occurrence, occurrence),
        ),
      );
  };

  try {
    const config: ChannelConfig = {
      kind: channel.kind,
      ...decryptJson<object>(channel.configEncrypted, env.encryptionKey),
    } as ChannelConfig;
    await deliver(config, notification, { email });
    await record("sent");
    console.log(`[notifier] ${payload.event} -> ${channel.name} (${channel.kind})`);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    if (job.attempts >= job.maxAttempts) await record("failed", message);
    throw e;
  }
}

/**
 * Turns a message that names a template into one carrying its HTML. Rendering happens here, so the request that queued
 * it never loads the renderer. If rendering fails the plain-text body still goes out: a broken template must not stop
 * a password reset or an outage alert.
 */
export async function withHtml<M extends { template?: { name: string; props: unknown } }>(m: M) {
  const { template, ...message } = m;
  if (!template) return message;
  try {
    return { ...message, html: await renderHtml(template.name as TemplateName, template.props) };
  } catch (e) {
    console.error("[email] couldn't render", template.name, e);
    return message;
  }
}

/** Sends a queued transactional email (invitations, password resets). Throws so the queue retries. */
export async function handleEmail(email: EmailSender | undefined, payload: Email) {
  if (!email)
    throw new Error("Email is not configured on this worker (RESEND_API_KEY or SMTP_URL)");
  await email(await withHtml(payload));
  console.log(`[email] sent "${payload.subject}"`);
}

export async function runNotifier(db: Db, env: NotifierEnv, signal: AbortSignal) {
  const email = makeEmailSender(env);
  // Email alert channels get the branded HTML too.
  const alertEmail: EmailSender | undefined = email && (async (m) => email(await withHtml(m)));
  await Promise.all([
    work<Email>(db, EMAIL_QUEUE, (p) => handleEmail(email, p), { concurrency: 3, signal }),
    work<NotifyJob>(db, NOTIFY_QUEUE, (p) => fanOut(db, p).then(() => undefined), {
      concurrency: 5,
      signal,
    }),
    work<StatusNotifyJob>(
      db,
      STATUS_NOTIFY_QUEUE,
      (p) => notifySubscribers(db, env.appUrl, p).then(() => undefined),
      { concurrency: 3, signal },
    ),
    work<DeliverJob | TestDeliverJob>(
      db,
      DELIVER_QUEUE,
      (p, job) => handleDeliver(db, env, alertEmail, p, job),
      { concurrency: 10, signal },
    ),
  ]);
}
