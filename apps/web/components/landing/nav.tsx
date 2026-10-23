import { Menu01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { buttonVariants } from "@upzy/ui/lib/button-variants";
import Link from "next/link";

import { NavActions } from "@/components/auth-aware";
import { Logo } from "@/components/logo";
import { ThemeToggle } from "@/components/theme-toggle";
import { REPO_URL } from "@/lib/seo";

const links = [
  { href: "/#features", label: "Features" },
  { href: "/#how-it-works", label: "How it works" },
  { href: "/tools", label: "Free tools" },
  { href: "/guides", label: "Guides" },
  { href: "/pricing", label: "Pricing" },
  { href: "/#faq", label: "FAQ" },
] as const;

const linkClass = buttonVariants({ variant: "ghost", size: "sm" }) + " text-muted-foreground";

/**
 * A floating pill across the top of the page: logo on the left, the sections in the middle, the theme switch and the
 * sign-in actions on the right. On a narrow screen the sections move into a small menu (no JavaScript needed).
 */
export function Nav() {
  return (
    <header className="fixed inset-x-0 top-0 z-40 px-3 pt-3 sm:px-6">
      <nav
        aria-label="Main"
        className="bg-card/70 relative mx-auto flex h-14 max-w-5xl items-center justify-between gap-2 rounded-full border pr-2 pl-4 shadow-[var(--shadow-panel)] backdrop-blur-xl"
      >
        <Link href="/" aria-label="Upzy home">
          <Logo />
        </Link>

        <ul className="hidden items-center gap-1 lg:flex">
          {links.map((l) => (
            <li key={l.href}>
              <Link href={l.href} className={linkClass}>
                {l.label}
              </Link>
            </li>
          ))}
          <li>
            <a href={REPO_URL} target="_blank" rel="noopener noreferrer" className={linkClass}>
              GitHub
            </a>
          </li>
        </ul>

        <div className="flex items-center gap-1">
          <ThemeToggle />
          <NavActions />
          <details className="group relative lg:hidden">
            <summary
              aria-label="Menu"
              className={`${buttonVariants({ variant: "ghost", size: "icon" })} cursor-pointer list-none [&::-webkit-details-marker]:hidden`}
            >
              <HugeiconsIcon icon={Menu01Icon} aria-hidden />
            </summary>
            <ul className="bg-card absolute top-full right-0 mt-3 w-52 space-y-1 rounded-3xl border p-2 shadow-[var(--shadow-panel)]">
              {links.map((l) => (
                <li key={l.href}>
                  <Link href={l.href} className={`${linkClass} w-full justify-start`}>
                    {l.label}
                  </Link>
                </li>
              ))}
              <li>
                <Link href="/login" className={`${linkClass} w-full justify-start sm:hidden`}>
                  Sign in
                </Link>
              </li>
              <li>
                <a
                  href={REPO_URL}
                  target="_blank"
                  rel="noopener noreferrer"
                  className={`${linkClass} w-full justify-start`}
                >
                  GitHub
                </a>
              </li>
            </ul>
          </details>
        </div>
      </nav>
    </header>
  );
}
