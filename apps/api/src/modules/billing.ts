import {
  PAID_PLANS,
  PLANS,
  planForProduct,
  verifyWebhook,
  DodoError,
  type Interval,
  type PaidPlan,
} from "@upzy/billing";
import { schema, type Db } from "@upzy/db";
import { and, desc, eq, gte } from "drizzle-orm";
import { Elysia } from "elysia";
import { z } from "zod";

import type { Billing } from "../lib/billing";
import type { AuthPlugin } from "../plugins/auth";
import { HttpError } from "../plugins/errors";

const { subscriptions, billingCheckouts, billingEvents } = schema;

const CheckoutBody = z.object({
  plan: z.enum(["starter", "pro", "agency"]),
  interval: z.enum(["monthly", "yearly"]),
});

/** The parts of a Dodo subscription webhook that we read. Anything else is ignored. */
interface WebhookEvent {
  type?: string;
  data?: {
    subscription_id?: string;
    product_id?: string;
    status?: string;
    next_billing_date?: string;
    cancel_at_next_billing_date?: boolean;
    customer?: { customer_id?: string; email?: string };
    metadata?: Record<string, unknown>;
  };
}

const publicPlans = () =>
  (["free", ...PAID_PLANS] as const).map((id) => {
    const p = PLANS[id];
    return { id, name: p.name, blurb: p.blurb, price: p.price, limits: p.limits };
  });

export const billingModule = (db: Db, authP: AuthPlugin, billing: Billing, webOrigin: string) => {
  return (
    new Elysia()
      .use(authP)
      .get(
        "/billing",
        async ({ orgId }) => {
          const { ent, sub } = await billing.entitlementFor(db, orgId);
          const used = await billing.usage(db, orgId);
          const limits = PLANS[ent.plan].limits;
          return {
            enabled: billing.config.enabled,
            mode: billing.config.mode,
            plan: ent.plan,
            planName: PLANS[ent.plan].name,
            source: ent.source,
            trialDaysLeft: ent.trialDaysLeft,
            status: sub?.status ?? "none",
            interval: sub?.interval ?? null,
            currentPeriodEnd: sub?.currentPeriodEnd ?? null,
            cancelAtPeriodEnd: sub?.cancelAtPeriodEnd ?? false,
            hasCustomer: !!sub?.providerCustomerId,
            // Infinity is not JSON: null means "no limit".
            limits: {
              monitors: Number.isFinite(limits.monitors) ? limits.monitors : null,
              assets: Number.isFinite(limits.assets) ? limits.assets : null,
              statusPages: Number.isFinite(limits.statusPages) ? limits.statusPages : null,
              minInterval: limits.minInterval,
              customDomain: limits.customDomain,
            },
            usage: used,
            plans: publicPlans(),
            // Which paid plans can actually be bought: the operator has to create each product in Dodo.
            purchasable: Object.fromEntries(
              PAID_PLANS.map((p) => [
                p,
                {
                  monthly: !!billing.config.products[p]?.monthly,
                  yearly: !!billing.config.products[p]?.yearly,
                },
              ]),
            ),
          };
        },
        { org: true },
      )
      .post(
        "/billing/checkout",
        async ({ body, orgId, user }) => {
          if (!billing.config.enabled || !billing.dodo)
            throw new HttpError(409, "Billing isn't switched on for this installation.");
          const productId =
            billing.config.products[body.plan as PaidPlan]?.[body.interval as Interval];
          if (!productId) throw new HttpError(409, "That plan isn't available to buy yet.");
          const { ent, sub } = await billing.entitlementFor(db, orgId);
          if (ent.source === "paid" && sub?.providerSubscriptionId)
            throw new HttpError(
              409,
              "You already have a subscription. Change it from Manage billing.",
            );
          try {
            const r = await billing.dodo.createCheckout({
              productId,
              email: user.email,
              name: user.name,
              returnUrl: `${webOrigin}/settings/billing?checkout=done`,
              metadata: { organizationId: orgId, plan: body.plan, interval: body.interval },
            });
            await db.insert(billingCheckouts).values({
              sessionId: r.sessionId,
              organizationId: orgId,
              email: user.email.toLowerCase(),
              plan: body.plan,
              interval: body.interval,
            });
            return { url: r.url };
          } catch (e) {
            if (e instanceof DodoError) throw new HttpError(502, e.message);
            throw e;
          }
        },
        { org: "admin", body: CheckoutBody },
      )
      .post(
        "/billing/portal",
        async ({ orgId }) => {
          const { sub } = await billing.entitlementFor(db, orgId);
          if (!billing.dodo || !sub?.providerCustomerId)
            throw new HttpError(409, "There's no subscription to manage yet.");
          try {
            return await billing.dodo.createPortal(
              sub.providerCustomerId,
              `${webOrigin}/settings/billing`,
            );
          } catch (e) {
            if (e instanceof DodoError) throw new HttpError(502, e.message);
            throw e;
          }
        },
        { org: "admin" },
      )
      // Dodo calls this. It is public: the signature is the only credential, so nothing is read before it checks out.
      .post(
        "/webhooks/dodo",
        async ({ request, set }) => {
          if (!billing.config.enabled) throw new HttpError(404, "Not found");
          const raw = await request.text();
          const ok = verifyWebhook({
            secret: billing.config.webhookSecret,
            id: request.headers.get("webhook-id"),
            timestamp: request.headers.get("webhook-timestamp"),
            signature: request.headers.get("webhook-signature"),
            body: raw,
            now: billing.now().getTime(),
          });
          if (!ok) throw new HttpError(401, "Invalid signature");

          let event: WebhookEvent;
          try {
            event = JSON.parse(raw) as WebhookEvent;
          } catch {
            throw new HttpError(400, "Invalid payload");
          }
          const webhookId = request.headers.get("webhook-id")!;
          // At-least-once delivery: a repeat of an event we have handled changes nothing.
          const fresh = await db
            .insert(billingEvents)
            .values({ id: webhookId, type: String(event.type ?? "") })
            .onConflictDoNothing()
            .returning({ id: billingEvents.id });
          if (fresh.length === 0) return { ok: true, duplicate: true };

          try {
            await applyEvent(event);
          } catch (e) {
            // Let the provider retry: forget we saw it.
            await db.delete(billingEvents).where(eq(billingEvents.id, webhookId));
            throw e;
          }
          set.status = 200;
          return { ok: true };
        },
        // The signature covers the exact bytes sent, so the body must reach the handler unparsed.
        { parse: "none" },
      )
  );

  async function orgFor(d: NonNullable<WebhookEvent["data"]>): Promise<string | undefined> {
    const fromMeta = d.metadata?.organizationId;
    if (typeof fromMeta === "string") {
      const [s] = await db
        .select({ id: subscriptions.organizationId })
        .from(subscriptions)
        .where(eq(subscriptions.organizationId, fromMeta));
      if (s) return s.id;
      const [c] = await db
        .select({ id: billingCheckouts.organizationId })
        .from(billingCheckouts)
        .where(eq(billingCheckouts.organizationId, fromMeta))
        .limit(1);
      if (c) return c.id;
    }
    if (d.subscription_id) {
      const [s] = await db
        .select({ id: subscriptions.organizationId })
        .from(subscriptions)
        .where(eq(subscriptions.providerSubscriptionId, d.subscription_id));
      if (s) return s.id;
    }
    // The first event for a new subscription: match the checkout we started for this customer's email.
    if (d.customer?.email) {
      const since = new Date(billing.now().getTime() - 3 * 86_400_000);
      const [c] = await db
        .select({ id: billingCheckouts.organizationId })
        .from(billingCheckouts)
        .where(
          and(
            eq(billingCheckouts.email, d.customer.email.toLowerCase()),
            gte(billingCheckouts.createdAt, since),
          ),
        )
        .orderBy(desc(billingCheckouts.createdAt))
        .limit(1);
      if (c) return c.id;
    }
    return undefined;
  }

  async function applyEvent(event: WebhookEvent) {
    const type = event.type ?? "";
    const d = event.data;
    if (!type.startsWith("subscription.") || !d) return;
    const orgId = await orgFor(d);
    // An event for something we can't place: acknowledge it (retrying won't help) and let it be investigated.
    if (!orgId) {
      console.warn(
        `[billing] ${type} for an unknown organization (subscription ${d.subscription_id ?? "?"})`,
      );
      return;
    }
    await billing.row(db, orgId);

    const known = planForProduct(billing.config, d.product_id);
    const set: Partial<typeof subscriptions.$inferInsert> = {
      updatedAt: billing.now(),
      ...(d.customer?.customer_id ? { providerCustomerId: d.customer.customer_id } : {}),
      ...(d.subscription_id ? { providerSubscriptionId: d.subscription_id } : {}),
      ...(d.next_billing_date ? { currentPeriodEnd: new Date(d.next_billing_date) } : {}),
      ...(typeof d.cancel_at_next_billing_date === "boolean"
        ? { cancelAtPeriodEnd: d.cancel_at_next_billing_date }
        : {}),
    };
    // A product we don't recognise never changes the plan: better to keep what was paid for than to guess.
    if (known) Object.assign(set, { plan: known.plan, interval: known.interval });

    switch (type) {
      case "subscription.active":
      case "subscription.renewed":
      case "subscription.updated":
      case "subscription.plan_changed":
        // `updated` can carry any status, so trust it; the others mean "paid and running".
        Object.assign(set, {
          status: type === "subscription.updated" ? statusOf(d.status) : "active",
        });
        break;
      case "subscription.past_due":
        set.status = "past_due";
        break;
      case "subscription.on_hold":
        set.status = "on_hold";
        break;
      case "subscription.cancelled":
      case "subscription.expired":
      case "subscription.failed":
        set.status = "cancelled";
        set.cancelAtPeriodEnd = false;
        break;
      default:
        return; // paused, unpaused, payment-method changes: nothing for us to do
    }
    await db.update(subscriptions).set(set).where(eq(subscriptions.organizationId, orgId));
  }

  function statusOf(s: string | undefined): "active" | "past_due" | "on_hold" | "cancelled" {
    if (s === "past_due") return "past_due";
    if (s === "on_hold" || s === "paused") return "on_hold";
    if (s === "cancelled" || s === "expired" || s === "failed") return "cancelled";
    return "active";
  }
};
