import { createGateway, createModelDiscovery, loadAiConfig, createDbStores } from "@upzy/ai";
import { PRIMARY_REGION, browserEndpoint, createDb, workerRegion } from "@upzy/db";
import { logQueueMetrics } from "@upzy/queue";
import { z } from "zod";

import { legacyRegionalProber } from "./legacy-region";
import { runScanResultIngest } from "./roles/active-scan";
import { runAdvisories } from "./roles/advisories";
import { runAgent } from "./roles/agent";
import { runBrowserProber } from "./roles/browser";
import { runCorrelator } from "./roles/correlator";
import { runDiscovery } from "./roles/discovery";
import { parseLifecycle, runLifecycle } from "./roles/lifecycle";
import { runNotifier } from "./roles/notifier";
import { runOwnership } from "./roles/ownership";
import { runResultIngest } from "./roles/probe-results";
import { runProber } from "./roles/prober";
import { parseReports, runReports } from "./roles/reports";
import { parseRetention, runRetention } from "./roles/retention";
import { runScanner } from "./roles/scanner";
import { runScheduler } from "./roles/scheduler";

const Env = z.object({
  DATABASE_URL: z.string().min(1),
  WORKER_ROLES: z.string().default("scheduler,prober,notifier,scanner,agent,correlator"),
  UPZY_ENCRYPTION_KEY: z.string().min(1),
  BROWSER_WS_ENDPOINT: z.string().optional(),
  APP_URL: z.string().default("http://localhost:3001"),
  SMTP_URL: z.string().optional(),
  RESEND_API_KEY: z.string().optional(),
  MAIL_FROM: z.string().default("Upzy <alerts@upzy.local>"),
});
const env = Env.parse(process.env);
const roles = new Set(
  env.WORKER_ROLES.split(",")
    .map((r) => r.trim())
    .filter(Boolean),
);

const db = createDb(env.DATABASE_URL);
const controller = new AbortController();
for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, () => controller.abort());

const running: Promise<void>[] = [];
// Queue depth and start lag, one line per queue (METRICS_INTERVAL_SECONDS, default 60; 0 turns it off).
const metricsSeconds = Number(process.env.METRICS_INTERVAL_SECONDS ?? 60);
if (Number.isFinite(metricsSeconds))
  running.push(logQueueMetrics(db, controller.signal, { intervalMs: metricsSeconds * 1000 }));
if (roles.has("scheduler")) {
  running.push(runScheduler(db, controller.signal));
  // Housekeeping rides along with the scheduler, which every deployment runs: old checks and finished jobs are
  // deleted so the database does not grow without bound (CHECK_RETENTION_DAYS, default 90).
  running.push(runRetention(db, controller.signal, parseRetention(process.env)));
  // Welcome, first-fix and trial-ending emails (LIFECYCLE_EMAILS=off disables them).
  running.push(runLifecycle(db, controller.signal, parseLifecycle(process.env)));
  // Scheduled client reports (CLIENT_REPORTS=off disables them).
  running.push(runReports(db, controller.signal, parseReports(process.env)));
}
if (roles.has("prober")) {
  const gate = legacyRegionalProber();
  if (gate.message) console.error(gate.message);
  if (gate.run)
    running.push(runProber(db, controller.signal, { encryptionKey: env.UPZY_ENCRYPTION_KEY }));
}
// Agents report to the API, which queues their results for the main server's worker; regional probers that read the
// database themselves never take these.
if (roles.has("prober") && workerRegion() === PRIMARY_REGION)
  running.push(runResultIngest(db, controller.signal));
if (roles.has("browser")) {
  const endpoint = browserEndpoint(process.env);
  if (endpoint)
    running.push(
      runBrowserProber(db, controller.signal, { encryptionKey: env.UPZY_ENCRYPTION_KEY, endpoint }),
    );
  else
    console.error(
      "[browser] the browser role needs BROWSER_WS_ENDPOINT (ws:// or wss://); it is not running",
    );
}
if (roles.has("scanner")) {
  running.push(runScanner(db, controller.signal));
  running.push(runDiscovery(db, controller.signal));
  running.push(runAdvisories(db, controller.signal));
  running.push(runOwnership(db, controller.signal));
  running.push(runScanResultIngest(db, controller.signal));
}
if (roles.has("agent")) {
  const aiConfig = loadAiConfig(process.env);
  const gateway = createGateway({
    config: aiConfig,
    discovery: createModelDiscovery(),
    stores: createDbStores(db, {
      dailyTokenBudget: aiConfig.defaultDailyTokenBudget,
      encryptionKey: env.UPZY_ENCRYPTION_KEY,
    }),
  });
  running.push(runAgent(db, gateway, env.APP_URL, controller.signal));
}
if (roles.has("correlator")) running.push(runCorrelator(db, controller.signal));
if (roles.has("notifier")) {
  running.push(
    runNotifier(
      db,
      {
        encryptionKey: env.UPZY_ENCRYPTION_KEY,
        appUrl: env.APP_URL,
        smtpUrl: env.SMTP_URL,
        resendApiKey: env.RESEND_API_KEY || undefined,
        mailFrom: env.MAIL_FROM,
      },
      controller.signal,
    ),
  );
}
console.log(`worker started: ${[...roles].join(", ")}`);

await Promise.all(running);
console.log("worker stopped");
process.exit(0);
