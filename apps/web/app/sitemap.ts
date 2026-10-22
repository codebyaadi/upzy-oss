import type { MetadataRoute } from "next";

export default function sitemap(): MetadataRoute.Sitemap {
  const site = process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3001";
  return [
    { url: site, changeFrequency: "monthly", priority: 1 },
    ...["pricing", "terms", "privacy", "acceptable-use", "ai-data", "bot"].map((p) => ({
      url: `${site}/${p}`,
      changeFrequency: "yearly" as const,
      priority: 0.3,
    })),
  ];
}
