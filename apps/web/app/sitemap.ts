import type { MetadataRoute } from "next";

import { TOOLS } from "@/lib/tools";

export default function sitemap(): MetadataRoute.Sitemap {
  const site = process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3001";
  return [
    { url: site, changeFrequency: "monthly", priority: 1 },
    ...["tools", ...TOOLS.map((t) => `tools/${t.slug}`)].map((p) => ({
      url: `${site}/${p}`,
      changeFrequency: "monthly" as const,
      priority: 0.7,
    })),
    ...["pricing", "terms", "privacy", "acceptable-use", "ai-data", "bot"].map((p) => ({
      url: `${site}/${p}`,
      changeFrequency: "yearly" as const,
      priority: 0.3,
    })),
  ];
}
