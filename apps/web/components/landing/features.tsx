import {
  Activity01Icon,
  ShieldKeyIcon,
  SparklesIcon,
  Notification03Icon,
  Globe02Icon,
  Calendar03Icon,
  Layers01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon, type IconSvgElement } from "@hugeicons/react";
import { Badge } from "@upzy/ui/components/badge";

const features: { icon: IconSvgElement; title: string; body: string; live?: boolean }[] = [
  {
    icon: Activity01Icon,
    title: "Uptime monitoring",
    live: true,
    body: "HTTP, TCP, DNS and SSL checks with keyword and status assertions. Declared down only after repeated failures, so blips don't page you.",
  },
  {
    icon: ShieldKeyIcon,
    title: "Attack-surface scans",
    live: true,
    body: "TLS, security headers, email auth, dangling DNS and exposed subdomains, ranked by real-world risk, not just severity.",
  },
  {
    icon: SparklesIcon,
    title: "AI explanations",
    live: true,
    body: "Plain-English impact and fix snippets for findings, a likely cause when a monitor goes down, postmortem drafts, and a copilot you can ask about your workspace. Opt-in, on your own AI key, and it never acts on its own.",
  },
  {
    icon: Notification03Icon,
    title: "Alerts that behave",
    live: true,
    body: "Email, Slack, Discord and signed webhooks. One outage is one incident, with a message when it opens and another when it recovers.",
  },
  {
    icon: Layers01Icon,
    title: "Less alert noise",
    live: true,
    body: "Incidents that open together on the same site or address are grouped, with one explanation of what they have in common. Every alert still reaches you.",
  },
  {
    icon: Globe02Icon,
    title: "Public status pages",
    live: true,
    body: "A page your customers can check: whether each service is up, 90 days of uptime and recent incidents. It shows only the names you choose, never your internal addresses or error details.",
  },
  {
    icon: Calendar03Icon,
    title: "Weekly digest",
    live: true,
    body: "Uptime, incidents and the riskiest open findings in one email every Monday, with the numbers straight from your data.",
  },
];

export function Features() {
  return (
    <section id="features" className="px-4 py-24">
      <div className="mx-auto max-w-5xl">
        <p className="text-brand text-sm font-semibold">Features</p>
        <h2 className="mt-3 max-w-2xl text-4xl font-extrabold tracking-tighter text-balance sm:text-5xl">
          Monitoring and security, in one calm place.
        </h2>
        <div className="mt-12 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {features.map((f) => (
            <article
              key={f.title}
              className="bg-card/70 rounded-3xl border p-7 backdrop-blur transition-shadow hover:shadow-[var(--shadow-panel)]"
            >
              <div className="flex items-start justify-between">
                <div className="bg-accent text-accent-foreground grid size-11 place-items-center rounded-2xl">
                  <HugeiconsIcon icon={f.icon} className="size-5" aria-hidden />
                </div>
                {f.live ? <Badge>Available</Badge> : <Badge variant="secondary">Coming soon</Badge>}
              </div>
              <h3 className="mt-6 text-xl font-bold tracking-tight">{f.title}</h3>
              <p className="text-muted-foreground mt-2 leading-relaxed">{f.body}</p>
            </article>
          ))}
        </div>
      </div>
    </section>
  );
}
