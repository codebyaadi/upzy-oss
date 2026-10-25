import { BROWSER_QUEUE, type Db } from "@upzy/db";
import { botUserAgent } from "@upzy/probes";
import { work } from "@upzy/queue";
import type { BrowserStep } from "@upzy/validator";

import { runBrowserCheck } from "../browser/run";
import { handleCheck } from "./prober";
import type { CheckJob } from "./scheduler";

/**
 * Runs browser monitors against a Playwright server. The check, the result and the incident logic are the ones
 * every monitor uses; only how the page is checked differs. Two at a time: a browser is heavy.
 */
export const runBrowserProber = (
  db: Db,
  signal: AbortSignal,
  opts: { encryptionKey?: string; endpoint: string; concurrency?: number },
) =>
  work<CheckJob>(
    db,
    BROWSER_QUEUE,
    (payload) =>
      handleCheck(db, payload, {
        encryptionKey: opts.encryptionKey,
        probe: (t) =>
          runBrowserCheck({
            target: t.target,
            steps: (t.config.browser ?? []) as BrowserStep[],
            secrets: t.secrets,
            endpoint: opts.endpoint,
            proxyHost: process.env.BROWSER_PROXY_HOST || undefined,
            userAgent: botUserAgent(),
          }),
      }),
    { concurrency: opts.concurrency ?? 2, signal, discardWhenDone: true },
  );
