"use client";

import Link from "next/link";
import { useState } from "react";

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
          <Segmented
            label="Filter incidents"
            value={filter}
            onValueChange={setFilter}
            options={FILTERS.map((f) => ({ value: f.id, label: f.label }))}
          />
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
      <ul className="space-y-3">
        {data?.map((i) => (
          <li key={i.id}>
            <Link
              href={`/incidents/${i.id}`}
              className="bg-card/70 flex items-center justify-between gap-4 rounded-3xl border px-6 py-5 backdrop-blur transition-shadow hover:shadow-[var(--shadow-panel)]"
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
