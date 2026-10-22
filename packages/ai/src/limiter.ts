import { AiRateLimitedError } from "./errors";

export interface RateLimiter {
  /** Resolves when a request may proceed. Throws if the wait would exceed `maxWaitMs`. */
  acquire(maxWaitMs?: number): Promise<void>;
}

/**
 * Sliding-window limiter: at most `rpm` requests in any 60s window. Sized to the free-tier limits
 * of the providers so a burst of scans queues up instead of being rejected.
 */
export function createRateLimiter(opts: {
  rpm: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}): RateLimiter {
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const stamps: number[] = [];

  return {
    async acquire(maxWaitMs = 20_000) {
      const deadline = now() + maxWaitMs;
      for (;;) {
        const t = now();
        while (stamps.length > 0 && stamps[0]! <= t - 60_000) stamps.shift();
        if (stamps.length < opts.rpm) {
          stamps.push(t);
          return;
        }
        const wait = stamps[0]! + 60_000 - t;
        if (t + wait > deadline) throw new AiRateLimitedError(Math.ceil(wait / 1000));
        await sleep(Math.min(wait, 1000));
      }
    },
  };
}
