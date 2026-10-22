import { createGateway, createModelDiscovery, loadAiConfig, createDbStores } from "@upzy/ai";
import { createDb } from "@upzy/db";
import { z } from "zod";

import { runAgent } from "./roles/agent";
import { runCorrelator } from "./roles/correlator";
import { runDiscovery } from "./roles/discovery";
import { parseLifecycle, runLifecycle } from "./roles/lifecycle";
import { runNotifier } from "./roles/notifier";
import { runProber } from "./roles/prober";
import { parseReports, runReports } from "./roles/reports";
import { parseRetention, runRetention } from "./roles/retention";
import { runScanner } from "./roles/scanner";
import { runScheduler } from "./roles/scheduler";

const Env = z.object({
  DATABASE_URL: z.string().min(1),
  WORKER_ROLES: z.string().default("scheduler,prober,notifier,scanner,agent,correlator"),
  UPZY_ENCRYPTION_KEY: z.string().min(1),
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
if (roles.has("prober"))
  running.push(runProber(db, controller.signal, { encryptionKey: env.UPZY_ENCRYPTION_KEY }));
if (roles.has("scanner")) {
  running.push(runScanner(db, controller.signal));
  running.push(runDiscovery(db, controller.signal));
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
