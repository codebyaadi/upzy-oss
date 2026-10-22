"use client";

import { Button } from "@upzy/ui/components/button";
import { Input } from "@upzy/ui/components/input";
import { toast } from "@upzy/ui/components/sonner";
import type { Route } from "next";
import { useParams, useRouter } from "next/navigation";
import { useEffect, useState } from "react";

import { ViewOnlyNote } from "@/components/app/can";
import { FlowSteps, HeartbeatFields, HttpOptions } from "@/components/app/monitor-fields";
import { SelectField } from "@/components/app/select-field";
import { BackLink, DetailSkeleton, ErrorNote, Field, PageHeader, Panel } from "@/components/app/ui";
import { useWorkspace } from "@/components/app/workspace";
import { api } from "@/lib/api";
import { configOf, draftOf, secretsForUpdate, type Draft } from "@/lib/monitor-form";
import { errorMessage } from "@/lib/use-action";
import { unwrap, useApi } from "@/lib/use-api";

/** Edits a monitor's settings, headers, checks and secrets. Its type and target can't change. */
export default function EditMonitorPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const { can } = useWorkspace();
  const monitor = useApi(`monitor:${id}:edit`, () => unwrap(api.monitor({ id }).get()), {
    refreshInterval: 0,
    revalidateOnFocus: false,
  });
  const [d, setD] = useState<Draft | null>(null);
  const [busy, setBusy] = useState(false);
  const set = (patch: Partial<Draft>) => setD((x) => (x ? { ...x, ...patch } : x));

  useEffect(() => {
    if (monitor.data && !d) setD(draftOf(monitor.data as never));
  }, [monitor.data, d]);

  if (!can("member"))
    return (
      <div className="mx-auto max-w-xl">
        <BackLink href={`/monitors/${id}` as Route}>Monitor</BackLink>
        <ViewOnlyNote what="monitors" />
      </div>
    );
  if (monitor.error) return <ErrorNote error={monitor.error} />;
  if (!d) return <DetailSkeleton />;

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (!d) return;
    setBusy(true);
    try {
      const heartbeat = d.type === "heartbeat";
      await unwrap(
        api.monitor({ id }).patch({
          name: d.name.trim(),
          ...(heartbeat
            ? {}
            : {
                interval: Number(d.every),
                failureThreshold: Number(d.threshold),
                latencyThresholdMs: d.slowMs.trim() ? Number(d.slowMs) : null,
              }),
          config: configOf(d),
          ...(d.type === "http" || d.type === "flow"
            ? { secrets: secretsForUpdate(d.secrets) }
            : {}),
        } as never),
      );
      toast.success("Monitor updated");
      router.push(`/monitors/${id}` as Route);
    } catch (err) {
      toast.error("Couldn't save the monitor", { description: errorMessage(err) });
      setBusy(false);
    }
  }

  return (
    <div className="mx-auto max-w-2xl">
      <BackLink href={`/monitors/${id}` as Route}>{d.name || "Monitor"}</BackLink>
      <PageHeader title="Edit monitor" />
      <Panel>
        <form onSubmit={save} className="space-y-5">
          <Field label="Name" htmlFor="name">
            <Input
              id="name"
              value={d.name}
              onChange={(e) => set({ name: e.target.value })}
              required
              maxLength={100}
            />
          </Field>
          <p className="text-muted-foreground text-sm">
            <span className="uppercase">{d.type}</span>
            {d.type !== "flow" && d.type !== "heartbeat" && <> · {d.target}</>}. The type and
            address can&apos;t be changed: create a new monitor for a different one.
          </p>
          {d.type === "http" && (
            <>
              <Field label="Must contain (optional)" htmlFor="keyword">
                <Input
                  id="keyword"
                  value={d.keyword}
                  onChange={(e) => set({ keyword: e.target.value })}
                  maxLength={200}
                />
              </Field>
              <HttpOptions d={d} set={set} />
            </>
          )}
          {d.type === "flow" && <FlowSteps d={d} set={set} />}
          {d.type === "heartbeat" ? (
            <HeartbeatFields d={d} set={set} />
          ) : (
            <div className="grid gap-5 sm:grid-cols-2">
              <Field label="Check every" htmlFor="interval">
                <SelectField
                  id="interval"
                  value={d.every}
                  onValueChange={(every) => set({ every })}
                  options={[
                    { value: "60", label: "1 minute" },
                    { value: "300", label: "5 minutes" },
                    { value: "600", label: "10 minutes" },
                    { value: "1800", label: "30 minutes" },
                    { value: "3600", label: "1 hour" },
                  ]}
                />
              </Field>
              <Field
                label="Down after"
                htmlFor="failureThreshold"
                hint="Consecutive failed checks."
              >
                <SelectField
                  id="failureThreshold"
                  value={d.threshold}
                  onValueChange={(threshold) => set({ threshold })}
                  options={[1, 2, 3, 5].map((n) => ({
                    value: String(n),
                    label: `${n} ${n === 1 ? "failure" : "failures"}`,
                  }))}
                />
              </Field>
              <Field
                label="Degraded when slower than"
                htmlFor="slowMs"
                hint="Milliseconds. After three slow checks in a row the monitor shows as degraded; it never raises an incident. Leave empty to turn this off."
              >
                <Input
                  id="slowMs"
                  inputMode="numeric"
                  placeholder="e.g. 1500"
                  value={d.slowMs}
                  onChange={(e) => set({ slowMs: e.target.value.replace(/[^0-9]/g, "") })}
                />
              </Field>
            </div>
          )}
          <div className="flex gap-2">
            <Button type="submit" size="lg" loading={busy}>
              Save changes
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="lg"
              onClick={() => router.push(`/monitors/${id}` as Route)}
            >
              Cancel
            </Button>
          </div>
        </form>
      </Panel>
    </div>
  );
}
