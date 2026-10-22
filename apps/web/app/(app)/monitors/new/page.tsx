"use client";

import { Button } from "@upzy/ui/components/button";
import { Input } from "@upzy/ui/components/input";
import { toast } from "@upzy/ui/components/sonner";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { ViewOnlyNote } from "@/components/app/can";
import { FlowSteps, HeartbeatFields, HttpOptions } from "@/components/app/monitor-fields";
import { SelectField } from "@/components/app/select-field";
import { BackLink, Field, PageHeader, Panel } from "@/components/app/ui";
import { useWorkspace } from "@/components/app/workspace";
import { api } from "@/lib/api";
import {
  configOf,
  emptyDraft,
  secretsForCreate,
  type Draft,
  type MonitorKind,
} from "@/lib/monitor-form";
import { errorMessage, useAction } from "@/lib/use-action";
import { unwrap, useApi } from "@/lib/use-api";

const TYPES = {
  http: {
    label: "HTTP(S)",
    placeholder: "https://example.com/health",
    hint: "We request this URL and expect a 2xx/3xx response.",
  },
  flow: {
    label: "API flow (several requests)",
    placeholder: "",
    hint: "Log in, then call an endpoint with the token it returned: the steps run in order.",
  },
  heartbeat: {
    label: "Heartbeat (cron job or worker)",
    placeholder: "",
    hint: "Your job calls a web address when it finishes. You're alerted if it stops.",
  },
  tcp: { label: "TCP port", placeholder: "db.example.com:5432", hint: "Format host:port." },
  dns: {
    label: "DNS",
    placeholder: "example.com",
    hint: "A hostname that should resolve to an address.",
  },
  ssl: {
    label: "SSL certificate",
    placeholder: "example.com",
    hint: "Fails if the certificate is invalid or expired.",
  },
} as const satisfies Record<MonitorKind, { label: string; placeholder: string; hint: string }>;
type Type = keyof typeof TYPES;

export default function NewMonitorPage() {
  const router = useRouter();
  const { workspace, can } = useWorkspace();
  const [d, setD] = useState<Draft>(emptyDraft);
  const set = (patch: Partial<Draft>) => setD((x) => ({ ...x, ...patch }));
  const [busy, setBusy] = useState(false);
  const [idea, setIdea] = useState("");
  const [draft, setDraft] = useState<{
    model: string;
    unsupported: string[];
    rationale: string;
  } | null>(null);
  const ai = useApi("ai-settings", () => unwrap(api.ai.settings.get()));
  const { run, isPending } = useAction();

  /** Fills the form from the model's draft. The person still reviews and submits: nothing is created here. */
  const askAi = async () => {
    const r = await run(
      "draft",
      async () =>
        (await unwrap(api.ai["monitor-draft"].post({ workspaceId: workspace.id, text: idea }))) as {
          draft: {
            name: string;
            type: Type;
            target: string;
            interval: number;
            failureThreshold: number;
            config: { keyword?: string };
          };
          unsupported: string[];
          rationale: string;
          model: string;
        },
      { error: "Couldn't draft the monitor" },
    );
    if (!r) return;
    set({
      name: r.draft.name,
      type: r.draft.type,
      target: r.draft.target,
      keyword: r.draft.config.keyword ?? "",
      every: String(r.draft.interval),
      threshold: String(r.draft.failureThreshold),
    });
    setDraft({ model: r.model, unsupported: r.unsupported, rationale: r.rationale });
    toast.success("Draft ready", {
      description: "Review every field before creating the monitor.",
    });
  };

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    try {
      const body = {
        workspaceId: workspace.id,
        name: d.name.trim(),
        type: d.type,
        ...(d.type === "flow" || d.type === "heartbeat" ? {} : { target: d.target.trim() }),
        interval: d.type === "heartbeat" ? 60 : Number(d.every),
        failureThreshold: d.type === "heartbeat" ? 1 : Number(d.threshold),
        active: true,
        config: configOf(d),
        secrets: d.type === "http" || d.type === "flow" ? secretsForCreate(d.secrets) : {},
      };
      const created = await unwrap(api.monitor.post(body as never));
      toast.success("Monitor created", {
        description:
          d.type === "heartbeat"
            ? "Copy its ping address on the next page into your job."
            : "The first check runs within a minute.",
      });
      router.push(`/monitors/${(created as { id: string }).id}`);
    } catch (err) {
      toast.error("Couldn't create the monitor", { description: errorMessage(err) });
      setBusy(false);
    }
  }

  if (!can("member")) {
    return (
      <div className="mx-auto max-w-xl">
        <BackLink href="/monitors">Monitors</BackLink>
        <ViewOnlyNote what="monitors" />
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-2xl">
      <BackLink href="/monitors">Monitors</BackLink>
      <PageHeader title="New monitor" />
      {ai.data?.enabled && (
        <Panel className="mb-4">
          <h2 className="text-lg font-bold tracking-tight">Describe it instead</h2>
          <p className="text-muted-foreground mt-1 mb-3 text-sm">
            For example: “check shop.example.com/checkout every minute and tell me if it says ‘Add
            to cart’ is missing”. AI fills in the form below; you review it before anything is
            created.
          </p>
          <label htmlFor="idea" className="sr-only">
            Describe the monitor you want
          </label>
          <textarea
            id="idea"
            value={idea}
            onChange={(e) => setIdea(e.target.value)}
            maxLength={1000}
            rows={3}
            placeholder="What should Upzy watch, and how often?"
            className="border-input focus-visible:ring-ring w-full resize-y rounded-2xl border bg-transparent px-4 py-3 text-sm outline-hidden focus-visible:ring-1"
          />
          <div className="mt-3 flex items-center justify-between gap-3">
            <span className="text-muted-foreground text-xs">{idea.length}/1000</span>
            <Button
              variant="outline"
              loading={isPending("draft")}
              disabled={idea.trim().length < 5}
              onClick={askAi}
            >
              Draft with AI
            </Button>
          </div>
          {draft && (
            <div role="status" className="bg-accent/50 mt-4 space-y-2 rounded-2xl p-4 text-sm">
              <p>
                <strong>AI draft</strong>{" "}
                <span className="text-muted-foreground">({draft.model})</span>: {draft.rationale}
              </p>
              {draft.unsupported.length > 0 && (
                <p className="text-muted-foreground">
                  Not something a monitor can do yet: {draft.unsupported.join("; ")}.
                </p>
              )}
            </div>
          )}
        </Panel>
      )}
      <Panel>
        <form onSubmit={onSubmit} className="space-y-5">
          <Field label="Name" htmlFor="name">
            <Input
              id="name"
              name="name"
              value={d.name}
              onChange={(e) => set({ name: e.target.value })}
              placeholder="Marketing site"
              required
              maxLength={100}
            />
          </Field>
          <Field label="Type" htmlFor="type" hint={TYPES[d.type].hint}>
            <SelectField
              id="type"
              value={d.type}
              onValueChange={(type) => set({ type })}
              options={Object.entries(TYPES).map(([k, v]) => ({
                value: k as Type,
                label: v.label,
              }))}
            />
          </Field>
          {d.type !== "flow" && d.type !== "heartbeat" && (
            <Field label="Target" htmlFor="target">
              <Input
                id="target"
                name="target"
                value={d.target}
                onChange={(e) => set({ target: e.target.value })}
                placeholder={TYPES[d.type].placeholder}
                required
              />
            </Field>
          )}
          {d.type === "http" && (
            <>
              <Field
                label="Must contain (optional)"
                htmlFor="keyword"
                hint="The check fails if this text is missing from the page."
              >
                <Input
                  id="keyword"
                  name="keyword"
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
            </div>
          )}
          <Button type="submit" size="lg" className="w-full" loading={busy}>
            Create monitor
          </Button>
        </form>
      </Panel>
    </div>
  );
}
