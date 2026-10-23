"use client";

import { cn } from "@upzy/ui/lib/utils";
import Link from "next/link";
import { useState } from "react";

import { DensityToggle, useDensity } from "@/components/app/density";
import { Segmented } from "@/components/app/segmented";
import {
  EmptyState,
  ErrorNote,
  IncidentBadge,
  ListSkeleton,
  PageHeader,
} from "@/components/app/ui";
import { useWorkspace } from "@/components/app/workspace";
import { api } from "@/lib/api";
import { dateTime, duration } from "@/lib/format";
import { unwrap, useApi } from "@/lib/use-api";

const FILTERS = [
  { id: "active", label: "Active" },
  { id: "all", label: "All" },
] as const;

export default function IncidentsPage() {
  const { workspace } = useWorkspace();
  const [density, setDensity] = useDensity();
  const compact = density === "compact";
  const [filter, setFilter] = useState<(typeof FILTERS)[number]["id"]>("active");
  const { data, error, isLoading } = useApi(`incidents:${workspace.id}:${filter}`, () =>
    unwrap(
      api.incident.get({
        query: {
          workspaceId: workspace.id,
          limit: 100,
          ...(filter === "active" ? { status: "active" as const } : {}),
        },
      }),
    ),
  );

  return (
    <>
      <PageHeader
        title="Incidents"
        description="Outages Upzy detected, and who was told about them."
        actions={
          <span className="flex flex-wrap items-center gap-3">
            <DensityToggle value={density} onValueChange={setDensity} />
            <Segmented
              label="Filter incidents"
              value={filter}
              onValueChange={setFilter}
              options={FILTERS.map((f) => ({ value: f.id, label: f.label }))}
            />
          </span>
        }
      />
      <ErrorNote error={error} />
      {isLoading && !data && <ListSkeleton />}
      {data?.length === 0 && (
        <EmptyState
          title={filter === "active" ? "All clear" : "No incidents yet"}
          body={
            filter === "active"
              ? "Nothing is down right now."
              : "When a monitor goes down, it shows up here."
          }
        />
      )}
      <ul className={compact ? "space-y-1.5" : "space-y-3"}>
        {data?.map((i) => (
          <li key={i.id}>
            <Link
              href={`/incidents/${i.id}`}
              className={cn(
                "bg-card/70 flex items-center justify-between gap-4 border backdrop-blur transition-shadow hover:shadow-[var(--shadow-panel)]",
                compact ? "rounded-2xl px-4 py-2" : "rounded-3xl px-6 py-5",
              )}
            >
              <span className="min-w-0">
                <span className="block truncate font-bold tracking-tight">{i.title}</span>
                {i.groupId && (
                  <span className="text-brand block text-xs font-semibold">
                    Part of a group of related incidents
                  </span>
                )}
                <span className="text-muted-foreground text-sm">
                  {dateTime(i.createdAt)} ·{" "}
                  {i.resolvedAt
                    ? `lasted ${duration(i.createdAt, i.resolvedAt)}`
                    : `ongoing for ${duration(i.createdAt, null)}`}
                </span>
              </span>
              <IncidentBadge status={i.status} />
            </Link>
          </li>
        ))}
      </ul>
    </>
  );
}
