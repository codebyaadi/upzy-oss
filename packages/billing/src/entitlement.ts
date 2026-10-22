import { PLANS, TRIAL_PLAN, type PaidPlan, type PlanId } from "./plans";

export type SubscriptionStatus = "none" | "active" | "past_due" | "on_hold" | "cancelled";

export interface SubscriptionRow {
  plan: PaidPlan | null;
  status: SubscriptionStatus;
  trialEndsAt: Date | null;
}

export interface Entitlement {
  plan: PlanId;
  /** Why the organization has this plan. */
  source: "disabled" | "paid" | "trial" | "free";
  /** Whole days of trial left, when on one. */
  trialDaysLeft: number | null;
}

/**
 * Which plan an organization has right now. A paid plan counts while the subscription is active or only late on a
 * payment (a grace period); once it is on hold or cancelled, the organization falls back to the trial if one is still
 * running, then to Free. With billing switched off everyone gets Unlimited, so a self-hosted install is never
 * limited by a payment provider it doesn't use.
 */
export function entitlement(opts: {
  billingEnabled: boolean;
  sub: SubscriptionRow | undefined;
  now?: Date;
}): Entitlement {
  const now = opts.now ?? new Date();
  if (!opts.billingEnabled) return { plan: "unlimited", source: "disabled", trialDaysLeft: null };
  const { sub } = opts;
  if (sub?.plan && (sub.status === "active" || sub.status === "past_due"))
    return { plan: sub.plan, source: "paid", trialDaysLeft: null };
  if (sub?.trialEndsAt && sub.trialEndsAt > now)
    return {
      plan: TRIAL_PLAN,
      source: "trial",
      trialDaysLeft: Math.ceil((sub.trialEndsAt.getTime() - now.getTime()) / 86_400_000),
    };
  return { plan: "free", source: "free", trialDaysLeft: null };
}

export const limitsOf = (plan: PlanId) => PLANS[plan].limits;
