import { cors } from "@elysiajs/cors";
import { authProviders } from "@upzy/auth/server";
import type { Auth } from "@upzy/auth/types";
import type { Db } from "@upzy/db";
import { Elysia } from "elysia";

import { createBilling, type BillingDeps } from "./lib/billing";
import { accessModule } from "./modules/access";
import { accountModule } from "./modules/account";
import { aiModule, type AiDeps } from "./modules/ai";
import { alertRuleModule } from "./modules/alert-rule";
import { assetModule } from "./modules/asset";
import { auditModule } from "./modules/audit";
import { billingModule } from "./modules/billing";
import { channelModule } from "./modules/channel";
import { discoveryModule } from "./modules/discovery";
import { emailModule } from "./modules/email";
import { findingModule } from "./modules/finding";
import { health } from "./modules/health";
import { incidentModule } from "./modules/incident";
import { maintenanceModule } from "./modules/maintenance";
import { monitorModule } from "./modules/monitor";
import { onboardingModule } from "./modules/onboarding";
import { overviewModule } from "./modules/overview";
import { pingModule } from "./modules/ping";
import { publicStatusModule } from "./modules/public-status";
import { reportsModule } from "./modules/reports";
import { statusPageModule, type StatusDns } from "./modules/status-page";
import { toolsModule, type ToolsDeps } from "./modules/tools";
import { workspaceModule } from "./modules/workspace";
import { audit, dbAuditSink, type AuditSink } from "./plugins/audit";
import { authPlugin } from "./plugins/auth";
import { errors } from "./plugins/errors";
import { rateLimit, type RateLimitOptions } from "./plugins/rate-limit";

export interface AppDeps {
  db: Db;
  auth: Pick<Auth, "handler" | "api">;
  webOrigin: string;
  /** Base64 32-byte key used to encrypt channel secrets at rest. */
  encryptionKey: string;
  /** Overrides for tests; production uses the defaults. */
  /** AI gateway, config and stores. Optional so tests and deployments without AI still run. */
  ai?: AiDeps;
  /** DNS lookups for custom-domain verification. Tests inject a fake; production uses the system resolver. */
  statusDns?: StatusDns;
  /** The API's public address, used to build heartbeat ping URLs. Defaults to BETTER_AUTH_URL. */
  apiOrigin?: string;
  /** Plans, limits and the payment provider. Tests inject a fake; by default it follows the DODO_* environment. */
  billing?: BillingDeps;
  /** Where audit entries go. Defaults to the audit_logs table. */
  auditSink?: AuditSink;
  rateLimit?: Partial<Pick<RateLimitOptions, "rules" | "now" | "trustProxy">>;
  /** Cancels a paid subscription at the payment provider when an organization is deleted. Absent without billing. */
  cancelSubscription?: (providerSubscriptionId: string) => Promise<void>;
  /** Overrides for the free checkers (tests). */
  tools?: ToolsDeps;
  /** Signs the unsubscribe links in lifecycle emails. Defaults to BETTER_AUTH_SECRET. */
  authSecret?: string;
}

/** Used when the server was started without AI wiring: every AI route answers "off"/"unavailable". */
const disabledAi: AiDeps = {
  config: { rpm: 1, defaultDailyTokenBudget: 0 },
  stores: {
    settings: {
      get: async () => ({
        enabled: false,
        dailyTokenBudget: 0,
        models: { fast: null, smart: null },
      }),
    },
    credentials: { get: async () => undefined, providers: async () => [] },
    usage: { tokensToday: async () => 0, record: async () => {} },
    cache: { get: async () => undefined, set: async () => {} },
  },
  gateway: {
    generateStructured: async () => {
      throw new Error("AI is not wired up");
    },
    chat: async () => {
      throw new Error("AI is not wired up");
    },
  },
};

export const createApp = ({
  db,
  auth,
  webOrigin,
  encryptionKey,
  auditSink,
  ai,
  statusDns,
  billing: billingDeps,
  apiOrigin: apiOriginDep,
  rateLimit: rateOptions,
  cancelSubscription,
  authSecret,
  tools,
}: AppDeps) => {
  const apiOrigin = (
    apiOriginDep ??
    process.env.BETTER_AUTH_URL ??
    "http://localhost:3000"
  ).replace(/(\/api\/auth)?\/*$/, "");
  const authP = authPlugin(auth, db);
  const billing = createBilling(billingDeps);
  return (
    new Elysia()
      .use(
        cors({
          origin: webOrigin,
          credentials: true,
          methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
          allowedHeaders: ["Content-Type", "Authorization", "X-Requested-With"],
        }),
      )
      .use(rateLimit({ webOrigin, trustProxy: process.env.TRUST_PROXY === "true", ...rateOptions }))
      .onAfterHandle({ as: "global" }, ({ set }) => {
        set.headers["x-content-type-options"] = "nosniff";
        set.headers["x-frame-options"] = "DENY";
        set.headers["referrer-policy"] = "no-referrer";
      })
      // Before `errors`: the first onError handler to return a response ends the chain, and audit must see refusals.
      .use(audit(auditSink ?? dbAuditSink(db), { trustProxy: process.env.TRUST_PROXY === "true" }))
      .use(errors)
      .use(authP)
      .use(health(db))
      // Public: lets the login and sign-up pages show only the sign-in methods this server has configured.
      .get("/auth-providers", () => authProviders())
      .use(workspaceModule(db, authP))
      .use(overviewModule(db, authP))
      .use(accessModule(db, authP))
      .use(
        reportsModule(db, authP, billing, {
          secret: authSecret ?? process.env.BETTER_AUTH_SECRET ?? "",
        }),
      )
      .use(monitorModule(db, authP, billing, { encryptionKey, apiOrigin }))
      .use(channelModule(db, authP, encryptionKey))
      .use(alertRuleModule(db, authP))
      .use(incidentModule(db, authP))
      .use(
        accountModule(db, authP, {
          cancelSubscription,
          secret: authSecret ?? process.env.BETTER_AUTH_SECRET ?? "",
        }),
      )
      .use(maintenanceModule(db, authP))
      .use(assetModule(db, authP, billing))
      .use(onboardingModule(db, authP, billing))
      .use(findingModule(db, authP))
      .use(discoveryModule(db, authP, billing))
      .use(auditModule(db, authP))
      .use(publicStatusModule(db, { webOrigin, billing }))
      .use(pingModule(db))
      .use(toolsModule(tools))
      .use(statusPageModule(db, authP, billing, { dns: statusDns }))
      .use(billingModule(db, authP, billing, webOrigin))
      .use(emailModule(db, authP))
      .use(aiModule(db, authP, ai ?? disabledAi, encryptionKey))
  );
};

/** Exported for the Eden Treaty client in apps/web. */
export type App = ReturnType<typeof createApp>;
