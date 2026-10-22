import { randomBytes } from "node:crypto";

import { emails, EMAIL_QUEUE } from "@upzy/auth/email";
import { schema, windowsCovering, type Db } from "@upzy/db";
import { enqueue } from "@upzy/queue";
import { healthFor } from "@upzy/security";
import { DomainSchema, SlugSchema } from "@upzy/validator";
import { and, asc, count, desc, eq, gte, inArray, isNotNull, isNull, lt, or } from "drizzle-orm";
import { Elysia } from "elysia";
import { z } from "zod";

import { badge, GRADE_TONE } from "../lib/badge";
import type { Billing } from "../lib/billing";
import {
  dailyUptime,
  overallStatus,
  overallUptime,
  type ComponentStatus,
  type Outage,
} from "../lib/status";
import { statusCache as cache } from "../lib/status-cache";
import { HttpError } from "../plugins/errors";

const {
  statusPages,
  statusPageMonitors,
  statusSubscribers,
  monitors,
  incidents,
  incidentUpdates,
  assets,
  workspaces,
} = schema;

const DAYS = 90;
const RECENT_INCIDENT_DAYS = 14;
const UPCOMING_MAINTENANCE_DAYS = 14;
const CACHE_MS = 30_000;
const MAX_SUBSCRIBERS = 2_000;
// A confirmation email goes to an address someone else typed in, so cap how fast any one page can send them.
const RESEND_AFTER_MS = 10 * 60_000;
const MAX_CONFIRMATIONS_PER_HOUR = 30;
const STALE_UNCONFIRMED_MS = 7 * 86_400_000;
const TokenSchema = z.string().regex(/^[A-Za-z0-9_-]{32,64}$/);
const SubscribeBody = z.object({ email: z.email().max(254) });

/**
 * The public side of status pages: no sign-in, and deliberately small. It never returns monitor targets, ids,
 * incident titles, error text or anything about the organization: only the names the admin chose, whether each is
 * up, and when each was last unavailable. An unknown address and an unpublished page answer the same way.
 */
export const publicStatusModule = (
  db: Db,
  {
    webOrigin,
    now = () => new Date(),
    billing,
  }: { webOrigin: string; now?: () => Date; billing?: Billing },
) => {
  const bySlug = async (slug: string) =>
    (
      await db
        .select()
        .from(statusPages)
        .where(and(eq(statusPages.slug, slug), eq(statusPages.published, true)))
    )[0];
  // Only a domain whose ownership was proven is ever served.
  const byDomain = async (host: string) =>
    (
      await db
        .select()
        .from(statusPages)
        .where(
          and(
            eq(statusPages.customDomain, host),
            isNotNull(statusPages.domainVerifiedAt),
            eq(statusPages.published, true),
          ),
        )
    )[0];

  /** Cached for a short while, under a key that admin changes clear (see status-cache). */
  async function cached(key: string, load: () => Promise<Awaited<ReturnType<typeof build>>>) {
    const hit = cache.get(key);
    let body = hit && now().getTime() - hit.at < CACHE_MS ? hit.body : undefined;
    if (!body) {
      body = (await load()) ?? null;
      cache.set(key, { at: now().getTime(), body });
      // Names are attacker-chosen: don't let a scan of random ones grow the cache without bound.
      if (cache.size > 500) cache.delete(cache.keys().next().value!);
    }
    if (!body) throw new HttpError(404, "Not found");
    return body as NonNullable<Awaited<ReturnType<typeof build>>>;
  }

  async function build(page: typeof statusPages.$inferSelect | undefined) {
    if (!page) return null;

    const comps = await db
      .select({
        monitorId: statusPageMonitors.monitorId,
        name: statusPageMonitors.displayName,
        lastStatus: monitors.lastStatus,
        active: monitors.active,
        createdAt: monitors.createdAt,
      })
      .from(statusPageMonitors)
      .innerJoin(monitors, eq(monitors.id, statusPageMonitors.monitorId))
      .where(eq(statusPageMonitors.pageId, page.id))
      .orderBy(asc(statusPageMonitors.position));

    const t = now();
    const since = new Date(t.getTime() - DAYS * 86_400_000);
    const rows = comps.length
      ? await db
          .select({
            id: incidents.id,
            monitorId: incidents.monitorId,
            start: incidents.createdAt,
            end: incidents.resolvedAt,
          })
          .from(incidents)
          .where(
            and(
              inArray(
                incidents.monitorId,
                comps.map((c) => c.monitorId),
              ),
              // Anything that overlaps the window: still open, or ended inside it.
              or(isNull(incidents.resolvedAt), gte(incidents.resolvedAt, since)),
            ),
          )
      : [];
    const outagesFor = (id: string): Outage[] =>
      rows.filter((r) => r.monitorId === id).map((r) => ({ start: r.start, end: r.end }));

    // Planned maintenance that the owner chose to show: it changes what a covered component reports, and the page
    // lists the windows that are on now or start within the next two weeks. A window kept internal changes nothing
    // here, so a monitor that is really down still shows as down.
    const windows = await windowsCovering(
      db,
      comps.map((c) => c.monitorId),
      t,
      new Date(t.getTime() + UPCOMING_MAINTENANCE_DAYS * 86_400_000),
    );
    const shown = (monitorId: string) =>
      (windows.get(monitorId) ?? []).filter((w) => w.showOnStatusPage);
    const inMaintenance = (monitorId: string) =>
      shown(monitorId).some((w) => w.startsAt.getTime() <= t.getTime());

    const components = comps.map((c) => {
      const days = dailyUptime(outagesFor(c.monitorId), c.createdAt, t, DAYS);
      const status: ComponentStatus = !c.active
        ? "paused"
        : inMaintenance(c.monitorId)
          ? "maintenance"
          : c.lastStatus === "down"
            ? "outage"
            : c.lastStatus === "degraded"
              ? "degraded"
              : "operational";
      return { name: c.name, status, uptime: overallUptime(days), days };
    });

    const seenWindows = new Map<string, { name: string; startsAt: Date; endsAt: Date }>();
    for (const c of comps) for (const w of shown(c.monitorId)) seenWindows.set(w.id, w);
    const maintenance = [...seenWindows.values()]
      .sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime())
      .slice(0, 10)
      .map((w) => ({
        name: w.name,
        startsAt: w.startsAt,
        endsAt: w.endsAt,
        active: w.startsAt.getTime() <= t.getTime(),
      }));

    // What a person chose to tell customers about each incident, newest first.
    const posted = rows.length
      ? await db
          .select({
            incidentId: incidentUpdates.incidentId,
            status: incidentUpdates.status,
            message: incidentUpdates.message,
            at: incidentUpdates.createdAt,
          })
          .from(incidentUpdates)
          .where(
            inArray(
              incidentUpdates.incidentId,
              rows.map((r) => r.id),
            ),
          )
          .orderBy(desc(incidentUpdates.createdAt))
      : [];

    const recentSince = t.getTime() - RECENT_INCIDENT_DAYS * 86_400_000;
    const recent = rows
      .filter((r) => !r.end || r.end.getTime() >= recentSince)
      .sort((a, b) => b.start.getTime() - a.start.getTime())
      .slice(0, 20)
      .map((r) => {
        const name = comps.find((c) => c.monitorId === r.monitorId)!.name;
        return {
          title: r.end ? `${name} was unavailable` : `${name} is unavailable`,
          status: r.end ? ("resolved" as const) : ("ongoing" as const),
          startedAt: r.start,
          resolvedAt: r.end,
          minutes: Math.max(1, Math.round(((r.end ?? t).getTime() - r.start.getTime()) / 60_000)),
          updates: posted
            .filter((u) => u.incidentId === r.id)
            .map((u) => ({ status: u.status, message: u.message, at: u.at })),
        };
      });

    // Opt-in: only the letter and when it was last measured. Never the findings behind it.
    let security: { grade: string; scannedAt: Date } | null = null;
    if (page.securityAssetId) {
      const [a] = await db
        .select({ lastScanAt: assets.lastScanAt })
        .from(assets)
        .where(eq(assets.id, page.securityAssetId));
      const health = (await healthFor(db, [page.securityAssetId])).get(page.securityAssetId);
      if (a?.lastScanAt && health) security = { grade: health.grade, scannedAt: a.lastScanAt };
    }

    // The logo shows only while the plan includes it, so a downgrade takes it down. Upzy's own credit is never optional.
    let logoUrl: string | null = null;
    if (page.logoUrl) {
      const [owner] = await db
        .select({ orgId: workspaces.orgId })
        .from(workspaces)
        .where(eq(workspaces.id, page.workspaceId));
      if (owner && (!billing || (await billing.customLogoAllowed(db, owner.orgId))))
        logoUrl = page.logoUrl;
    }

    return {
      title: page.title,
      description: page.description,
      branding: { logoUrl },
      notice: page.notice ? { text: page.notice, kind: page.noticeKind } : null,
      overall: overallStatus(components),
      updatedAt: t,
      components,
      maintenance,
      incidents: recent,
      security,
    };
  }

  /**
   * Same answer whether or not the address was already known, so the form can't be used to find out who is
   * subscribed. Only a confirmed address ever receives incident email.
   */
  async function subscribe(page: typeof statusPages.$inferSelect | undefined, rawEmail: string) {
    if (!page) throw new HttpError(404, "Not found");
    const email = rawEmail.trim().toLowerCase();
    const t = now();
    // Housekeeping: addresses that never confirmed don't linger.
    await db
      .delete(statusSubscribers)
      .where(
        and(
          eq(statusSubscribers.pageId, page.id),
          isNull(statusSubscribers.confirmedAt),
          lt(statusSubscribers.confirmationSentAt, new Date(t.getTime() - STALE_UNCONFIRMED_MS)),
        ),
      );
    const [existing] = await db
      .select()
      .from(statusSubscribers)
      .where(and(eq(statusSubscribers.pageId, page.id), eq(statusSubscribers.email, email)));
    if (existing?.confirmedAt) return;
    if (existing && t.getTime() - existing.confirmationSentAt.getTime() < RESEND_AFTER_MS) return;

    const [{ total } = { total: 0 }] = await db
      .select({ total: count() })
      .from(statusSubscribers)
      .where(eq(statusSubscribers.pageId, page.id));
    if (!existing && total >= MAX_SUBSCRIBERS)
      throw new HttpError(409, "This status page isn't taking new subscribers right now.");
    const [{ recent } = { recent: 0 }] = await db
      .select({ recent: count() })
      .from(statusSubscribers)
      .where(
        and(
          eq(statusSubscribers.pageId, page.id),
          gte(statusSubscribers.confirmationSentAt, new Date(t.getTime() - 3_600_000)),
        ),
      );
    if (recent >= MAX_CONFIRMATIONS_PER_HOUR)
      throw new HttpError(429, "Too many sign-ups right now. Please try again later.");

    const token = existing?.token ?? randomBytes(32).toString("base64url");
    if (existing)
      await db
        .update(statusSubscribers)
        .set({ confirmationSentAt: t })
        .where(eq(statusSubscribers.id, existing.id));
    else
      await db
        .insert(statusSubscribers)
        .values({ pageId: page.id, email, token, confirmationSentAt: t });
    await enqueue(
      db,
      EMAIL_QUEUE,
      emails.statusConfirm({
        to: email,
        page: page.title,
        url: `${webOrigin}/subscription/${token}`,
      }),
      { maxAttempts: 5 },
    );
  }

  const byToken = async (token: string) => {
    const [row] = await db
      .select({
        id: statusSubscribers.id,
        confirmedAt: statusSubscribers.confirmedAt,
        pageTitle: statusPages.title,
      })
      .from(statusSubscribers)
      .innerJoin(statusPages, eq(statusPages.id, statusSubscribers.pageId))
      .where(eq(statusSubscribers.token, token));
    if (!row) throw new HttpError(404, "Not found");
    return row;
  };

  return (
    new Elysia()
      .post(
        "/public/status/:slug/subscribe",
        async ({ params, body, set }) => {
          await subscribe(await bySlug(params.slug), body.email);
          set.status = 202;
          return { ok: true as const };
        },
        { params: z.object({ slug: SlugSchema }), body: SubscribeBody },
      )
      .post(
        "/public/status-domain/:host/subscribe",
        async ({ params, body, set }) => {
          await subscribe(await byDomain(params.host), body.email);
          set.status = 202;
          return { ok: true as const };
        },
        { params: z.object({ host: DomainSchema }), body: SubscribeBody },
      )
      // These take the secret token from the email. Confirm and unsubscribe are POSTs behind a button on the web
      // page, never links that act on a GET: mail scanners open links, and must not confirm or cancel anyone.
      .get(
        "/public/subscription/:token",
        async ({ params }) => {
          const r = await byToken(params.token);
          return { pageTitle: r.pageTitle, confirmed: !!r.confirmedAt };
        },
        { params: z.object({ token: TokenSchema }) },
      )
      .post(
        "/public/subscription/:token/confirm",
        async ({ params }) => {
          const r = await byToken(params.token);
          if (!r.confirmedAt)
            await db
              .update(statusSubscribers)
              .set({ confirmedAt: now() })
              .where(eq(statusSubscribers.id, r.id));
          return { pageTitle: r.pageTitle, confirmed: true as const };
        },
        { params: z.object({ token: TokenSchema }) },
      )
      .post(
        "/public/subscription/:token/unsubscribe",
        async ({ params }) => {
          const r = await byToken(params.token);
          await db.delete(statusSubscribers).where(eq(statusSubscribers.id, r.id));
          return { pageTitle: r.pageTitle, confirmed: false as const };
        },
        { params: z.object({ token: TokenSchema }) },
      )
      .get(
        "/public/status/:slug",
        async ({ params, set }) => {
          const body = await cached(params.slug, async () => build(await bySlug(params.slug)));
          set.headers["cache-control"] = "public, max-age=30, stale-while-revalidate=60";
          return body;
        },
        { params: z.object({ slug: SlugSchema }) },
      )
      // An embeddable badge for a README or a site footer. Text comes from fixed words only.
      .get(
        "/public/status/:slug/badge.svg",
        async ({ params, query, set }) => {
          const body = await cached(params.slug, async () => build(await bySlug(params.slug)));
          let svg: string;
          if (query.type === "security") {
            if (!body.security) throw new HttpError(404, "Not found");
            svg = badge(
              "security",
              body.security.grade,
              GRADE_TONE[body.security.grade] ?? "muted",
            );
          } else {
            const label = {
              operational: "operational",
              degraded: "degraded",
              maintenance: "maintenance",
              partial: "partial outage",
              major: "outage",
            }[body.overall];
            const tone = {
              operational: "good",
              degraded: "warn",
              maintenance: "muted",
              partial: "warn",
              major: "bad",
            } as const;
            svg = badge("status", label, tone[body.overall]);
          }
          set.headers["content-type"] = "image/svg+xml; charset=utf-8";
          set.headers["cache-control"] = "public, max-age=300, stale-while-revalidate=300";
          set.headers["content-security-policy"] = "default-src 'none'; style-src 'unsafe-inline'";
          set.headers["x-content-type-options"] = "nosniff";
          return svg;
        },
        {
          params: z.object({ slug: SlugSchema }),
          query: z.object({ type: z.enum(["status", "security"]).default("status") }),
        },
      )
      .get(
        "/public/status-domain/:host",
        async ({ params, set }) => {
          const body = await cached(`domain:${params.host}`, async () =>
            build(await byDomain(params.host)),
          );
          set.headers["cache-control"] = "public, max-age=30, stale-while-revalidate=60";
          return body;
        },
        { params: z.object({ host: DomainSchema }) },
      )
      // Caddy asks this before it requests a certificate for a name it has never seen. Without it anyone could point
      // any domain at the server and make it ask Let's Encrypt for certificates. It answers yes only for a verified,
      // published custom domain, and only to Caddy itself: anything that came through the proxy carries X-Forwarded-For.
      .get(
        "/internal/tls-check",
        async ({ query, request, set }) => {
          if (request.headers.get("x-forwarded-for")) throw new HttpError(404, "Not found");
          const host = DomainSchema.safeParse(query.domain);
          if (!host.success || !(await byDomain(host.data))) throw new HttpError(404, "Not found");
          set.status = 200;
          return { ok: true };
        },
        { query: z.object({ domain: z.string().max(253) }) },
      )
  );
};
