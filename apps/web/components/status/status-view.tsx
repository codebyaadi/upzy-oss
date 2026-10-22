import { Logo } from "@/components/logo";
import { SubscribeForm } from "@/components/status/subscribe-form";
import { dateTime } from "@/lib/format";

export interface Day {
  date: string;
  uptime: number | null;
}
export interface Status {
  title: string;
  /** The customer's own logo (Agency plan), already filtered by the server to what the plan allows. */
  branding?: { logoUrl: string | null };
  description: string;
  notice: { text: string; kind: "info" | "maintenance" | "incident" } | null;
  overall: "operational" | "degraded" | "maintenance" | "partial" | "major";
  updatedAt: string;
  components: {
    name: string;
    status: "operational" | "degraded" | "maintenance" | "outage" | "paused";
    uptime: number | null;
    days: Day[];
  }[];
  /** Planned maintenance on these services: what is on now and what starts in the next two weeks. */
  maintenance: { name: string; startsAt: string; endsAt: string; active: boolean }[];
  /** Only when the owner opted in: the letter and when it was measured. */
  security: { grade: "A" | "B" | "C" | "D" | "F"; scannedAt: string } | null;
  incidents: {
    title: string;
    status: "ongoing" | "resolved";
    startedAt: string;
    resolvedAt: string | null;
    minutes: number;
    updates: {
      status: "investigating" | "identified" | "monitoring" | "update";
      message: string;
      at: string;
    }[];
  }[];
}

const BANNER = {
  operational: {
    label: "All systems operational",
    cls: "bg-brand/15 text-foreground border-brand/30",
    dot: "bg-brand",
  },
  degraded: {
    label: "Some systems are running slowly",
    cls: "bg-amber-400/20 text-foreground border-amber-500/40",
    dot: "bg-amber-500",
  },
  maintenance: {
    label: "Scheduled maintenance in progress",
    cls: "bg-sky-500/15 text-foreground border-sky-500/30",
    dot: "bg-sky-500",
  },
  partial: {
    label: "Some systems are having problems",
    cls: "bg-amber-400/20 text-foreground border-amber-500/40",
    dot: "bg-amber-500",
  },
  major: {
    label: "Major outage",
    cls: "bg-destructive/15 text-foreground border-destructive/40",
    dot: "bg-destructive",
  },
} as const;

const COMPONENT = {
  operational: { label: "Operational", cls: "text-brand" },
  degraded: { label: "Degraded performance", cls: "text-amber-600 dark:text-amber-400" },
  maintenance: { label: "Under maintenance", cls: "text-sky-600 dark:text-sky-400" },
  outage: { label: "Unavailable", cls: "text-destructive" },
  paused: { label: "Paused", cls: "text-muted-foreground" },
} as const;

const NOTICE = {
  info: { label: "Notice", cls: "bg-accent/60" },
  maintenance: { label: "Maintenance", cls: "bg-sky-500/15 border-sky-500/30" },
  incident: { label: "Known issue", cls: "bg-amber-400/20 border-amber-500/40" },
} as const;

const UPDATE = {
  investigating: "Investigating",
  identified: "Identified",
  monitoring: "Monitoring",
  update: "Update",
} as const;

const GRADE = {
  A: "bg-brand text-background",
  B: "bg-lime-500 text-white",
  C: "bg-amber-400 text-black",
  D: "bg-orange-500 text-white",
  F: "bg-destructive text-white",
} as const;

const barColor = (u: number | null) =>
  u === null
    ? "bg-muted"
    : u >= 99.9
      ? "bg-brand"
      : u >= 99
        ? "bg-amber-400"
        : u >= 95
          ? "bg-orange-500"
          : "bg-destructive";

const when = (iso: string) =>
  new Date(iso).toLocaleString("en-GB", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "UTC",
  }) + " UTC";
const length = (m: number) => (m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`);

/** The public status page itself. Shared by /status/<slug> and by custom domains. */
export function StatusView({
  s,
  slug,
  homeUrl = "/",
}: {
  s: Status;
  /** Set on Upzy's own address; on a custom domain the host identifies the page. */
  slug?: string;
  homeUrl?: string;
}) {
  const banner = BANNER[s.overall];
  return (
    <div className="ambient min-h-svh px-4 py-12">
      <main className="mx-auto max-w-3xl space-y-6">
        <header>
          {s.branding?.logoUrl && (
            // eslint-disable-next-line @next/next/no-img-element -- an arbitrary customer-supplied address
            <img
              src={s.branding.logoUrl}
              alt=""
              referrerPolicy="no-referrer"
              className="mb-5 max-h-14 w-auto max-w-[14rem] object-contain"
            />
          )}
          <h1 className="text-3xl font-extrabold tracking-tighter text-balance sm:text-4xl">
            {s.title}
          </h1>
          {s.description && <p className="text-muted-foreground mt-2">{s.description}</p>}
        </header>

        <div
          role="status"
          className={`flex items-center gap-3 rounded-3xl border px-6 py-5 text-lg font-bold ${banner.cls}`}
        >
          <span aria-hidden className={`size-3 rounded-full ${banner.dot}`} />
          {banner.label}
        </div>

        {s.security && (
          <div className="bg-card/70 flex items-center gap-4 rounded-3xl border px-6 py-4">
            <span
              aria-hidden
              className={`grid size-11 shrink-0 place-items-center rounded-2xl text-xl font-extrabold ${GRADE[s.security.grade]}`}
            >
              {s.security.grade}
            </span>
            <div className="text-sm">
              <p className="font-bold tracking-tight">Security grade {s.security.grade}</p>
              <p className="text-muted-foreground">
                From automated checks of the public website (certificate, security headers, email
                protection), last run {when(s.security.scannedAt)}.
              </p>
            </div>
          </div>
        )}

        {s.notice && (
          <div className={`rounded-3xl border px-6 py-4 text-sm ${NOTICE[s.notice.kind].cls}`}>
            <p className="text-muted-foreground mb-1 text-xs font-semibold tracking-wide uppercase">
              {NOTICE[s.notice.kind].label}
            </p>
            <p className="whitespace-pre-wrap">{s.notice.text}</p>
          </div>
        )}

        {s.maintenance.length > 0 && (
          <section aria-label="Scheduled maintenance" className="space-y-2">
            <h2 className="text-xl font-bold tracking-tight">Scheduled maintenance</h2>
            <ul className="bg-card/70 divide-y rounded-3xl border">
              {s.maintenance.map((w, n) => (
                <li
                  key={n}
                  className="flex flex-wrap items-center justify-between gap-2 px-6 py-4 text-sm"
                >
                  <span>
                    <span className="font-semibold">{w.name}</span>
                    <span className="text-muted-foreground block text-xs">
                      {dateTime(w.startsAt)} to {dateTime(w.endsAt)}
                    </span>
                  </span>
                  <span
                    className={`text-xs font-semibold ${w.active ? "text-sky-600 dark:text-sky-400" : "text-muted-foreground"}`}
                  >
                    {w.active ? "In progress" : "Upcoming"}
                  </span>
                </li>
              ))}
            </ul>
          </section>
        )}

        <section
          aria-label="Components"
          className="bg-card/70 divide-y rounded-3xl border shadow-[var(--shadow-panel)] backdrop-blur"
        >
          {s.components.length === 0 && (
            <p className="text-muted-foreground p-6 text-sm">Nothing is listed here yet.</p>
          )}
          {s.components.map((c) => (
            <div key={c.name} className="p-6">
              <div className="mb-3 flex items-center justify-between gap-3">
                <h2 className="font-bold tracking-tight">{c.name}</h2>
                <span className={`text-sm font-semibold ${COMPONENT[c.status].cls}`}>
                  {COMPONENT[c.status].label}
                </span>
              </div>
              <div
                role="img"
                aria-label={`${c.name}: ${c.uptime === null ? "no data yet" : `${c.uptime}% uptime`} over the last ${c.days.length} days`}
                className="flex h-8 gap-px"
              >
                {c.days.map((d) => (
                  <span
                    key={d.date}
                    title={`${d.date}: ${d.uptime === null ? "no data" : `${d.uptime}% up`}`}
                    className={`min-w-px flex-1 rounded-[2px] ${barColor(d.uptime)}`}
                  />
                ))}
              </div>
              <p className="text-muted-foreground mt-2 flex justify-between text-xs">
                <span>{c.days.length} days ago</span>
                <span>{c.uptime === null ? "No data yet" : `${c.uptime}% uptime`}</span>
                <span>Today</span>
              </p>
            </div>
          ))}
        </section>

        <section aria-label="Recent incidents">
          <h2 className="mb-3 text-xl font-bold tracking-tight">Past 14 days</h2>
          {s.incidents.length === 0 ? (
            <p className="text-muted-foreground text-sm">No incidents reported.</p>
          ) : (
            <ul className="bg-card/70 divide-y rounded-3xl border">
              {s.incidents.map((i, n) => (
                <li key={n} className="space-y-3 px-6 py-4 text-sm">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span>
                      <span className="font-semibold">{i.title}</span>
                      <span className="text-muted-foreground block text-xs">
                        {when(i.startedAt)} ·{" "}
                        {i.status === "ongoing"
                          ? `ongoing for ${length(i.minutes)}`
                          : `lasted ${length(i.minutes)}`}
                      </span>
                    </span>
                    <span
                      className={`text-xs font-semibold ${i.status === "ongoing" ? "text-destructive" : "text-brand"}`}
                    >
                      {i.status === "ongoing" ? "Ongoing" : "Resolved"}
                    </span>
                  </div>
                  {i.updates.length > 0 && (
                    <ol className="space-y-3 border-l pl-4">
                      {i.updates.map((u, k) => (
                        <li key={k}>
                          <p>
                            <span className="font-semibold">{UPDATE[u.status]}</span>
                            <span className="text-muted-foreground"> · {when(u.at)}</span>
                          </p>
                          <p className="mt-0.5 break-words whitespace-pre-wrap">{u.message}</p>
                        </li>
                      ))}
                    </ol>
                  )}
                </li>
              ))}
            </ul>
          )}
        </section>

        <section
          aria-label="Subscribe to updates"
          className="bg-card/70 rounded-3xl border px-6 py-5"
        >
          <h2 className="mb-1 text-base font-bold tracking-tight">Get updates by email</h2>
          <p className="text-muted-foreground mb-3 text-sm">
            We&apos;ll email you when an incident starts, when there&apos;s news, and when it&apos;s
            fixed.
          </p>
          <SubscribeForm slug={slug} />
          <p className="text-muted-foreground mt-3 text-xs">
            We use your address only to send these updates, and every email has an unsubscribe link.{" "}
            <a
              href={`${homeUrl.replace(/\/$/, "")}/privacy`}
              className="underline underline-offset-4"
            >
              Privacy
            </a>
          </p>
        </section>

        <footer className="text-muted-foreground flex flex-wrap items-center justify-between gap-3 pt-4 text-xs">
          <span>Updated {when(s.updatedAt)}</span>
          <a href={homeUrl} className="inline-flex items-center gap-2 hover:underline">
            Powered by <Logo className="scale-75" />
          </a>
        </footer>
      </main>
    </div>
  );
}
