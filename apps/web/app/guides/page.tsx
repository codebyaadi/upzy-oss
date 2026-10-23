import type { Metadata } from "next";
import Link from "next/link";

import { ToolsShell } from "@/components/tools/shell";
import { GUIDES } from "@/lib/guides";
import { jsonLd, pageMetadata, SITE_NAME, SITE_URL } from "@/lib/seo";

export const metadata: Metadata = pageMetadata({
  title: "Website security how-to guides",
  description:
    "Step-by-step guides to fix common website security findings: HSTS, Content-Security-Policy, SPF, DMARC, SSL certificates and more. Copy-paste config for nginx, Apache, Cloudflare, Vercel and others.",
  path: "/guides",
});

const itemList = jsonLd({
  "@context": "https://schema.org",
  "@type": "ItemList",
  name: "Website security how-to guides",
  itemListElement: GUIDES.map((g, i) => ({
    "@type": "ListItem",
    position: i + 1,
    name: g.title,
    url: `${SITE_URL}/guides/${g.slug}`,
  })),
  publisher: { "@type": "Organization", name: SITE_NAME, url: SITE_URL },
});

export default function GuidesIndex() {
  return (
    <ToolsShell>
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: itemList }} />
      <header className="max-w-2xl">
        <h1 className="text-4xl font-extrabold tracking-tighter text-balance sm:text-5xl">
          Website security how-to guides
        </h1>
        <p className="text-muted-foreground mt-4 text-lg text-pretty">
          Short guides to the fixes our scanner finds most often, each with copy-paste config for
          the platform you run. Not sure what you need? Run the{" "}
          <Link
            href="/tools"
            className="text-foreground font-semibold underline underline-offset-4"
          >
            free checkers
          </Link>{" "}
          first.
        </p>
      </header>
      <ul className="mt-10 grid gap-4 sm:grid-cols-2">
        {GUIDES.map((g) => (
          <li key={g.slug}>
            <Link
              href={`/guides/${g.slug}`}
              className="bg-card/70 hover:border-foreground/30 flex h-full flex-col rounded-3xl border p-6 shadow-[var(--shadow-panel)] transition-colors"
            >
              <span className="text-lg font-bold tracking-tight">{g.title}</span>
              <span className="text-muted-foreground mt-2 flex-1 text-sm leading-relaxed">
                {g.description}
              </span>
              <span className="text-brand mt-4 text-sm font-semibold">Read the guide →</span>
            </Link>
          </li>
        ))}
      </ul>
    </ToolsShell>
  );
}
