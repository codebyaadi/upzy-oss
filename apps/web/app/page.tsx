import { Cta } from "@/components/landing/cta";
import { Faq } from "@/components/landing/faq";
import { Features } from "@/components/landing/features";
import { Hero } from "@/components/landing/hero";
import { HowItWorks } from "@/components/landing/how-it-works";
import { Nav } from "@/components/landing/nav";

const siteUrl = process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3001";

/** Structured data for search engines and link previews: what Upzy is and who makes it. Static, so safe to inline. */
const structuredData = JSON.stringify({
  "@context": "https://schema.org",
  "@type": "SoftwareApplication",
  name: "Upzy",
  url: siteUrl,
  applicationCategory: "DeveloperApplication",
  operatingSystem: "Web",
  description:
    "Uptime monitoring and external attack-surface security for small teams, with plain-English fixes for your stack.",
  author: { "@type": "Person", name: "Aditya Rajbhar", url: "https://github.com/codebyaadi" },
}).replace(/</g, "\\u003c");

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
    </div>
  );
}
