import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Suspense } from "react";

import { Checker } from "@/components/tools/checker";
import { ToolsShell } from "@/components/tools/shell";
import { guidesForTool } from "@/lib/guides";
import { jsonLd, pageMetadata, SITE_NAME, SITE_URL } from "@/lib/seo";
import { TOOLS, toolBySlug } from "@/lib/tools";

export const dynamicParams = false;
export const generateStaticParams = () => TOOLS.map((t) => ({ tool: t.slug }));

export async function generateMetadata({
  params,
}: {
  params: Promise<{ tool: string }>;
}): Promise<Metadata> {
  const tool = toolBySlug((await params).tool);
  if (!tool) return {};
  return pageMetadata({
    title: tool.title,
    description: tool.description,
    path: `/tools/${tool.slug}`,
  });
}

export default async function ToolPage({ params }: { params: Promise<{ tool: string }> }) {
  const tool = toolBySlug((await params).tool);
  if (!tool) notFound();
  const others = TOOLS.filter((t) => t.id !== tool.id);
  const guides = guidesForTool(tool.id);

  const faqData = jsonLd({
    "@context": "https://schema.org",
    "@graph": [
      {
        "@type": "WebApplication",
        name: tool.title,
        url: `${SITE_URL}/tools/${tool.slug}`,
        description: tool.description,
        applicationCategory: "SecurityApplication",
        operatingSystem: "Any",
        browserRequirements: "Requires JavaScript",
        isAccessibleForFree: true,
        offers: { "@type": "Offer", price: 0, priceCurrency: "USD" },
        publisher: { "@type": "Organization", name: SITE_NAME, url: SITE_URL },
      },
      {
        "@type": "BreadcrumbList",
        itemListElement: [
          { "@type": "ListItem", position: 1, name: SITE_NAME, item: SITE_URL },
          { "@type": "ListItem", position: 2, name: "Free tools", item: `${SITE_URL}/tools` },
          {
            "@type": "ListItem",
            position: 3,
            name: tool.name,
            item: `${SITE_URL}/tools/${tool.slug}`,
          },
        ],
      },
      {
        "@type": "FAQPage",
        mainEntity: tool.faq.map((f) => ({
          "@type": "Question",
          name: f.q,
          acceptedAnswer: { "@type": "Answer", text: f.a },
        })),
      },
    ],
  });

  return (
    <ToolsShell>
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: faqData }} />
      <header className="max-w-2xl">
        <Link
          href="/tools"
          className="text-muted-foreground hover:text-foreground text-sm font-semibold"
        >
          ← Free tools
        </Link>
        <h1 className="mt-4 text-4xl font-extrabold tracking-tighter text-balance sm:text-5xl">
          {tool.title}
        </h1>
        <p className="text-muted-foreground mt-4 text-lg text-pretty">{tool.summary}</p>
      </header>

      <div className="mt-8 max-w-3xl">
        <Suspense fallback={null}>
          <Checker tool={tool} />
        </Suspense>
      </div>

      <section className="mt-16 max-w-3xl">
        <h2 className="text-2xl font-extrabold tracking-tighter">What it checks</h2>
        <ul className="mt-4 list-disc space-y-2 pl-5 leading-relaxed">
          {tool.checks.map((c) => (
            <li key={c}>{c}</li>
          ))}
        </ul>
        <p className="text-muted-foreground mt-4 text-sm">
          It makes a few ordinary requests to the domain you enter, the same ones a browser or mail
          server would, and stores nothing about you or the result. Only public sites can be
          checked.
        </p>
      </section>

      <section className="mt-12 max-w-3xl">
        <h2 className="text-2xl font-extrabold tracking-tighter">Questions</h2>
        <dl className="mt-4 space-y-5">
          {tool.faq.map((f) => (
            <div key={f.q}>
              <dt className="font-bold">{f.q}</dt>
              <dd className="text-muted-foreground mt-1 leading-relaxed">{f.a}</dd>
            </div>
          ))}
        </dl>
      </section>

      {guides.length > 0 && (
        <section className="mt-12 max-w-3xl">
          <h2 className="text-2xl font-extrabold tracking-tighter">How to fix what it finds</h2>
          <ul className="mt-4 space-y-2">
            {guides.map((g) => (
              <li key={g.slug}>
                <Link
                  href={`/guides/${g.slug}`}
                  className="text-foreground font-semibold underline underline-offset-4"
                >
                  {g.title}
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="mt-12 max-w-3xl">
        <h2 className="text-2xl font-extrabold tracking-tighter">More free checks</h2>
        <ul className="mt-4 grid gap-3 sm:grid-cols-2">
          {others.map((t) => (
            <li key={t.id}>
              <Link
                href={`/tools/${t.slug}`}
                className="bg-card/70 hover:border-foreground/30 block rounded-3xl border p-5 transition-colors"
              >
                <span className="font-bold">{t.name}</span>
                <span className="text-muted-foreground mt-1 block text-sm">{t.summary}</span>
              </Link>
            </li>
          ))}
        </ul>
      </section>
    </ToolsShell>
  );
}
