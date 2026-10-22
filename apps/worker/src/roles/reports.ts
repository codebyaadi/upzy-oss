import { EMAIL_QUEUE, type Email } from "@upzy/auth/email";
import { reportUnsubscribeUrl } from "@upzy/auth/unsubscribe";
import { entitlement, loadBillingConfig, PLANS } from "@upzy/billing";
import { schema, type Db } from "@upzy/db";
import { enqueue, work } from "@upzy/queue";
import { healthFor } from "@upzy/security";
import { compose, type TemplateProps } from "@upzy/transactional/templates";
import { and, asc, eq, isNull, sql } from "drizzle-orm";

import { computePeriodStats, weekStartOf } from "../digest-stats";
import { sleepUnlessAborted } from "./retention";

const {
  reportSchedules,
  reportRecipients,
  workspaces,
  organizations,
  subscriptions,
  assets,
  statusPages,
  monitors,
} = schema;

export const REPORT_QUEUE = "report";

export interface ReportConfig {
  enabled: boolean;
  /** Whether plans are enforced; with billing off every organization may send reports. */
  billingEnabled: boolean;
  appUrl: string;
  apiUrl: string;
  secret: string;
}

/** Needs BETTER_AUTH_SECRET to sign the unsubscribe links: a report without a working opt-out is never sent. */
export function parseReports(env: Record<string, string | undefined> = process.env): ReportConfig {
  const off = ["off", "false", "0", "no"].includes(env.CLIENT_REPORTS?.trim().toLowerCase() ?? "");
  const secret = env.BETTER_AUTH_SECRET?.trim() ?? "";
  return {
    enabled: !off && secret.length > 0,
    billingEnabled: loadBillingConfig(env).enabled,
    appUrl: (env.APP_URL?.trim() || "http://localhost:3001").replace(/\/$/, ""),
    apiUrl: (env.BETTER_AUTH_URL?.trim() || "http://localhost:3000").replace(/\/$/, ""),
    secret,
  };
}

export type Frequency = "weekly" | "monthly";

export interface Period {
  /** Identifies the period, so each is reported once: the Monday it started ("2026-10-12"), or the month ("2026-09"). */
  key: string;
  from: Date;
  to: Date;
  label: string;
  /** Whether sending time has been reached (07:00 UTC on the day after the period ends). */
  due: boolean;
}

const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];
const SEND_HOUR_UTC = 7;
const DAY = 86_400_000;

function weekLabel(from: Date, lastDay: Date) {
  const d1 = from.getUTCDate();
  const d2 = lastDay.getUTCDate();
  const m1 = MONTHS[from.getUTCMonth()]!;
  const m2 = MONTHS[lastDay.getUTCMonth()]!;
  const y1 = from.getUTCFullYear();
  const y2 = lastDay.getUTCFullYear();
  if (y1 !== y2) return `${d1} ${m1} ${y1} to ${d2} ${m2} ${y2}`;
  if (m1 !== m2) return `${d1} ${m1} to ${d2} ${m2} ${y2}`;
  return `${d1} to ${d2} ${m2} ${y2}`;
}

/** The most recent period that has fully ended, in UTC. Weeks run Monday to Sunday; months are calendar months. */
export function lastPeriod(frequency: Frequency, now: Date): Period {
  if (frequency === "weekly") {
    const thisMonday = new Date(`${weekStartOf(now)}T00:00:00Z`);
    const from = new Date(thisMonday.getTime() - 7 * DAY);
    return {
      key: from.toISOString().slice(0, 10),
      from,
      to: thisMonday,
      label: weekLabel(from, new Date(thisMonday.getTime() - DAY)),
      due: now.getTime() >= thisMonday.getTime() + SEND_HOUR_UTC * 3_600_000,
    };
  }
  const first = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const from = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() - 1, 1));
  return {
    key: `${from.getUTCFullYear()}-${String(from.getUTCMonth() + 1).padStart(2, "0")}`,
    from,
    to: first,
    label: `${MONTHS[from.getUTCMonth()]} ${from.getUTCFullYear()}`,
    due: now.getTime() >= first.getTime() + SEND_HOUR_UTC * 3_600_000,
  };
}

/** Whether the organization's plan includes client reports right now (trial counts as Pro, which doesn't). */
async function planAllows(db: Db, orgId: string, config: ReportConfig) {
  if (!config.billingEnabled) return true;
  const [sub] = await db
    .select({
      plan: subscriptions.plan,
      status: subscriptions.status,
      trialEndsAt: subscriptions.trialEndsAt,
    })
    .from(subscriptions)
    .where(eq(subscriptions.organizationId, orgId));
  const ent = entitlement({ billingEnabled: true, sub });
  return PLANS[ent.plan].limits.clientReports;
}

const pct = (v: number | null) => (v === null ? "no data" : `${(v * 100).toFixed(2)}%`);

/** What the report says for a workspace and period. Numbers come straight from the database. */
export async function buildReport(
  db: Db,
  workspaceId: string,
  frequency: Frequency,
  period: Period,
  config: ReportConfig,
): Promise<Omit<TemplateProps["clientReport"], "unsubscribeUrl"> | null> {
  const [ws] = await db
    .select({ name: workspaces.name, orgName: organizations.name })
    .from(workspaces)
    .innerJoin(organizations, eq(organizations.id, workspaces.orgId))
    .where(eq(workspaces.id, workspaceId));
  if (!ws) return null;

  const stats = await computePeriodStats(db, workspaceId, period.from, period.to);
  const totalChecks = stats.monitors.reduce((n, m) => n + m.checks, 0);
  const weighted = stats.monitors.reduce((n, m) => n + (m.uptime ?? 0) * m.checks, 0);

  const assetRows = await db
    .select({ id: assets.id })
    .from(assets)
    .where(eq(assets.workspaceId, workspaceId));
  const health = await healthFor(
    db,
    assetRows.map((a) => a.id),
  );
  const order = ["A", "B", "C", "D", "F"];
  const grade =
    [...health.values()]
      .flatMap((h) => (h ? [h.grade] : []))
      .sort((a, b) => order.indexOf(b) - order.indexOf(a))[0] ?? null;

  const [page] = await db
    .select({
      slug: statusPages.slug,
      domain: statusPages.customDomain,
      verified: statusPages.domainVerifiedAt,
    })
    .from(statusPages)
    .where(and(eq(statusPages.workspaceId, workspaceId), eq(statusPages.published, true)))
    .orderBy(asc(statusPages.createdAt))
    .limit(1);

  return {
    workspace: stats.workspace,
    preparedBy: ws.orgName,
    frequency,
    periodLabel: period.label,
    uptime: totalChecks > 0 ? pct(weighted / totalChecks) : null,
    monitors: stats.monitors.map((m) => ({ ...m, uptime: pct(m.uptime) })),
    incidents: stats.incidents,
    security: {
      grade,
      newFindings: stats.findings.new,
      resolvedFindings: stats.findings.resolved,
      openFindings: stats.findings.open,
    },
    statusPageUrl: page
      ? page.domain && page.verified
        ? `https://${page.domain}`
        : `${config.appUrl}/status/${page.slug}`
      : null,
  };
}

export type ReportJob =
  | { kind: "scheduled"; workspaceId: string; periodKey: string }
  | { kind: "test"; workspaceId: string; to: string };

/**
 * Looks for reports that are due and queues one job per workspace. Claiming the period is one atomic update, so
 * several workers (or a restart) never send the same report twice, and a plan that doesn't include reports is never
 * claimed (so upgrading later still sends the next one).
 */
export async function scheduleReports(
  db: Db,
  config: ReportConfig,
  now: Date = new Date(),
): Promise<number> {
  if (!config.enabled) return 0;
  const due = await db
    .select({
      workspaceId: reportSchedules.workspaceId,
      frequency: reportSchedules.frequency,
      last: reportSchedules.lastSentPeriod,
      orgId: workspaces.orgId,
    })
    .from(reportSchedules)
    .innerJoin(workspaces, eq(workspaces.id, reportSchedules.workspaceId))
    .where(eq(reportSchedules.enabled, true));

  let queued = 0;
  for (const s of due) {
    const period = lastPeriod(s.frequency, now);
    if (!period.due || s.last === period.key) continue;
    if (!(await planAllows(db, s.orgId, config))) continue;

    const claimed = await db
      .update(reportSchedules)
      .set({ lastSentPeriod: period.key })
      .where(
        and(
          eq(reportSchedules.workspaceId, s.workspaceId),
          sql`${reportSchedules.lastSentPeriod} is distinct from ${period.key}`,
        ),
      )
      .returning({ workspaceId: reportSchedules.workspaceId });
    if (claimed.length === 0) continue;
    await enqueue<ReportJob>(
      db,
      REPORT_QUEUE,
      { kind: "scheduled", workspaceId: s.workspaceId, periodKey: period.key },
      { maxAttempts: 3, dedupeKey: `report:${s.workspaceId}:${period.key}` },
    );
    queued++;
  }
  return queued;
}

/** Builds the report once and queues an email per recipient who hasn't opted out. */
export async function handleReport(
  db: Db,
  job: ReportJob,
  config: ReportConfig,
  now: Date = new Date(),
): Promise<number> {
  const [schedule] = await db
    .select()
    .from(reportSchedules)
    .where(eq(reportSchedules.workspaceId, job.workspaceId));
  const frequency: Frequency = schedule?.frequency ?? "monthly";
  const period = lastPeriod(frequency, now);
  if (job.kind === "scheduled" && period.key !== job.periodKey) {
    // The job ran late enough that a newer period has begun: report the one that was claimed.
    return handleReportFor(db, job, frequency, periodFromKey(frequency, job.periodKey), config);
  }
  return handleReportFor(db, job, frequency, period, config);
}

function periodFromKey(frequency: Frequency, key: string): Period {
  if (frequency === "weekly") {
    const from = new Date(`${key}T00:00:00Z`);
    const to = new Date(from.getTime() + 7 * DAY);
    return { key, from, to, label: weekLabel(from, new Date(to.getTime() - DAY)), due: true };
  }
  const [y, m] = key.split("-").map(Number) as [number, number];
  const from = new Date(Date.UTC(y, m - 1, 1));
  return {
    key,
    from,
    to: new Date(Date.UTC(y, m, 1)),
    label: `${MONTHS[m - 1]} ${y}`,
    due: true,
  };
}

async function handleReportFor(
  db: Db,
  job: ReportJob,
  frequency: Frequency,
  period: Period,
  config: ReportConfig,
): Promise<number> {
  const body = await buildReport(db, job.workspaceId, frequency, period, config);
  if (!body) return 0;
  // Nothing to report on: a workspace with no monitors yet.
  const [anyMonitor] = await db
    .select({ id: monitors.id })
    .from(monitors)
    .where(eq(monitors.workspaceId, job.workspaceId))
    .limit(1);
  if (!anyMonitor && job.kind === "scheduled") return 0;

  const people =
    job.kind === "test"
      ? [{ email: job.to }]
      : await db
          .select({ email: reportRecipients.email })
          .from(reportRecipients)
          .where(
            and(
              eq(reportRecipients.workspaceId, job.workspaceId),
              isNull(reportRecipients.unsubscribedAt),
            ),
          );

  let n = 0;
  for (const r of people) {
    const email: Email = compose("clientReport", r.email, {
      ...body,
      unsubscribeUrl: reportUnsubscribeUrl(config.apiUrl, config.secret, job.workspaceId, r.email),
    });
    await enqueue<Email>(db, EMAIL_QUEUE, email, {
      maxAttempts: 5,
      // A test may be sent as often as someone asks; real reports go out once per period and address.
      ...(job.kind === "scheduled"
        ? { dedupeKey: `report-mail:${job.workspaceId}:${period.key}:${r.email}` }
        : {}),
    });
    n++;
  }
  return n;
}

/** Checks for due reports every 15 minutes and works the report queue. A failure never affects monitoring. */
export async function runReports(
  db: Db,
  signal: AbortSignal,
  config: ReportConfig,
  opts: { firstDelayMs?: number; intervalMs?: number } = {},
) {
  if (!config.enabled) return;
  const loop = (async () => {
    await sleepUnlessAborted(opts.firstDelayMs ?? 3 * 60_000, signal);
    while (!signal.aborted) {
      try {
        const n = await scheduleReports(db, config);
        if (n) console.log(`[reports] queued ${n} report(s)`);
      } catch (e) {
        console.error("[reports]", e);
      }
      await sleepUnlessAborted(opts.intervalMs ?? 15 * 60_000, signal);
    }
  })();
  await Promise.all([
    loop,
    work<ReportJob>(db, REPORT_QUEUE, async (job) => void (await handleReport(db, job, config)), {
      concurrency: 2,
      signal,
    }),
  ]);
}
