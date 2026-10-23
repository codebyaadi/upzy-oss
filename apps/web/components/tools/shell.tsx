import Link from "next/link";

import { Logo } from "@/components/logo";

/** The frame for the public tool pages: logo, content, and the links back into the site. */
export function ToolsShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="ambient min-h-svh px-4 py-10">
      <div className="mx-auto max-w-6xl">
        <div className="flex items-center justify-between gap-4">
          <Link href="/" aria-label="Upzy home">
            <Logo />
          </Link>
          <nav aria-label="Main" className="text-muted-foreground flex gap-5 text-sm font-semibold">
            <Link href="/tools" className="hover:text-foreground">
              Free tools
            </Link>
            <Link href="/guides" className="hover:text-foreground">
              Guides
            </Link>
            <Link href="/pricing" className="hover:text-foreground">
              Pricing
            </Link>
            <Link href="/login" className="hover:text-foreground">
              Sign in
            </Link>
          </nav>
        </div>
        <main className="mt-12">{children}</main>
      </div>
    </div>
  );
}
