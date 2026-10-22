"use client";

import { Button } from "@upzy/ui/components/button";
import { toast } from "@upzy/ui/components/sonner";
import { cn } from "@upzy/ui/lib/utils";
import { useEffect, useState } from "react";

import { Can } from "@/components/app/can";
import { Segmented } from "@/components/app/segmented";
import { ErrorNote, PageHeader, Panel } from "@/components/app/ui";
import { PlanGrid, price } from "@/components/plan-cards";
import { api } from "@/lib/api";
import { dateTime } from "@/lib/format";
import { useAction } from "@/lib/use-action";
import { unwrap, useApi } from "@/lib/use-api";

type Interval = "monthly" | "yearly";
type Paid = "starter" | "pro" | "agency";

const STATUS_NOTE: Record<string, string> = {
  past_due:
    "Your last payment didn't go through. Your plan stays active for now: update your payment method.",
  on_hold:
    "Your subscription is on hold because a payment failed. Update your payment method to restore it.",
  cancelled: "Your subscription ended.",
};

function Meter({ label, used, limit }: { label: string; used: number; limit: number | null }) {
  const pct = limit ? Math.min(100, Math.round((used / limit) * 100)) : 0;
  const over = limit !== null && used > limit;
  return (
    <div>
      <div className="mb-1 flex items-baseline justify-between text-sm">
        <span className="font-semibold">{label}</span>
        <span className={cn("text-muted-foreground", over && "text-destructive font-semibold")}>
          {used} of {limit ?? "unlimited"}
        </span>
      </div>
      <div
        className="bg-muted h-2 overflow-hidden rounded-full"
        role="img"
        aria-label={`${label}: ${used} of ${limit ?? "unlimited"}`}
      >
        <div
          className={cn(
            "h-full rounded-full",
            over ? "bg-destructive" : pct > 85 ? "bg-amber-400" : "bg-brand",
          )}
          style={{ width: limit ? `${pct}%` : "6%" }}
        />
      </div>
    </div>
  );
}

export default function BillingPage() {
  const { run, isPending } = useAction();
  const [interval, setInterval] = useState<Interval>("monthly");
  // After paying, the webhook can take a few seconds: poll until the plan shows up.
  const [returning, setReturning] = useState(false);
  const billing = useApi("billing", () => unwrap(api.billing.get()), {
    refreshInterval: returning ? 3_000 : 30_000,
  });

  useEffect(() => {
    if (new URLSearchParams(window.location.search).get("checkout") === "done") {
      setReturning(true);
      window.history.replaceState(null, "", window.location.pathname);
      const t = setTimeout(() => setReturning(false), 90_000);
      return () => clearTimeout(t);
    }
  }, []);
  useEffect(() => {
    if (returning && billing.data?.source === "paid") {
      setReturning(false);
      toast.success("You're subscribed", { description: `Welcome to ${billing.data.planName}.` });
    }
  }, [returning, billing.data]);

  const b = billing.data;

  const checkout = (plan: Paid) =>
    run(
      `buy:${plan}`,
      async () => {
        const r = await unwrap(api.billing.checkout.post({ plan, interval }));
        window.location.assign(r.url);
      },
      { error: "Couldn't start checkout" },
    );
  const portal = () =>
    run(
      "portal",
      async () => {
        const r = await unwrap(api.billing.portal.post());
        window.location.assign(r.url);
      },
      { error: "Couldn't open billing" },
    );

  return (
    <>
      <PageHeader
        title="Billing"
        description="Your plan, what you're using, and how to change it."
      />
      <ErrorNote error={billing.error} />
      {b && !b.enabled && (
        <Panel className="mb-4">
          <p className="font-semibold">Billing isn&apos;t switched on for this installation.</p>
          <p className="text-muted-foreground mt-1 text-sm">
            There are no plan limits here: everything is available. If you run this installation,
            set the Dodo Payments keys to turn plans on (see docs/BILLING.md).
          </p>
        </Panel>
      )}
      {returning && (
        <Panel className="mb-4">
          <p className="font-semibold">Thanks! Confirming your payment…</p>
          <p className="text-muted-foreground mt-1 text-sm">
            This usually takes a few seconds. Your plan updates here by itself.
          </p>
        </Panel>
      )}

      {b && (
        <div className="grid gap-4 lg:grid-cols-[1fr_22rem]">
          <Panel>
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div>
                <p className="text-muted-foreground text-xs font-semibold tracking-wide uppercase">
                  Current plan
                </p>
                <h2 className="mt-1 text-3xl font-extrabold tracking-tight">{b.planName}</h2>
                <p className="text-muted-foreground mt-2 text-sm">
                  {b.source === "trial" &&
                    `Free trial of Pro: ${b.trialDaysLeft} day${b.trialDaysLeft === 1 ? "" : "s"} left. After that you stay on Free unless you pick a plan.`}
                  {b.source === "paid" &&
                    (b.cancelAtPeriodEnd
                      ? `Cancels on ${b.currentPeriodEnd ? dateTime(b.currentPeriodEnd) : "the next billing date"}.`
                      : `Renews ${b.currentPeriodEnd ? dateTime(b.currentPeriodEnd) : ""} (${b.interval}).`)}
                  {b.source === "free" && "The free plan. Pick a plan below to add more."}
                  {b.source === "disabled" && "No limits."}
                </p>
                {STATUS_NOTE[b.status] && (
                  <p className="text-destructive mt-2 text-sm">{STATUS_NOTE[b.status]}</p>
                )}
              </div>
              <Can min="admin">
                {b.hasCustomer && (
                  <Button variant="outline" loading={isPending("portal")} onClick={portal}>
                    Manage billing
                  </Button>
                )}
              </Can>
            </div>
          </Panel>

          <Panel>
            <h2 className="mb-4 text-lg font-bold tracking-tight">Usage</h2>
            <div className="space-y-4">
              <Meter label="Monitors" used={b.usage.monitors} limit={b.limits.monitors} />
              <Meter
                label="Scanned domains and URLs"
                used={b.usage.assets}
                limit={b.limits.assets}
              />
              <Meter label="Status pages" used={b.usage.statusPages} limit={b.limits.statusPages} />
            </div>
            <p className="text-muted-foreground mt-4 text-xs">
              Checks every {b.limits.minInterval / 60} min or faster
              {b.limits.customDomain ? ", custom domains included" : ", no custom domains"}. Going
              over a limit never stops monitoring or alerts: it only stops you adding more.
            </p>
          </Panel>
        </div>
      )}

      {b?.enabled && (
        <section className="mt-8" aria-label="Plans">
          <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
            <h2 className="text-xl font-bold tracking-tight">Plans</h2>
            <Segmented
              label="Billing interval"
              value={interval}
              onValueChange={setInterval}
              options={[
                { value: "monthly", label: "Monthly" },
                { value: "yearly", label: "Yearly (2 months free)" },
              ]}
            />
          </div>
          <PlanGrid>
            {(id) => {
              const current = b.plan === id && b.source !== "trial";
              if (id === "free")
                return (
                  <p className="text-muted-foreground mt-6 text-sm">
                    {current ? "Your plan" : "Where you land if you cancel."}
                  </p>
                );
              const buyable = b.purchasable[id]?.[interval];
              return (
                <Can
                  min="admin"
                  fallback={
                    <p className="text-muted-foreground mt-6 text-sm">
                      Ask an admin to change the plan.
                    </p>
                  }
                >
                  <div className="mt-6 space-y-2">
                    <p className="text-sm">
                      <strong>{price(id, interval)}</strong> / month
                      {interval === "yearly" && (
                        <span className="text-muted-foreground"> billed yearly</span>
                      )}
                    </p>
                    <Button
                      className="w-full"
                      variant={id === "pro" ? "default" : "outline"}
                      disabled={current || !buyable || b.source === "paid"}
                      loading={isPending(`buy:${id}`)}
                      onClick={() => checkout(id as Paid)}
                    >
                      {current
                        ? "Current plan"
                        : !buyable
                          ? "Not available yet"
                          : b.source === "paid"
                            ? "Use Manage billing"
                            : `Choose ${id[0]!.toUpperCase()}${id.slice(1)}`}
                    </Button>
                  </div>
                </Can>
              );
            }}
          </PlanGrid>
        </section>
      )}
    </>
  );
}
