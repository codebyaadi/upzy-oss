import type { MetadataRoute } from "next";

/**
 * The public pages (landing, pricing, free tools, legal) are for search engines. The signed-in app, account and
 * invitation pages are private, and customers' status pages are for their own customers: all of those are also marked
 * noindex in their own metadata, so a stray link to one never puts it in search results.
 */
export default function robots(): MetadataRoute.Robots {
  const site = process.env.NEXT_PUBLIC_SITE_URL?.replace(/\/$/, "");
  return {
    rules: [
      {
        userAgent: "*",
        allow: "/",
        disallow: [
          "/overview",
          "/monitors",
          "/incidents",
          "/assets",
          "/findings",
          "/alerts",
          "/maintenance",
          "/status-pages",
          "/reports",
          "/copilot",
          "/team",
          "/audit",
          "/settings",
          "/login",
          "/sign-up",
          "/forgot-password",
          "/reset-password",
          "/onboarding",
          "/accept-invitation",
          "/subscription",
          "/status/",
        ],
      },
    ],
    ...(site ? { sitemap: `${site}/sitemap.xml`, host: site } : {}),
  };
}
