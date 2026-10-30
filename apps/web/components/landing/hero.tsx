import { ArrowRight01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Badge } from "@upzy/ui/components/badge";

import { PrimaryCta } from "@/components/auth-aware";
import { BuiltBy } from "@/components/built-by";
import { ButtonLink } from "@/components/button-link";

const rows = [
  { name: "api.acme.com", ms: "182 ms", up: true },
  { name: "acme.com", ms: "96 ms", up: true },
  { name: "checkout.acme.com", ms: "Timeout", up: false },
  { name: "status.acme.com", ms: "121 ms", up: true },
];

export function Hero() {
  return (
    <section className="px-4 pt-32 pb-16 sm:pt-40">
      <div className="animate-in fade-in slide-in-from-bottom-4 mx-auto max-w-5xl text-center duration-700">
        <div className="mb-7 flex justify-center">
          <BuiltBy />
        </div>
        <p className="text-brand text-sm font-semibold">
          Uptime monitoring + attack-surface security
        </p>
        <h1 className="mx-auto mt-5 max-w-4xl text-5xl leading-[1.02] font-extrabold tracking-tighter text-balance sm:text-6xl lg:text-7xl">
          Know it&rsquo;s down before your customers do.
        </h1>
        <p className="text-muted-foreground mx-auto mt-6 max-w-2xl text-lg leading-relaxed text-pretty">
          Upzy watches your sites and APIs, scans what you expose to the internet, and gives you the
          fix for every finding. Connect your own AI key and it explains incidents in plain English
          too.
        </p>
        <div className="mt-9 flex flex-col items-center justify-center gap-3 sm:flex-row">
          <PrimaryCta size="lg">
            <HugeiconsIcon icon={ArrowRight01Icon} aria-hidden />
          </PrimaryCta>
          <ButtonLink size="lg" variant="outline" href="#how-it-works">
            See how it works
          </ButtonLink>
        </div>
      </div>

      <div className="bg-card/70 mx-auto mt-16 max-w-3xl rounded-3xl border p-3 shadow-[var(--shadow-panel)] backdrop-blur-xl">
        <div className="flex items-center justify-between px-4 py-3">
          <span className="text-sm font-bold tracking-tight">Monitors</span>
          <Badge variant="secondary">Product preview</Badge>
        </div>
        <ul className="space-y-1">
          {rows.map((r) => (
            <li
              key={r.name}
              className="hover:bg-accent/50 flex items-center justify-between rounded-2xl px-4 py-3 text-sm"
            >
              <span className="flex items-center gap-3">
                <span
                  aria-hidden
                  className={`size-2 rounded-full ${r.up ? "bg-brand" : "bg-destructive"}`}
                />
                <span className="font-medium">{r.name}</span>
              </span>
              <span className="text-muted-foreground flex items-center gap-3 text-xs">
                {r.ms}
                <span className="font-semibold">{r.up ? "Up" : "Down"}</span>
              </span>
            </li>
          ))}
        </ul>
        <div className="bg-accent/60 text-accent-foreground m-1 mt-3 rounded-2xl px-4 py-3 text-sm">
          <span className="text-brand font-semibold">AI summary:</span> checkout.acme.com stopped
          responding at 02:14 UTC. DNS resolves, TLS is valid, the origin times out.
        </div>
      </div>
    </section>
  );
}
