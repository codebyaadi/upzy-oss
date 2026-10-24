import {
  PLANS,
  TRIAL_DAYS,
  createDodoClient,
  customDomainMessage,
  entitlement,
  intervalMessage,
  limitMessage,
  customLogoMessage,
  ssoMessage,
  regionsMessage,
  browserMonitorsMessage,
  loadBillingConfig,
  type BillingConfig,
  type DodoClient,
  type Entitlement,
  type Resource,
  type SubscriptionRow,
} from "@upzy/billing";
import { schema, type Db } from "@upzy/db";
import { and, count, eq, inArray } from "drizzle-orm";

import { HttpError } from "../plugins/errors";
import { allOrgWorkspaceIds } from "./scope";

const { subscriptions, workspaces, monitors, assets, statusPages } = schema;

export interface BillingDeps {
  config: BillingConfig;
  /** Talks to the payment provider. Tests inject a fake. */
  dodo?: DodoClient;
  now?: () => Date;
}

export type Billing = ReturnType<typeof createBilling>;

/**
 * Plans and limits for an organization. Limits only ever stop *creating* more of something: monitoring, alerting
 * and public status pages keep running whatever the plan, so a billing problem can never silence an outage alert.
 */
export function createBilling(deps: BillingDeps = { config: loadBillingConfig(process.env) }) {
  const now = deps.now ?? (() => new Date());
  const { config } = deps;
  const dodo = deps.dodo ?? (config.enabled ? createDodoClient(config) : undefined);

  /** The organization's row. The first look starts its 14-day Pro trial; it is never started twice. */
  async function row(db: Db, orgId: string) {
    const [existing] = await db
      .select()
      .from(subscriptions)
      .where(eq(subscriptions.organizationId, orgId));
    if (existing?.trialEndsAt || !config.enabled) return existing;
    const trialEndsAt = new Date(now().getTime() + TRIAL_DAYS * 86_400_000);
    const [saved] = await db
      .insert(subscriptions)
      .values({ organizationId: orgId, trialEndsAt })
      .onConflictDoUpdate({ target: subscriptions.organizationId, set: { trialEndsAt } })
      .returning();
    return saved;
  }

  async function entitlementFor(
    db: Db,
    orgId: string,
  ): Promise<{ ent: Entitlement; sub: typeof subscriptions.$inferSelect | undefined }> {
    const sub = await row(db, orgId);
    const asRow: SubscriptionRow | undefined = sub && {
      plan: sub.plan,
      status: sub.status,
      trialEndsAt: sub.trialEndsAt,
    };
    return { ent: entitlement({ billingEnabled: config.enabled, sub: asRow, now: now() }), sub };
  }

  async function usage(db: Db, orgId: string): Promise<Record<Resource, number>> {
    // Plan limits count the whole organization, whatever the caller is allowed to see.
    const ids = allOrgWorkspaceIds(db, orgId);
    const one = async (table: typeof monitors | typeof assets | typeof statusPages) => {
      const [r] = await db
        .select({ n: count() })
        .from(table)
        .where(inArray(table.workspaceId, ids));
      return r?.n ?? 0;
    };
    return {
      monitors: await one(monitors),
      assets: await one(assets),
      statusPages: await one(statusPages),
    };
  }

  /** Refuses (402) when adding `add` more of a resource would pass the plan's limit. */
  async function assertCanCreate(db: Db, orgId: string, resource: Resource, add = 1) {
    const { ent } = await entitlementFor(db, orgId);
    const limit = PLANS[ent.plan].limits[resource];
    if (limit === Infinity) return;
    const used = (await usage(db, orgId))[resource] ?? 0;
    if (used + add > limit) throw new HttpError(402, limitMessage(ent.plan, resource, limit));
  }

  async function assertInterval(db: Db, orgId: string, interval: number) {
    const { ent } = await entitlementFor(db, orgId);
    const min = PLANS[ent.plan].limits.minInterval;
    if (interval < min) throw new HttpError(402, intervalMessage(ent.plan, min));
  }

  /** Refuses (402) when a monitor would be checked from more places than the plan includes. */
  async function assertRegions(db: Db, orgId: string, places: number) {
    const { ent } = await entitlementFor(db, orgId);
    const max = PLANS[ent.plan].limits.regions;
    if (places > max) throw new HttpError(402, regionsMessage(ent.plan, max));
  }

  /** Refuses (402) when the plan doesn't include single sign-on. */
  async function assertSso(db: Db, orgId: string) {
    const { ent } = await entitlementFor(db, orgId);
    if (!PLANS[ent.plan].limits.sso) throw new HttpError(402, ssoMessage(ent.plan));
  }

  /** Refuses (402) when one more browser monitor would pass the plan's limit. */
  async function assertBrowserMonitor(db: Db, orgId: string) {
    const { ent } = await entitlementFor(db, orgId);
    const max = PLANS[ent.plan].limits.browserMonitors;
    if (max === Infinity) return;
    const [r] = await db
      .select({ n: count() })
      .from(monitors)
      .where(
        and(
          inArray(monitors.workspaceId, allOrgWorkspaceIds(db, orgId)),
          eq(monitors.type, "synthetic"),
        ),
      );
    if ((r?.n ?? 0) + 1 > max) throw new HttpError(402, browserMonitorsMessage(ent.plan, max));
  }

  async function assertCustomDomain(db: Db, orgId: string) {
    const { ent } = await entitlementFor(db, orgId);
    if (!PLANS[ent.plan].limits.customDomain)
      throw new HttpError(402, customDomainMessage(ent.plan));
  }

  async function assertCustomLogo(db: Db, orgId: string) {
    const { ent } = await entitlementFor(db, orgId);
    if (!PLANS[ent.plan].limits.customLogo) throw new HttpError(402, customLogoMessage(ent.plan));
  }

  /** Whether this organization's plan currently includes a custom logo (checked when the page is shown, so a downgrade takes effect). */
  async function customLogoAllowed(db: Db, orgId: string) {
    const { ent } = await entitlementFor(db, orgId);
    return PLANS[ent.plan].limits.customLogo;
  }

  return {
    config,
    dodo,
    now,
    row,
    entitlementFor,
    usage,
    assertCanCreate,
    assertInterval,
    assertRegions,
    assertBrowserMonitor,
    assertSso,
    assertCustomDomain,
    assertCustomLogo,
    customLogoAllowed,
    workspaces,
  };
}
