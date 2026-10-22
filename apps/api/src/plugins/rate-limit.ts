import { Elysia } from "elysia";

export interface Rule {
  /** Matches the request path. First matching rule wins. */
  match: (path: string) => boolean;
  /** Counters are kept per (bucket, client). */
  bucket: string;
  max: number;
  windowMs: number;
}

export interface RateLimitOptions {
  rules?: Rule[];
  /** Trust the X-Forwarded-For header (only behind a proxy that overwrites it). */
  trustProxy?: boolean;
  /** Origin to echo on 429s: the early response skips the CORS plugin. */
  webOrigin: string;
  now?: () => number;
}

const MINUTE = 60_000;

export const DEFAULT_RULES: Rule[] = [
  { match: (p) => p === "/health", bucket: "health", max: Infinity, windowMs: MINUTE },
  // Credential endpoints: slow down guessing and sign-up spam.
  {
    match: (p) =>
      /^\/api\/auth\/(sign-in|sign-up|forget-password|request-password-reset|reset-password|send-verification-email)/.test(
        p,
      ),
    bucket: "auth-strict",
    max: 10,
    windowMs: MINUTE,
  },
  { match: (p) => p.startsWith("/api/auth/"), bucket: "auth", max: 120, windowMs: MINUTE },
  // Every call here can cost tokens on a shared free tier.
  {
    match: (p) => p.startsWith("/ai/") && p !== "/ai/settings",
    bucket: "ai",
    max: 20,
    windowMs: MINUTE,
  },
  // Cron jobs and workers report in here, often from one shared address.
  { match: (p) => p.startsWith("/ping/"), bucket: "ping", max: 600, windowMs: MINUTE },
  // The free checkers open connections to whatever site a stranger names, so keep them slow.
  { match: (p) => p.startsWith("/tools/"), bucket: "tools", max: 10, windowMs: MINUTE },
  // Public status pages are read by the web server on behalf of every visitor, so one address does a lot of the traffic.
  { match: (p) => p.startsWith("/public/"), bucket: "public", max: 600, windowMs: MINUTE },
  { match: () => true, bucket: "api", max: 300, windowMs: MINUTE },
];

/** The client address: the socket peer, or the first X-Forwarded-For hop when a proxy is trusted. */
export function clientIp(request: Request, peer: string | undefined, trustProxy: boolean): string {
  if (trustProxy) {
    const forwarded = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
    if (forwarded) return forwarded;
  }
  return peer ?? "unknown";
}

/**
 * Fixed-window rate limiter, per client address and rule bucket. In-memory: correct for a single
 * API instance; run it behind a shared store (Redis/Postgres) before scaling out horizontally.
 * Runs in `onRequest`, so it also covers the mounted better-auth routes.
 */
export const rateLimit = ({
  rules = DEFAULT_RULES,
  trustProxy = false,
  webOrigin,
  now = Date.now,
}: RateLimitOptions) => {
  const windows = new Map<string, { count: number; resetAt: number }>();
  let lastSweep = now();

  return new Elysia({ name: "rate-limit" }).onRequest(({ request, server }) => {
    const t = now();
    if (t - lastSweep > MINUTE) {
      lastSweep = t;
      for (const [k, w] of windows) if (w.resetAt <= t) windows.delete(k);
    }

    const path = new URL(request.url).pathname;
    const rule = rules.find((r) => r.match(path));
    if (!rule || rule.max === Infinity) return;

    const ip = clientIp(request, server?.requestIP(request)?.address, trustProxy);
    const key = `${rule.bucket}:${ip}`;
    let w = windows.get(key);
    if (!w || w.resetAt <= t) windows.set(key, (w = { count: 0, resetAt: t + rule.windowMs }));
    w.count++;

    const remaining = Math.max(0, rule.max - w.count);
    if (w.count <= rule.max) return;

    const retryAfter = Math.max(1, Math.ceil((w.resetAt - t) / 1000));
    return new Response(
      JSON.stringify({ message: "Too many requests. Please slow down and try again shortly." }),
      {
        status: 429,
        headers: {
          "content-type": "application/json",
          "retry-after": String(retryAfter),
          "ratelimit-limit": String(rule.max),
          "ratelimit-remaining": String(remaining),
          "ratelimit-reset": String(retryAfter),
          "access-control-allow-origin": webOrigin,
          "access-control-allow-credentials": "true",
          vary: "Origin",
        },
      },
    );
  });
};
