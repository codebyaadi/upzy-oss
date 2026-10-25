export type PaidPlan = "starter" | "pro" | "agency";
export type PlanId = "free" | PaidPlan | "unlimited";
export type Interval = "monthly" | "yearly";

export interface Limits {
  monitors: number;
  /** The shortest check interval allowed, in seconds. */
  minInterval: number;
  /** Domains, subdomains and URLs under security scans. */
  assets: number;
  statusPages: number;
  customDomain: boolean;
  /** The customer's own logo on status pages (Upzy's credit always stays). */
  customLogo: boolean;
  /** Scheduled uptime and security reports emailed to a client. */
  clientReports: boolean;
  /** How many places one monitor can be checked from at once. */
  regions: number;
  /** Browser monitors: real-browser checks of a page or a login. They are heavy, so they are counted separately. */
  browserMonitors: number;
  /** How many days of response-time history (charts, uptime, reports) the organization keeps. */
  historyDays: number;
  /** Single sign-on through the organization's own identity provider (Okta, Entra, Google Workspace, Keycloak). */
  sso: boolean;
}

export interface Plan {
  id: PlanId;
  name: string;
  /** US dollars. Yearly is ten months: two free. */
  price: Record<Interval, number>;
  blurb: string;
  limits: Limits;
}

/**
 * What each plan includes. Seats are unlimited on every plan, and AI features run on the customer's own provider
 * key, so they cost Upzy nothing and are not metered here.
 */
export const PLANS: Record<PlanId, Plan> = {
  free: {
    id: "free",
    name: "Free",
    price: { monthly: 0, yearly: 0 },
    blurb: "Side projects and trying it out",
    limits: {
      monitors: 10,
      minInterval: 300,
      assets: 1,
      statusPages: 1,
      customDomain: false,
      customLogo: false,
      clientReports: false,
      regions: 1,
      browserMonitors: 0,
      historyDays: 7,
      sso: false,
    },
  },
  starter: {
    id: "starter",
    name: "Starter",
    price: { monthly: 15, yearly: 150 },
    blurb: "A freelancer or a single product",
    limits: {
      monitors: 30,
      minInterval: 60,
      assets: 3,
      statusPages: 1,
      customDomain: true,
      customLogo: false,
      clientReports: false,
      regions: 2,
      browserMonitors: 2,
      historyDays: 90,
      sso: false,
    },
  },
  pro: {
    id: "pro",
    name: "Pro",
    price: { monthly: 39, yearly: 390 },
    blurb: "A startup or SaaS team",
    limits: {
      monitors: 100,
      minInterval: 60,
      assets: 10,
      statusPages: 5,
      customDomain: true,
      customLogo: false,
      clientReports: false,
      regions: 3,
      browserMonitors: 5,
      historyDays: 365,
      sso: false,
    },
  },
  agency: {
    id: "agency",
    name: "Agency",
    price: { monthly: 99, yearly: 990 },
    blurb: "Agencies and teams with many brands",
    limits: {
      monitors: 300,
      minInterval: 60,
      assets: 30,
      statusPages: 100,
      customDomain: true,
      customLogo: true,
      clientReports: true,
      regions: 5,
      browserMonitors: 20,
      historyDays: 365,
      sso: true,
    },
  },
  // Not for sale: what everyone gets while billing is switched off (self-hosting, early access).
  unlimited: {
    id: "unlimited",
    name: "Unlimited",
    price: { monthly: 0, yearly: 0 },
    blurb: "Billing is switched off",
    limits: {
      monitors: Infinity,
      minInterval: 60,
      assets: Infinity,
      statusPages: Infinity,
      customDomain: true,
      customLogo: true,
      clientReports: true,
      regions: Infinity,
      browserMonitors: Infinity,
      historyDays: Infinity,
      sso: true,
    },
  },
};

export const PAID_PLANS: PaidPlan[] = ["starter", "pro", "agency"];
export const TRIAL_PLAN: PlanId = "pro";
export const TRIAL_DAYS = 14;

export type Resource = "monitors" | "assets" | "statusPages";
const NOUN: Record<Resource, [string, string]> = {
  monitors: ["monitor", "monitors"],
  assets: ["scanned domain or URL", "scanned domains and URLs"],
  statusPages: ["status page", "status pages"],
};

/** The refusal shown when creating one more would pass the plan's limit. */
export function limitMessage(plan: PlanId, resource: Resource, limit: number): string {
  const [one, many] = NOUN[resource];
  return `The ${PLANS[plan].name} plan includes ${limit} ${limit === 1 ? one : many}. Upgrade under Settings → Billing to add more.`;
}

export const intervalMessage = (plan: PlanId, min: number) =>
  `The ${PLANS[plan].name} plan checks at most every ${min >= 60 ? `${min / 60} minute${min === 60 ? "" : "s"}` : `${min} seconds`}. Upgrade under Settings → Billing for faster checks.`;

export const customDomainMessage = (plan: PlanId) =>
  `Custom domains aren't included in the ${PLANS[plan].name} plan. Upgrade under Settings → Billing.`;

export const customLogoMessage = (plan: PlanId) =>
  `A custom logo on status pages isn't included in the ${PLANS[plan].name} plan. Upgrade to Agency under Settings → Billing.`;

export const clientReportsMessage = (plan: PlanId) =>
  `Scheduled client reports aren't included in the ${PLANS[plan].name} plan. Upgrade to Agency under Settings → Billing.`;

export const regionsMessage = (plan: PlanId, max: number) =>
  `The ${PLANS[plan].name} plan checks each monitor from ${max} ${max === 1 ? "place" : "places"} at most. Upgrade under Settings → Billing to check from more.`;

export const browserMonitorsMessage = (plan: PlanId, max: number) =>
  max === 0
    ? `Browser monitors aren't included in the ${PLANS[plan].name} plan. Upgrade under Settings → Billing.`
    : `The ${PLANS[plan].name} plan includes ${max} browser ${max === 1 ? "monitor" : "monitors"}. Upgrade under Settings → Billing to add more.`;

export const ssoMessage = (plan: PlanId) =>
  `Single sign-on isn't included in the ${PLANS[plan].name} plan. Upgrade to Agency under Settings → Billing.`;

export const historyLabel = (days: number) =>
  !Number.isFinite(days)
    ? "Unlimited history"
    : days >= 365
      ? `${Math.round(days / 365)} year of history`
      : `${days} days of history`;
