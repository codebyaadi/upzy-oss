"use client";

import { cn } from "@upzy/ui/lib/utils";
import Link from "next/link";

import { DensityToggle, useDensity } from "@/components/app/density";
import { EmptyState, ErrorNote, ListSkeleton, PageHeader, StatusPill } from "@/components/app/ui";
import { useWorkspace } from "@/components/app/workspace";
import { ButtonLink } from "@/components/button-link";
import { api } from "@/lib/api";
import { ms, pct, timeAgo } from "@/lib/format";
import { kindLabel } from "@/lib/monitor-form";
import { unwrap, useApi } from "@/lib/use-api";

export default function MonitorsPage() {
  const { workspace, can } = useWorkspace();
  const { data, error, isLoading } = useApi(`monitors:${workspace.id}`, () =>
    unwrap(api.monitor.get({ query: { workspaceId: workspace.id } })),
  );

  const [density, setDensity] = useDensity();
  const compact = density === "compact";

  const newButton = (
    <ButtonLink size="lg" href="/monitors/new">
      New monitor
    </ButtonLink>
  );

  return (
    <>
      <PageHeader
        title="Monitors"
        description="Everything Upzy is watching in this workspace."
        actions={
          data && data.length > 0 ? (
            <span className="flex flex-wrap items-center gap-3">
              <DensityToggle value={density} onValueChange={setDensity} />
              {can("member") && newButton}
            </span>
          ) : undefined
        }
      />
      <ErrorNote error={error} />
      {isLoading && <ListSkeleton />}
      {data && data.length === 0 && (
        <EmptyState
          title="No monitors yet"
          body="Add a website and Upzy watches it, checks its certificate and security, and gives it a grade. Or add any API or host by hand."
          action={
            can("member") ? (
              <span className="flex flex-wrap justify-center gap-2">
                <ButtonLink size="lg" href="/get-started">
                  Watch my website
                </ButtonLink>
                <ButtonLink size="lg" variant="outline" href="/monitors/new">
                  New monitor
                </ButtonLink>
              </span>
            ) : undefined
          }
        />
      )}
      {data && data.length > 0 && (
        <ul className={compact ? "space-y-1.5" : "space-y-3"}>
          {data.map((m) => {
            const status = !m.active ? "paused" : m.maintenance ? "maintenance" : m.lastStatus;
            return (
              <li key={m.id}>
                <Link
                  href={`/monitors/${m.id}`}
                  className={cn(
                    "bg-card/70 grid grid-cols-[1fr_auto] items-center gap-x-6 gap-y-2 border backdrop-blur transition-shadow hover:shadow-[var(--shadow-panel)] sm:grid-cols-[1fr_auto_auto_auto]",
                    compact ? "gap-y-0 rounded-2xl px-4 py-2" : "rounded-3xl px-6 py-5",
                  )}
                >
                  <div className="min-w-0">
                    <p className="truncate font-bold tracking-tight">{m.name}</p>
                    <p
                      className={cn("text-muted-foreground truncate text-sm", compact && "text-xs")}
                    >
                      <span className="uppercase">{kindLabel(m.type)}</span>
                      {m.type === "heartbeat" ? " · waits for pings" : ` · ${m.target}`}
                    </p>
                  </div>
                  <StatusPill status={status} />
                  {m.type === "heartbeat" ? (
                    <dl className="col-span-2 hidden text-right text-sm sm:block">
                      <dt className="sr-only">Last ping</dt>
                      <dd className="font-semibold">
                        {m.lastPingAt ? `pinged ${timeAgo(m.lastPingAt)}` : "no ping yet"}
                      </dd>
                    </dl>
                  ) : (
                    <>
                      <dl className="hidden text-right text-sm sm:block">
                        <dt className="sr-only">Uptime, last 24 hours</dt>
                        <dd className="font-semibold">{pct(m.uptime24h)}</dd>
                        <dd className="text-muted-foreground text-xs">24h uptime</dd>
                      </dl>
                      <dl className="hidden text-right text-sm sm:block">
                        <dt className="sr-only">Average response time</dt>
                        <dd className="font-semibold">{ms(m.avgMs24h)}</dd>
                        <dd className="text-muted-foreground text-xs">
                          checked {timeAgo(m.lastCheckAt)}
                        </dd>
                      </dl>
                    </>
                  )}
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </>
  );
}
