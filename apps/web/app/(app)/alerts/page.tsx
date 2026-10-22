"use client";

import { Badge } from "@upzy/ui/components/badge";
import { Button } from "@upzy/ui/components/button";
import { Checkbox } from "@upzy/ui/components/checkbox";
import { Input } from "@upzy/ui/components/input";
import { toast } from "@upzy/ui/components/sonner";
import { Switch } from "@upzy/ui/components/switch";
import { useState } from "react";

import { ActionMenu } from "@/components/app/action-menu";
import { Can, ViewOnlyNote } from "@/components/app/can";
import { useConfirm } from "@/components/app/confirm";
import { SelectField } from "@/components/app/select-field";
import { EmptyState, ErrorNote, Field, ListSkeleton, PageHeader, Panel } from "@/components/app/ui";
import { useWorkspace } from "@/components/app/workspace";
import { api } from "@/lib/api";
import { useAction } from "@/lib/use-action";
import { unwrap, useApi } from "@/lib/use-api";

const KINDS = {
  email: {
    label: "Email",
    field: "to",
    placeholder: "oncall@example.com",
    type: "email",
    hint: "Sent from Upzy's mailer.",
  },
  slack: {
    label: "Slack",
    field: "url",
    placeholder: "https://hooks.slack.com/services/…",
    type: "url",
    hint: "An incoming webhook URL.",
  },
  discord: {
    label: "Discord",
    field: "url",
    placeholder: "https://discord.com/api/webhooks/…",
    type: "url",
    hint: "A channel webhook URL.",
  },
  webhook: {
    label: "Webhook",
    field: "url",
    placeholder: "https://example.com/hooks/upzy",
    type: "url",
    hint: "We POST JSON, signed with an HMAC secret.",
  },
} as const;
type Kind = keyof typeof KINDS;

type EventName = "incident.opened" | "incident.resolved" | "finding.opened";
const EVENT_LABELS: Record<EventName, string> = {
  "incident.opened": "down",
  "incident.resolved": "recovery",
  "finding.opened": "new critical/high findings",
};
const ALL_EVENTS: EventName[] = ["incident.opened", "incident.resolved", "finding.opened"];

export default function AlertsPage() {
  const { workspace, can } = useWorkspace();
  const confirm = useConfirm();
  const { run, isPending } = useAction();
  const [kind, setKind] = useState<Kind>("email");
  const [secret, setSecret] = useState<{ name: string; value: string } | null>(null);

  const channels = useApi(`channels:${workspace.id}`, () =>
    unwrap(api.channel.get({ query: { workspaceId: workspace.id } })),
  );
  const rules = useApi(`rules:${workspace.id}`, () =>
    unwrap(api["alert-rule"].get({ query: { workspaceId: workspace.id } })),
  );
  const monitors = useApi(`monitors:${workspace.id}`, () =>
    unwrap(api.monitor.get({ query: { workspaceId: workspace.id } })),
  );

  const channelName = (id: string) =>
    channels.data?.find((c) => c.id === id)?.name ?? "Unknown channel";
  const monitorName = (id: string | null) =>
    id ? (monitors.data?.find((m) => m.id === id)?.name ?? "Unknown monitor") : "All monitors";

  async function createChannel(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const f = new FormData(form);
    const created = await run(
      "create-channel",
      async () => {
        const spec = KINDS[kind];
        const body = {
          workspaceId: workspace.id,
          name: String(f.get("name")).trim(),
          kind,
          [spec.field]: String(f.get("target")).trim(),
        };
        const c = (await unwrap(api.channel.post(body as never))) as {
          id: string;
          name: string;
          secret?: string;
        };
        // New channels notify about everything workspace-wide; narrow or remove the rule below.
        await unwrap(
          api["alert-rule"].post({
            workspaceId: workspace.id,
            channelId: c.id,
            events: ALL_EVENTS,
          } as never),
        );
        await Promise.all([channels.mutate(), rules.mutate()]);
        return c;
      },
      { success: (c) => `Channel “${c.name}” added`, error: "Couldn't add the channel" },
    );
    if (!created) return;
    if (created.secret) setSecret({ name: created.name, value: created.secret });
    form.reset();
  }

  async function testChannel(id: string, name: string) {
    const loadingId = toast.loading(`Sending a test to ${name}…`);
    const { data, error } = await api.channel({ id }).test.post();
    const v = (error?.value ?? data) as { ok?: boolean; queued?: boolean; error?: string } | null;
    if (v?.queued)
      toast.info("Test email queued", {
        id: loadingId,
        description: "It should arrive in a moment.",
      });
    else if (v?.ok) toast.success(`Test delivered to ${name}`, { id: loadingId });
    else
      toast.error(`Test to ${name} failed`, {
        id: loadingId,
        description: v?.error ?? "Unknown error",
      });
  }

  const toggleChannel = (id: string, enabled: boolean) =>
    run(
      `channel:${id}`,
      async () => {
        await unwrap(api.channel({ id }).patch({ enabled }));
        await channels.mutate();
      },
      {
        success: enabled ? "Channel enabled" : "Channel disabled",
        error: "Couldn't update the channel",
      },
    );

  async function deleteChannel(id: string, name: string) {
    const ok = await confirm({
      title: `Delete channel “${name}”?`,
      description: "Alert rules that use it are deleted too.",
      confirmLabel: "Delete channel",
      destructive: true,
    });
    if (!ok) return;
    await run(
      `channel:${id}`,
      async () => {
        const { error } = await api.channel({ id }).delete();
        if (error) throw new Error("Could not delete the channel");
        await Promise.all([channels.mutate(), rules.mutate()]);
      },
      { success: "Channel deleted" },
    );
  }

  const toggleRule = (id: string, enabled: boolean) =>
    run(
      `rule:${id}`,
      () =>
        rules.mutate(
          async (current) => {
            await unwrap(api["alert-rule"]({ id }).patch({ enabled }));
            return current?.map((r) => (r.id === id ? { ...r, enabled } : r));
          },
          {
            optimisticData: (current) =>
              current?.map((r) => (r.id === id ? { ...r, enabled } : r)) ?? [],
            rollbackOnError: true,
            revalidate: false,
          },
        ),
      { success: enabled ? "Rule resumed" : "Rule paused", error: "Couldn't update the rule" },
    );

  const deleteRule = (id: string) =>
    run(
      `rule:${id}`,
      async () => {
        const { error } = await api["alert-rule"]({ id }).delete();
        if (error) throw new Error("Could not delete the rule");
        await rules.mutate();
      },
      { success: "Rule deleted" },
    );

  return (
    <>
      <PageHeader
        title="Alerts"
        description="Choose where Upzy tells you when something goes down or recovers."
      />
      <ErrorNote error={channels.error ?? rules.error} />
      {!can("admin") && <ViewOnlyNote what="alert channels and rules" />}

      {secret && (
        <div role="status" className="bg-accent/60 mb-4 rounded-3xl border p-5">
          <p className="font-semibold">Signing secret for “{secret.name}”</p>
          <p className="text-muted-foreground mt-1 text-sm">
            Copy it now. It won&rsquo;t be shown again. Verify the{" "}
            <code className="font-mono">Upzy-Signature</code> header with it.
          </p>
          <code className="bg-card mt-3 block overflow-x-auto rounded-2xl px-4 py-3 font-mono text-sm">
            {secret.value}
          </code>
          <div className="mt-3 flex gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={async () => {
                await navigator.clipboard.writeText(secret.value);
                toast.success("Secret copied");
              }}
            >
              Copy secret
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setSecret(null)}>
              I&rsquo;ve saved it
            </Button>
          </div>
        </div>
      )}

      <div className="grid gap-4 lg:grid-cols-[1fr_22rem]">
        <div className="space-y-4">
          <Panel>
            <h2 className="mb-4 text-xl font-bold tracking-tight">Channels</h2>
            {channels.isLoading && !channels.data && <ListSkeleton rows={2} />}
            {channels.data?.length === 0 && (
              <EmptyState
                title="No channels yet"
                body={
                  can("admin")
                    ? "Add one on the right to start getting alerts."
                    : "An admin can add one to start getting alerts."
                }
              />
            )}
            <ul className="divide-y">
              {channels.data?.map((c) => (
                <li key={c.id} className="flex flex-wrap items-center justify-between gap-3 py-3">
                  <div className="min-w-0">
                    <p className="flex items-center gap-2 font-semibold">
                      {c.name}
                      <Badge variant="secondary">{KINDS[c.kind].label}</Badge>
                      {!c.enabled && <Badge variant="outline">Disabled</Badge>}
                    </p>
                    <p className="text-muted-foreground truncate text-sm">{c.summary}</p>
                  </div>
                  <Can min="admin">
                    <div className="flex items-center gap-2">
                      <Switch
                        aria-label={`${c.name} enabled`}
                        checked={c.enabled}
                        disabled={isPending(`channel:${c.id}`)}
                        onCheckedChange={(on) => toggleChannel(c.id, on)}
                      />
                      <Button variant="outline" size="sm" onClick={() => testChannel(c.id, c.name)}>
                        Send test
                      </Button>
                      <ActionMenu
                        label={`Actions for ${c.name}`}
                        actions={[
                          {
                            label: "Delete channel",
                            destructive: true,
                            onSelect: () => deleteChannel(c.id, c.name),
                          },
                        ]}
                      />
                    </div>
                  </Can>
                </li>
              ))}
            </ul>
          </Panel>

          <Panel>
            <h2 className="mb-1 text-xl font-bold tracking-tight">Rules</h2>
            <p className="text-muted-foreground mb-4 text-sm">
              Which monitors notify which channel.
            </p>
            {rules.isLoading && !rules.data && <ListSkeleton rows={2} />}
            {rules.data?.length === 0 && (
              <p className="text-muted-foreground text-sm">
                No rules. Channels without a rule never fire.
              </p>
            )}
            <ul className="divide-y">
              {rules.data?.map((r) => (
                <li
                  key={r.id}
                  className="flex flex-wrap items-center justify-between gap-3 py-3 text-sm"
                >
                  <span>
                    <span className="font-semibold">{monitorName(r.monitorId)}</span> →{" "}
                    {channelName(r.channelId)}
                    <span className="text-muted-foreground block text-xs">
                      {r.events.map((e) => EVENT_LABELS[e]).join(" + ")}
                      {!r.enabled && " · paused"}
                    </span>
                  </span>
                  <Can min="admin">
                    <div className="flex items-center gap-2">
                      <Switch
                        aria-label="Rule enabled"
                        checked={r.enabled}
                        disabled={isPending(`rule:${r.id}`)}
                        onCheckedChange={(on) => toggleRule(r.id, on)}
                      />
                      <ActionMenu
                        label="Actions for this rule"
                        actions={[
                          {
                            label: "Delete rule",
                            destructive: true,
                            onSelect: () => deleteRule(r.id),
                          },
                        ]}
                      />
                    </div>
                  </Can>
                </li>
              ))}
            </ul>
            {can("admin") && channels.data && channels.data.length > 0 && (
              <RuleForm
                channels={channels.data}
                monitors={monitors.data ?? []}
                pending={isPending("create-rule")}
                onSubmit={(channelId, monitorId, events) =>
                  run(
                    "create-rule",
                    async () => {
                      await unwrap(
                        api["alert-rule"].post({
                          workspaceId: workspace.id,
                          channelId,
                          monitorId,
                          events,
                        } as never),
                      );
                      await rules.mutate();
                    },
                    { success: "Rule added", error: "Couldn't add the rule" },
                  )
                }
              />
            )}
          </Panel>
        </div>

        <Can min="admin">
          <Panel className="h-fit">
            <h2 className="mb-4 text-xl font-bold tracking-tight">Add channel</h2>
            <form onSubmit={createChannel} className="space-y-4">
              <Field label="Type" htmlFor="kind">
                <SelectField
                  id="kind"
                  value={kind}
                  onValueChange={setKind}
                  options={(Object.keys(KINDS) as Kind[]).map((k) => ({
                    value: k,
                    label: KINDS[k].label,
                  }))}
                />
              </Field>
              <Field label="Name" htmlFor="name">
                <Input id="name" name="name" placeholder="On-call" required maxLength={100} />
              </Field>
              <Field
                label={kind === "email" ? "Address" : "URL"}
                htmlFor="target"
                hint={KINDS[kind].hint}
              >
                <Input
                  id="target"
                  name="target"
                  key={kind}
                  type={KINDS[kind].type}
                  placeholder={KINDS[kind].placeholder}
                  required
                />
              </Field>
              <Button type="submit" className="w-full" loading={isPending("create-channel")}>
                Add channel
              </Button>
            </form>
          </Panel>
        </Can>
      </div>
    </>
  );
}

function RuleForm({
  channels,
  monitors,
  pending,
  onSubmit,
}: {
  channels: { id: string; name: string }[];
  monitors: { id: string; name: string }[];
  pending: boolean;
  onSubmit: (channelId: string, monitorId: string | null, events: EventName[]) => void;
}) {
  const [channelId, setChannelId] = useState(channels[0]!.id);
  const [monitorId, setMonitorId] = useState("all");
  const [events, setEvents] = useState<Record<EventName, boolean>>({
    "incident.opened": true,
    "incident.resolved": true,
    "finding.opened": true,
  });
  // Security findings belong to the workspace, not a monitor.
  const findingsAllowed = monitorId === "all";
  const chosen = ALL_EVENTS.filter((e) => events[e] && (e !== "finding.opened" || findingsAllowed));
  const labels: Record<EventName, string> = {
    "incident.opened": "Down",
    "incident.resolved": "Recovered",
    "finding.opened": "New critical/high findings",
  };

  return (
    <form
      className="mt-5 space-y-3 border-t pt-5"
      onSubmit={(e) => {
        e.preventDefault();
        if (chosen.length > 0) onSubmit(channelId, monitorId === "all" ? null : monitorId, chosen);
      }}
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <SelectField
          aria-label="Channel"
          value={channelId}
          onValueChange={setChannelId}
          options={channels.map((c) => ({ value: c.id, label: c.name }))}
        />
        <SelectField
          aria-label="Monitor"
          value={monitorId}
          onValueChange={setMonitorId}
          options={[
            { value: "all", label: "All monitors" },
            ...monitors.map((m) => ({ value: m.id, label: m.name })),
          ]}
        />
      </div>
      <fieldset className="flex flex-wrap gap-x-5 gap-y-2 text-sm">
        <legend className="sr-only">Notify on</legend>
        {ALL_EVENTS.map((ev) => {
          const disabled = ev === "finding.opened" && !findingsAllowed;
          return (
            <label key={ev} className={`flex items-center gap-2 ${disabled ? "opacity-50" : ""}`}>
              <Checkbox
                checked={events[ev] && !disabled}
                disabled={disabled}
                onCheckedChange={(on) => setEvents((s) => ({ ...s, [ev]: on }))}
              />
              {labels[ev]}
            </label>
          );
        })}
      </fieldset>
      <Button type="submit" disabled={chosen.length === 0} loading={pending}>
        Add rule
      </Button>
    </form>
  );
}
