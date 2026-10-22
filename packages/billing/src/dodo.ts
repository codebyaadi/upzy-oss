import { createHmac, timingSafeEqual } from "node:crypto";

import { PAID_PLANS, type Interval, type PaidPlan } from "./plans";

export interface BillingConfig {
  /** True only when both the API key and the webhook secret are set. */
  enabled: boolean;
  apiKey: string;
  webhookSecret: string;
  mode: "test" | "live";
  /** Dodo product ids, created in the Dodo dashboard. */
  products: Partial<Record<PaidPlan, Partial<Record<Interval, string>>>>;
}

export function loadBillingConfig(env: Record<string, string | undefined>): BillingConfig {
  const apiKey = env.DODO_API_KEY?.trim() ?? "";
  const webhookSecret = env.DODO_WEBHOOK_SECRET?.trim() ?? "";
  const products: BillingConfig["products"] = {};
  for (const plan of PAID_PLANS)
    for (const interval of ["monthly", "yearly"] as const) {
      const id = env[`DODO_PRODUCT_${plan.toUpperCase()}_${interval.toUpperCase()}`]?.trim();
      if (id) (products[plan] ??= {})[interval] = id;
    }
  return {
    enabled: !!apiKey && !!webhookSecret,
    apiKey,
    webhookSecret,
    mode: env.DODO_MODE === "live" ? "live" : "test",
    products,
  };
}

/** Which plan and interval a Dodo product id is. */
export function planForProduct(
  config: Pick<BillingConfig, "products">,
  productId: string | undefined | null,
): { plan: PaidPlan; interval: Interval } | undefined {
  if (!productId) return undefined;
  for (const plan of PAID_PLANS)
    for (const interval of ["monthly", "yearly"] as const)
      if (config.products[plan]?.[interval] === productId) return { plan, interval };
  return undefined;
}

/**
 * Standard Webhooks signature check (what Dodo uses): HMAC-SHA256 over `${id}.${timestamp}.${rawBody}` with the
 * secret's base64 payload (after "whsec_"), compared in constant time against every `v1,<sig>` in the header.
 * Stale timestamps are refused so a captured request can't be replayed later.
 */
export function verifyWebhook(opts: {
  secret: string;
  id: string | null;
  timestamp: string | null;
  signature: string | null;
  body: string;
  now?: number;
  toleranceSeconds?: number;
}): boolean {
  const { secret, id, timestamp, signature, body } = opts;
  if (!id || !timestamp || !signature || !secret) return false;
  const ts = Number(timestamp);
  const now = (opts.now ?? Date.now()) / 1000;
  if (!Number.isFinite(ts) || Math.abs(now - ts) > (opts.toleranceSeconds ?? 300)) return false;
  const key = secret.startsWith("whsec_")
    ? Buffer.from(secret.slice(6), "base64")
    : Buffer.from(secret, "utf8");
  const expected = createHmac("sha256", key).update(`${id}.${timestamp}.${body}`).digest();
  return signature.split(" ").some((part) => {
    const [version, sig] = part.split(",");
    if (version !== "v1" || !sig) return false;
    const given = Buffer.from(sig, "base64");
    return given.length === expected.length && timingSafeEqual(given, expected);
  });
}

type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

export interface DodoClient {
  createCheckout(input: {
    productId: string;
    email: string;
    name?: string;
    returnUrl: string;
    metadata: Record<string, string>;
  }): Promise<{ url: string; sessionId: string }>;
  createPortal(customerId: string, returnUrl?: string): Promise<{ url: string }>;
  /** Ends a subscription right away (no further charges). */
  cancelSubscription(subscriptionId: string): Promise<void>;
}

export class DodoError extends Error {}

/** The few Dodo calls Upzy needs. `fetch` is injectable so tests never touch the network. */
export function createDodoClient(
  config: Pick<BillingConfig, "apiKey" | "mode">,
  fetchImpl: Fetch = fetch,
): DodoClient {
  const base =
    config.mode === "live" ? "https://live.dodopayments.com" : "https://test.dodopayments.com";
  async function call<T>(path: string, init: RequestInit): Promise<T> {
    let res: Response;
    try {
      res = await fetchImpl(`${base}${path}`, {
        ...init,
        headers: {
          authorization: `Bearer ${config.apiKey}`,
          "content-type": "application/json",
          ...init.headers,
        },
        signal: AbortSignal.timeout(15_000),
      });
    } catch {
      throw new DodoError("The payment provider couldn't be reached. Try again in a moment.");
    }
    if (!res.ok) throw new DodoError(`The payment provider refused the request (${res.status}).`);
    return (await res.json()) as T;
  }
  return {
    async createCheckout({ productId, email, name, returnUrl, metadata }) {
      const r = await call<{ session_id: string; checkout_url: string | null }>("/checkouts", {
        method: "POST",
        body: JSON.stringify({
          product_cart: [{ product_id: productId, quantity: 1 }],
          customer: { email, ...(name ? { name } : {}) },
          return_url: returnUrl,
          metadata,
        }),
      });
      if (!r.checkout_url)
        throw new DodoError("The payment provider didn't return a checkout link.");
      return { url: r.checkout_url, sessionId: r.session_id };
    },
    async createPortal(customerId, returnUrl) {
      const qs = returnUrl ? `?return_url=${encodeURIComponent(returnUrl)}` : "";
      const r = await call<{ link: string }>(
        `/customers/${encodeURIComponent(customerId)}/customer-portal/session${qs}`,
        { method: "POST" },
      );
      return { url: r.link };
    },
    async cancelSubscription(subscriptionId) {
      await call(`/subscriptions/${encodeURIComponent(subscriptionId)}`, {
        method: "PATCH",
        body: JSON.stringify({ status: "cancelled" }),
      });
    },
  };
}
