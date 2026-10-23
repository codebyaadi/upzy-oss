import type { Metadata } from "next";
import Link from "next/link";

import { ToolsShell } from "@/components/tools/shell";
import { jsonLd, pageMetadata, SITE_NAME, SITE_URL } from "@/lib/seo";
import { TOOLS } from "@/lib/tools";

export const metadata: Metadata = pageMetadata({
  title: "Free website security tools",
  description:
    "Free checks for your website's security headers, SSL certificate, and email spoofing protection (SPF and DMARC). No sign-up, with plain-English fixes for your host.",
  path: "/tools",
});

const itemList = jsonLd({
  "@context": "https://schema.org",
  "@type": "ItemList",
  name: "Free website security tools",
  itemListElement: TOOLS.map((t, i) => ({
    "@type": "ListItem",
    position: i + 1,
    name: t.title,
    url: `${SITE_URL}/tools/${t.slug}`,
  })),
  publisher: { "@type": "Organization", name: SITE_NAME, url: SITE_URL },
});

export default function ToolsIndex() {
  return (
    <ToolsShell>
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: itemList }} />
      <header className="max-w-2xl">
        <h1 className="text-4xl font-extrabold tracking-tighter text-balance sm:text-5xl">
          Free website security tools
        </h1>
        <p className="text-muted-foreground mt-4 text-lg text-pretty">
          Type a domain, get a grade and the exact fix for your host. No account, nothing stored.
          They run the same checks Upzy uses to watch your sites around the clock.
        </p>
      </header>
      <ul className="mt-10 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {TOOLS.map((t) => (
          <li key={t.id}>
            <Link
              href={`/tools/${t.slug}`}
              className="bg-card/70 hover:border-foreground/30 flex h-full flex-col rounded-3xl border p-6 shadow-[var(--shadow-panel)] transition-colors"
            >
              <span className="text-xl font-bold tracking-tight">{t.name}</span>
              <span className="text-muted-foreground mt-2 flex-1 leading-relaxed">{t.summary}</span>
              <span className="text-brand mt-4 text-sm font-semibold">Check a domain →</span>
            </Link>
          </li>
        ))}
      </ul>
    </ToolsShell>
  );
}
