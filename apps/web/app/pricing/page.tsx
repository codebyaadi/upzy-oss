import { PAID_PLANS, PLANS, TRIAL_DAYS } from "@upzy/billing";
import type { Metadata } from "next";
import Link from "next/link";

import { ButtonLink } from "@/components/button-link";
import { Logo } from "@/components/logo";
import { PlanGrid } from "@/components/plan-cards";
import { legal } from "@/lib/legal";
import { jsonLd, pageMetadata, SITE_NAME, SITE_URL } from "@/lib/seo";

// Whether this is early access is read from the server's environment at request time.
export const dynamic = "force-dynamic";

export const metadata: Metadata = pageMetadata({
  title: "Pricing",
  description:
    "Upzy is free during early access, with every feature and no plan limits. Paid plans, from $15 a month, open later and will be announced in advance. Uptime monitoring, security scans, alerts and status pages, with unlimited team members.",
  path: "/pricing",
});

// During early access paid plans cannot be bought yet, so search engines are told they are not in stock.
const offersFor = (earlyAccess: boolean) =>
  jsonLd({
    "@context": "https://schema.org",
    "@type": "SoftwareApplication",
    name: SITE_NAME,
    url: SITE_URL,
    applicationCategory: "DeveloperApplication",
    operatingSystem: "Web",
    offers: ["free", ...PAID_PLANS].map((id) => ({
      "@type": "Offer",
      name: PLANS[id as keyof typeof PLANS].name,
      description: PLANS[id as keyof typeof PLANS].blurb,
      price: PLANS[id as keyof typeof PLANS].price.monthly,
      priceCurrency: "USD",
      url: `${SITE_URL}/pricing`,
      availability:
        earlyAccess && id !== "free" ? "https://schema.org/PreOrder" : "https://schema.org/InStock",
    })),
  });

export default function Pricing() {
  const { earlyAccess } = legal();
  const offers = offersFor(earlyAccess);
  return (
    <div className="ambient min-h-svh px-4 py-10">
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: offers }} />
      <div className="mx-auto max-w-6xl">
        <Link href="/" aria-label="Upzy home" className="inline-block">
          <Logo />
        </Link>
        {earlyAccess && (
          <div className="bg-card mt-8 max-w-2xl rounded-xl border p-4 text-sm">
            <p className="font-semibold">Free during early access</p>
            <p className="text-muted-foreground mt-1">
              Upzy is in early access: every feature is free, with no plan limits, and nothing can
              be bought yet. The plans below show what paid plans will look like later. We will
              announce them in advance, and you will never be charged unless you choose a paid plan.
            </p>
          </div>
        )}
        <header className="mt-10 max-w-2xl">
          <h1 className="text-4xl font-extrabold tracking-tighter text-balance sm:text-5xl">
            Simple pricing, unlimited team members
          </h1>
          <p className="text-muted-foreground mt-4 text-lg text-pretty">
            Every plan includes uptime monitoring, security scans, alerts and status pages.{" "}
            {earlyAccess
              ? "During early access everything is included for free."
              : `New accounts get ${TRIAL_DAYS} days of Pro, with no card. After that you stay on Free or pick a plan. Yearly billing is two months free.`}
          </p>
        </header>
        <div className="mt-10">
          <PlanGrid>
            {(id) =>
              earlyAccess && id !== "free" ? (
                <p className="text-muted-foreground mt-6 text-sm">Opens after early access</p>
              ) : (
                <ButtonLink
                  href="/sign-up"
                  variant={id === "pro" ? "default" : "outline"}
                  className="mt-6"
                >
                  {id === "free" ? "Start free" : "Start with a free trial"}
                </ButtonLink>
              )
            }
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
