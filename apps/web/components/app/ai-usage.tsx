"use client";

import { Skeleton } from "@upzy/ui/components/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@upzy/ui/components/table";
import { useState } from "react";

import { Segmented } from "@/components/app/segmented";
import { ErrorNote, Panel } from "@/components/app/ui";
import { api } from "@/lib/api";
import { usd } from "@/lib/format";
import { unwrap, useApi } from "@/lib/use-api";

const FEATURES: Record<string, string> = {
  "explain-finding": "Finding explanations",
  "monitor-draft": "Monitor drafts",
  "weekly-digest": "Weekly digest",
  "triage-incident": "Incident analysis",
  postmortem: "Postmortem drafts",
  "group-summary": "Related-incident summaries",
  "discovery-classify": "Subdomain analysis",
  copilot: "Copilot",
};

/** Eden turns date-like strings into Date objects; the API's "day" is a plain UTC calendar day. */
const dayLabel = (d: string | Date) => (d instanceof Date ? d.toISOString() : d).slice(0, 10);

type Range = "7" | "30" | "90";
type Metric = "cost" | "tokens";

/** Spend and token use over the last 7/30/90 days, per day, model and feature. */
export function AiUsage() {
  const [range, setRange] = useState<Range>("30");
  const [metric, setMetric] = useState<Metric>("cost");
  const usage = useApi(`ai-usage:${range}`, () =>
    unwrap(api.ai.usage.get({ query: { days: Number(range) } })),
  );
  const u = usage.data;

  const value = (d: { inputTokens: number; outputTokens: number; costMicros: number }) =>
    metric === "cost" ? d.costMicros : d.inputTokens + d.outputTokens;
  const max = Math.max(1, ...(u?.perDay.map(value) ?? [1]));
  const tokens = (n: { inputTokens: number; outputTokens: number }) =>
    (n.inputTokens + n.outputTokens).toLocaleString();

  return (
    <Panel>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-xl font-bold tracking-tight">Usage and cost</h2>
        <div className="flex flex-wrap gap-2">
          <Segmented
            label="Measure"
            value={metric}
            onValueChange={setMetric}
            options={[
              { value: "cost", label: "Cost" },
              { value: "tokens", label: "Tokens" },
            ]}
          />
          <Segmented
            label="Period"
            value={range}
            onValueChange={setRange}
            options={[
              { value: "7", label: "7 days" },
              { value: "30", label: "30 days" },
              { value: "90", label: "90 days" },
            ]}
          />
        </div>
      </div>
      <ErrorNote error={usage.error} />
      {!u && !usage.error && (
        <div role="status" aria-label="Loading usage" className="space-y-3">
          <Skeleton className="h-24 w-full rounded-2xl" />
          <Skeleton className="h-32 w-full rounded-2xl" />
        </div>
      )}
      {u && (
        <div className="space-y-6">
          <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            {[
              ["Estimated cost", usd(u.total.costMicros)],
              ["Requests", u.total.requests.toLocaleString()],
              ["Tokens", tokens(u.total)],
              ["Failed calls", u.total.failures.toLocaleString()],
            ].map(([k, v]) => (
              <div key={k} className="bg-muted/50 rounded-2xl px-4 py-3">
                <dt className="text-muted-foreground text-xs">{k}</dt>
                <dd className="text-xl font-bold tracking-tight">{v}</dd>
              </div>
            ))}
          </dl>
          {u.total.unpriced > 0 && (
            <p className="text-muted-foreground text-xs">
              {u.total.unpriced} request{u.total.unpriced === 1 ? "" : "s"} used a model without a
              known price, so the cost above is a minimum.
            </p>
          )}

          <figure>
            <div
              className="flex h-28 items-end gap-px"
              role="img"
              aria-label={`${metric === "cost" ? "Cost" : "Tokens"} per day over the last ${u.days} days`}
            >
              {u.perDay.map((d) => (
                <div
                  key={dayLabel(d.day)}
                  title={`${dayLabel(d.day)}: ${usd(d.costMicros)} · ${tokens(d)} tokens`}
                  className="bg-brand/80 hover:bg-brand min-h-px flex-1 rounded-t-sm"
                  style={{
                    height: `${Math.max(1, (value(d) / max) * 100)}%`,
                    opacity: value(d) ? 1 : 0.2,
                  }}
                />
              ))}
            </div>
            <figcaption className="text-muted-foreground mt-1 flex justify-between text-xs">
              <span>{u.perDay[0] && dayLabel(u.perDay[0].day)}</span>
              <span>{u.perDay.length > 0 && dayLabel(u.perDay.at(-1)!.day)}</span>
            </figcaption>
          </figure>

          {u.byModel.length === 0 ? (
            <p className="text-muted-foreground text-sm">No AI calls in this period.</p>
          ) : (
            <>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Model</TableHead>
                    <TableHead className="text-right">Requests</TableHead>
                    <TableHead className="text-right">Input</TableHead>
                    <TableHead className="text-right">Output</TableHead>
                    <TableHead className="text-right">Est. cost</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {u.byModel.map((m) => (
                    <TableRow key={m.key}>
                      <TableCell className="font-mono text-xs">{m.key}</TableCell>
                      <TableCell className="text-right">{m.requests.toLocaleString()}</TableCell>
                      <TableCell className="text-right">{m.inputTokens.toLocaleString()}</TableCell>
                      <TableCell className="text-right">
                        {m.outputTokens.toLocaleString()}
                      </TableCell>
                      <TableCell className="text-right">
                        {m.known ? usd(m.costMicros) : "price unknown"}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
              <ul className="divide-y text-sm">
                {u.byFeature.map((f) => (
                  <li key={f.key} className="flex items-center justify-between py-2">
                    <span>{FEATURES[f.key] ?? f.key}</span>
                    <span className="text-muted-foreground text-xs">
                      {f.requests} request{f.requests === 1 ? "" : "s"} · {tokens(f)} tokens ·{" "}
                      {usd(f.costMicros)}
                    </span>
                  </li>
                ))}
              </ul>
            </>
          )}
          <p className="text-muted-foreground text-xs">
            Estimates use list prices as of {u.pricesAsOf}. Your provider&rsquo;s invoice is
            authoritative.
          </p>
        </div>
      )}
    </Panel>
  );
}
