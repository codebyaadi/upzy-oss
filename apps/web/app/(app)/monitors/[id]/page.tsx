"use client";

import { Button } from "@upzy/ui/components/button";
import { Skeleton } from "@upzy/ui/components/skeleton";
import { buttonVariants } from "@upzy/ui/lib/button-variants";
import { cn } from "@upzy/ui/lib/utils";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useState } from "react";

import { Can } from "@/components/app/can";
import { useConfirm } from "@/components/app/confirm";
import { HeartbeatPanel } from "@/components/app/heartbeat-panel";
import { ResponseChart } from "@/components/app/response-chart";
import { Segmented } from "@/components/app/segmented";
import {
  BackLink,
  DetailSkeleton,
  ErrorNote,
  IncidentBadge,
  Panel,
  StatSkeleton,
  StatusPill,
  PageTitle,
} from "@/components/app/ui";
import { api } from "@/lib/api";
import { dateTime, duration, ms, pct, timeAgo } from "@/lib/format";
import { useAction } from "@/lib/use-action";
import { unwrap, useApi } from "@/lib/use-api";

const RANGES = ["24h", "7d", "30d"] as const;

export default function MonitorDetailPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const [range, setRange] = useState<(typeof RANGES)[number]>("24h");
  const confirm = useConfirm();
  const { run, isPending } = useAction();

  const monitor = useApi(`monitor:${id}`, () => unwrap(api.monitor({ id }).get()));
  const stats = useApi(`monitor:${id}:stats:${range}`, () =>
    unwrap(api.monitor({ id }).stats.get({ query: { range } })),
  );
  const checks = useApi(`monitor:${id}:checks`, () =>
    unwrap(api.monitor({ id }).checks.get({ query: { limit: 20 } })),
  );
  const incidents = useApi(`monitor:${id}:incidents`, () =>
    unwrap(api.incident.get({ query: { monitorId: id, limit: 10 } })),
  );

  const m = monitor.data;
  if (monitor.error) return <ErrorNote error={monitor.error} />;
  if (!m) return <DetailSkeleton />;
  const status = !m.active ? "paused" : m.maintenance ? "maintenance" : m.lastStatus;

  const toggle = () =>
    run(
      "toggle",
      async () => {
        await unwrap(api.monitor({ id }).patch({ active: !m.active }));
        await monitor.mutate();
      },
      {
        success: m.active ? "Monitor paused" : "Monitor resumed",
        error: "Couldn't update the monitor",
      },
    );

  async function remove() {
    const ok = await confirm({
      title: `Delete "${m!.name}"?`,
      description: "Its check history and incidents are deleted too. This can't be undone.",
      confirmLabel: "Delete monitor",
      destructive: true,
    });
    if (!ok) return;
    const done = await run(
      "delete",
      async () => {
        const { error } = await api.monitor({ id }).delete();
        if (error) throw new Error("Couldn't delete the monitor");
        return true;
      },
      { success: "Monitor deleted" },
    );
    if (done) router.replace("/monitors");
  }

  return (
    <>
      <BackLink href="/monitors">Monitors</BackLink>
      <PageTitle>{m.name}</PageTitle>
      <div className="mb-8 flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-4">
            <h1 className="text-3xl font-extrabold tracking-tighter sm:text-4xl">{m.name}</h1>
            <StatusPill status={status} />
          </div>
          <p className="text-muted-foreground mt-2 break-all">
            <span className="uppercase">{m.type}</span>
            {m.type === "heartbeat"
              ? " · waits for pings"
              : ` · ${m.target} · every ${m.interval / 60} min`}
            {m.secretNames.length > 0 &&
              ` · ${m.secretNames.length} secret${m.secretNames.length === 1 ? "" : "s"} (${m.secretNames.join(", ")})`}
          </p>
        </div>
        <div className="flex gap-2">
          <Can min="member">
            <Link
              href={`/monitors/${id}/edit` as never}
              className={buttonVariants({ variant: "outline" })}
            >
              Edit
            </Link>
            <Button variant="outline" loading={isPending("toggle")} onClick={toggle}>
              {m.active ? "Pause" : "Resume"}
            </Button>
            <Button variant="destructive" loading={isPending("delete")} onClick={remove}>
              Delete
            </Button>
          </Can>
        </div>
      </div>
      {m.active && m.maintenance && (
        <p role="status" className="bg-accent/60 mb-6 rounded-2xl border px-4 py-3 text-sm">
          <span className="font-semibold">Maintenance: {m.maintenance.name}.</span> Checks keep
          running, but a failure won&rsquo;t open an incident until {dateTime(m.maintenance.endsAt)}
          .
        </p>
      )}
      {m.active && !m.maintenance && m.lastStatus === "degraded" && (
        <p role="status" className="bg-accent/60 mb-6 rounded-2xl border px-4 py-3 text-sm">
          <span className="font-semibold">Degraded.</span> The last checks succeeded but took longer
          than {m.latencyThresholdMs} ms. This doesn&rsquo;t raise an incident; it clears on the
          first fast check.
        </p>
      )}

      {m.type === "heartbeat" && (
        <HeartbeatPanel
          id={id}
          pingUrl={(m as { pingUrl?: string | null }).pingUrl}
          config={m.config}
          lastPingAt={m.lastPingAt}
          lastFailAt={m.lastFailAt}
          onChanged={() => monitor.mutate()}
        />
      )}

      {m.type === "heartbeat" ? null : stats.isLoading && !stats.data ? (
        <StatSkeleton />
      ) : (
        <div className="mt-2 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {[
            ["Uptime", pct(stats.data?.uptime)],
            ["Avg response", ms(stats.data?.avgMs)],
            ["p95 response", ms(stats.data?.p95Ms)],
            ["Checks", stats.data ? String(stats.data.checks) : "–"],
          ].map(([label, value]) => (
            <Panel key={label} className="p-5">
              <p className="text-muted-foreground text-sm">{label}</p>
              <p className="mt-1 text-2xl font-extrabold tracking-tighter">{value}</p>
            </Panel>
          ))}
        </div>
      )}

      {m.type !== "heartbeat" && (
        <Panel className="mt-4">
          <div className="mb-4 flex items-center justify-between">
            <h2 className="text-xl font-bold tracking-tight">Response time</h2>
            <Segmented
              label="Time range"
              value={range}
              onValueChange={setRange}
              options={RANGES.map((r) => ({ value: r, label: r }))}
            />
          </div>
          {stats.isLoading && !stats.data ? (
            <Skeleton className="h-56 w-full" />
          ) : (
            <ResponseChart points={stats.data?.series ?? []} />
          )}
        </Panel>
      )}

      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        <Panel>
          <h2 className="mb-4 text-xl font-bold tracking-tight">Incidents</h2>
          {incidents.data?.length === 0 && (
            <p className="text-muted-foreground text-sm">No incidents. Nice.</p>
          )}
          <ul className="space-y-2">
            {incidents.data?.map((i) => (
              <li key={i.id}>
                <Link
                  href={`/incidents/${i.id}`}
                  className="hover:bg-accent/50 flex items-center justify-between gap-3 rounded-2xl px-3 py-2.5 transition-colors"
                >
                  <span className="min-w-0">
                    <span className="block truncate text-sm font-semibold">{i.title}</span>
                    <span className="text-muted-foreground text-xs">
                      {dateTime(i.createdAt)} · {duration(i.createdAt, i.resolvedAt)}
                    </span>
                  </span>
                  <IncidentBadge status={i.status} />
                </Link>
              </li>
            ))}
          </ul>
        </Panel>

        <Panel>
          <h2 className="mb-4 text-xl font-bold tracking-tight">Recent checks</h2>
          {checks.data?.length === 0 && (
            <p className="text-muted-foreground text-sm">Waiting for the first check…</p>
          )}
          <ul className="divide-y">
            {checks.data?.map((c) => (
              <li key={c.id} className="flex items-center justify-between gap-3 py-2.5 text-sm">
                <span className="flex items-center gap-2 font-semibold">
                  <span
                    aria-hidden
                    className={cn(
                      "size-2 rounded-full",
                      c.status === "up" ? "bg-brand" : "bg-destructive",
                    )}
                  />
                  {c.status === "up" ? "Up" : "Down"}
                  {c.statusCode ? (
                    <span className="text-muted-foreground font-normal">HTTP {c.statusCode}</span>
                  ) : null}
                </span>
                <span className="text-muted-foreground min-w-0 truncate text-right">
                  {c.error ?? ms(c.responseMs)}
                </span>
                <span className="text-muted-foreground shrink-0 text-xs">
                  {timeAgo(c.createdAt)}
                </span>
              </li>
            ))}
          </ul>
        </Panel>
      </div>
    </>
  );
}
