import { PLANS, PAID_PLANS } from "@upzy/billing";
import type { Metadata } from "next";

import { Cta } from "@/components/landing/cta";
import { Faq, faqItems } from "@/components/landing/faq";
import { Features } from "@/components/landing/features";
import { Footer } from "@/components/landing/footer";
import { Hero } from "@/components/landing/hero";
import { HowItWorks } from "@/components/landing/how-it-works";
import { Nav } from "@/components/landing/nav";
import { AUTHOR, jsonLd, REPO_URL, SITE_NAME, SITE_URL, TAGLINE } from "@/lib/seo";

export const metadata: Metadata = {
  alternates: { canonical: "/" },
  openGraph: {
    type: "website",
    siteName: SITE_NAME,
    url: "/",
    locale: "en_US",
    images: [{ url: "/opengraph-image", width: 1200, height: 630 }],
    title: "Upzy: uptime monitoring and attack-surface security",
    description:
      "Know when your sites go down and what's exposed before attackers do. Free to start, open source.",
  },
};

const prices = ["free", ...PAID_PLANS].map((id) => PLANS[id as keyof typeof PLANS].price.monthly);

/**
 * What a search engine should know about the site: who makes it, what the product is and costs, and the questions
 * answered on the page. Everything here is also visible on the page, which is what search engines require.
 */
const structuredData = jsonLd({
  "@context": "https://schema.org",
  "@graph": [
    {
      "@type": "Organization",
      "@id": `${SITE_URL}/#organization`,
      name: SITE_NAME,
      url: SITE_URL,
      logo: { "@type": "ImageObject", url: `${SITE_URL}/logo-512.png`, width: 512, height: 512 },
      sameAs: [REPO_URL, AUTHOR.url],
      founder: { "@type": "Person", name: AUTHOR.name, url: AUTHOR.url },
    },
    {
      "@type": "WebSite",
      "@id": `${SITE_URL}/#website`,
      url: SITE_URL,
      name: SITE_NAME,
      description: TAGLINE,
      publisher: { "@id": `${SITE_URL}/#organization` },
      inLanguage: "en",
    },
    {
      "@type": "SoftwareApplication",
      "@id": `${SITE_URL}/#software`,
      name: SITE_NAME,
      url: SITE_URL,
      applicationCategory: "DeveloperApplication",
      operatingSystem: "Web",
      description: TAGLINE,
      license: "https://opensource.org/licenses/MIT",
      codeRepository: REPO_URL,
      author: { "@id": `${SITE_URL}/#organization` },
      featureList: [
        "Uptime monitoring for HTTP, TCP, DNS, SSL and heartbeat checks",
        "Public status pages with email subscribers and custom domains",
        "External attack-surface scans with plain-English fixes",
        "Incident alerts by email, Slack, Discord and signed webhooks",
        "Maintenance windows and slow-response warnings",
        "Workspaces for agencies, with limited client access and client reports",
      ],
      offers: {
        "@type": "AggregateOffer",
        priceCurrency: "USD",
        lowPrice: Math.min(...prices),
        highPrice: Math.max(...prices),
        offerCount: prices.length,
        url: `${SITE_URL}/pricing`,
      },
    },
    {
      "@type": "FAQPage",
      "@id": `${SITE_URL}/#faq`,
      mainEntity: faqItems.map((f) => ({
        "@type": "Question",
        name: f.q,
        acceptedAnswer: { "@type": "Answer", text: f.a },
      })),
    },
  ],
});

export default function Page() {
  return (
    <div className="ambient min-h-svh">
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: structuredData }} />
      <Nav />
      <main>
        <Hero />
        <Features />
        <HowItWorks />
        <Faq />
        <Cta />
      </main>
      <Footer />
    </div>
  );
}
