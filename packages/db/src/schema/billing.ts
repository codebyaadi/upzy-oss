import { index, pgTable, text, timestamp, boolean } from "drizzle-orm/pg-core";

import { createdAt } from "./_helpers";
import { organizations } from "./auth";

/**
 * One row per organization: its paid plan (kept in step with the payment provider by webhooks) and when its free
 * trial ends. `plan` is null until a subscription has existed. What the organization is entitled to *now* is worked
 * out from this by @upzy/billing, never stored.
 */
export const subscriptions = pgTable("subscriptions", {
  organizationId: text("organization_id")
    .primaryKey()
    .references(() => organizations.id, { onDelete: "cascade" }),
  plan: text("plan").$type<"starter" | "pro" | "agency">(),
  interval: text("interval").$type<"monthly" | "yearly">(),
  status: text("status")
    .$type<"none" | "active" | "past_due" | "on_hold" | "cancelled">()
    .notNull()
    .default("none"),
  providerCustomerId: text("provider_customer_id"),
  providerSubscriptionId: text("provider_subscription_id"),
  currentPeriodEnd: timestamp("current_period_end", { withTimezone: true }),
  cancelAtPeriodEnd: boolean("cancel_at_period_end").notNull().default(false),
  /** Set the first time the organization's billing is looked at, then never moved. */
  trialEndsAt: timestamp("trial_ends_at", { withTimezone: true }),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * A checkout we started, so the first webhook for a new subscription can be matched to the organization even if
 * the provider doesn't carry our metadata through.
 */
export const billingCheckouts = pgTable(
  "billing_checkouts",
  {
    sessionId: text("session_id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    email: text("email").notNull(),
    plan: text("plan").notNull(),
    interval: text("interval").notNull(),
    createdAt: createdAt(),
  },
  (t) => [index("billing_checkouts_email_idx").on(t.email, t.createdAt)],
);

/** Webhook ids we have already handled: providers deliver at least once, so repeats must do nothing. */
export const billingEvents = pgTable("billing_events", {
  id: text("id").primaryKey(),
  type: text("type").notNull(),
  receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
});
