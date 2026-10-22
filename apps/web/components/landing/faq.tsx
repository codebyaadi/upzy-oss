import { ArrowDown01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";

const items = [
  {
    q: "Is Upzy available today?",
    a: "Yes: uptime monitoring, alerts, passive security scans, subdomain discovery, vulnerability matching, AI explanations and the weekly digest all work. Public status pages and AI incident triage are still being built and are marked Coming soon.",
  },
  {
    q: "Will you scan sites I don't own?",
    a: "Only passive checks, which look at what any visitor can already see. Anything more intrusive requires you to prove you own the domain first.",
  },
  {
    q: "What does the AI actually do?",
    a: "It explains findings in plain English with fix snippets, turns a sentence into a monitor draft, and writes the weekly summary. It can't change anything on its own: drafts are for you to review. It's off by default per organisation, and an admin connects the one provider that sees data, with their own key.",
  },
  {
    q: "Which AI providers are used?",
    a: "Only the AI provider you connect with your own API key (Groq, OpenAI, Anthropic, Gemini or OpenRouter). Upzy has no AI key of its own, and secrets and tokens are redacted before anything is sent.",
  },
];

export function Faq() {
  return (
    <section id="faq" className="px-4 py-24">
      <div className="mx-auto max-w-3xl">
        <p className="text-brand text-sm font-semibold">FAQ</p>
        <h2 className="mt-3 text-4xl font-extrabold tracking-tighter text-balance sm:text-5xl">
          Questions, answered.
        </h2>
        <div className="mt-10 space-y-3">
          {items.map((i) => (
            <details
              key={i.q}
              className="group bg-card/70 rounded-3xl border px-6 py-5 backdrop-blur open:shadow-[var(--shadow-panel)]"
            >
              <summary className="flex cursor-pointer list-none items-center justify-between gap-4 font-bold tracking-tight">
                {i.q}
                <HugeiconsIcon
                  icon={ArrowDown01Icon}
                  className="size-5 shrink-0 transition-transform group-open:rotate-180"
                  aria-hidden
                />
              </summary>
              <p className="text-muted-foreground mt-3 leading-relaxed">{i.a}</p>
            </details>
          ))}
        </div>
      </div>
    </section>
  );
}
