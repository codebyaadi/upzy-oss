"use client";

import { Button } from "@upzy/ui/components/button";
import { Input } from "@upzy/ui/components/input";
import { cn } from "@upzy/ui/lib/utils";
import { useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";

import { FixForStack } from "@/components/app/fix-for-stack";
import { SeverityBadge } from "@/components/app/ui";
import { ButtonLink } from "@/components/button-link";
import { api } from "@/lib/api";
import type { ToolInfo } from "@/lib/tools";

type Grade = "A" | "B" | "C" | "D" | "F";
const TONE: Record<Grade, string> = {
  A: "bg-brand text-background",
  B: "bg-lime-500 text-white",
  C: "bg-amber-400 text-black",
  D: "bg-orange-500 text-white",
  F: "bg-destructive text-white",
};
const VERDICT: Record<Grade, string> = {
  A: "Looking good",
  B: "Mostly good, a few things to tighten",
  C: "Several gaps worth closing",
  D: "Significant gaps",
  F: "Serious problems",
};

interface Finding {
  checkKey: string;
  severity: "critical" | "high" | "medium" | "low" | "info";
  title: string;
  description: string;
  remediation: string;
  fix: {
    target: string;
    detected: string;
    steps: string[];
    snippets: { label: string; language: string; code: string }[];
    caveat?: string | undefined;
  } | null;
}
interface Result {
  host: string;
  score: number;
  grade: Grade;
  findings: Finding[];
  facts: { label: string; value: string | null }[];
  detected: string | null;
  checkedAt: string;
}

type State =
  | { kind: "idle" }
  | { kind: "loading"; host: string }
  | { kind: "done"; result: Result }
  | { kind: "error"; message: string };

/** The form and the result. The address stays in the URL (?host=), so a result can be shared or bookmarked. */
export function Checker({ tool }: { tool: ToolInfo }) {
  const router = useRouter();
  const params = useSearchParams();
  const [value, setValue] = useState(params.get("host") ?? "");
  const [state, setState] = useState<State>({ kind: "idle" });
  const latest = useRef(0);

  const run = useCallback(
    async (host: string) => {
      const mine = ++latest.current;
      setState({ kind: "loading", host });
      try {
        const { data, error } = await api.tools({ tool: tool.id }).get({ query: { host } });
        if (mine !== latest.current) return;
        if (error) {
          const v = error.value as { message?: string } | undefined;
          setState({
            kind: "error",
            message:
              Number(error.status) === 429
                ? "That's a lot of checks in a minute. Wait a little and try again."
                : (v?.message ?? "The check failed. Try again in a moment."),
          });
          return;
        }
        setState({ kind: "done", result: data as Result });
      } catch {
        if (mine === latest.current)
          setState({ kind: "error", message: "Couldn't reach the checker. Try again." });
      }
    },
    [tool.id],
  );

  // Opening a shared link runs the check straight away.
  const first = useRef(true);
  useEffect(() => {
    const host = params.get("host");
    if (first.current && host) void run(host);
    first.current = false;
  }, [params, run]);

  function submit(e: React.FormEvent) {
    e.preventDefault();
    const host = value.trim();
    if (!host) return;
    router.replace(`?host=${encodeURIComponent(host)}`, { scroll: false });
    void run(host);
  }

  const busy = state.kind === "loading";
  return (
    <div>
      <form onSubmit={submit} className="flex flex-col gap-3 sm:flex-row">
        <label htmlFor="host" className="sr-only">
          Domain to check
        </label>
        <Input
          id="host"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder={tool.placeholder}
          inputMode="url"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          autoComplete="off"
          className="h-12 flex-1 text-base"
        />
        <Button type="submit" size="lg" loading={busy} disabled={!value.trim()}>
          {busy ? "Checking…" : "Check"}
        </Button>
      </form>

      <div aria-live="polite" className="mt-6">
        {state.kind === "error" && (
          <p
            role="alert"
            className="bg-destructive/10 text-destructive rounded-2xl px-5 py-4 text-sm"
          >
            {state.message}
          </p>
        )}
        {state.kind === "loading" && (
          <p className="text-muted-foreground text-sm">Checking {state.host}…</p>
        )}
        {state.kind === "done" && <ResultView result={state.result} />}
      </div>
    </div>
  );
}

function ResultView({ result }: { result: Result }) {
  return (
    <div className="space-y-6">
      <div className="bg-card/70 flex items-center gap-5 rounded-3xl border p-5 shadow-[var(--shadow-panel)] sm:p-6">
        <span
          title={`Score ${result.score} / 100`}
          className={cn(
            "grid size-16 shrink-0 place-items-center rounded-3xl text-3xl font-extrabold",
            TONE[result.grade],
          )}
        >
          {result.grade}
        </span>
        <div className="min-w-0">
          <p className="truncate text-lg font-bold tracking-tight">{result.host}</p>
          <p className="text-muted-foreground text-sm">
            {VERDICT[result.grade]}
            {result.findings.length > 0 &&
              ` · ${result.findings.length} ${result.findings.length === 1 ? "issue" : "issues"}`}
          </p>
        </div>
      </div>

      {result.facts.length > 0 && (
        <dl className="bg-card/70 divide-y rounded-3xl border">
          {result.facts.map((f) => (
            <div
              key={f.label}
              className="grid gap-1 px-5 py-3 text-sm sm:grid-cols-[14rem_1fr] sm:gap-4"
            >
              <dt className="font-semibold">{f.label}</dt>
              <dd
                className={cn(
                  "min-w-0 font-mono text-xs break-words sm:text-sm",
                  f.value === null && "text-destructive font-sans font-semibold",
                )}
              >
                {f.value ?? "Missing"}
              </dd>
            </div>
          ))}
        </dl>
      )}

      {result.findings.length === 0 ? (
        <p className="bg-accent/60 rounded-2xl px-5 py-4 text-sm">
          Nothing to fix here. Upzy can re-check it every day and alert you if that changes.
        </p>
      ) : (
        <ol className="space-y-4">
          {result.findings.map((f) => (
            <li key={`${f.checkKey}`} className="bg-card/70 rounded-3xl border p-5 sm:p-6">
              <div className="flex flex-wrap items-center gap-2">
                <SeverityBadge severity={f.severity} />
                <h3 className="font-bold tracking-tight">{f.title}</h3>
              </div>
              <p className="text-muted-foreground mt-2 text-sm leading-relaxed">{f.description}</p>
              <p className="mt-3 text-sm leading-relaxed">
                <strong>Fix:</strong> {f.remediation}
              </p>
              {f.fix && (
                <details className="mt-4">
                  <summary className="cursor-pointer text-sm font-semibold">
                    Show me how
                    {result.detected ? ` (for ${result.detected})` : ""}
                  </summary>
                  <div className="mt-3">
                    <FixForStack fix={f.fix} title="Fix it for your stack" />
                  </div>
                </details>
              )}
            </li>
          ))}
        </ol>
      )}

      <div className="bg-card/70 rounded-3xl border p-6 text-center shadow-[var(--shadow-panel)] sm:p-8">
        <h2 className="text-2xl font-extrabold tracking-tighter text-balance">
          Don&apos;t check by hand every time
        </h2>
        <p className="text-muted-foreground mx-auto mt-2 max-w-md text-sm leading-relaxed text-pretty">
          Upzy watches {result.host} around the clock: uptime, certificates, headers and email
          records, and tells you the moment something slips. Free to start, no card.
        </p>
        <ButtonLink href="/sign-up" size="lg" className="mt-5">
          Monitor {result.host}
        </ButtonLink>
      </div>
      <p className="text-muted-foreground text-xs">
        Checked {new Date(result.checkedAt).toLocaleString()}. Results are cached for ten minutes.
      </p>
    </div>
  );
}
