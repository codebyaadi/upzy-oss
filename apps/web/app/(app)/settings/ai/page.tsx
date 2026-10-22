"use client";

import { Badge } from "@upzy/ui/components/badge";
import { Button } from "@upzy/ui/components/button";
import { Input } from "@upzy/ui/components/input";
import { Skeleton } from "@upzy/ui/components/skeleton";
import { Switch } from "@upzy/ui/components/switch";
import { useState } from "react";

import { AiConnection } from "@/components/app/ai-connection";
import { AiUsage } from "@/components/app/ai-usage";
import { Can, ViewOnlyNote } from "@/components/app/can";
import { useConfirm } from "@/components/app/confirm";
import { ErrorNote, Field, PageHeader, Panel } from "@/components/app/ui";
import { useWorkspace } from "@/components/app/workspace";
import { api } from "@/lib/api";
import { useAction } from "@/lib/use-action";
import { unwrap, useApi } from "@/lib/use-api";

const FEATURE_LABELS: Record<string, string> = {
  "explain-finding": "Finding explanations",
  "monitor-draft": "Monitor drafts",
  "weekly-digest": "Weekly digest",
  "triage-incident": "Incident analysis",
  postmortem: "Postmortem drafts",
  "group-summary": "Related-incident summaries",
  "discovery-classify": "Subdomain analysis",
  copilot: "Copilot",
};

export default function AiSettingsPage() {
  const { can } = useWorkspace();
  const confirm = useConfirm();
  const { run, isPending } = useAction();
  const settings = useApi("ai-settings", () => unwrap(api.ai.settings.get()));
  const [budget, setBudget] = useState<string | null>(null);
  const s = settings.data;

  const save = (
    body: {
      enabled?: boolean;
      dailyTokenBudget?: number;
    },
    success: string,
    key: string,
  ) =>
    run(
      key,
      async () => {
        await unwrap(api.ai.settings.patch(body));
        await settings.mutate();
      },
      { success, error: "Couldn't save the AI settings" },
    );

  async function toggle(on: boolean) {
    if (!s) return;
    if (on) {
      const provider = s.active.smart.model?.split(":")[0] ?? "your AI provider";
      const who = `${provider}, using your own API key`;
      const ok = await confirm({
        title: "Turn on AI features?",
        description: `Upzy will send finding details (titles, descriptions and evidence such as headers and DNS values), text you type into the monitor assistant, weekly statistics, the monitor, incident and finding records the copilot looks up to answer your questions, and for discovered subdomains the page title, server header and a short text snippet of each site's front page, to ${who}. Secrets, cookies, tokens and email addresses are removed first. AI never changes anything on its own.`,
        confirmLabel: "Turn on",
      });
      if (!ok) return;
    }
    await save({ enabled: on }, on ? "AI features turned on" : "AI features turned off", "enabled");
  }

  const used = s?.usedToday ?? 0;
  const pct = s ? Math.min(100, Math.round((used / Math.max(1, s.dailyTokenBudget)) * 100)) : 0;
  const ready = !!s?.active.smart.ready && !!s?.active.fast.ready;

  return (
    <>
      <PageHeader
        title="AI settings"
        description="Optional help that explains findings, analyses outages, drafts monitors and writes summaries. It runs on your own AI provider key, and is off until you add one and turn it on."
      />
      <ErrorNote error={settings.error} />
      {!can("admin") && <ViewOnlyNote what="the AI settings" />}
      {!s && !settings.error && (
        <div className="space-y-4" role="status" aria-label="Loading">
          <Skeleton className="h-40 w-full rounded-3xl" />
          <Skeleton className="h-56 w-full rounded-3xl" />
        </div>
      )}

      {s && (
        <div className="grid gap-4 lg:grid-cols-[1fr_22rem]">
          <div className="space-y-4">
            <Panel>
              <div className="flex items-start justify-between gap-4">
                <div>
                  <h2 className="text-xl font-bold tracking-tight">AI features</h2>
                  <p className="text-muted-foreground mt-1 text-sm">
                    {s.enabled
                      ? "On for this organization."
                      : "Off. Nothing is sent to any AI provider."}
                  </p>
                </div>
                <Can
                  min="admin"
                  fallback={
                    <Badge variant={s.enabled ? "default" : "secondary"}>
                      {s.enabled ? "On" : "Off"}
                    </Badge>
                  }
                >
                  <Switch
                    aria-label="AI features"
                    checked={s.enabled}
                    disabled={isPending("enabled") || (!s.enabled && !ready)}
                    onCheckedChange={toggle}
                  />
                </Can>
              </div>
              {!s.enabled && !ready && (
                <p className="bg-accent/60 mt-4 rounded-2xl px-4 py-3 text-sm">
                  Add an API key below to turn AI on. Upzy has no AI key of its own: nothing is sent
                  anywhere until you connect your provider.
                </p>
              )}
              <ul className="text-muted-foreground mt-5 space-y-2 text-sm">
                <li>
                  <strong className="text-foreground">Finding explanations:</strong> plain-English
                  impact and fix snippets, written when you ask for them.
                </li>
                <li>
                  <strong className="text-foreground">Monitor assistant:</strong> describe a monitor
                  in words and review the draft before creating it.
                </li>
                <li>
                  <strong className="text-foreground">Incident analysis:</strong> when a monitor
                  goes down, Upzy re-checks it, looks at DNS, related monitors and history, and
                  suggests a likely cause with the evidence it used.
                </li>
                <li>
                  <strong className="text-foreground">Subdomain analysis:</strong> for newly found
                  subdomains, Upzy makes one anonymous request to each, and AI labels what it
                  probably is (staging, admin tool, third party) and flags risky-looking ones.
                  Suggestions only: nothing is added or scanned automatically.
                </li>
                <li>
                  <strong className="text-foreground">Copilot:</strong> ask questions about your
                  monitors, incidents, findings and certificates. It only reads your data (it can
                  look things up, never change anything), and each answer links to the records it
                  used.
                </li>
                <li>
                  <strong className="text-foreground">Weekly digest:</strong> a Monday email to
                  owners and admins. The numbers always come from your data; AI only writes the
                  summary.
                </li>
              </ul>
            </Panel>

            <Panel>
              <h2 className="mb-1 text-xl font-bold tracking-tight">Your AI provider</h2>
              <p className="text-muted-foreground mb-4 text-sm">
                Inputs are stripped of secrets, cookies, tokens and email addresses, and untrusted
                content (page text, headers) is clearly fenced so it can&rsquo;t instruct the model.
                They go only to the provider you connect, under your account and its data terms.
              </p>
              {can("admin") ? (
                <AiConnection data={s} onChange={() => settings.mutate()} />
              ) : (
                <p className="text-muted-foreground text-sm">
                  {s.credentials.length > 0 ? (
                    <>
                      Your organization uses{" "}
                      <span className="font-mono">{s.active.smart.model}</span> with its own key.
                    </>
                  ) : (
                    "No AI provider key has been added yet. An admin can add one here."
                  )}
                </p>
              )}
            </Panel>
          </div>

          <div className="space-y-4">
            <Panel>
              <h2 className="mb-3 text-xl font-bold tracking-tight">Today&rsquo;s usage</h2>
              <div
                role="progressbar"
                aria-label="Daily AI token budget used"
                aria-valuemin={0}
                aria-valuemax={s.dailyTokenBudget}
                aria-valuenow={used}
                className="bg-muted h-2.5 overflow-hidden rounded-full"
              >
                <div
                  className={`h-full rounded-full transition-all ${pct >= 90 ? "bg-destructive" : "bg-brand"}`}
                  style={{ width: `${pct}%` }}
                />
              </div>
              <p className="mt-2 text-sm">
                <span className="font-semibold">{used.toLocaleString()}</span> of{" "}
                {s.dailyTokenBudget.toLocaleString()} tokens ({pct}%)
              </p>
              <p className="text-muted-foreground text-xs">Resets at 00:00 UTC.</p>
              {s.byFeature.length > 0 && (
                <ul className="mt-4 divide-y text-sm">
                  {s.byFeature.map((f) => (
                    <li key={f.feature} className="flex items-center justify-between py-2">
                      <span>{FEATURE_LABELS[f.feature] ?? f.feature}</span>
                      <span className="text-muted-foreground text-xs">
                        {f.requests} request{f.requests === 1 ? "" : "s"} ·{" "}
                        {f.tokens.toLocaleString()} tokens
                        {f.failures ? ` · ${f.failures} failed` : ""}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </Panel>

            <Can min="admin">
              <Panel>
                <h2 className="mb-3 text-xl font-bold tracking-tight">Daily budget</h2>
                <form
                  className="space-y-3"
                  onSubmit={(e) => {
                    e.preventDefault();
                    const n = Number(budget ?? s.dailyTokenBudget);
                    if (Number.isInteger(n))
                      save({ dailyTokenBudget: n }, "Budget updated", "budget");
                  }}
                >
                  <Field
                    label="Tokens per day"
                    htmlFor="budget"
                    hint="Between 1,000 and 5,000,000. Once used up, AI features pause until the next UTC day."
                  >
                    <Input
                      id="budget"
                      type="number"
                      min={1000}
                      max={5000000}
                      step={1000}
                      value={budget ?? String(s.dailyTokenBudget)}
                      onChange={(e) => setBudget(e.target.value)}
                    />
                  </Field>
                  <Button
                    type="submit"
                    className="w-full"
                    loading={isPending("budget")}
                    disabled={budget === null || Number(budget) === s.dailyTokenBudget}
                  >
                    Save budget
                  </Button>
                </form>
              </Panel>
            </Can>
          </div>
        </div>
      )}
      {s && (
        <div className="mt-4">
          <AiUsage />
        </div>
      )}
    </>
  );
}
