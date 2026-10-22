"use client";

import { cn } from "@upzy/ui/lib/utils";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense, useState } from "react";

import { Segmented } from "@/components/app/segmented";
import {
  EmptyState,
  ErrorNote,
  ListSkeleton,
  PageHeader,
  SeverityBadge,
  SEVERITIES,
  type Severity,
} from "@/components/app/ui";
import { useWorkspace } from "@/components/app/workspace";
import { api } from "@/lib/api";
import { timeAgo } from "@/lib/format";
import { unwrap, useApi } from "@/lib/use-api";

const STATUSES = ["open", "resolved", "ignored"] as const;

function Findings() {
  const { workspace } = useWorkspace();
  const assetId = useSearchParams().get("assetId") ?? undefined;
  const [status, setStatus] = useState<(typeof STATUSES)[number]>("open");
  const [severity, setSeverity] = useState<Severity | null>(null);

  const summary = useApi(`finding-summary:${workspace.id}`, () =>
    unwrap(api.finding.summary.get({ query: { workspaceId: workspace.id } })),
  );
  const list = useApi(`findings:${workspace.id}:${status}:${severity}:${assetId}`, () =>
    unwrap(
      api.finding.get({
        query: {
          workspaceId: workspace.id,
          status,
          limit: 200,
          ...(severity ? { severity } : {}),
          ...(assetId ? { assetId } : {}),
        },
      }),
    ),
  );

  return (
    <>
      <PageHeader
        title="Findings"
        description="Security issues found on your assets, ranked by risk. Fixed issues resolve themselves on the next scan."
      />
      <ErrorNote error={list.error} />

      <div className="mb-6 grid grid-cols-2 gap-3 sm:grid-cols-5">
        {SEVERITIES.map((s) => (
          <button
            key={s}
            type="button"
            aria-pressed={severity === s}
            onClick={() => setSeverity(severity === s ? null : s)}
            className={cn(
              "bg-card/70 rounded-3xl border p-4 text-left backdrop-blur transition-shadow hover:shadow-[var(--shadow-panel)]",
              severity === s && "ring-ring ring-1",
            )}
          >
            <SeverityBadge severity={s} />
            <p className="mt-2 text-3xl font-extrabold tracking-tighter">
              {summary.data?.bySeverity[s] ?? "–"}
            </p>
            <p className="sr-only">open {s} findings</p>
          </button>
        ))}
      </div>

      <div className="mb-4">
        <Segmented
          label="Finding status"
          value={status}
          onValueChange={setStatus}
          options={STATUSES.map((s) => ({ value: s, label: s[0]!.toUpperCase() + s.slice(1) }))}
        />
      </div>

      {list.isLoading && !list.data && <ListSkeleton />}
      {list.data?.length === 0 && (
        <EmptyState
          title={status === "open" ? "No open findings" : `No ${status} findings`}
          body={
            status === "open"
              ? "Add an asset and run a scan, or enjoy the quiet: nothing needs attention."
              : "Nothing here yet."
          }
        />
      )}
      <ul className="space-y-3">
        {list.data?.map((f) => (
          <li key={f.id}>
            <Link
              href={`/findings/${f.id}`}
              className="bg-card/70 flex items-center justify-between gap-4 rounded-3xl border px-6 py-5 backdrop-blur transition-shadow hover:shadow-[var(--shadow-panel)]"
            >
              <span className="min-w-0">
                <span className="block truncate font-bold tracking-tight">{f.title}</span>
                <span className="text-muted-foreground text-sm">
                  {f.assetValue} · first seen {timeAgo(f.firstSeen)}
                  {f.resolvedAt ? ` · resolved ${timeAgo(f.resolvedAt)}` : ""}
                </span>
              </span>
              <SeverityBadge severity={f.severity} />
            </Link>
          </li>
        ))}
      </ul>
    </>
  );
}

export default function FindingsPage() {
  return (
    <Suspense fallback={<p className="text-muted-foreground">Loading…</p>}>
      <Findings />
    </Suspense>
  );
}
