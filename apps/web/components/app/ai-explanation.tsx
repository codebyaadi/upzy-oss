"use client";

import { Badge } from "@upzy/ui/components/badge";
import { Button } from "@upzy/ui/components/button";
import { Skeleton } from "@upzy/ui/components/skeleton";
import { toast } from "@upzy/ui/components/sonner";
import { Spinner } from "@upzy/ui/components/spinner";
import Link from "next/link";

import { Can } from "@/components/app/can";
import { Panel } from "@/components/app/ui";
import { api } from "@/lib/api";
import { timeAgo } from "@/lib/format";
import { useAction } from "@/lib/use-action";
import { unwrap, useApi } from "@/lib/use-api";

interface Explanation {
  summary: string;
  impact: string;
  exploitability: string;
  steps: { title: string; detail: string }[];
  snippets: { platform: string; language: string; code: string }[];
  caveats: string[];
  confidence: "low" | "medium" | "high";
  model?: string;
}

/**
 * The model's output is rendered strictly as text: no markdown, no HTML, no links. Code is shown in a
 * labelled block and is never run by Upzy; the reader is reminded to review it before applying.
 */
export function AiExplanation({
  findingId,
  explanation,
  status,
  error,
  explainedAt,
  onChanged,
}: {
  findingId: string;
  explanation: Record<string, unknown> | null;
  status: "pending" | "failed" | null;
  error: string | null;
  explainedAt: string | Date | null;
  onChanged: () => Promise<unknown>;
}) {
  const settings = useApi("ai-settings", () => unwrap(api.ai.settings.get()));
  const { run, isPending } = useAction();
  const e = explanation as unknown as Explanation | null;
  const enabled = settings.data?.enabled;

  const request = (force: boolean) =>
    run(
      "explain",
      async () => {
        await unwrap(api.ai.finding({ id: findingId }).explain.post({ force }));
        await onChanged();
      },
      { error: "Couldn't start the explanation" },
    );

  const copy = async (code: string) => {
    await navigator.clipboard.writeText(code);
    toast.success("Snippet copied");
  };

  return (
    <Panel>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-xl font-bold tracking-tight">AI explanation</h2>
        {e && <Badge variant="secondary">AI-generated</Badge>}
      </div>

      {status === "pending" && (
        <div role="status" aria-live="polite" className="space-y-3">
          <p className="text-muted-foreground flex items-center gap-2 text-sm">
            <Spinner aria-hidden /> Writing the explanation. This usually takes a few seconds.
          </p>
          <Skeleton className="h-4 w-4/5" />
          <Skeleton className="h-4 w-3/5" />
          <Skeleton className="h-20 w-full" />
        </div>
      )}

      {status !== "pending" && !e && (
        <div className="space-y-3">
          {status === "failed" && (
            <p
              role="alert"
              className="bg-destructive/10 text-destructive rounded-2xl px-4 py-3 text-sm"
            >
              {error ?? "The explanation couldn't be written."} The built-in guidance on this page
              still applies.
            </p>
          )}
          {enabled === false ? (
            <p className="text-muted-foreground text-sm">
              AI explanations are off for this organization.{" "}
              <Can min="admin" fallback="Ask an admin to turn them on.">
                <Link
                  href="/settings/ai"
                  className="text-foreground font-semibold underline underline-offset-4"
                >
                  Turn them on in AI settings
                </Link>
              </Can>
            </p>
          ) : (
            <>
              <p className="text-muted-foreground text-sm">
                Get a plain-English explanation of why this matters and exactly how to fix it,
                including config snippets.
              </p>
              <Can min="member">
                <Button
                  loading={isPending("explain")}
                  disabled={enabled === undefined}
                  onClick={() => request(false)}
                >
                  {status === "failed" ? "Try again" : "Explain with AI"}
                </Button>
              </Can>
            </>
          )}
        </div>
      )}

      {status !== "pending" && e && (
        <div className="space-y-5">
          <p className="leading-relaxed">{e.summary}</p>
          <section>
            <h3 className="mb-1 text-sm font-semibold">Impact</h3>
            <p className="text-muted-foreground text-sm leading-relaxed">{e.impact}</p>
          </section>
          <section>
            <h3 className="mb-1 text-sm font-semibold">How likely is exploitation?</h3>
            <p className="text-muted-foreground text-sm leading-relaxed">{e.exploitability}</p>
          </section>
          <section>
            <h3 className="mb-2 text-sm font-semibold">What to do</h3>
            <ol className="space-y-3">
              {e.steps.map((s, i) => (
                <li key={i} className="grid grid-cols-[1.5rem_1fr] gap-2 text-sm">
                  <span className="bg-accent text-accent-foreground grid size-6 place-items-center rounded-full text-xs font-bold">
                    {i + 1}
                  </span>
                  <span>
                    <span className="block font-semibold">{s.title}</span>
                    <span className="text-muted-foreground leading-relaxed">{s.detail}</span>
                  </span>
                </li>
              ))}
            </ol>
          </section>
          {e.snippets.length > 0 && (
            <section>
              <h3 className="mb-2 text-sm font-semibold">Configuration snippets</h3>
              <div className="space-y-3">
                {e.snippets.map((sn, i) => (
                  <figure key={i} className="overflow-hidden rounded-2xl border">
                    <figcaption className="bg-muted flex items-center justify-between gap-2 px-4 py-2 text-xs">
                      <span className="font-semibold">
                        {sn.platform}{" "}
                        <span className="text-muted-foreground font-normal">({sn.language})</span>
                      </span>
                      <Button variant="ghost" size="xs" onClick={() => copy(sn.code)}>
                        Copy
                      </Button>
                    </figcaption>
                    <pre className="overflow-x-auto px-4 py-3 font-mono text-xs leading-relaxed whitespace-pre-wrap">
                      <code>{sn.code}</code>
                    </pre>
                  </figure>
                ))}
              </div>
              <p className="text-muted-foreground mt-2 text-xs">
                Review snippets before applying them. They are suggestions, and Upzy never runs
                them.
              </p>
            </section>
          )}
          {e.caveats.length > 0 && (
            <section>
              <h3 className="mb-1 text-sm font-semibold">Keep in mind</h3>
              <ul className="text-muted-foreground list-disc space-y-1 pl-5 text-sm">
                {e.caveats.map((c, i) => (
                  <li key={i}>{c}</li>
                ))}
              </ul>
            </section>
          )}
          <div className="text-muted-foreground flex flex-wrap items-center justify-between gap-2 border-t pt-3 text-xs">
            <span>
              Confidence: {e.confidence}
              {e.model ? ` · ${e.model}` : ""}
              {explainedAt ? ` · ${timeAgo(explainedAt)}` : ""}
            </span>
            <Can min="member">
              <Button
                variant="ghost"
                size="xs"
                loading={isPending("explain")}
                onClick={() => request(true)}
              >
                Regenerate
              </Button>
            </Can>
          </div>
        </div>
      )}
    </Panel>
  );
}
