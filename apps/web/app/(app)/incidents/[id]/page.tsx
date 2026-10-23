"use client";

import { Button } from "@upzy/ui/components/button";
import { cn } from "@upzy/ui/lib/utils";
import Link from "next/link";
import { useParams } from "next/navigation";

import { AiTriage } from "@/components/app/ai-triage";
import { Can } from "@/components/app/can";
import { IncidentUpdates } from "@/components/app/incident-updates";
import { Postmortem } from "@/components/app/postmortem";
import { SimilarIncidents } from "@/components/app/similar-incidents";
import {
  PageTitle,
  BackLink,
  DetailSkeleton,
  ErrorNote,
  IncidentBadge,
  Panel,
} from "@/components/app/ui";
import { api } from "@/lib/api";
import { dateTime, duration, ms, timeAgo } from "@/lib/format";
import { useAction } from "@/lib/use-action";
import { unwrap, useApi } from "@/lib/use-api";

interface Step {
  at: string | Date;
  title: string;
  detail?: string;
  tone: "bad" | "good" | "neutral";
}

export default function IncidentDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { run, isPending } = useAction();
  const {
    data: i,
    error,
    mutate,
  } = useApi(`incident:${id}`, () => unwrap(api.incident({ id }).get()), {
    refreshInterval: 5_000,
  });

  if (error) return <ErrorNote error={error} />;
  if (!i) return <DetailSkeleton />;

  const steps: Step[] = (
    [
      { at: i.createdAt, title: "Incident opened", detail: i.title, tone: "bad" as const },
      ...i.deliveries.map<Step>((d) => ({
        at: d.createdAt,
        title: `${d.status === "sent" ? "Notified" : "Failed to notify"} ${d.channelName}`,
        detail: `${d.event === "incident.opened" ? "Down alert" : "Recovery alert"} via ${d.channelKind}${d.error ? `: ${d.error}` : ""}`,
        tone: d.status === "sent" ? "neutral" : "bad",
      })),
      ...(i.resolvedAt
        ? [
            {
              at: i.resolvedAt,
              title: "Recovered",
              detail: `Total downtime ${duration(i.createdAt, i.resolvedAt)}`,
              tone: "good" as const,
            },
          ]
        : []),
    ] as Step[]
  ).sort((a, b) => new Date(a.at).getTime() - new Date(b.at).getTime());

  const acknowledge = () =>
    run(
      "ack",
      async () => {
        await unwrap(api.incident({ id }).acknowledge.patch());
        await mutate();
      },
      { success: "Incident acknowledged", error: "Couldn't acknowledge" },
    );

  return (
    <>
      <BackLink href="/incidents">Incidents</BackLink>
      <PageTitle>{i.title}</PageTitle>
      <div className="mb-8 flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-3">
            <h1 className="text-3xl font-extrabold tracking-tighter text-balance sm:text-4xl">
              {i.title}
            </h1>
            <IncidentBadge status={i.status} />
          </div>
          {i.monitor && (
            <p className="text-muted-foreground mt-2">
              Monitor:{" "}
              <Link
                href={`/monitors/${i.monitor.id}`}
                className="text-foreground font-semibold underline underline-offset-4"
              >
                {i.monitor.name}
              </Link>{" "}
              · {i.monitor.target}
            </p>
          )}
        </div>
        {i.status === "open" && (
          <Can min="member">
            <Button loading={isPending("ack")} onClick={acknowledge}>
              Acknowledge
            </Button>
          </Can>
        )}
      </div>

      {i.group && i.group.size > 1 && (
        <Link
          href={`/incidents/group/${i.group.id}`}
          className="bg-accent/60 hover:bg-accent mb-4 block rounded-2xl px-5 py-4 text-sm transition-colors"
        >
          <strong>Part of a group of {i.group.size} related incidents</strong> that opened within
          minutes of each other and share <span className="font-mono">{i.group.sharedKey}</span>.{" "}
          <span className="underline underline-offset-4">See them together</span>
        </Link>
      )}
      <AiTriage
        incidentId={i.id}
        triage={i.aiTriage}
        status={i.aiTriageStatus}
        error={i.aiTriageError}
        triagedAt={i.aiTriagedAt}
        hasMonitor={!!i.monitor}
        onChanged={() => mutate()}
      />

      <SimilarIncidents incidentId={i.id} />

      {i.monitor && (
        <IncidentUpdates incidentId={i.id} updates={i.updates} onChanged={() => mutate()} />
      )}

      <div className="grid gap-4 lg:grid-cols-2">
        <Panel>
          <h2 className="mb-5 text-xl font-bold tracking-tight">Timeline</h2>
          <ol className="relative space-y-6 border-l pl-6">
            {steps.map((s, n) => (
              <li key={n} className="relative">
                <span
                  aria-hidden
                  className={cn(
                    "ring-card absolute top-1.5 -left-[1.9rem] size-2.5 rounded-full ring-4",
                    s.tone === "bad"
                      ? "bg-destructive"
                      : s.tone === "good"
                        ? "bg-brand"
                        : "bg-muted-foreground/60",
                  )}
                />
                <p className="font-semibold">{s.title}</p>
                {s.detail && <p className="text-muted-foreground text-sm">{s.detail}</p>}
                <p className="text-muted-foreground mt-0.5 text-xs">{dateTime(s.at)}</p>
              </li>
            ))}
            {i.status !== "resolved" && (
              <li className="text-muted-foreground relative text-sm">
                <span
                  aria-hidden
                  className="bg-muted-foreground/40 ring-card absolute top-1.5 -left-[1.9rem] size-2.5 animate-pulse rounded-full ring-4"
                />
                Ongoing for {duration(i.createdAt, null)}. Upzy keeps checking and will resolve this
                automatically.
              </li>
            )}
          </ol>
        </Panel>

        <Panel>
          <h2 className="mb-4 text-xl font-bold tracking-tight">Latest checks</h2>
          <ul className="divide-y">
            {i.recentChecks.map((c) => (
              <li key={c.id} className="flex items-center justify-between gap-3 py-2.5 text-sm">
                <span className="flex items-center gap-2 font-semibold">
                  <span
                    aria-hidden
                    className={cn(
                      "size-2 rounded-full",
                      c.status === "up" ? "bg-brand" : "bg-destructive",
                    )}
                  />
                  {c.status === "up" ? "Up" : "Down"}
                </span>
                <span className="text-muted-foreground min-w-0 truncate">
                  {c.error ?? `HTTP ${c.statusCode ?? "–"} · ${ms(c.responseMs)}`}
                </span>
                <span className="text-muted-foreground shrink-0 text-xs">
                  {timeAgo(c.createdAt)}
                </span>
              </li>
            ))}
          </ul>
        </Panel>
      </div>
      {i.status === "resolved" && i.monitor && <Postmortem incidentId={i.id} />}
    </>
  );
}
