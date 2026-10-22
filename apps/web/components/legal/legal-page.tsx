import Link from "next/link";

import { Logo } from "@/components/logo";
import { DOCS, legal } from "@/lib/legal";

export function Contact() {
  const { email } = legal();
  return email ? (
    <a
      href={`mailto:${email}`}
      className="text-foreground font-semibold underline underline-offset-4"
    >
      {email}
    </a>
  ) : (
    <a
      href="https://github.com/codebyaadi"
      target="_blank"
      rel="noopener noreferrer"
      className="text-foreground font-semibold underline underline-offset-4"
    >
      github.com/codebyaadi
    </a>
  );
}

export const Section = ({ title, children }: { title: string; children: React.ReactNode }) => (
  <section className="mt-10">
    <h2 className="text-xl font-bold tracking-tight">{title}</h2>
    <div className="mt-3 space-y-3">{children}</div>
  </section>
);
export const P = ({ children }: { children: React.ReactNode }) => (
  <p className="leading-relaxed">{children}</p>
);
export const UL = ({ children }: { children: React.ReactNode }) => (
  <ul className="list-disc space-y-1.5 pl-5 leading-relaxed">{children}</ul>
);

/** Shared frame for the legal documents: plain readable text, links to the sibling documents. */
export function LegalPage({
  title,
  intro,
  children,
}: {
  title: string;
  intro: string;
  children: React.ReactNode;
}) {
  const { updated } = legal();
  return (
    <div className="ambient min-h-svh px-4 py-10">
      <div className="mx-auto max-w-3xl">
        <Link href="/" aria-label="Upzy home" className="inline-block">
          <Logo />
        </Link>
        <article className="bg-card/70 mt-8 rounded-3xl border p-6 shadow-[var(--shadow-panel)] backdrop-blur-xl sm:p-10">
          <h1 className="text-3xl font-extrabold tracking-tighter text-balance sm:text-4xl">
            {title}
          </h1>
          <p className="text-muted-foreground mt-2 text-sm">Last updated {updated}</p>
          <p className="mt-6 text-lg leading-relaxed text-pretty">{intro}</p>
          <div className="text-[0.95rem]">{children}</div>
        </article>
        <nav
          aria-label="Legal documents"
          className="text-muted-foreground mt-6 flex flex-wrap gap-x-5 gap-y-2 text-sm"
        >
          {DOCS.map((d) => (
            <Link
              key={d.href}
              href={d.href}
              className="hover:text-foreground underline underline-offset-4"
            >
              {d.label}
            </Link>
          ))}
        </nav>
      </div>
    </div>
  );
}
