import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";

import { createAuth } from "@upzy/auth/server";
import { loadBillingConfig, type DodoClient } from "@upzy/billing";
import { createDb, schema } from "@upzy/db";
import { eq, like } from "drizzle-orm";

import { createApp } from "../src/app";

// Real Postgres + real better-auth. Needs: DATABASE_URL=... bun test
const url = process.env.DATABASE_URL;
const run = url ? describe : describe.skip;

run("billing (postgres)", () => {
  process.env.BETTER_AUTH_SECRET ??= "integration-test-secret-integration-test-secret";
  const db = createDb(url);
  const auth = createAuth(db, {
    sendEmail: async () => {},
    signup: { mode: "open", allowedEmails: [], allowedDomains: [] },
  });
  const tag = `bl${Date.now()}`;
  const origin = "http://localhost:3001";
  let clock = new Date();
  const secretRaw = Buffer.from("dodo-test-signing-secret-0123456789");
  const config = loadBillingConfig({
    DODO_API_KEY: "sk_test",
    DODO_WEBHOOK_SECRET: `whsec_${secretRaw.toString("base64")}`,
    DODO_PRODUCT_STARTER_MONTHLY: "pdt_starter_m",
    DODO_PRODUCT_PRO_MONTHLY: "pdt_pro_m",
    DODO_PRODUCT_PRO_YEARLY: "pdt_pro_y",
  });
  const checkouts: { productId: string; email: string; metadata: Record<string, string> }[] = [];
  const portals: string[] = [];
  const dodo: DodoClient = {
    createCheckout: async (i) => {
      checkouts.push({ productId: i.productId, email: i.email, metadata: i.metadata });
      return {
        url: `https://pay.example/${checkouts.length}`,
        sessionId: `cks_${tag}_${checkouts.length}`,
      };
    },
    createPortal: async (id) => {
      portals.push(id);
      return { url: `https://portal.example/${id}` };
    },
    cancelSubscription: async () => {},
  };
  const baseApp = (billing: object) =>
    createApp({
      db,
      auth,
      webOrigin: origin,
      encryptionKey: Buffer.alloc(32, 4).toString("base64"),
      rateLimit: { rules: [{ match: () => true, bucket: "t", max: Infinity, windowMs: 1 }] },
      billing: billing as never,
    });
  const app = baseApp({ config, dodo, now: () => clock });
  const offApp = baseApp({ config: loadBillingConfig({}) });
  const send = (path: string, init: RequestInit & { cookie?: string; app?: typeof app } = {}) =>
    (init.app ?? app).handle(
      new Request(`http://localhost${path}`, {
        ...init,
        headers: {
          "content-type": "application/json",
          origin,
          ...(init.cookie ? { cookie: init.cookie } : {}),
        },
      }),
    );
  const json = async (r: Response) => (await r.json()) as any;
  const cookieOf = (r: Response) =>
    r.headers
      .getSetCookie()
      .map((c) => c.split(";")[0])
      .join("; ");
  const person = async (name: string) => {
    const r = await send("/api/auth/sign-up/email", {
      method: "POST",
      body: JSON.stringify({
        email: `${tag}-${name}@example.com`,
        password: "supersecret123",
        name,
      }),
    });
    return { cookie: cookieOf(r) };
  };
  const makeOrg = async (who: { cookie: string }, slug: string) => {
    const org = await json(
      await send("/api/auth/organization/create", {
        method: "POST",
        cookie: who.cookie,
        body: JSON.stringify({ name: slug, slug: `${tag}-${slug}` }),
      }),
    );
    await send("/api/auth/organization/set-active", {
      method: "POST",
      cookie: who.cookie,
      body: JSON.stringify({ organizationId: org.id }),
    });
    const [ws] = await db
      .insert(schema.workspaces)
      .values({ orgId: org.id, name: `${slug} ws` })
      .returning({ id: schema.workspaces.id });
    return { orgId: org.id as string, ws: ws!.id };
  };

  const sign = (id: string, body: string, ts = Math.floor(clock.getTime() / 1000)) =>
    `v1,${createHmac("sha256", secretRaw).update(`${id}.${ts}.${body}`).digest("base64")}`;
  let seq = 0;
  const hook = async (event: object, over: { id?: string; ts?: number; badSig?: boolean } = {}) => {
    const body = JSON.stringify(event);
    const id = over.id ?? `msg_${tag}_${++seq}`;
    const ts = over.ts ?? Math.floor(clock.getTime() / 1000);
    return app.handle(
      new Request("http://localhost/webhooks/dodo", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "webhook-id": id,
          "webhook-timestamp": String(ts),
          "webhook-signature": over.badSig ? "v1,AAAA" : sign(id, body, ts),
        },
        body,
      }),
    );
  };
  const call = (who: { cookie: string }, method: string, path: string, body?: unknown) =>
    send(path, { method, cookie: who.cookie, ...(body ? { body: JSON.stringify(body) } : {}) });
  const sub = (type: string, data: object) => ({ type, data });

  let owner: { cookie: string }, member: { cookie: string }, other: { cookie: string };
  let A = { orgId: "", ws: "" };
  let B = { orgId: "", ws: "" };
  const billingOf = async (who = owner) => json(await call(who, "GET", "/billing"));
  const mon = (ws: string, i: number, interval = 300) =>
    call(owner, "POST", "/monitor", {
      workspaceId: ws,
      name: `m${i}`,
      type: "http",
      target: `https://${tag}-${i}.example.com/`,
      interval,
    });

  beforeAll(async () => {
    owner = await person("owner");
    member = await person("member");
    other = await person("other");
    A = await makeOrg(owner, "a");
    B = await makeOrg(other, "b");
    await auth.api.addMember({
      body: {
        userId: (await json(await call(member, "GET", "/api/auth/get-session"))).user.id,
        role: "member",
        organizationId: A.orgId,
      },
    });
    await send("/api/auth/organization/set-active", {
      method: "POST",
      cookie: member.cookie,
      body: JSON.stringify({ organizationId: A.orgId }),
    });
  });
  afterAll(async () => {
    await db.delete(schema.organizations).where(eq(schema.organizations.id, A.orgId));
    await db.delete(schema.organizations).where(eq(schema.organizations.id, B.orgId));
    await db.delete(schema.billingEvents).where(like(schema.billingEvents.id, `msg_${tag}%`));
  });

  test("with billing switched off nobody is limited", async () => {
    const r = await json(await send("/billing", { cookie: other.cookie, app: offApp }));
    expect(r).toMatchObject({ enabled: false, plan: "unlimited", source: "disabled" });
    expect(r.limits.monitors).toBeNull();
    // Far past what Free allows, and a 1-minute interval, and nothing refuses.
    for (let i = 0; i < 12; i++) {
      const res = await send("/monitor", {
        method: "POST",
        cookie: other.cookie,
        app: offApp,
        body: JSON.stringify({
          workspaceId: B.ws,
          name: `x${i}`,
          type: "http",
          target: `https://off-${tag}-${i}.example.com/`,
          interval: 60,
        }),
      });
      expect(res.status).toBe(201);
    }
    expect((await send("/webhooks/dodo", { method: "POST", app: offApp, body: "{}" })).status).toBe(
      404,
    );
  });

  test("a new organization starts a 14-day Pro trial, once", async () => {
    const b = await billingOf();
    expect(b).toMatchObject({ enabled: true, plan: "pro", source: "trial", trialDaysLeft: 14 });
    expect(b.limits.monitors).toBe(100);
    expect(b.plans.map((p: any) => p.id)).toEqual(["free", "starter", "pro", "agency"]);
    expect(b.purchasable.pro).toEqual({ monthly: true, yearly: true });
    expect(b.purchasable.agency).toEqual({ monthly: false, yearly: false });
    clock = new Date(clock.getTime() + 3 * 86_400_000);
    expect((await billingOf()).trialDaysLeft).toBe(11);
  });

  test("when the trial ends the organization is on Free: creating more is refused, what exists keeps running", async () => {
    for (let i = 0; i < 10; i++) expect((await mon(A.ws, i)).status).toBe(201);
    clock = new Date(clock.getTime() + 12 * 86_400_000);
    const b = await billingOf();
    expect(b).toMatchObject({ plan: "free", source: "free", trialDaysLeft: null });
    expect(b.usage.monitors).toBe(10);

    const eleventh = await mon(A.ws, 11);
    expect(eleventh.status).toBe(402);
    expect((await json(eleventh)).message).toBe(
      "The Free plan includes 10 monitors. Upgrade under Settings → Billing to add more.",
    );
    // Free checks at most every 5 minutes.
    const fast = await call(
      owner,
      "PATCH",
      `/monitor/${(await db.select().from(schema.monitors).where(eq(schema.monitors.workspaceId, A.ws)))[0]!.id}`,
      { interval: 60 },
    );
    expect(fast.status).toBe(402);
    expect((await json(fast)).message).toContain("every 5 minutes");
    // Slowing one down is never refused, and listing still works.
    expect((await call(owner, "GET", `/monitor?workspaceId=${A.ws}`)).status).toBe(200);

    // One scanned asset, then the second is refused; onboarding hits the same wall.
    const asset = (v: string) =>
      call(owner, "POST", "/asset", { workspaceId: A.ws, kind: "domain", value: v });
    expect((await asset(`${tag}-one.com`)).status).toBe(201);
    expect((await asset(`${tag}-two.com`)).status).toBe(402);
    expect(
      (
        await call(owner, "POST", "/onboarding/site", {
          workspaceId: A.ws,
          site: `${tag}-three.com`,
        })
      ).status,
    ).toBe(402);

    // One status page, no custom domain.
    const page = (slug: string, extra: object = {}) =>
      call(owner, "POST", "/status-page", {
        workspaceId: A.ws,
        title: slug,
        slug: `${tag.toLowerCase()}-${slug}`,
        components: [],
        ...extra,
      });
    expect((await page("p1")).status).toBe(201);
    expect((await page("p2")).status).toBe(402);
    const created = await json(await call(owner, "GET", `/status-page?workspaceId=${A.ws}`));
    const patch = await call(owner, "PATCH", `/status-page/${created[0].id}`, {
      customDomain: `status.${tag}.com`,
    });
    expect(patch.status).toBe(402);
    expect((await json(patch)).message).toContain("Custom domains");
  });

  test("checkout is for admins, uses the configured product and remembers who asked", async () => {
    expect(
      (await call(member, "POST", "/billing/checkout", { plan: "pro", interval: "monthly" }))
        .status,
    ).toBe(403);
    expect(
      (await call(owner, "POST", "/billing/checkout", { plan: "agency", interval: "monthly" }))
        .status,
    ).toBe(409);
    expect(
      (await call(owner, "POST", "/billing/checkout", { plan: "gold", interval: "monthly" }))
        .status,
    ).toBe(400);
    const r = await json(
      await call(owner, "POST", "/billing/checkout", { plan: "pro", interval: "yearly" }),
    );
    expect(r.url).toStartWith("https://pay.example/");
    expect(checkouts.at(-1)).toMatchObject({
      productId: "pdt_pro_y",
      email: `${tag}-owner@example.com`,
      metadata: { organizationId: A.orgId, plan: "pro", interval: "yearly" },
    });
    const [saved] = await db
      .select()
      .from(schema.billingCheckouts)
      .where(eq(schema.billingCheckouts.organizationId, A.orgId));
    expect(saved).toMatchObject({ plan: "pro", interval: "yearly" });
    // No subscription yet, so there is nothing to manage.
    expect((await call(owner, "POST", "/billing/portal")).status).toBe(409);
  });

  test("webhooks must be signed and fresh", async () => {
    const ev = sub("subscription.active", {
      subscription_id: "sub_x",
      product_id: "pdt_pro_m",
      metadata: { organizationId: A.orgId },
    });
    expect((await hook(ev, { badSig: true })).status).toBe(401);
    expect((await hook(ev, { ts: Math.floor(clock.getTime() / 1000) - 3600 })).status).toBe(401);
    expect((await billingOf()).plan).toBe("free");
  });

  test("an active subscription unlocks its plan, and a repeat of the same delivery changes nothing", async () => {
    const ev = sub("subscription.active", {
      subscription_id: `sub_${tag}`,
      product_id: "pdt_pro_m",
      status: "active",
      next_billing_date: "2026-11-17T00:00:00Z",
      cancel_at_next_billing_date: false,
      customer: { customer_id: `cus_${tag}`, email: `${tag}-owner@example.com` },
      metadata: { organizationId: A.orgId },
    });
    expect((await hook(ev, { id: `msg_${tag}_dup` })).status).toBe(200);
    const b = await billingOf();
    expect(b).toMatchObject({
      plan: "pro",
      source: "paid",
      status: "active",
      interval: "monthly",
      hasCustomer: true,
      cancelAtPeriodEnd: false,
    });
    expect(b.currentPeriodEnd).toStartWith("2026-11-17");
    expect(b.limits.monitors).toBe(100);
    // Limits lifted: the 11th monitor and the second asset now work.
    expect((await mon(A.ws, 11)).status).toBe(201);
    expect(
      (
        await call(owner, "POST", "/asset", {
          workspaceId: A.ws,
          kind: "domain",
          value: `${tag}-two.com`,
        })
      ).status,
    ).toBe(201);

    // The same delivery again, with a different payload: ignored.
    const again = await hook(
      { ...ev, data: { ...ev.data, next_billing_date: "2030-01-01T00:00:00Z" } },
      { id: `msg_${tag}_dup` },
    );
    expect(await json(again)).toMatchObject({ duplicate: true });
    expect((await billingOf()).currentPeriodEnd).toStartWith("2026-11-17");

    // Already subscribed: buy again is refused, manage is offered.
    expect(
      (await call(owner, "POST", "/billing/checkout", { plan: "pro", interval: "monthly" })).status,
    ).toBe(409);
    const portal = await json(await call(owner, "POST", "/billing/portal"));
    expect(portal.url).toBe(`https://portal.example/cus_${tag}`);
    expect(portals).toEqual([`cus_${tag}`]);
  });

  test("renewals, plan changes and scheduled cancellation are tracked by the subscription id", async () => {
    const base = { subscription_id: `sub_${tag}`, customer: { customer_id: `cus_${tag}` } };
    await hook(
      sub("subscription.plan_changed", {
        ...base,
        product_id: "pdt_starter_m",
        next_billing_date: "2026-12-17T00:00:00Z",
      }),
    );
    expect(await billingOf()).toMatchObject({ plan: "starter", status: "active" });
    await hook(
      sub("subscription.updated", { ...base, status: "active", cancel_at_next_billing_date: true }),
    );
    expect(await billingOf()).toMatchObject({ plan: "starter", cancelAtPeriodEnd: true });
    // A product we don't know never changes the plan.
    await hook(
      sub("subscription.renewed", {
        ...base,
        product_id: "pdt_mystery",
        next_billing_date: "2027-01-17T00:00:00Z",
      }),
    );
    expect(await billingOf()).toMatchObject({ plan: "starter", status: "active" });
  });

  test("a late payment keeps the plan for the grace period; on hold or cancelled drops to Free", async () => {
    const base = { subscription_id: `sub_${tag}` };
    await hook(sub("subscription.past_due", base));
    expect(await billingOf()).toMatchObject({
      plan: "starter",
      status: "past_due",
      source: "paid",
    });
    await hook(sub("subscription.on_hold", base));
    expect(await billingOf()).toMatchObject({ plan: "free", status: "on_hold" });
    await hook(sub("subscription.active", { ...base, product_id: "pdt_starter_m" }));
    expect((await billingOf()).plan).toBe("starter");
    await hook(sub("subscription.cancelled", base));
    expect(await billingOf()).toMatchObject({
      plan: "free",
      status: "cancelled",
      cancelAtPeriodEnd: false,
    });
    // Things already created stay: only creating more is limited.
    expect((await call(owner, "GET", `/monitor?workspaceId=${A.ws}`)).status).toBe(200);
  });

  test("the first event of a new subscription finds its organization by the checkout's email when metadata is missing", async () => {
    await db
      .update(schema.subscriptions)
      .set({ providerSubscriptionId: null })
      .where(eq(schema.subscriptions.organizationId, A.orgId));
    // The test clock has moved on since the checkout was saved with the real time.
    await db
      .update(schema.billingCheckouts)
      .set({ createdAt: clock })
      .where(eq(schema.billingCheckouts.organizationId, A.orgId));
    const r = await hook(
      sub("subscription.active", {
        subscription_id: `sub2_${tag}`,
        product_id: "pdt_pro_m",
        customer: { customer_id: `cus2_${tag}`, email: `${tag.toUpperCase()}-OWNER@example.com` },
      }),
    );
    expect(r.status).toBe(200);
    expect(await billingOf()).toMatchObject({ plan: "pro", source: "paid" });
  });

  test("events we can't place or don't use are acknowledged without changing anything", async () => {
    const before = await billingOf();
    expect(
      (
        await hook(
          sub("subscription.active", {
            subscription_id: "sub_stranger",
            product_id: "pdt_pro_m",
            customer: { email: "nobody@nowhere.test" },
          }),
        )
      ).status,
    ).toBe(200);
    expect(
      (await hook(sub("subscription.paused", { subscription_id: `sub2_${tag}` }))).status,
    ).toBe(200);
    expect((await hook({ type: "payment.succeeded", data: {} })).status).toBe(200);
    expect(await billingOf()).toEqual(before);
    // Another organization is untouched by all of it.
    expect((await billingOf(other)).plan).toBe("pro");
    expect((await billingOf(other)).source).toBe("trial");
  });
});
