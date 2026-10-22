"use client";

import { Badge } from "@upzy/ui/components/badge";
import { Button } from "@upzy/ui/components/button";
import { Checkbox } from "@upzy/ui/components/checkbox";
import { Input } from "@upzy/ui/components/input";
import { Switch } from "@upzy/ui/components/switch";
import { useState } from "react";

import { ActionMenu } from "@/components/app/action-menu";
import { Can, ViewOnlyNote } from "@/components/app/can";
import { useConfirm } from "@/components/app/confirm";
import { SelectField } from "@/components/app/select-field";
import { EmptyState, ErrorNote, Field, ListSkeleton, PageHeader, Panel } from "@/components/app/ui";
import { useWorkspace } from "@/components/app/workspace";
import { api } from "@/lib/api";
import { dateTime } from "@/lib/format";
import { useAction } from "@/lib/use-action";
import { unwrap, useApi } from "@/lib/use-api";

/** `<input type="datetime-local">` wants local time as YYYY-MM-DDTHH:mm. */
const toLocalInput = (d: Date) => {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
};
const inOneHour = () => new Date(Math.ceil((Date.now() + 3_600_000) / 900_000) * 900_000);
const soon = () => new Date(Math.ceil(Date.now() / 900_000) * 900_000);

const PHASE = {
  active: { label: "In progress", variant: "default" as const },
  upcoming: { label: "Scheduled", variant: "secondary" as const },
  past: { label: "Finished", variant: "outline" as const },
};

export default function MaintenancePage() {
  const { workspace, can } = useWorkspace();
  const confirm = useConfirm();
  const { run, isPending } = useAction();
  const [name, setName] = useState("");
  const [starts, setStarts] = useState(() => toLocalInput(soon()));
  const [ends, setEnds] = useState(() => toLocalInput(inOneHour()));
  const [scope, setScope] = useState<"all" | "some">("all");
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [show, setShow] = useState(true);

  const windows = useApi(`maintenance:${workspace.id}`, () =>
    unwrap(api.maintenance.get({ query: { workspaceId: workspace.id, pastDays: 30 } })),
  );
  const monitors = useApi(`monitors:${workspace.id}`, () =>
    unwrap(api.monitor.get({ query: { workspaceId: workspace.id } })),
  );
  const monitorName = (id: string) => monitors.data?.find((m) => m.id === id)?.name ?? "A monitor";
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;

  async function create(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const created = await run(
      "create",
      async () => {
        const body = {
          workspaceId: workspace.id,
          name: name.trim(),
          startsAt: new Date(starts).toISOString(),
          endsAt: new Date(ends).toISOString(),
          allMonitors: scope === "all",
          monitorIds: scope === "all" ? [] : [...picked],
          showOnStatusPage: show,
        };
        const w = await unwrap(api.maintenance.post(body as never));
        await windows.mutate();
        return w;
      },
      { success: "Maintenance scheduled", error: "Couldn't schedule the window" },
    );
    if (!created) return;
    setName("");
    setPicked(new Set());
  }

  async function end(id: string, label: string) {
    const ok = await confirm({
      title: `End “${label}” now?`,
      description:
        "Alerts resume right away. A monitor that is still down opens its incident on its next failed check.",
      confirmLabel: "End maintenance",
    });
    if (!ok) return;
    await run(
      `win:${id}`,
      async () => {
        await unwrap(api.maintenance({ id }).end.post());
        await Promise.all([windows.mutate(), monitors.mutate()]);
      },
      { success: "Maintenance ended", error: "Couldn't end the window" },
    );
  }

  async function remove(id: string, label: string, phase: string) {
    const ok = await confirm({
      title: phase === "upcoming" ? `Cancel “${label}”?` : `Delete “${label}”?`,
      description:
        phase === "active"
          ? "Deleting a window in progress ends it right away and removes it from the history."
          : "It is removed from the list.",
      confirmLabel: phase === "upcoming" ? "Cancel maintenance" : "Delete",
      destructive: true,
    });
    if (!ok) return;
    await run(
      `win:${id}`,
      async () => {
        const { error } = await api.maintenance({ id }).delete();
        if (error) throw new Error("Could not delete the window");
        await Promise.all([windows.mutate(), monitors.mutate()]);
      },
      { success: "Removed", error: "Couldn't remove the window" },
    );
  }

  const togglePick = (id: string, on: boolean) =>
    setPicked((p) => {
      const n = new Set(p);
      if (on) n.add(id);
      else n.delete(id);
      return n;
    });

  const invalid =
    !name.trim() ||
    !starts ||
    !ends ||
    new Date(ends) <= new Date(starts) ||
    (scope === "some" && picked.size === 0);

  return (
    <>
      <PageHeader
        title="Maintenance"
        description="Planned downtime. While a window is on, the monitors it covers keep running, but a failure doesn't open an incident or send an alert."
      />
      <ErrorNote error={windows.error} />
      {!can("admin") && <ViewOnlyNote what="maintenance windows" />}

      <div className="grid gap-4 lg:grid-cols-[1fr_22rem]">
        <Panel>
          <h2 className="mb-4 text-xl font-bold tracking-tight">Windows</h2>
          {windows.isLoading && !windows.data && <ListSkeleton rows={2} />}
          {windows.data?.length === 0 && (
            <EmptyState
              title="Nothing scheduled"
              body={
                can("admin")
                  ? "Schedule a window before you deploy, migrate or restart something, so the planned downtime doesn't page anyone."
                  : "An admin can schedule one."
              }
            />
          )}
          <ul className="divide-y">
            {windows.data?.map((w) => (
              <li key={w.id} className="flex flex-wrap items-start justify-between gap-3 py-4">
                <div className="min-w-0">
                  <p className="flex flex-wrap items-center gap-2 font-semibold">
                    {w.name}
                    <Badge variant={PHASE[w.phase].variant}>{PHASE[w.phase].label}</Badge>
                    {!w.showOnStatusPage && <Badge variant="outline">Not on status pages</Badge>}
                  </p>
                  <p className="text-muted-foreground text-sm">
                    {dateTime(w.startsAt)} to {dateTime(w.endsAt)}
                  </p>
                  <p className="text-muted-foreground mt-1 text-sm">
                    {w.allMonitors
                      ? "All monitors in this workspace"
                      : w.monitorIds.map(monitorName).join(", ")}
                  </p>
                </div>
                <Can min="admin">
                  <div className="flex items-center gap-2">
                    {w.phase === "active" && (
                      <Button
                        variant="outline"
                        size="sm"
                        loading={isPending(`win:${w.id}`)}
                        onClick={() => end(w.id, w.name)}
                      >
                        End now
                      </Button>
                    )}
                    <ActionMenu
                      label={`Actions for ${w.name}`}
                      actions={[
                        {
                          label: w.phase === "upcoming" ? "Cancel" : "Delete",
                          destructive: true,
                          onSelect: () => remove(w.id, w.name, w.phase),
                        },
                      ]}
                    />
                  </div>
                </Can>
              </li>
            ))}
          </ul>
        </Panel>

        <Can min="admin">
          <Panel className="h-fit">
            <h2 className="mb-4 text-xl font-bold tracking-tight">Schedule maintenance</h2>
            <form onSubmit={create} className="space-y-4">
              <Field
                label="Name"
                htmlFor="mw-name"
                hint="Shown on your status pages if you leave that on, so keep it customer-friendly."
              >
                <Input
                  id="mw-name"
                  value={name}
                  maxLength={100}
                  placeholder="Database upgrade"
                  onChange={(e) => setName(e.target.value)}
                  required
                />
              </Field>
              <Field label="Starts" htmlFor="mw-start" hint={`Your time (${timeZone}).`}>
                <Input
                  id="mw-start"
                  type="datetime-local"
                  value={starts}
                  onChange={(e) => setStarts(e.target.value)}
                  required
                />
              </Field>
              <Field label="Ends" htmlFor="mw-end" hint="At most 14 days long.">
                <Input
                  id="mw-end"
                  type="datetime-local"
                  value={ends}
                  onChange={(e) => setEnds(e.target.value)}
                  required
                />
              </Field>
              <Field label="Covers" htmlFor="mw-scope">
                <SelectField
                  id="mw-scope"
                  value={scope}
                  onValueChange={(v) => setScope(v)}
                  options={[
                    { value: "all", label: "All monitors" },
                    { value: "some", label: "Selected monitors" },
                  ]}
                />
              </Field>
              {scope === "some" && (
                <fieldset className="max-h-48 space-y-2 overflow-y-auto rounded-2xl border p-3">
                  <legend className="sr-only">Monitors covered</legend>
                  {monitors.data?.length === 0 && (
                    <p className="text-muted-foreground text-sm">No monitors yet.</p>
                  )}
                  {monitors.data?.map((m) => (
                    <label key={m.id} className="flex items-center gap-3 text-sm">
                      <Checkbox
                        checked={picked.has(m.id)}
                        onCheckedChange={(on) => togglePick(m.id, on === true)}
                      />
                      <span className="truncate">{m.name}</span>
                    </label>
                  ))}
                </fieldset>
              )}
              <label className="flex items-start justify-between gap-4 text-sm">
                <span>
                  <span className="font-semibold">Show on status pages</span>
                  <span className="text-muted-foreground block text-xs">
                    Affected services show as &ldquo;Maintenance&rdquo; and the window is announced
                    in advance.
                  </span>
                </span>
                <Switch
                  checked={show}
                  onCheckedChange={setShow}
                  aria-label="Show on status pages"
                />
              </label>
              <Button
                type="submit"
                className="w-full"
                size="lg"
                loading={isPending("create")}
                disabled={invalid}
              >
                Schedule
              </Button>
            </form>
          </Panel>
        </Can>
      </div>
    </>
  );
}
