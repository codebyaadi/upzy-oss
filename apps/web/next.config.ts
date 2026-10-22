import path from "node:path";

import { loadEnvConfig } from "@next/env";
import type { NextConfig } from "next";

// Share the repo-root .env with the other apps (Next only reads apps/web/.env by default).
// Next runs with apps/web as the working directory.
loadEnvConfig(path.resolve(process.cwd(), "../.."));

/**
 * Baseline hardening for every page. A Content-Security-Policy is deliberately not set here:
 * Next injects inline scripts, so a useful CSP needs per-request nonces (a proxy.ts concern),
 * and a static `unsafe-inline` policy would give a false sense of security.
 */
const securityHeaders = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  {
    key: "Permissions-Policy",
    value: "camera=(), microphone=(), geolocation=(), interest-cohort=()",
  },
];

const nextConfig: NextConfig = {
  // Internal packages export TypeScript source directly.
  transpilePackages: ["@upzy/ui", "@upzy/auth", "@upzy/validator", "@upzy/billing"],

  // The production image runs `node server.js` from a trimmed copy of the app (see docker/Dockerfile.web). The
  // trace root is the repo root so the workspace packages (@upzy/*) are included.
  ...(process.env.NEXT_STANDALONE === "true"
    ? { output: "standalone" as const, outputFileTracingRoot: path.resolve(process.cwd(), "../..") }
    : {}),

  // Don't advertise the framework.
  poweredByHeader: false,

  // Type-checks every <Link href> and router.push against the real route tree.
  typedRoutes: true,

  experimental: {
    // @hugeicons/core-free-icons is one barrel of thousands of icons: only bundle (and compile in dev) the ones imported.
    optimizePackageImports: ["@hugeicons/core-free-icons"],
  },

  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  },
};

export default nextConfig;
