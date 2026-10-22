import { expect, test } from "bun:test";

import { AiRateLimitedError } from "../src/errors";
import { createRateLimiter } from "../src/limiter";

test("allows up to rpm requests per minute, then waits for the window", async () => {
  let t = 0;
  const slept: number[] = [];
  const limiter = createRateLimiter({
    rpm: 2,
    now: () => t,
    sleep: async (ms) => {
      slept.push(ms);
      t += ms;
    },
  });
  await limiter.acquire();
  await limiter.acquire();
  expect(slept).toEqual([]);
  await limiter.acquire(120_000);
  expect(t).toBeGreaterThanOrEqual(60_000);
});

test("refuses instead of waiting past maxWait", async () => {
  let t = 0;
  const limiter = createRateLimiter({
    rpm: 1,
    now: () => t,
    sleep: async (ms) => {
      t += ms;
    },
  });
  await limiter.acquire();
  await expect(limiter.acquire(5_000)).rejects.toBeInstanceOf(AiRateLimitedError);
});
