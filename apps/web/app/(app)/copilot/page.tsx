"use client";

import { Button } from "@upzy/ui/components/button";
import { toast } from "@upzy/ui/components/sonner";
import { Spinner } from "@upzy/ui/components/spinner";
import type { Route } from "next";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";

import { Can } from "@/components/app/can";
import { PageHeader, Panel } from "@/components/app/ui";
import { api } from "@/lib/api";
import { errorMessage } from "@/lib/use-action";
import { unwrap, useApi } from "@/lib/use-api";

interface Citation {
  type: "monitor" | "incident" | "finding" | "asset" | "workspace";
  id: string;
  label: string;
}
interface Turn {
  role: "user" | "assistant";
  content: string;
  citations?: Citation[];
  looked?: string[];
}

const EXAMPLES = [
  "Which monitors are down right now?",
  "What incidents happened in the last 7 days?",
  "Which critical or high findings are still open?",
  "Which certificates expire in the next 30 days?",
  "How reliable was each monitor this week?",
];

const LOOKED: Record<string, string> = {
  listWorkspaces: "workspaces",
  listMonitors: "monitors",
  monitorStats: "uptime statistics",
  listIncidents: "incidents",
  getIncident: "an incident",
  listFindings: "findings",
  getFinding: "a finding",
  listAssets: "assets",
  expiringCertificates: "certificates",
};

const hrefFor = (c: Citation): Route | null =>
  c.type === "monitor"
    ? (`/monitors/${c.id}` as Route)
    : c.type === "incident"
      ? (`/incidents/${c.id}` as Route)
      : c.type === "finding"
        ? (`/findings/${c.id}` as Route)
        : c.type === "asset"
          ? "/assets"
          : null;

/**
 * Ask questions about the workspace in plain English. The copilot can only read (monitors, incidents, findings,
 * assets, certificates); every answer links to the records it used. Nothing is stored: the conversation lives here.
 */
export default function CopilotPage() {
  const ai = useApi("ai-settings", () => unwrap(api.ai.settings.get()));
  const [turns, setTurns] = useState<Turn[]>([]);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const end = useRef<HTMLDivElement>(null);
  const enabled = ai.data?.enabled;

  useEffect(() => {
    end.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [turns, busy]);

  async function send(question: string) {
    const q = question.trim();
    if (!q || busy) return;
    const next: Turn[] = [...turns, { role: "user", content: q }];
    setTurns(next);
    setText("");
    setBusy(true);
    try {
      const r = (await unwrap(
        api.ai.copilot.post({
          messages: next.slice(-10).map((t) => ({ role: t.role, content: t.content })),
        }),
      )) as { answer: string; citations: Citation[]; looked: string[] };
      setTurns([
        ...next,
        { role: "assistant", content: r.answer, citations: r.citations, looked: r.looked },
      ]);
    } catch (e) {
      // Put the question back so it can be sent again.
      setTurns(turns);
      setText(q);
      toast.error("The copilot couldn't answer", { description: errorMessage(e) });
    }
    setBusy(false);
  }

  return (
    <>
      <PageHeader
        title="Copilot"
        description="Ask about your monitors, incidents, findings and certificates. It can only look things up: it never changes anything."
      />

      {ai.data && !enabled && (
        <Panel>
          <h2 className="text-xl font-bold tracking-tight">Turn on AI to use the copilot</h2>
          <p className="text-muted-foreground mt-2 text-sm">
            The copilot runs on your own AI provider key and is off until an admin enables it.
          </p>
          <Can
            min="admin"
            fallback={
              <p className="text-muted-foreground mt-3 text-sm">Ask an admin to turn it on.</p>
            }
          >
            <Link
              href="/settings/ai"
              className="mt-4 inline-block text-sm font-semibold underline underline-offset-4"
            >
              Open AI settings
            </Link>
          </Can>
        </Panel>
      )}

      {enabled && (
        <Panel className="flex min-h-[28rem] flex-col p-0">
          <div className="flex-1 space-y-5 overflow-y-auto p-6" aria-live="polite">
            {turns.length === 0 && (
              <div className="py-6">
                <p className="text-muted-foreground mb-4 text-sm">
                  Try one of these, or ask your own.
                </p>
                <div className="flex flex-wrap gap-2">
                  {EXAMPLES.map((e) => (
                    <button
                      key={e}
                      type="button"
                      onClick={() => send(e)}
                      className="hover:bg-accent focus-visible:ring-ring rounded-full border px-4 py-2 text-left text-sm outline-hidden transition-colors focus-visible:ring-1"
                    >
                      {e}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {turns.map((t, i) =>
              t.role === "user" ? (
                <div key={i} className="flex justify-end">
                  <p className="bg-primary text-primary-foreground max-w-[85%] rounded-3xl rounded-br-md px-4 py-2.5 text-sm whitespace-pre-wrap">
                    {t.content}
                  </p>
                </div>
              ) : (
                <div key={i} className="max-w-[92%] space-y-2">
                  <p className="bg-muted/60 rounded-3xl rounded-bl-md px-4 py-3 text-sm leading-relaxed whitespace-pre-wrap">
                    {t.content}
                  </p>
                  {t.citations && t.citations.length > 0 && (
                    <p className="flex flex-wrap gap-1.5 pl-1">
                      {t.citations.map((c) => {
                        const href = hrefFor(c);
                        const chip =
                          "bg-card inline-flex max-w-full items-center gap-1.5 rounded-full border px-3 py-1 text-xs";
                        return href ? (
                          <Link
                            key={`${c.type}${c.id}`}
                            href={href}
                            className={`${chip} hover:bg-accent font-medium`}
                          >
                            <span className="text-muted-foreground capitalize">{c.type}</span>
                            <span className="truncate">{c.label}</span>
                          </Link>
                        ) : null;
                      })}
                    </p>
                  )}
                  {t.looked && t.looked.length > 0 && (
                    <p className="text-muted-foreground pl-1 text-xs">
                      Looked at: {[...new Set(t.looked.map((l) => LOOKED[l] ?? l))].join(", ")}
                    </p>
                  )}
                </div>
              ),
            )}

            {busy && (
              <p role="status" className="text-muted-foreground flex items-center gap-2 text-sm">
                <Spinner aria-hidden /> Looking things up…
              </p>
            )}
            <div ref={end} />
          </div>

          <form
            className="border-t p-4"
            onSubmit={(e) => {
              e.preventDefault();
              void send(text);
            }}
          >
            <label htmlFor="ask" className="sr-only">
              Ask the copilot
            </label>
            <div className="flex items-end gap-3">
              <textarea
                id="ask"
                rows={2}
                maxLength={2000}
                value={text}
                disabled={busy}
                onChange={(e) => setText(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    void send(text);
                  }
                }}
                placeholder="Ask about your workspace…"
                className="border-input focus-visible:ring-ring w-full resize-none rounded-2xl border bg-transparent px-4 py-3 text-sm outline-hidden focus-visible:ring-1 disabled:opacity-60"
              />
              <Button type="submit" loading={busy} disabled={text.trim().length === 0}>
                Ask
              </Button>
            </div>
            <div className="text-muted-foreground mt-2 flex flex-wrap items-center justify-between gap-2 text-xs">
              <span>
                AI can be wrong. Check the linked records before acting. Enter to send, Shift+Enter
                for a new line.
              </span>
              {turns.length > 0 && (
                <button
                  type="button"
                  className="underline underline-offset-4"
                  disabled={busy}
                  onClick={() => setTurns([])}
                >
                  Clear conversation
                </button>
              )}
            </div>
          </form>
        </Panel>
      )}
    </>
  );
}
