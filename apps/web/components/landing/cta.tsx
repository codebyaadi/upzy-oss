import Link from "next/link";

import { PrimaryCta } from "@/components/auth-aware";
import { Logo } from "@/components/logo";

export function Cta() {
  return (
    <section id="early-access" className="px-4 py-24">
      <div className="bg-card/70 mx-auto max-w-5xl rounded-[2rem] border p-8 text-center shadow-[var(--shadow-panel)] backdrop-blur-xl sm:p-14">
        <h2 className="mx-auto max-w-2xl text-4xl font-extrabold tracking-tighter text-balance sm:text-5xl">
          Start watching with <span className="text-brand">Upzy</span>.
        </h2>
        <p className="text-muted-foreground mx-auto mt-4 max-w-xl text-lg leading-relaxed text-pretty">
          Create a free account, add your first monitor and get alerted in minutes.
        </p>
        <PrimaryCta size="lg" className="mt-8" />
      </div>
      <footer className="text-muted-foreground mx-auto mt-16 flex max-w-5xl flex-col items-center justify-between gap-5 text-xs sm:flex-row">
        <Logo />
        <nav aria-label="Legal" className="flex flex-wrap justify-center gap-x-5 gap-y-2">
          <Link href="/pricing" className="hover:text-foreground underline underline-offset-4">
            Pricing
          </Link>
          <Link href="/terms" className="hover:text-foreground underline underline-offset-4">
            Terms
          </Link>
          <Link href="/privacy" className="hover:text-foreground underline underline-offset-4">
            Privacy
          </Link>
          <Link
            href="/acceptable-use"
            className="hover:text-foreground underline underline-offset-4"
          >
            Acceptable use
          </Link>
          <Link href="/ai-data" className="hover:text-foreground underline underline-offset-4">
            AI data use
          </Link>
        </nav>
        <p>&copy; {new Date().getFullYear()} Upzy. Press d to toggle dark mode.</p>
      </footer>
    </section>
  );
}
