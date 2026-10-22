"use client";

import { Badge } from "@upzy/ui/components/badge";
import { Button } from "@upzy/ui/components/button";
import { Skeleton } from "@upzy/ui/components/skeleton";
import { Spinner } from "@upzy/ui/components/spinner";

import { Can } from "@/components/app/can";
import { Panel } from "@/components/app/ui";
import { api } from "@/lib/api";
import { timeAgo } from "@/lib/format";
import { useAction } from "@/lib/use-action";
import { unwrap, useApi } from "@/lib/use-api";

interface Triage {
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

/**
 * What Upzy found out about an outage, written by AI from facts Upzy collected itself. Text only:
 * every claim points at a numbered fact below so it can be checked, and it is labelled as a suggestion.
 */
export function AiTriage({
  incidentId,
  triage,
  status,
  error,
  triagedAt,
  hasMonitor,
  onChanged,
}: {
  incidentId: string;
  triage: Record<string, unknown> | null;
  status: "pending" | "failed" | null;
  error: string | null;
  triagedAt: string | Date | null;
  hasMonitor: boolean;
  onChanged: () => Promise<unknown>;
}) {
  const settings = useApi("ai-settings", () => unwrap(api.ai.settings.get()));
  const { run, isPending } = useAction();
  const t = triage as unknown as Triage | null;
  const enabled = settings.data?.enabled;

  const start = () =>
    run(
      "triage",
      async () => {
        await unwrap(api.incident({ id: incidentId }).triage.post());
        await onChanged();
      },
      { error: "Couldn't start the analysis" },
    );

  // Nothing to show and nothing the person can do.
  if (!t && !status && !(enabled && hasMonitor)) return null;

  return (
    <Panel className="mb-4">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-xl font-bold tracking-tight">What happened?</h2>
        {t && <Badge variant="secondary">AI suggestion</Badge>}
      </div>

      {status === "pending" && (
        <div role="status" aria-live="polite" className="space-y-3">
          <p className="text-muted-foreground flex items-center gap-2 text-sm">
            <Spinner aria-hidden /> Re-checking the service and reading the evidence…
          </p>
          <Skeleton className="h-4 w-4/5" />
          <Skeleton className="h-4 w-3/5" />
        </div>
      )}

      {status === "failed" && (
        <p
          role="alert"
          className="bg-destructive/10 text-destructive mb-3 rounded-2xl px-4 py-3 text-sm"
        >
          {error ?? "The analysis couldn't be completed."}
        </p>
      )}

      {t && status !== "pending" && (
        <div className="space-y-5">
          <div>
            <p className="flex flex-wrap items-center gap-2">
              <Badge>{CAUSES[t.likelyCause] ?? t.likelyCause}</Badge>
              <span className="text-muted-foreground text-xs">{t.confidence} confidence</span>
            </p>
            <p className="mt-2 text-lg leading-snug font-semibold">{t.summary}</p>
          </div>

          <div>
            <h3 className="mb-2 font-bold tracking-tight">Try this first</h3>
            <ol className="list-decimal space-y-2 pl-5 text-sm">
              {t.suggestedActions.map((a, n) => (
                <li key={n}>
                  <strong>{a.title}.</strong>{" "}
                  <span className="text-muted-foreground">{a.detail}</span>
                </li>
              ))}
            </ol>
          </div>

          <details className="text-sm">
            <summary className="cursor-pointer font-semibold">
              Evidence ({t.facts.length} facts checked)
            </summary>
            <ul className="mt-3 space-y-2">
              {t.facts.map((f) => {
                const note = t.evidence.find((e) => e.ref === f.id);
                return (
                  <li key={f.id} className="rounded-2xl border px-3 py-2">
                    <p>
                      <span className="text-muted-foreground font-mono text-xs">{f.id}</span>{" "}
                      <span className="font-semibold capitalize">{f.kind}:</span> {f.text}
                    </p>
                    {note && <p className="text-brand mt-1 text-xs">Used because: {note.note}</p>}
                  </li>
                );
              })}
            </ul>
          </details>

          {t.unknowns.length > 0 && (
            <div>
              <h3 className="mb-1 text-sm font-bold">Not known</h3>
              <ul className="text-muted-foreground list-disc space-y-1 pl-5 text-sm">
                {t.unknowns.map((u, n) => (
                  <li key={n}>{u}</li>
                ))}
              </ul>
            </div>
          )}
          <p className="text-muted-foreground text-xs">
            Written by AI from the facts above{t.model ? ` (${t.model})` : ""}
            {triagedAt ? `, ${timeAgo(triagedAt)}` : ""}. It can be wrong: verify before acting.
          </p>
        </div>
      )}

      {status !== "pending" && enabled && hasMonitor && (
        <Can min="member">
          <div className={t ? "mt-4" : ""}>
            {!t && !status && (
              <p className="text-muted-foreground mb-3 text-sm">
                Upzy can re-check the service, look at DNS, related monitors and history, and
                suggest a likely cause.
              </p>
            )}
            <Button variant="outline" size="sm" loading={isPending("triage")} onClick={start}>
              {t ? "Analyse again" : "Analyse with AI"}
            </Button>
          </div>
        </Can>
      )}
    </Panel>
  );
}
