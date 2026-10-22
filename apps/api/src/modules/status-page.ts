import { randomBytes } from "node:crypto";
import { resolve4, resolveCname, resolveTxt } from "node:dns/promises";

import { hasRole } from "@upzy/auth/roles";
import { schema, type Db } from "@upzy/db";
import { CreateStatusPageSchema, UpdateStatusPageSchema } from "@upzy/validator";
import { and, asc, count, eq, inArray, isNotNull } from "drizzle-orm";
import { Elysia } from "elysia";
import { z } from "zod";

import type { Billing } from "../lib/billing";
import { orgWorkspaceIds, requireWorkspace } from "../lib/scope";
import { forgetStatusPage } from "../lib/status-cache";
import type { AuthPlugin } from "../plugins/auth";
import { HttpError } from "../plugins/errors";

const { statusPages, statusPageMonitors, statusSubscribers, monitors, assets } = schema;
const Params = z.object({ id: z.uuid() });

/** DNS lookups, injectable so tests don't need a real domain. */
export interface StatusDns {
  txt(name: string): Promise<string[]>;
  a(host: string): Promise<string[]>;
  cname(host: string): Promise<string[]>;
}
const quiet = <T>(p: Promise<T[]>) => p.catch(() => [] as T[]);
export const realStatusDns: StatusDns = {
  txt: async (name) => (await quiet(resolveTxt(name))).map((parts) => parts.join("")),
  a: (host) => quiet(resolve4(host)),
  cname: (host) => quiet(resolveCname(host)),
};

const hostOf = (url: string | undefined) => {
  try {
    return url ? new URL(url).hostname.toLowerCase() : null;
  } catch {
    return null;
  }
};
export const challengeFor = (domain: string, token: string) => ({
  name: `_upzy-challenge.${domain}`,
  value: `upzy-verify=${token}`,
});
const ListQuery = z.object({ workspaceId: z.uuid().optional() });

/**
 * Managing public status pages. Pages are public, so changes are admin-only; everyone in the organization can see
 * what exists. The public read side lives in public-status.ts and exposes far less than this does.
 */
export const statusPageModule = (
  db: Db,
  authP: AuthPlugin,
  billing: Billing,
  deps: { dns?: StatusDns; env?: Record<string, string | undefined> } = {},
) => {
  const dns = deps.dns ?? realStatusDns;
  const env = deps.env ?? process.env;
  // Upzy's own addresses: a status page can't claim them, and they are what a custom domain must point at.
  const appHost = hostOf(env.WEB_ORIGIN);
  const ownHosts = new Set([appHost, hostOf(env.BETTER_AUTH_URL)].filter((h): h is string => !!h));

  const owned = (orgId: string, userId: string, id: string) =>
    and(
      eq(statusPages.id, id),
      inArray(statusPages.workspaceId, orgWorkspaceIds(db, orgId, userId)),
    );

  async function withComponents(pageIds: string[]) {
    if (pageIds.length === 0)
      return new Map<string, { monitorId: string; displayName: string; monitorName: string }[]>();
    const rows = await db
      .select({
        pageId: statusPageMonitors.pageId,
        monitorId: statusPageMonitors.monitorId,
        displayName: statusPageMonitors.displayName,
        monitorName: monitors.name,
      })
      .from(statusPageMonitors)
      .innerJoin(monitors, eq(monitors.id, statusPageMonitors.monitorId))
      .where(inArray(statusPageMonitors.pageId, pageIds))
      .orderBy(asc(statusPageMonitors.position));
    const by = new Map<string, typeof rows>();
    for (const r of rows) by.set(r.pageId, [...(by.get(r.pageId) ?? []), r]);
    return by;
  }

  /** The asset whose grade a page shows must belong to the page's own workspace. */
  async function checkSecurityAsset(workspaceId: string, assetId: string | null | undefined) {
    if (!assetId) return;
    const [a] = await db
      .select({ id: assets.id })
      .from(assets)
      .where(and(eq(assets.id, assetId), eq(assets.workspaceId, workspaceId)));
    if (!a) throw new HttpError(422, "That asset isn't in this workspace.");
  }

  /** Every monitor must live in the page's own workspace: a page can't show another team's monitors. */
  async function checkComponents(workspaceId: string, components: { monitorId: string }[]) {
    if (components.length === 0) return;
    const found = await db
      .select({ id: monitors.id })
      .from(monitors)
      .where(
        and(
          eq(monitors.workspaceId, workspaceId),
          inArray(
            monitors.id,
            components.map((c) => c.monitorId),
          ),
        ),
      );
    if (found.length !== components.length)
      throw new HttpError(422, "One of the chosen monitors isn't in this workspace.");
  }

  const replaceComponents = async (
    tx: Pick<Db, "delete" | "insert">,
    pageId: string,
    components: { monitorId: string; displayName: string }[],
  ) => {
    await tx.delete(statusPageMonitors).where(eq(statusPageMonitors.pageId, pageId));
    if (components.length)
      await tx.insert(statusPageMonitors).values(
        components.map((c, position) => ({
          pageId,
          monitorId: c.monitorId,
          displayName: c.displayName,
          position,
        })),
      );
  };

  const taken = () => new HttpError(409, "That address is already used by another status page.");
  const isDuplicate = (e: unknown) =>
    /duplicate key|unique/i.test(String((e as Error)?.message ?? e)) ||
    (e as { code?: string })?.code === "23505";

  return new Elysia({ prefix: "/status-page" })
    .use(authP)
    .get(
      "/",
      async ({ user, orgId, query, role }) => {
        const pages = await db
          .select()
          .from(statusPages)
          .where(
            and(
              inArray(statusPages.workspaceId, orgWorkspaceIds(db, orgId, user.id)),
              query.workspaceId ? eq(statusPages.workspaceId, query.workspaceId) : undefined,
            ),
          )
          .orderBy(asc(statusPages.createdAt));
        const comps = await withComponents(pages.map((p) => p.id));
        // Only the number: who subscribed is nobody's business but the subscriber's.
        const subs = pages.length
          ? await db
              .select({ pageId: statusSubscribers.pageId, n: count() })
              .from(statusSubscribers)
              .where(
                and(
                  inArray(
                    statusSubscribers.pageId,
                    pages.map((p) => p.id),
                  ),
                  isNotNull(statusSubscribers.confirmedAt),
                ),
              )
              .groupBy(statusSubscribers.pageId)
          : [];
        return pages.map(({ domainToken, ...p }) => ({
          ...p,
          subscribers: subs.find((x) => x.pageId === p.id)?.n ?? 0,
          components: comps.get(p.id) ?? [],
          domainVerified: !!p.domainVerifiedAt,
          // The proof the owner must publish. Only admins see it, and only while it still matters.
          domainChallenge:
            hasRole(role, "admin") && p.customDomain && domainToken && !p.domainVerifiedAt
              ? challengeFor(p.customDomain, domainToken)
              : null,
          domainTarget: appHost,
        }));
      },
      { org: true, query: ListQuery },
    )
    .post(
      "/",
      async ({ user, body, orgId, set }) => {
        await requireWorkspace(db, orgId, body.workspaceId, user.id);
        await checkComponents(body.workspaceId, body.components);
        await checkSecurityAsset(body.workspaceId, body.securityAssetId);
        await billing.assertCanCreate(db, orgId, "statusPages");
        if (body.customDomain) await billing.assertCustomDomain(db, orgId);
        if (body.logoUrl) await billing.assertCustomLogo(db, orgId);
        const { components, ...page } = body;
        try {
          const created = await db.transaction(async (tx) => {
            const [row] = await tx.insert(statusPages).values(page).returning();
            await replaceComponents(tx, row!.id, components);
            return row!;
          });
          forgetStatusPage(created.slug);
          set.status = 201;
          return created;
        } catch (e) {
          if (isDuplicate(e)) throw taken();
          throw e;
        }
      },
      { org: "admin", body: CreateStatusPageSchema },
    )
    .patch(
      "/:id",
      async ({ user, params, body, orgId }) => {
        const [page] = await db
          .select()
          .from(statusPages)
          .where(owned(orgId, user.id, params.id));
        if (!page) throw new HttpError(404, "Status page not found");
        const { components, customDomain, ...fields } = body;
        if (components) await checkComponents(page.workspaceId, components);
        await checkSecurityAsset(page.workspaceId, fields.securityAssetId);
        // Only setting or changing the logo needs the plan: saving other edits on a page that already has one never does.
        if (fields.logoUrl && fields.logoUrl !== page.logoUrl)
          await billing.assertCustomLogo(db, orgId);
        // A new (or cleared) domain starts over: fresh proof to publish, nothing verified.
        const domain: Partial<typeof statusPages.$inferInsert> = {};
        if (customDomain !== undefined && customDomain !== page.customDomain) {
          if (customDomain) await billing.assertCustomDomain(db, orgId);
          if (customDomain && ownHosts.has(customDomain))
            throw new HttpError(422, "That is Upzy's own address. Use a domain you own.");
          domain.customDomain = customDomain;
          domain.domainToken = customDomain ? randomBytes(18).toString("base64url") : null;
          domain.domainVerifiedAt = null;
        }
        try {
          await db.transaction(async (tx) => {
            await tx
              .update(statusPages)
              .set({ ...fields, ...domain, updatedAt: new Date() })
              .where(eq(statusPages.id, page.id));
            if (components) await replaceComponents(tx, page.id, components);
          });
        } catch (e) {
          if (isDuplicate(e)) throw taken();
          throw e;
        }
        forgetStatusPage(
          page.slug,
          fields.slug,
          `domain:${page.customDomain}`,
          `domain:${customDomain}`,
        );
        return { ok: true as const };
      },
      { org: "admin", params: Params, body: UpdateStatusPageSchema },
    )
    .post(
      "/:id/verify-domain",
      async ({ user, params, orgId }) => {
        const [page] = await db
          .select()
          .from(statusPages)
          .where(owned(orgId, user.id, params.id));
        if (!page) throw new HttpError(404, "Status page not found");
        if (!page.customDomain || !page.domainToken)
          throw new HttpError(409, "Set a custom domain first.");
        const want = challengeFor(page.customDomain, page.domainToken);
        const records = await dns.txt(want.name);
        const txt = records.some((r) => r.trim() === want.value);

        // Informational: does the name already lead to Upzy? (Not required for verification, only for the page to load.)
        let pointsToUs: boolean | null = null;
        if (appHost) {
          const cnames = (await dns.cname(page.customDomain)).map((c) =>
            c.replace(/\.$/, "").toLowerCase(),
          );
          if (cnames.includes(appHost)) pointsToUs = true;
          else {
            const ours = await dns.a(appHost);
            const theirs = await dns.a(page.customDomain);
            pointsToUs = theirs.length > 0 && theirs.every((ip) => ours.includes(ip));
          }
        }

        if (txt && !page.domainVerifiedAt) {
          try {
            await db
              .update(statusPages)
              .set({ domainVerifiedAt: new Date(), updatedAt: new Date() })
              .where(eq(statusPages.id, page.id));
          } catch (e) {
            if (isDuplicate(e))
              throw new HttpError(409, "That domain is already verified on another status page.");
            throw e;
          }
          forgetStatusPage(`domain:${page.customDomain}`);
        }
        return { verified: txt || !!page.domainVerifiedAt, txt, pointsToUs };
      },
      { org: "admin", params: Params },
    )
    .delete(
      "/:id",
      async ({ user, params, orgId }) => {
        const rows = await db
          .delete(statusPages)
          .where(owned(orgId, user.id, params.id))
          .returning({
            id: statusPages.id,
            slug: statusPages.slug,
            domain: statusPages.customDomain,
          });
        if (rows.length === 0) throw new HttpError(404, "Status page not found");
        forgetStatusPage(rows[0]!.slug, `domain:${rows[0]!.domain}`);
        return { ok: true as const };
      },
      { org: "admin", params: Params },
    );
};
