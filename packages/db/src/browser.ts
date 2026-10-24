/*
 * Browser monitors drive a real browser, which is heavy and runs customer-chosen pages, so it is optional: the
 * installation points BROWSER_WS_ENDPOINT at a separate Playwright server (its own container, see
 * docs/BROWSER-MONITORS.md). Without it the monitor type is not offered and nothing is scheduled.
 */

/** The job queue the browser role listens on. */
export const BROWSER_QUEUE = "browser";

/** The shortest interval for a browser check, in seconds. They are slow and use a lot of memory. */
export const BROWSER_MIN_INTERVAL = 300;

/** Where the Playwright server listens, or null when browser monitors are not set up here. */
export function browserEndpoint(
  env: Record<string, string | undefined> = process.env,
): string | null {
  const url = env.BROWSER_WS_ENDPOINT?.trim();
  return url && /^wss?:\/\//.test(url) ? url : null;
}
