"use client";

import Link from "next/link";

import { IncidentBadge, Panel } from "@/components/app/ui";
import { api } from "@/lib/api";
import { dateTime, duration } from "@/lib/format";
import { unwrap, useApi } from "@/lib/use-api";

/** Earlier incidents in this workspace that failed in a similar way, and how long they lasted. */
export function SimilarIncidents({ incidentId }: { incidentId: string }) {
  const { data } = useApi(`incident-similar:${incidentId}`, () =>
    unwrap(api.incident({ id: incidentId }).similar.get()),
  );
  if (!data || data.length === 0) return null;
  return (
    <Panel className="mb-4">
      <h2 className="text-xl font-bold tracking-tight">Seen before</h2>
      <p className="text-muted-foreground mt-1 text-sm">
        Earlier incidents that failed in a similar way. Useful for what fixed them last time.
      </p>
      <ul className="mt-4 divide-y">
        {data.map((s) => (
          <li key={s.id}>
            <Link
              href={`/incidents/${s.id}`}
              className="hover:bg-accent/40 -mx-2 flex items-center justify-between gap-4 rounded-xl px-2 py-3"
            >
              <span className="min-w-0">
                <span className="block truncate font-semibold">{s.title}</span>
                <span className="text-muted-foreground block text-xs">
                  {s.monitorName ? `${s.monitorName} · ` : ""}
                  {dateTime(s.createdAt)}
                  {s.resolvedAt ? ` · lasted ${duration(s.createdAt, s.resolvedAt)}` : ""}
                </span>
              </span>
              <span className="flex shrink-0 items-center gap-3">
                <span className="text-muted-foreground text-xs">
                  {Math.round(s.similarity * 100)}% alike
                </span>
                <IncidentBadge status={s.status} />
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </Panel>
  );
}
