import Link from "next/link";

import { NavActions } from "@/components/auth-aware";
import { ButtonLink } from "@/components/button-link";
import { Logo } from "@/components/logo";

const links = [
  { href: "#features", label: "Features" },
  { href: "#how-it-works", label: "How it works" },
  { href: "#faq", label: "FAQ" },
  { href: "/pricing", label: "Pricing" },
] as const;

/** A plain bar across the top of the page: logo, a few anchors, and the sign-in actions. */
export function Nav() {
  return (
    <header className="bg-background/80 sticky top-0 z-50 border-b backdrop-blur-xl">
      <nav
        aria-label="Main"
        className="mx-auto flex h-16 max-w-6xl items-center justify-between gap-4 px-4"
      >
        <Link href="/" aria-label="Upzy home">
          <Logo />
        </Link>
        <ul className="hidden items-center gap-1 sm:flex">
          {links.map((l) => (
            <li key={l.href}>
              <ButtonLink variant="ghost" size="sm" href={l.href}>
                {l.label}
              </ButtonLink>
            </li>
          ))}
        </ul>
        <NavActions />
      </nav>
    </header>
  );
}
