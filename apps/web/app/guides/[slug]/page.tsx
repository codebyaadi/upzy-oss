import { fixFor, UNKNOWN_STACK, type Fix } from "@upzy/security/fixes";
import { buttonVariants } from "@upzy/ui/lib/button-variants";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { CodeBlock } from "@/components/guides/snippet";
import { ToolsShell } from "@/components/tools/shell";
import { GUIDES, STACKS, guideBySlug, type Guide } from "@/lib/guides";
import { AUTHOR, jsonLd, pageMetadata, SITE_NAME, SITE_URL } from "@/lib/seo";
import { TOOLS } from "@/lib/tools";

/** Shown in the page's structured data. Bump it when a guide's advice changes. */
const UPDATED = "2026-10-23";
const EXAMPLE = "example.com";

export const dynamicParams = false;
export const generateStaticParams = () => GUIDES.map((g) => ({ slug: g.slug }));

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const g = guideBySlug((await params).slug);
  if (!g) return {};
  return pageMetadata({ title: g.title, description: g.description, path: `/guides/${g.slug}` });
}

/** The instructions for one platform: the same library the dashboard uses for "Fix it for your stack". */
function instructions(g: Guide): { id: string; label: string; fix: Fix }[] {
  if (g.kind === "single") {
    const fix = fixFor({ checkKey: g.checkKey, stack: UNKNOWN_STACK, host: EXAMPLE });
    return fix ? [{ id: "fix", label: "Steps", fix }] : [];
  }
  return STACKS.flatMap((s) => {
    const fix = fixFor({ checkKey: g.checkKey, stack: s.stack, host: EXAMPLE });
    return fix && fix.snippets.length ? [{ id: s.id, label: s.label, fix }] : [];
  });
}

export default async function GuidePage({ params }: { params: Promise<{ slug: string }> }) {
  const g = guideBySlug((await params).slug);
  if (!g) notFound();
  const tool = TOOLS.find((t) => t.id === g.tool)!;
  const fixes = instructions(g);
  const steps = fixes[0]?.fix.steps ?? [];
  const related = GUIDES.filter((x) => x.slug !== g.slug && x.tool === g.tool).slice(0, 4);
  const url = `${SITE_URL}/guides/${g.slug}`;

  const data = jsonLd({
    "@context": "https://schema.org",
    "@graph": [
      {
        "@type": "TechArticle",
        headline: g.title,
        description: g.description,
        url,
        mainEntityOfPage: url,
        datePublished: UPDATED,
        dateModified: UPDATED,
        inLanguage: "en",
        author: { "@type": "Person", name: AUTHOR.name, url: AUTHOR.url },
        publisher: { "@type": "Organization", name: SITE_NAME, url: SITE_URL },
        image: `${SITE_URL}/opengraph-image`,
      },
      {
        "@type": "BreadcrumbList",
        itemListElement: [
          { "@type": "ListItem", position: 1, name: SITE_NAME, item: SITE_URL },
          { "@type": "ListItem", position: 2, name: "Guides", item: `${SITE_URL}/guides` },
          { "@type": "ListItem", position: 3, name: g.title, item: url },
        ],
      },
      {
        "@type": "FAQPage",
        mainEntity: g.faq.map((f) => ({
          "@type": "Question",
          name: f.q,
          acceptedAnswer: { "@type": "Answer", text: f.a },
        })),
      },
    ],
  });

  return (
    <ToolsShell>
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: data }} />
      <article className="max-w-3xl">
        <header>
          <Link
            href="/guides"
            className="text-muted-foreground hover:text-foreground text-sm font-semibold"
          >
            ← Guides
          </Link>
          <h1 className="mt-4 text-4xl font-extrabold tracking-tighter text-balance sm:text-5xl">
            {g.title}
          </h1>
          <p className="text-muted-foreground mt-4 text-lg leading-relaxed text-pretty">
            {g.intro}
          </p>
          <p className="text-muted-foreground mt-3 text-xs">Updated {UPDATED}</p>
        </header>

        <section className="mt-10">
          <h2 className="text-2xl font-extrabold tracking-tighter">Why it matters</h2>
          <ul className="mt-4 list-disc space-y-2 pl-5 leading-relaxed">
            {g.why.map((w) => (
              <li key={w}>{w}</li>
            ))}
          </ul>
        </section>

        <section className="mt-12">
          <h2 className="text-2xl font-extrabold tracking-tighter">How to fix it</h2>
          {steps.length > 0 && (
            <ol className="mt-4 list-decimal space-y-2 pl-5 leading-relaxed">
              {steps.map((s) => (
                <li key={s}>{s}</li>
              ))}
            </ol>
          )}
          {g.kind === "header" && (
            <>
              <p className="text-muted-foreground mt-4 text-sm">
                Pick what your site runs on. Replace {EXAMPLE} with your own domain where it
                appears.
              </p>
              <nav aria-label="Platforms" className="mt-3 flex flex-wrap gap-2">
                {fixes.map((f) => (
                  <a
                    key={f.id}
                    href={`#${f.id}`}
                    className="hover:border-foreground/30 rounded-full border px-3 py-1 text-sm font-semibold"
                  >
                    {f.label}
                  </a>
                ))}
              </nav>
            </>
          )}
          <p className="text-muted-foreground mt-6 text-sm">
            After you deploy, re-check the site. A CDN or the browser cache can keep serving the old
            headers for a few minutes.
          </p>
          <div className="mt-6 space-y-8">
            {fixes.map((f) => (
              <div key={f.id} id={f.id}>
                {g.kind === "header" && (
                  <h3 className="text-xl font-bold tracking-tight">{f.label}</h3>
                )}
                {g.kind === "header" &&
                  f.fix.steps.slice(1).map((s) => (
                    <p key={s} className="text-muted-foreground mt-2 text-sm leading-relaxed">
                      {s}
                    </p>
                  ))}
                {f.fix.snippets.map((s) => (
                  <CodeBlock key={s.label} label={s.label} code={s.code} />
                ))}
              </div>
            ))}
          </div>
        </section>

        <section className="mt-12">
          <h2 className="text-2xl font-extrabold tracking-tighter">Common mistakes</h2>
          <ul className="mt-4 list-disc space-y-2 pl-5 leading-relaxed">
            {g.mistakes.map((m) => (
              <li key={m}>{m}</li>
            ))}
          </ul>
        </section>

        <section className="bg-card/70 mt-12 rounded-3xl border p-6 shadow-[var(--shadow-panel)] sm:p-8">
          <h2 className="text-2xl font-extrabold tracking-tighter">Check that it worked</h2>
          <p className="text-muted-foreground mt-2 leading-relaxed">
            Run your domain through the free {tool.name.toLowerCase()}. It takes a few seconds,
            needs no account, and shows anything still missing.
          </p>
          <Link href={`/tools/${tool.slug}`} className={`${buttonVariants()} mt-4`}>
            Open the {tool.name.toLowerCase()}
          </Link>
        </section>

        <section className="mt-12">
          <h2 className="text-2xl font-extrabold tracking-tighter">Questions</h2>
          <dl className="mt-4 space-y-5">
            {g.faq.map((f) => (
              <div key={f.q}>
                <dt className="font-bold">{f.q}</dt>
                <dd className="text-muted-foreground mt-1 leading-relaxed">{f.a}</dd>
              </div>
            ))}
          </dl>
        </section>

        {related.length > 0 && (
          <section className="mt-12">
            <h2 className="text-2xl font-extrabold tracking-tighter">Related guides</h2>
            <ul className="mt-4 grid gap-3 sm:grid-cols-2">
              {related.map((r) => (
                <li key={r.slug}>
                  <Link
                    href={`/guides/${r.slug}`}
                    className="bg-card/70 hover:border-foreground/30 block rounded-3xl border p-5 transition-colors"
                  >
                    <span className="font-bold">{r.title}</span>
                  </Link>
                </li>
              ))}
            </ul>
          </section>
        )}

        <section className="mt-12 text-sm">
          <p className="text-muted-foreground leading-relaxed">
            Don&apos;t want to check by hand? Upzy watches your site around the clock and tells you
            when a header, certificate or email record slips.{" "}
            <Link
              href="/sign-up"
              className="text-foreground font-semibold underline underline-offset-4"
            >
              Start free
            </Link>
            .
          </p>
        </section>
      </article>
    </ToolsShell>
  );
}
