"use client";

import { cn } from "@upzy/ui/lib/utils";
import { useRouter } from "next/navigation";

import { SetupChecklist } from "@/components/app/setup-checklist";
import { EmptyState, ErrorNote, ListSkeleton, PageHeader } from "@/components/app/ui";
import { useWorkspace } from "@/components/app/workspace";
import { api } from "@/lib/api";
import { unwrap, useApi } from "@/lib/use-api";

type Grade = "A" | "B" | "C" | "D" | "F";
const TONE: Record<Grade, string> = {
  A: "bg-brand text-background",
  B: "bg-lime-500 text-white",
  C: "bg-amber-400 text-black",
  D: "bg-orange-500 text-white",
  F: "bg-destructive text-white",
};

/** Every workspace (for an agency, every client) at a glance. Picking one opens it. */
export default function OverviewPage() {
  const router = useRouter();
  const { workspace, setWorkspaceId } = useWorkspace();
  const overview = useApi("overview", () => unwrap(api.overview.get()), {
    refreshInterval: 30_000,
  });

  const open = (id: string, to: "/monitors" | "/incidents" | "/findings") => {
    setWorkspaceId(id);
    router.push(to);
  };

  return (
    <>
      <PageHeader
        title="All workspaces"
        description="Every workspace in your organization at a glance, so you see which client needs you first."
      />
      <ErrorNote error={overview.error} />
      {overview.isLoading && !overview.data && <ListSkeleton rows={3} />}
      {overview.data && (
        <SetupChecklist
          title="Set up your clients"
          steps={[
            {
              label: "Create a workspace for each client",
              hint: "Use the workspace menu in the sidebar. Each client's monitors, incidents and findings stay separate.",
              done: overview.data.length > 1,
            },
            {
              label: "Add monitors to every workspace",
              hint: "Watch the client's website so their outages show up here first.",
              done: overview.data.every((w) => w.monitors.total > 0),
              href: "/get-started",
            },
            {
              label: "Publish a status page for a client",
              hint: "A public page with the client's own logo and domain.",
              done: overview.data.some((w) => w.statusPage),
              href: "/status-pages",
            },
          ]}
        />
      )}
      {overview.data?.length === 0 && (
        <EmptyState title="No workspaces yet" body="Create one from the workspace menu." />
      )}

      <ul className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {overview.data?.map((w) => {
          const trouble = w.monitors.down > 0 || w.openIncidents > 0;
          return (
            <li
              key={w.id}
              className={cn(
                "bg-card/70 flex flex-col rounded-3xl border p-5 shadow-[var(--shadow-panel)]",
                trouble && "border-destructive/40",
              )}
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <h2 className="truncate text-lg font-bold tracking-tight">{w.name}</h2>
                  <p className="text-muted-foreground text-xs">
                    {w.id === workspace.id ? "Current workspace" : " "}
                  </p>
                </div>
                <span
                  title={w.grade ? `Worst security grade: ${w.grade}` : "Not scanned yet"}
                  className={cn(
                    "grid size-11 shrink-0 place-items-center rounded-2xl text-xl font-extrabold",
                    w.grade ? TONE[w.grade] : "bg-muted text-muted-foreground",
                  )}
                >
                  {w.grade ?? "–"}
                </span>
              </div>

              <dl className="mt-4 grid grid-cols-3 gap-3 text-center">
                <Stat
                  label="Down"
                  value={w.monitors.down}
                  alert={w.monitors.down > 0}
                  onClick={() => open(w.id, "/monitors")}
                />
                <Stat
                  label="Incidents"
                  value={w.openIncidents}
                  alert={w.openIncidents > 0}
                  onClick={() => open(w.id, "/incidents")}
                />
                <Stat
                  label="Critical or high"
                  value={w.openFindings.critical + w.openFindings.high}
                  alert={w.openFindings.critical > 0}
                  onClick={() => open(w.id, "/findings")}
                />
              </dl>

              <p className="text-muted-foreground mt-4 text-sm">
                {w.monitors.total === 0
                  ? "No monitors yet"
                  : `${w.monitors.up} of ${w.monitors.total} monitors up${
                      w.monitors.degraded ? `, ${w.monitors.degraded} slow` : ""
                    }${w.monitors.paused ? `, ${w.monitors.paused} paused` : ""}`}
              </p>

              <div className="mt-auto flex items-center justify-between gap-3 pt-4 text-sm font-semibold">
                <button
                  type="button"
                  onClick={() => open(w.id, "/monitors")}
                  className="text-brand hover:underline"
                >
                  Open workspace →
                </button>
                {w.statusPage && (
                  <a
                    href={`/status/${w.statusPage.slug}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-muted-foreground hover:text-foreground"
                  >
                    Status page ↗
                  </a>
                )}
              </div>
            </li>
          );
        })}
      </ul>
    </>
  );
}

function Stat({
  label,
  value,
  alert,
  onClick,
}: {
  label: string;
  value: number;
  alert: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="hover:bg-accent/60 rounded-2xl px-2 py-2 transition-colors"
    >
      <dd className={cn("text-2xl font-extrabold tabular-nums", alert && "text-destructive")}>
        {value}
      </dd>
      <dt className="text-muted-foreground text-xs">{label}</dt>
    </button>
  );
}
