import type { SafeFetchResult } from "@upzy/probes";

/**
 * Where a site is hosted and what serves it, read from its response headers. Fixes differ by platform (a
 * Cloudflare rule, a vercel.json entry, an nginx directive), so this decides which instructions we show.
 */
export type Platform =
  | "cloudflare"
  | "vercel"
  | "netlify"
  | "cloudfront"
  | "github-pages"
  | "fly"
  | "azure"
  | "heroku"
  | "unknown";
export type Server = "nginx" | "apache" | "caddy" | "iis" | "litespeed" | "unknown";
export type Framework = "nextjs" | "express" | "wordpress" | "php" | "aspnet" | "unknown";

export interface Stack {
  platform: Platform;
  server: Server;
  framework: Framework;
}

export const UNKNOWN_STACK: Stack = {
  platform: "unknown",
  server: "unknown",
  framework: "unknown",
};

/** Headers are lowercase (SafeFetchResult). Only reads names and well-known markers; never stores page content. */
export function detectStack(res: Pick<SafeFetchResult, "headers">): Stack {
  const h = res.headers;
  const server = (h["server"] ?? "").toLowerCase();
  const powered = (h["x-powered-by"] ?? "").toLowerCase();
  const via = (h["via"] ?? "").toLowerCase();

  const platform: Platform =
    h["cf-ray"] || server.includes("cloudflare")
      ? "cloudflare"
      : h["x-vercel-id"] || server.includes("vercel")
        ? "vercel"
        : h["x-nf-request-id"] || server.includes("netlify")
          ? "netlify"
          : h["x-amz-cf-id"] || via.includes("cloudfront")
            ? "cloudfront"
            : h["x-github-request-id"] ||
                (server.includes("github.com") && !!h["x-fastly-request-id"])
              ? "github-pages"
              : h["fly-request-id"] || server.includes("fly")
                ? "fly"
                : h["x-azure-ref"] || h["x-ms-request-id"]
                  ? "azure"
                  : via.includes("vegur")
                    ? "heroku"
                    : "unknown";

  const software: Server = server.includes("nginx")
    ? "nginx"
    : server.includes("apache")
      ? "apache"
      : server.includes("caddy")
        ? "caddy"
        : server.includes("iis") || server.includes("microsoft")
          ? "iis"
          : server.includes("litespeed")
            ? "litespeed"
            : "unknown";

  const framework: Framework = powered.includes("next.js")
    ? "nextjs"
    : powered.includes("express")
      ? "express"
      : /wp-json/.test(h["link"] ?? "") || powered.includes("wordpress")
        ? "wordpress"
        : powered.includes("php")
          ? "php"
          : powered.includes("asp.net")
            ? "aspnet"
            : "unknown";

  return { platform, server: software, framework };
}

export const STACK_LABEL: Record<Platform | Server | Framework, string> = {
  cloudflare: "Cloudflare",
  vercel: "Vercel",
  netlify: "Netlify",
  cloudfront: "Amazon CloudFront",
  "github-pages": "GitHub Pages",
  fly: "Fly.io",
  azure: "Azure",
  heroku: "Heroku",
  nginx: "nginx",
  apache: "Apache",
  caddy: "Caddy",
  iis: "IIS",
  litespeed: "LiteSpeed",
  nextjs: "Next.js",
  express: "Express",
  wordpress: "WordPress",
  php: "PHP",
  aspnet: "ASP.NET",
  unknown: "Unknown",
};

/** A short human description, e.g. "Cloudflare in front of nginx (Next.js)". */
export function describeStack(s: Stack): string {
  const parts: string[] = [];
  if (s.platform !== "unknown") parts.push(STACK_LABEL[s.platform]);
  if (s.server !== "unknown")
    parts.push(parts.length ? `in front of ${STACK_LABEL[s.server]}` : STACK_LABEL[s.server]);
  const base = parts.join(" ");
  if (s.framework !== "unknown")
    return base ? `${base} (${STACK_LABEL[s.framework]})` : STACK_LABEL[s.framework];
  return base || "Unknown";
}
