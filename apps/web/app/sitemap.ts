import type { MetadataRoute } from "next";

import { GUIDES } from "@/lib/guides";
import { SITE_URL } from "@/lib/seo";
import { TOOLS } from "@/lib/tools";

/** Every public page, once. Private and noindex pages are left out on purpose. */
export default function sitemap(): MetadataRoute.Sitemap {
  const built = new Date();
  const entry = (
    path: string,
    changeFrequency: MetadataRoute.Sitemap[number]["changeFrequency"],
    priority: number,
  ) => ({
    url: path === "/" ? SITE_URL : `${SITE_URL}${path}`,
    lastModified: built,
    changeFrequency,
    priority,
  });
  return [
    entry("/", "weekly", 1),
    entry("/pricing", "monthly", 0.8),
    entry("/tools", "monthly", 0.8),
    ...TOOLS.map((t) => entry(`/tools/${t.slug}`, "monthly", 0.7)),
    entry("/guides", "monthly", 0.8),
    ...GUIDES.map((g) => entry(`/guides/${g.slug}`, "monthly", 0.7)),
    ...["terms", "privacy", "acceptable-use", "ai-data", "bot"].map((p) =>
      entry(`/${p}`, "yearly", 0.3),
    ),
  ];
}
