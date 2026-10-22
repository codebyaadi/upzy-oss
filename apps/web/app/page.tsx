import { Cta } from "@/components/landing/cta";
import { Faq } from "@/components/landing/faq";
import { Features } from "@/components/landing/features";
import { Hero } from "@/components/landing/hero";
import { HowItWorks } from "@/components/landing/how-it-works";
import { Nav } from "@/components/landing/nav";

export default function Page() {
  return (
    <div className="ambient min-h-svh">
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
