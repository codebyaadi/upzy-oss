import { render, redactValues, resolvePublic, TemplateError, type CheckResult } from "@upzy/probes";
import { describeStep, type BrowserStep } from "@upzy/validator";
import { chromium, type Browser, type Locator, type Page } from "playwright-core";

import { startEgressProxy, type EgressProxy, type ResolveHost } from "./proxy";

const STEP_TIMEOUT_MS = 10_000;
const NAVIGATION_TIMEOUT_MS = 20_000;
/** The whole check, connecting included. A page that never settles can't hold the browser for longer. */
const TOTAL_TIMEOUT_MS = 60_000;

export interface BrowserTarget {
  /** The page to open first. */
  target: string;
  steps: BrowserStep[];
  /** Decrypted secrets, available to `fill` as {{secret.NAME}}. */
  secrets?: Record<string, string>;
  /** Where the Playwright server listens. */
  endpoint: string;
  /** Replaceable in tests. The public address to connect to for a host, or null when it must not be reached. */
  resolveHost?: ResolveHost;
  /** How the browser server reaches this process, where the proxy listens. Default: this machine. */
  proxyHost?: string;
  userAgent?: string;
}

/** Thrown for a step that did not do what was expected, so it is reported as the page's fault, not ours. */
class StepFailed extends Error {
  constructor(
    message: string,
    readonly kind: "assertion" | "timeout" | "http" | "blocked" | "other" = "assertion",
  ) {
    super(message);
  }
}

const publicAddress: ResolveHost = async (host) => {
  try {
    return (await resolvePublic(host)).address;
  } catch {
    return null;
  }
};

/** The first line of a Playwright error, without its call log. */
const firstLine = (e: unknown) =>
  (e instanceof Error ? e.message : String(e)).split("\n")[0]!.replace(/\s+/g, " ").slice(0, 300);

const isTimeout = (e: unknown) => (e as { name?: string })?.name === "TimeoutError";

/**
 * Runs a browser monitor: opens the page, does each step, and reports the first thing that goes wrong, in words,
 * with the step number. Everything the browser asks the network for is first checked to be a public address, and
 * WebSockets are refused, so a page cannot be used to reach the host's own network.
 */
export async function runBrowserCheck(t: BrowserTarget): Promise<CheckResult> {
  const started = Date.now();
  const secrets = t.secrets ?? {};
  const scrub = (text: string) => redactValues(text, Object.values(secrets));

  let browser: Browser | undefined;
  let proxy: EgressProxy | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const work = (async (): Promise<CheckResult> => {
    let statusCode: number | undefined;
    let step = 0;
    try {
      proxy = await startEgressProxy(t.resolveHost ?? publicAddress);
      browser = await chromium.connect(t.endpoint, { timeout: 15_000 });
      const context = await browser.newContext({
        viewport: { width: 1280, height: 720 },
        userAgent: t.userAgent,
        serviceWorkers: "block",
        acceptDownloads: false,
        permissions: [],
        ignoreHTTPSErrors: false,
        // All traffic, "localhost" included, goes through the checking proxy.
        proxy: {
          server: `http://${t.proxyHost ?? "127.0.0.1"}:${proxy.port}`,
          username: proxy.username,
          password: proxy.password,
          bypass: "<-loopback>",
        },
      });

      const page = await context.newPage();
      page.setDefaultTimeout(STEP_TIMEOUT_MS);
      page.on("dialog", (d) => void d.dismiss());

      const open = async (url: string) => {
        const res = await page.goto(url, { waitUntil: "load", timeout: NAVIGATION_TIMEOUT_MS });
        if (statusCode === undefined && res) statusCode = res.status();
        if (res && res.status() >= 400)
          throw new StepFailed(`The page answered HTTP ${res.status()}`, "http");
      };

      step = 0;
      await open(t.target);
      for (const [i, s] of t.steps.entries()) {
        step = i + 1;
        await run(page, s, open, secrets);
      }
      await context.close();
      return { status: "up", responseMs: Date.now() - started, statusCode };
    } catch (e) {
      const where = step === 0 ? "Opening the page" : `Step ${step}`;
      const what =
        step > 0 && t.steps[step - 1] ? ` (${scrub(describeStep(t.steps[step - 1]!))})` : "";
      let kind: "assertion" | "timeout" | "http" | "blocked" | "other";
      let why: string;
      if (e instanceof StepFailed) ((kind = e.kind), (why = e.message));
      else if (e instanceof TemplateError) ((kind = "other"), (why = e.message));
      else if (isTimeout(e)) ((kind = "timeout"), (why = "timed out"));
      else ((kind = "other"), (why = firstLine(e)));
      const refused = proxy ? [...proxy.blocked] : [];
      if (refused.length > 0 && kind !== "assertion") {
        kind = "blocked";
        why = `${why}; the page asked for ${refused.join(", ")}, which is not a public address`;
      }
      return {
        status: "down",
        responseMs: Date.now() - started,
        statusCode,
        error: scrub(`${where}${what} failed: ${why}`).slice(0, 500),
        errorKind: kind,
      };
    }
  })();

  const deadline = new Promise<CheckResult>((resolve) => {
    timer = setTimeout(
      () =>
        resolve({
          status: "down",
          responseMs: Date.now() - started,
          error: `The check took longer than ${TOTAL_TIMEOUT_MS / 1000} seconds`,
          errorKind: "timeout",
        }),
      TOTAL_TIMEOUT_MS,
    );
  });
  try {
    return await Promise.race([work, deadline]);
  } finally {
    clearTimeout(timer);
    await browser?.close().catch(() => {});
    proxy?.close();
  }
}

const loc = (page: Page, selector: string): Locator => page.locator(selector).first();

async function run(
  page: Page,
  s: BrowserStep,
  open: (url: string) => Promise<void>,
  secrets: Record<string, string>,
) {
  switch (s.do) {
    case "goto":
      return open(s.url);
    case "click":
      return loc(page, s.selector).click();
    case "fill":
      return loc(page, s.selector).fill(render(s.value, {}, secrets));
    case "press":
      return page.keyboard.press(s.key);
    case "wait_for":
      return loc(page, s.selector).waitFor({ state: "visible" });
    case "expect_text":
      try {
        return await page
          .locator(s.selector ?? "body")
          .filter({ hasText: s.text })
          .first()
          .waitFor({ state: "attached" });
      } catch (e) {
        if (isTimeout(e)) throw new StepFailed(`The text "${s.text}" did not appear`);
        throw e;
      }
    case "expect_url":
      try {
        return await page.waitForURL((u) => u.href.includes(s.contains));
      } catch (e) {
        if (isTimeout(e))
          throw new StepFailed(
            `The address is ${page.url()}, which does not contain "${s.contains}"`,
          );
        throw e;
      }
    case "wait":
      return page.waitForTimeout(s.ms);
  }
}
