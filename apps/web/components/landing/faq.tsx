import { ArrowDown01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";

/** Shown on the page and repeated, word for word, in the page's structured data (app/page.tsx). */
export const faqItems = [
  {
    q: "What is Upzy?",
    a: "Upzy watches your websites and APIs for downtime, scans what you expose to the internet for security problems, and tells you in plain English what is wrong and how to fix it. It is built for small teams and agencies.",
  },
  {
    q: "Is Upzy free?",
    a: "There is a free plan with 10 monitors, one status page and one scanned domain. Paid plans start at $15 a month, and every new account gets a 14-day Pro trial with no card. Team members are unlimited on every plan.",
  },
  {
    q: "Is Upzy open source? Can I self-host it?",
    a: "Yes. The code is MIT licensed on GitHub (codebyaadi/upzy-oss) and runs on one small server with Docker Compose. The hosted version is the same code.",
  },
  {
    q: "Can I check my website's security without signing up?",
    a: "Yes. The free tools check your security headers, your SSL certificate, and your SPF and DMARC email records, and show the fix for your host. No account and nothing is stored.",
  },
  {
    q: "Can I give my customers a status page?",
    a: "Yes. A public status page shows whether each service is up, 90 days of uptime and recent incidents, on your own domain if you like, and lets people subscribe to updates by email. It shows only the names you choose, never your internal addresses.",
  },
  {
    q: "Is Upzy good for agencies?",
    a: "Yes. Each client gets their own workspace, one screen shows every client at a glance, people can be limited to only their own client, and the Agency plan adds the client's logo on their status page and scheduled uptime and security reports emailed to them.",
  },
  {
    q: "Will you scan sites I don't own?",
    a: "Passive checks, which look at what any visitor can already see. Deeper checks (looking for exposed files such as .env and for open database ports) run only after you prove you own the domain.",
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
          {faqItems.map((i) => (
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
