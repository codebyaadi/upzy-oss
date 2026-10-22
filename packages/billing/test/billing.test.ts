import { describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";

import {
  PLANS,
  createDodoClient,
  entitlement,
  intervalMessage,
  limitMessage,
  loadBillingConfig,
  planForProduct,
  verifyWebhook,
} from "../src";

const NOW = new Date("2026-10-17T12:00:00Z");
const days = (n: number) => new Date(NOW.getTime() + n * 86_400_000);

describe("plans", () => {
  test("every limit grows with the plan, and yearly is two months free", () => {
    const order = ["free", "starter", "pro", "agency"] as const;
    for (let i = 1; i < order.length; i++) {
      const a = PLANS[order[i - 1]!].limits;
      const b = PLANS[order[i]!].limits;
      expect(b.monitors).toBeGreaterThan(a.monitors);
      expect(b.assets).toBeGreaterThan(a.assets);
      expect(b.minInterval).toBeLessThanOrEqual(a.minInterval);
    }
    for (const p of ["starter", "pro", "agency"] as const)
      expect(PLANS[p].price.yearly).toBe(PLANS[p].price.monthly * 10);
    expect(PLANS.free.limits.customDomain).toBe(false);
    expect(PLANS.starter.limits.customDomain).toBe(true);
  });

  test("refusals say what the plan has and where to upgrade", () => {
    expect(limitMessage("free", "monitors", 10)).toBe(
      "The Free plan includes 10 monitors. Upgrade under Settings → Billing to add more.",
    );
    expect(limitMessage("free", "statusPages", 1)).toContain("1 status page.");
    expect(intervalMessage("free", 300)).toContain("every 5 minutes");
  });
});

describe("entitlement", () => {
  const sub = (over: object) => ({
    plan: null,
    status: "none" as const,
    trialEndsAt: null,
    ...over,
  });

  test("with billing off, everyone is unlimited", () => {
    expect(entitlement({ billingEnabled: false, sub: undefined, now: NOW }).plan).toBe("unlimited");
  });

  test("a paid, active or late subscription gives its plan", () => {
    expect(
      entitlement({
        billingEnabled: true,
        sub: sub({ plan: "starter", status: "active" }),
        now: NOW,
      }),
    ).toEqual({
      plan: "starter",
      source: "paid",
      trialDaysLeft: null,
    });
    expect(
      entitlement({ billingEnabled: true, sub: sub({ plan: "pro", status: "past_due" }), now: NOW })
        .plan,
    ).toBe("pro");
  });

  test("a running trial is Pro, and it ends on time", () => {
    const e = entitlement({ billingEnabled: true, sub: sub({ trialEndsAt: days(9) }), now: NOW });
    expect(e).toEqual({ plan: "pro", source: "trial", trialDaysLeft: 9 });
    expect(
      entitlement({ billingEnabled: true, sub: sub({ trialEndsAt: days(-1) }), now: NOW }).plan,
    ).toBe("free");
  });

  test("on hold or cancelled falls back to the trial if there is one, else Free", () => {
    expect(
      entitlement({ billingEnabled: true, sub: sub({ plan: "pro", status: "on_hold" }), now: NOW })
        .plan,
    ).toBe("free");
    expect(
      entitlement({
        billingEnabled: true,
        sub: sub({ plan: "pro", status: "cancelled" }),
        now: NOW,
      }).plan,
    ).toBe("free");
    expect(
      entitlement({
        billingEnabled: true,
        sub: sub({ plan: "pro", status: "cancelled", trialEndsAt: days(3) }),
        now: NOW,
      }).source,
    ).toBe("trial");
    expect(entitlement({ billingEnabled: true, sub: undefined, now: NOW }).plan).toBe("free");
  });
});

describe("config", () => {
  test("billing is on only with both the key and the webhook secret", () => {
    expect(loadBillingConfig({}).enabled).toBe(false);
    expect(loadBillingConfig({ DODO_API_KEY: "k" }).enabled).toBe(false);
    const c = loadBillingConfig({
      DODO_API_KEY: "k",
      DODO_WEBHOOK_SECRET: "whsec_x",
      DODO_PRODUCT_PRO_MONTHLY: "pdt_pro_m",
      DODO_PRODUCT_PRO_YEARLY: "pdt_pro_y",
      DODO_PRODUCT_STARTER_MONTHLY: "pdt_s_m",
    });
    expect(c.enabled).toBe(true);
    expect(c.mode).toBe("test");
    expect(loadBillingConfig({ DODO_MODE: "live" }).mode).toBe("live");
    expect(planForProduct(c, "pdt_pro_y")).toEqual({ plan: "pro", interval: "yearly" });
    expect(planForProduct(c, "pdt_s_m")).toEqual({ plan: "starter", interval: "monthly" });
    expect(planForProduct(c, "pdt_other")).toBeUndefined();
    expect(planForProduct(c, undefined)).toBeUndefined();
  });
});

describe("webhook signatures", () => {
  const raw = Buffer.from("super-secret-signing-key-0123456789");
  const secret = `whsec_${raw.toString("base64")}`;
  const body = JSON.stringify({ type: "subscription.active", data: { subscription_id: "sub_1" } });
  const id = "msg_123";
  const ts = String(Math.floor(NOW.getTime() / 1000));
  // Computed here from the spec, not by the code under test.
  const sig = createHmac("sha256", raw).update(`${id}.${ts}.${body}`).digest("base64");
  const ok = (over: object = {}) =>
    verifyWebhook({
      secret,
      id,
      timestamp: ts,
      signature: `v1,${sig}`,
      body,
      now: NOW.getTime(),
      ...over,
    });

  test("a correct signature passes, including among several", () => {
    expect(ok()).toBe(true);
    expect(ok({ signature: `v1,AAAA v1,${sig}` })).toBe(true);
  });

  test("a changed body, wrong key, missing header or wrong version fails", () => {
    expect(ok({ body: body + " " })).toBe(false);
    expect(ok({ secret: `whsec_${Buffer.from("other").toString("base64")}` })).toBe(false);
    expect(ok({ id: "msg_999" })).toBe(false);
    expect(ok({ signature: null })).toBe(false);
    expect(ok({ id: null })).toBe(false);
    expect(ok({ signature: `v2,${sig}` })).toBe(false);
    expect(ok({ signature: sig })).toBe(false);
  });

  test("a stale or future timestamp is refused (replay protection)", () => {
    const old = String(Math.floor(NOW.getTime() / 1000) - 3600);
    const oldSig = createHmac("sha256", raw).update(`${id}.${old}.${body}`).digest("base64");
    expect(ok({ timestamp: old, signature: `v1,${oldSig}` })).toBe(false);
    expect(ok({ timestamp: "not-a-number" })).toBe(false);
  });
});

describe("Dodo client", () => {
  const calls: { url: string; init: RequestInit }[] = [];
  const fake =
    (res: object, status = 200) =>
    async (url: string, init?: RequestInit) => {
      calls.push({ url, init: init ?? {} });
      return new Response(JSON.stringify(res), { status });
    };

  test("creates a checkout with the product, customer and metadata", async () => {
    const c = createDodoClient(
      { apiKey: "sk", mode: "test" },
      fake({ session_id: "cks_1", checkout_url: "https://pay/1" }),
    );
    const r = await c.createCheckout({
      productId: "pdt_1",
      email: "a@b.co",
      returnUrl: "https://app/billing",
      metadata: { organizationId: "org1" },
    });
    expect(r).toEqual({ url: "https://pay/1", sessionId: "cks_1" });
    const call = calls.at(-1)!;
    expect(call.url).toBe("https://test.dodopayments.com/checkouts");
    expect((call.init.headers as Record<string, string>).authorization).toBe("Bearer sk");
    expect(JSON.parse(call.init.body as string)).toEqual({
      product_cart: [{ product_id: "pdt_1", quantity: 1 }],
      customer: { email: "a@b.co" },
      return_url: "https://app/billing",
      metadata: { organizationId: "org1" },
    });
  });

  test("live mode uses the live host; a portal session returns its link", async () => {
    const c = createDodoClient({ apiKey: "sk", mode: "live" }, fake({ link: "https://portal/x" }));
    expect(await c.createPortal("cus_1", "https://app/b")).toEqual({ url: "https://portal/x" });
    expect(calls.at(-1)!.url).toBe(
      "https://live.dodopayments.com/customers/cus_1/customer-portal/session?return_url=https%3A%2F%2Fapp%2Fb",
    );
  });

  test("errors are readable and never include the key or response body", async () => {
    const bad = createDodoClient(
      { apiKey: "sk_secret", mode: "test" },
      fake({ detail: "sk_secret leaked" }, 422),
    );
    const err = (await bad.createPortal("c").catch((e) => e)) as Error;
    expect(err.message).toContain("422");
    expect(err.message).not.toContain("sk_secret");
    const noUrl = createDodoClient(
      { apiKey: "k", mode: "test" },
      fake({ session_id: "s", checkout_url: null }),
    );
    await expect(
      noUrl.createCheckout({ productId: "p", email: "e@x.co", returnUrl: "u", metadata: {} }),
    ).rejects.toThrow("checkout link");
  });
});
