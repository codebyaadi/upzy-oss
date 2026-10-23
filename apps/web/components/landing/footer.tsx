import Link from "next/link";

import { Logo } from "@/components/logo";
import { REPO_URL, TAGLINE } from "@/lib/seo";

const product = [
  { href: "/#features", label: "Features" },
  { href: "/#how-it-works", label: "How it works" },
  { href: "/tools", label: "Free tools" },
  { href: "/guides", label: "Guides" },
  { href: "/pricing", label: "Pricing" },
] as const;

const legal = [
  { href: "/terms", label: "Terms" },
  { href: "/privacy", label: "Privacy" },
  { href: "/acceptable-use", label: "Acceptable use" },
  { href: "/ai-data", label: "AI data use" },
] as const;

const link = "text-muted-foreground hover:text-foreground";

/** Brand and a line about it on the left, the main links on the right, and the small print underneath. */
export function Footer() {
  return (
    <footer className="border-t px-4 py-12">
      <div className="mx-auto flex max-w-5xl flex-col items-start justify-between gap-8 sm:flex-row sm:items-center">
        <div className="space-y-3">
          <Link href="/" aria-label="Upzy home" className="inline-block">
            <Logo />
          </Link>
          <p className="text-muted-foreground max-w-xs text-sm">{TAGLINE}</p>
        </div>
        <nav aria-label="Footer" className="flex flex-wrap gap-x-6 gap-y-2 text-sm">
          {product.map((l) => (
            <Link key={l.href} href={l.href} className={link}>
              {l.label}
            </Link>
          ))}
          <a href={REPO_URL} target="_blank" rel="noopener noreferrer" className={link}>
            GitHub
          </a>
        </nav>
      </div>
      <div className="text-muted-foreground mx-auto mt-8 flex max-w-5xl flex-col gap-3 text-xs sm:flex-row sm:items-center sm:justify-between">
        <p>&copy; {new Date().getFullYear()} Upzy &middot; MIT licensed</p>
        <nav aria-label="Legal" className="flex flex-wrap gap-x-5 gap-y-2">
          {legal.map((l) => (
            <Link key={l.href} href={l.href} className="hover:text-foreground">
              {l.label}
            </Link>
          ))}
        </nav>
      </div>
    </footer>
  );
}
