"use client";

import { Badge } from "@upzy/ui/components/badge";
import { Button } from "@upzy/ui/components/button";
import { Skeleton } from "@upzy/ui/components/skeleton";
import { Spinner } from "@upzy/ui/components/spinner";
import Link from "next/link";
import { useParams } from "next/navigation";

import { Can } from "@/components/app/can";
import {
  BackLink,
  DetailSkeleton,
  ErrorNote,
  IncidentBadge,
  PageTitle,
  Panel,
} from "@/components/app/ui";
import { api } from "@/lib/api";
import { dateTime, timeAgo } from "@/lib/format";
import { useAction } from "@/lib/use-action";
import { unwrap, useApi } from "@/lib/use-api";

interface Summary {
  headline: string;
  summary: string;
  likelyCause: string;
  confidence: "low" | "medium" | "high";
  evidence: { ref: string; note: string }[];
  suggestedActions: { title: string; detail: string }[];
  unknowns: string[];
  facts: { id: string; kind: string; text: string }[];
  model?: string;
}

const CAUSES: Record<string, string> = {
  dns: "DNS",
  network: "Network",
  tls_certificate: "TLS certificate",
  origin_down: "Server not responding",
  application_error: "Application error",
  config_or_deploy: "Config or deploy",
  provider_outage: "Provider outage",
  unknown: "Unclear",
};

/** One page for incidents that opened together and share a site or address, with an AI reading of what they have in common. */
export default function IncidentGroupPage() {
  const { id } = useParams<{ id: string }>();
  const { run, isPending } = useAction();
  const ai = useApi("ai-settings", () => unwrap(api.ai.settings.get()));
  const group = useApi(`incident-group:${id}`, () => unwrap(api.incident.group({ id }).get()), {
    refreshInterval: (d) => (d?.summaryStatus === "pending" ? 2_000 : 10_000),
  });
  const g = group.data;
  const s = g?.summary as unknown as Summary | null | undefined;

  const ask = () =>
    run(
      "summary",
      async () => {
        await unwrap(api.incident.group({ id }).summary.post());
        await group.mutate();
      },
      { error: "Couldn't start the summary" },
    );

  if (group.error) return <ErrorNote error={group.error} />;
  if (!g) return <DetailSkeleton />;

  return (
    <>
      <BackLink href="/incidents">Incidents</BackLink>
      <PageTitle>Related incidents</PageTitle>
      <h1 className="mb-2 text-3xl font-extrabold tracking-tighter text-balance sm:text-4xl">
        {s?.headline ?? `${g.members.length} related incidents`}
      </h1>
      <p className="text-muted-foreground mb-8">
        They opened within minutes of each other and share{" "}
        <span className="font-mono">{g.sharedKey}</span>. Each one still sends its own alerts.
      </p>

      <Panel className="mb-4">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-xl font-bold tracking-tight">What do they have in common?</h2>
          {s && <Badge variant="secondary">AI suggestion</Badge>}
        </div>
        {g.summaryStatus === "pending" && (
          <div role="status" aria-live="polite" className="space-y-3">
            <p className="text-muted-foreground flex items-center gap-2 text-sm">
              <Spinner aria-hidden /> Comparing the incidents…
            </p>
            <Skeleton className="h-4 w-4/5" />
          </div>
        )}
        {g.summaryStatus === "failed" && (
          <p
            role="alert"
            className="bg-destructive/10 text-destructive mb-3 rounded-2xl px-4 py-3 text-sm"
          >
            {g.summaryError ?? "The summary couldn't be written."}
          </p>
        )}
        {s && g.summaryStatus !== "pending" && (
          <div className="space-y-4 text-sm">
            <p className="flex flex-wrap items-center gap-2">
              <Badge>{CAUSES[s.likelyCause] ?? s.likelyCause}</Badge>
              <span className="text-muted-foreground text-xs">{s.confidence} confidence</span>
            </p>
            <p className="text-lg leading-snug font-semibold">{s.summary}</p>
            <ol className="list-decimal space-y-2 pl-5">
              {s.suggestedActions.map((a, n) => (
                <li key={n}>
                  <strong>{a.title}.</strong>{" "}
                  <span className="text-muted-foreground">{a.detail}</span>
                </li>
              ))}
            </ol>
            <details>
              <summary className="cursor-pointer font-semibold">
                Evidence ({s.facts.length} facts checked)
              </summary>
              <ul className="mt-3 space-y-2">
                {s.facts.map((f) => {
                  const note = s.evidence.find((e) => e.ref === f.id);
                  return (
                    <li key={f.id} className="rounded-2xl border px-3 py-2">
                      <span className="text-muted-foreground font-mono text-xs">{f.id}</span>{" "}
                      <span className="font-semibold capitalize">{f.kind}:</span> {f.text}
                      {note && <p className="text-brand mt-1 text-xs">Used because: {note.note}</p>}
                    </li>
                  );
                })}
              </ul>
            </details>
            {s.unknowns.length > 0 && (
              <ul className="text-muted-foreground list-disc space-y-1 pl-5">
                {s.unknowns.map((u, n) => (
                  <li key={n}>{u}</li>
                ))}
              </ul>
            )}
            <p className="text-muted-foreground text-xs">
              Written by AI from the facts above{s.model ? ` (${s.model})` : ""}
              {g.summaryAt ? `, ${timeAgo(g.summaryAt)}` : ""}. It can be wrong: verify before
              acting.
            </p>
          </div>
        )}
        {!s && !g.summaryStatus && !ai.data?.enabled && (
          <p className="text-muted-foreground text-sm">
            Turn on AI in Settings to get an explanation of what these have in common.
          </p>
        )}
        {g.summaryStatus !== "pending" && ai.data?.enabled && (
          <Can min="member">
            <Button
              variant="outline"
              size="sm"
              className={s ? "mt-4" : ""}
              loading={isPending("summary")}
              onClick={ask}
            >
              {s ? "Explain again" : "Explain with AI"}
            </Button>
          </Can>
        )}
      </Panel>

      <Panel>
        <h2 className="mb-4 text-xl font-bold tracking-tight">Incidents in this group</h2>
        <ul className="divide-y">
          {g.members.map((m) => (
            <li key={m.id}>
              <Link
                href={`/incidents/${m.id}`}
                className="hover:bg-accent/40 flex items-center justify-between gap-3 rounded-xl px-2 py-3"
              >
                <span className="min-w-0">
                  <span className="block truncate font-semibold">{m.title}</span>
                  <span className="text-muted-foreground text-xs">{dateTime(m.createdAt)}</span>
                </span>
                <IncidentBadge status={m.status} />
              </Link>
            </li>
          ))}
        </ul>
      </Panel>
    </>
  );
}
