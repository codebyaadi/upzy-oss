import type { MetadataRoute } from "next";

/** Only the landing page is for search engines: the app and the account pages are private. */
export default function robots(): MetadataRoute.Robots {
  const site = process.env.NEXT_PUBLIC_SITE_URL;
  return {
    rules: [
      {
        userAgent: "*",
        allow: "/",
        disallow: [
          "/monitors",
          "/incidents",
          "/assets",
          "/findings",
          "/alerts",
          "/status-pages",
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
        ],
      },
    ],
    ...(site ? { sitemap: `${site}/sitemap.xml` } : {}),
  };
}
