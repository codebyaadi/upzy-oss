import { emails, queueEmail, type Email } from "@upzy/auth/email";
import { unsubscribeUrl } from "@upzy/auth/unsubscribe";
import { schema, type Db } from "@upzy/db";
import { and, desc, eq, gt, inArray, isNull, lte, notInArray, or } from "drizzle-orm";

import { sleepUnlessAborted } from "./retention";

const {
  users,
  members,
  organizations,
  subscriptions,
  workspaces,
  findings,
  assets,
  lifecycleEmails,
} = schema;

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

export interface LifecycleConfig {
  enabled: boolean;
  /** The web app, for links to the dashboard. */
  appUrl: string;
  /** The API as seen from outside, for the unsubscribe link. */
  apiUrl: string;
  /** Signs unsubscribe links (BETTER_AUTH_SECRET). */
  secret: string;
  /** Send the trial reminder when this many days or fewer are left. */
  trialWarnDays: number;
}

/**
 * LIFECYCLE_EMAILS=off  switches the welcome, fix-nudge and trial emails off (account mail is unaffected)
 * They also stay off without BETTER_AUTH_SECRET, because an email without a working unsubscribe link must not go out.
 */
export function parseLifecycle(env: Record<string, string | undefined> = process.env) {
  const off = ["off", "false", "0", "no"].includes(
    env.LIFECYCLE_EMAILS?.trim().toLowerCase() ?? "",
  );
  const secret = env.BETTER_AUTH_SECRET?.trim() ?? "";
  const appUrl = (env.APP_URL?.trim() || "http://localhost:3001").replace(/\/$/, "");
  return {
    enabled: !off && secret.length > 0,
    appUrl,
    apiUrl: (env.BETTER_AUTH_URL?.trim() || "http://localhost:3000").replace(/\/$/, ""),
    secret,
    trialWarnDays: 3,
  } satisfies LifecycleConfig;
}

export interface LifecycleResult {
  welcome: number;
  fixNudge: number;
  trialEnding: number;
}

/** Who gets a fix nudge is capped so one run never floods the mail queue after a long outage. */
const BATCH = 200;

/**
 * Records that this email is going out, and says whether it's ours to send. The row is the lock: only the worker whose
 * insert succeeds sends, so two workers (or a restart mid-run) never send the same email twice.
 */
async function claim(db: Db, subject: string, kind: string, now: Date) {
  const rows = await db
    .insert(lifecycleEmails)
    .values({ subject, kind, sentAt: now })
    .onConflictDoNothing()
    .returning({ subject: lifecycleEmails.subject });
  return rows.length > 0;
}

/** Sends a claimed email; if it can't be queued, the claim is released so the next run retries it. */
async function sendClaimed(db: Db, subject: string, kind: string, email: Email) {
  try {
    await queueEmail(db)(email);
    return true;
  } catch (e) {
    await db
      .delete(lifecycleEmails)
      .where(and(eq(lifecycleEmails.subject, subject), eq(lifecycleEmails.kind, kind)));
    console.error("[lifecycle] couldn't queue", kind, e);
    return false;
  }
}

const firstName = (name: string) => name.trim().split(/\s+/)[0] || "there";

/** A welcome shortly after sign-up, to people who haven't opted out. Older accounts never get one. */
async function welcomes(db: Db, config: LifecycleConfig, now: Date) {
  const candidates = await db
    .select({ id: users.id, name: users.name, email: users.email })
    .from(users)
    .where(
      and(
        eq(users.lifecycleEmails, true),
        lte(users.createdAt, new Date(now.getTime() - 10 * 60_000)),
        gt(users.createdAt, new Date(now.getTime() - 2 * DAY)),
        notInArray(
          users.id,
          db
            .select({ id: lifecycleEmails.subject })
            .from(lifecycleEmails)
            .where(eq(lifecycleEmails.kind, "welcome")),
        ),
      ),
    )
    .limit(BATCH);
  let sent = 0;
  for (const u of candidates) {
    if (!(await claim(db, u.id, "welcome", now))) continue;
    const ok = await sendClaimed(
      db,
      u.id,
      "welcome",
      emails.welcome({
        to: u.email,
        name: firstName(u.name),
        appUrl: config.appUrl,
        unsubscribeUrl: unsubscribeUrl(config.apiUrl, config.secret, u.id),
      }),
    );
    if (ok) sent++;
  }
  return sent;
}

/**
 * Two days after sign-up, if their first scan found something, a nudge to fix the most serious open finding. Nothing
 * is sent when there is nothing to fix or the team has already fixed something: it's a prompt, not a newsletter.
 */
async function fixNudges(db: Db, config: LifecycleConfig, now: Date) {
  const candidates = await db
    .select({ id: users.id, name: users.name, email: users.email })
    .from(users)
    .where(
      and(
        eq(users.lifecycleEmails, true),
        lte(users.createdAt, new Date(now.getTime() - 2 * DAY)),
        gt(users.createdAt, new Date(now.getTime() - 7 * DAY)),
        notInArray(
          users.id,
          db
            .select({ id: lifecycleEmails.subject })
            .from(lifecycleEmails)
            .where(eq(lifecycleEmails.kind, "fix_nudge")),
        ),
      ),
    )
    .limit(BATCH);

  let sent = 0;
  for (const u of candidates) {
    const orgIds = db
      .select({ id: members.organizationId })
      .from(members)
      .where(and(eq(members.userId, u.id), inArray(members.role, ["owner", "admin", "member"])));
    const wsIds = db
      .select({ id: workspaces.id })
      .from(workspaces)
      .where(inArray(workspaces.orgId, orgIds));

    const [fixedAny] = await db
      .select({ id: findings.id })
      .from(findings)
      .where(and(inArray(findings.workspaceId, wsIds), eq(findings.status, "resolved")))
      .limit(1);
    if (fixedAny) continue;

    const [top] = await db
      .select({
        title: findings.title,
        severity: findings.severity,
        remediation: findings.remediation,
        asset: assets.value,
      })
      .from(findings)
      .innerJoin(assets, eq(assets.id, findings.assetId))
      .where(
        and(
          inArray(findings.workspaceId, wsIds),
          eq(findings.status, "open"),
          inArray(findings.severity, ["critical", "high", "medium"]),
        ),
      )
      .orderBy(desc(findings.riskScore))
      .limit(1);
    if (!top) continue;

    if (!(await claim(db, u.id, "fix_nudge", now))) continue;
    const ok = await sendClaimed(
      db,
      u.id,
      "fix_nudge",
      emails.fixNudge({
        to: u.email,
        name: firstName(u.name),
        findingTitle: top.title,
        asset: top.asset,
        severity: top.severity,
        remediation: top.remediation,
        findingUrl: `${config.appUrl}/findings`,
        unsubscribeUrl: unsubscribeUrl(config.apiUrl, config.secret, u.id),
      }),
    );
    if (ok) sent++;
  }
  return sent;
}

/**
 * One reminder per organization as its trial runs out, to the owners and admins who haven't opted out. Organizations
 * already on a paid plan are left alone. Only organizations with a trial have a date, so this does nothing when
 * billing is off.
 */
async function trialEndings(db: Db, config: LifecycleConfig, now: Date) {
  const due = await db
    .select({
      orgId: subscriptions.organizationId,
      org: organizations.name,
      trialEndsAt: subscriptions.trialEndsAt,
    })
    .from(subscriptions)
    .innerJoin(organizations, eq(organizations.id, subscriptions.organizationId))
    .where(
      and(
        gt(subscriptions.trialEndsAt, now),
        lte(subscriptions.trialEndsAt, new Date(now.getTime() + config.trialWarnDays * DAY)),
        or(isNull(subscriptions.plan), notInArray(subscriptions.status, ["active", "past_due"])),
        notInArray(
          subscriptions.organizationId,
          db
            .select({ id: lifecycleEmails.subject })
            .from(lifecycleEmails)
            .where(eq(lifecycleEmails.kind, "trial_ending")),
        ),
      ),
    )
    .limit(BATCH);

  let sent = 0;
  for (const o of due) {
    if (!(await claim(db, o.orgId, "trial_ending", now))) continue;
    const daysLeft = Math.max(1, Math.ceil((o.trialEndsAt!.getTime() - now.getTime()) / DAY));
    const people = await db
      .select({ id: users.id, name: users.name, email: users.email })
      .from(members)
      .innerJoin(users, eq(users.id, members.userId))
      .where(
        and(
          eq(members.organizationId, o.orgId),
          inArray(members.role, ["owner", "admin"]),
          eq(users.lifecycleEmails, true),
        ),
      );
    let failed = false;
    for (const p of people) {
      const ok = await sendClaimed(
        db,
        `${o.orgId}:${p.id}`,
        "trial_ending_to",
        emails.trialEnding({
          to: p.email,
          name: firstName(p.name),
          organization: o.org,
          daysLeft,
          billingUrl: `${config.appUrl}/settings/billing`,
          unsubscribeUrl: unsubscribeUrl(config.apiUrl, config.secret, p.id),
        }),
      );
      if (ok) sent++;
      else failed = true;
    }
    // Released so the next run retries; the per-person rows keep those already emailed from getting it twice.
    if (failed)
      await db
        .delete(lifecycleEmails)
        .where(and(eq(lifecycleEmails.subject, o.orgId), eq(lifecycleEmails.kind, "trial_ending")));
  }
  return sent;
}

/** One pass over everything that is due. Safe to run from several workers at once. */
export async function sendLifecycleEmails(
  db: Db,
  config: LifecycleConfig,
  now: Date = new Date(),
): Promise<LifecycleResult> {
  if (!config.enabled) return { welcome: 0, fixNudge: 0, trialEnding: 0 };
  return {
    welcome: await welcomes(db, config, now),
    fixNudge: await fixNudges(db, config, now),
    trialEnding: await trialEndings(db, config, now),
  };
}

/** Looks for due emails a couple of minutes after start and then every 15 minutes. A failure never affects monitoring. */
export async function runLifecycle(
  db: Db,
  signal: AbortSignal,
  config: LifecycleConfig,
  opts: { firstDelayMs?: number; intervalMs?: number } = {},
) {
  if (!config.enabled) return;
  await sleepUnlessAborted(opts.firstDelayMs ?? 2 * 60_000, signal);
  while (!signal.aborted) {
    try {
      const r = await sendLifecycleEmails(db, config);
      if (r.welcome || r.fixNudge || r.trialEnding)
        console.log(
          `[lifecycle] queued ${r.welcome} welcome, ${r.fixNudge} fix nudge and ${r.trialEnding} trial email(s)`,
        );
    } catch (e) {
      console.error("[lifecycle]", e);
    }
    await sleepUnlessAborted(opts.intervalMs ?? 15 * 60_000, signal);
  }
}
