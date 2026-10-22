import { TRIAL_DAYS } from "@upzy/billing";
import type { Metadata } from "next";
import Link from "next/link";

import { ButtonLink } from "@/components/button-link";
import { Logo } from "@/components/logo";
import { PlanGrid } from "@/components/plan-cards";

export const metadata: Metadata = {
  title: "Pricing",
  description: "Uptime monitoring and security checks with one grade. Start free, no card needed.",
};

export default function Pricing() {
  return (
    <div className="ambient min-h-svh px-4 py-10">
      <div className="mx-auto max-w-6xl">
        <Link href="/" aria-label="Upzy home" className="inline-block">
          <Logo />
        </Link>
        <header className="mt-10 max-w-2xl">
          <h1 className="text-4xl font-extrabold tracking-tighter text-balance sm:text-5xl">
            Simple pricing, unlimited team members
          </h1>
          <p className="text-muted-foreground mt-4 text-lg text-pretty">
            Every plan includes uptime monitoring, security scans, alerts and status pages. New
            accounts get {TRIAL_DAYS} days of Pro, with no card. After that you stay on Free or pick
            a plan. Yearly billing is two months free.
          </p>
        </header>
        <div className="mt-10">
          <PlanGrid>
            {(id) => (
              <ButtonLink
                href="/sign-up"
                variant={id === "pro" ? "default" : "outline"}
                className="mt-6"
              >
                {id === "free" ? "Start free" : "Start with a free trial"}
              </ButtonLink>
            )}
          </PlanGrid>
        </div>
        <p className="text-muted-foreground mt-8 max-w-2xl text-sm">
          Limits only stop you adding more; your monitors and alerts keep running if you go over.
          Prices are in US dollars. AI features use your own provider key and are billed by that
          provider. See the{" "}
          <Link href="/terms" className="underline underline-offset-4">
            Terms
          </Link>{" "}
          and{" "}
          <Link href="/privacy" className="underline underline-offset-4">
            Privacy Policy
          </Link>
          .
        </p>
      </div>
    </div>
  );
}
