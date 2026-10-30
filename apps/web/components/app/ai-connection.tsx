"use client";

import { Badge } from "@upzy/ui/components/badge";
import { Button } from "@upzy/ui/components/button";
import { Input } from "@upzy/ui/components/input";
import { toast } from "@upzy/ui/components/sonner";
import { useState } from "react";

import { useConfirm } from "@/components/app/confirm";
import { ProviderMark } from "@/components/app/provider-mark";
import { SelectField } from "@/components/app/select-field";
import { Field } from "@/components/app/ui";
import { api } from "@/lib/api";
import { timeAgo } from "@/lib/format";
import { useAction } from "@/lib/use-action";
import { unwrap, useApi } from "@/lib/use-api";

interface CatalogModel {
  provider: string;
  id: string;
  label: string;
  inputPerM: number;
  outputPerM: number;
  tier: "fast" | "smart";
  free?: boolean;
}
export interface Connection {
  fastModel: string | null;
  smartModel: string | null;
  credentials: { provider: string; hint: string; lastUsedAt: string | Date | null }[];
  catalog: {
    pricesAsOf: string;
    providers: { id: string; label: string; keysUrl: string }[];
    models: CatalogModel[];
  };
  active: {
    fast: { model: string | null; ready: boolean };
    smart: { model: string | null; ready: boolean };
  };
}

const NOT_CHAT =
  /embed|whisper|tts|dall-e|moderation|image|audio|realtime|transcribe|guard|imagen|veo/i;
const price = (n: number) => `$${n}`;
const optionLabel = (m: CatalogModel) =>
  m.free ? "free" : `${price(m.inputPerM)} in / ${price(m.outputPerM)} out per 1M`;

/** The organization's own provider keys and model choices: the only way AI gets a key. */
export function AiConnection({ data, onChange }: { data: Connection; onChange: () => unknown }) {
  const confirm = useConfirm();
  const { run, isPending } = useAction();
  const [adding, setAdding] = useState<string | null>(null);
  const [apiKey, setApiKey] = useState("");
  const [smart, setSmart] = useState(data.smartModel ?? "");
  const [fast, setFast] = useState(data.fastModel ?? "");
  const [custom, setCustom] = useState("");
  // What each saved key can really use, from the provider: models retire, so the list below follows it.
  const live = useApi("ai-models", () => unwrap(api.ai.models.get()));

  const providerLabel = (id: string) =>
    data.catalog.providers.find((p) => p.id === id)?.label ?? id;
  const liveFor = (provider: string) => live.data?.[provider];
  const known = new Set(data.catalog.models.map((m) => `${m.provider}:${m.id}`));
  const connected = new Set(data.credentials.map((c) => c.provider));
  const options = [
    { value: "", label: "Automatic (recommended)" },
    // Only models of providers that have a saved key, and of those only the ones the key can use.
    ...data.catalog.models
      .filter((m) => {
        if (!connected.has(m.provider)) return false;
        const l = liveFor(m.provider);
        return !l || l.length === 0 || l.includes(m.id);
      })
      .map((m) => ({
        value: `${m.provider}:${m.id}`,
        label: `${m.label} · ${optionLabel(m)}`,
        icon: <ProviderMark provider={m.provider} />,
      })),
    // Chat models the key can use that we don't have a price for (not embeddings, speech or image models).
    ...Object.entries(live.data ?? {})
      .filter(([provider]) => connected.has(provider))
      .flatMap(([provider, ids]) =>
        ids
          .filter((id) => !known.has(`${provider}:${id}`) && !NOT_CHAT.test(id))
          .slice(0, 40)
          .map((id) => ({
            value: `${provider}:${id}`,
            label: `${id} (price unknown)`,
            icon: <ProviderMark provider={provider} />,
          })),
      ),
  ];
  // A custom id typed earlier must stay selectable, otherwise the picker would show a blank value.
  const withCurrent = (current: string) =>
    current && !options.some((o) => o.value === current)
      ? [...options, { value: current, label: `${current} (custom, price unknown)` }]
      : options;

  async function saveKey(provider: string) {
    const r = await run(
      `key:${provider}`,
      async () => {
        const saved = (await unwrap(api.ai.credentials({ provider }).put({ apiKey }))) as {
          unavailable: string[];
          automatic: { fast: string | null; smart: string | null };
        };
        await Promise.all([onChange(), live.mutate()]);
        return saved;
      },
      { error: "Couldn't save the key" },
    );
    if (!r) return;
    setAdding(null);
    setApiKey("");
    const use = [...new Set(Object.values(r.automatic ?? {}).filter(Boolean))];
    if (use.length > 0) {
      // Say which model "Automatic" will run, so it isn't a surprise; warn about catalog models this key can't use.
      toast.success(`${providerLabel(provider)} key saved`, {
        description:
          `Automatic will use ${use.join(" and ")}.` +
          (r.unavailable.length > 0
            ? ` Not available to this key: ${r.unavailable.join(", ")}.`
            : ""),
        duration: 8_000,
      });
    } else toast.success(`${providerLabel(provider)} key saved`);
  }

  async function removeKey(provider: string) {
    const yes = await confirm({
      title: `Remove the ${providerLabel(provider)} key?`,
      description: "Upzy deletes it immediately. You can add it again at any time.",
      confirmLabel: "Remove key",
      destructive: true,
    });
    if (!yes) return;
    await run(
      `del:${provider}`,
      async () => {
        await unwrap(api.ai.credentials({ provider }).delete());
        await Promise.all([onChange(), live.mutate()]);
      },
      { success: "Key removed", error: "Couldn't remove the key" },
    );
  }

  const saveModels = () =>
    run(
      "models",
      async () => {
        await unwrap(
          api.ai.settings.patch({
            smartModel: custom.trim() || smart || null,
            fastModel: fast || null,
          }),
        );
        setCustom("");
        await onChange();
      },
      { success: "Models updated", error: "Couldn't change the models" },
    );

  const dirty =
    smart !== (data.smartModel ?? "") || fast !== (data.fastModel ?? "") || custom.trim() !== "";

  return (
    <div className="space-y-6">
      <section aria-labelledby="keys-h">
        <h3 id="keys-h" className="mb-1 font-bold tracking-tight">
          Your API keys
        </h3>
        <p className="text-muted-foreground mb-3 text-sm">
          Keys are checked with a tiny test request, encrypted before they are stored, and never
          shown again. Calls go straight to your provider and are billed to your account.
        </p>
        <ul className="divide-y rounded-2xl border">
          {data.catalog.providers.map((p) => {
            const saved = data.credentials.find((c) => c.provider === p.id);
            const open = adding === p.id;
            return (
              <li key={p.id} className="px-4 py-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex items-center gap-2 text-sm">
                    <ProviderMark provider={p.id} />
                    <span className="font-semibold">{p.label}</span>
                    {saved ? <Badge>Connected</Badge> : <Badge variant="outline">No key</Badge>}
                    {saved && (
                      <span className="text-muted-foreground font-mono text-xs">
                        ••••{saved.hint}
                        {saved.lastUsedAt ? ` · used ${timeAgo(saved.lastUsedAt)}` : ""}
                      </span>
                    )}
                  </div>
                  <div className="flex gap-1">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => {
                        setAdding(open ? null : p.id);
                        setApiKey("");
                      }}
                    >
                      {open ? "Cancel" : saved ? "Replace" : "Add key"}
                    </Button>
                    {saved && (
                      <Button
                        variant="ghost"
                        size="sm"
                        loading={isPending(`del:${p.id}`)}
                        onClick={() => removeKey(p.id)}
                      >
                        Remove
                      </Button>
                    )}
                  </div>
                </div>
                {open && (
                  <form
                    className="mt-3 flex flex-col gap-2 sm:flex-row sm:items-end"
                    onSubmit={(e) => {
                      e.preventDefault();
                      void saveKey(p.id);
                    }}
                  >
                    <div className="flex-1">
                      <Field
                        label={`${p.label} API key`}
                        htmlFor={`key-${p.id}`}
                        hint={
                          <a
                            href={p.keysUrl}
                            target="_blank"
                            rel="noreferrer noopener"
                            className="underline"
                          >
                            Create one in the {p.label} console
                          </a>
                        }
                      >
                        <Input
                          id={`key-${p.id}`}
                          type="password"
                          autoComplete="off"
                          spellCheck={false}
                          value={apiKey}
                          onChange={(e) => setApiKey(e.target.value)}
                          placeholder="Paste your key"
                          required
                          minLength={8}
                        />
                      </Field>
                    </div>
                    <Button type="submit" loading={isPending(`key:${p.id}`)}>
                      Verify and save
                    </Button>
                  </form>
                )}
              </li>
            );
          })}
        </ul>
      </section>

      <section aria-labelledby="models-h" className="space-y-4">
        <div>
          <h3 id="models-h" className="mb-1 font-bold tracking-tight">
            Models
          </h3>
          <p className="text-muted-foreground text-sm">
            Prices are list prices as of {data.catalog.pricesAsOf}; your provider&rsquo;s bill is
            the source of truth. Only models your saved keys can use are listed.
          </p>
          {connected.size === 0 && (
            <p className="text-muted-foreground mt-2 rounded-xl border border-dashed p-3 text-sm">
              Add an API key above to choose a model. OpenRouter&rsquo;s &ldquo;Free models&rdquo;
              option costs nothing, but free models can log what you send and are rate limited.
            </p>
          )}
        </div>
        <Field
          label="Main model"
          htmlFor="smart-model"
          hint="Used for finding explanations and the weekly digest."
        >
          <SelectField
            id="smart-model"
            value={smart}
            onValueChange={setSmart}
            options={withCurrent(smart)}
          />
        </Field>
        <Field label="Quick-task model" htmlFor="fast-model" hint="Used for monitor drafts.">
          <SelectField
            id="fast-model"
            value={fast}
            onValueChange={setFast}
            options={withCurrent(fast)}
          />
        </Field>
        <Field
          label="Or enter any model ID for the main model"
          htmlFor="custom-model"
          hint="Format provider:model, e.g. openai:gpt-4.1. Its cost is shown as unknown unless it is in the list above."
        >
          <Input
            id="custom-model"
            value={custom}
            onChange={(e) => setCustom(e.target.value)}
            placeholder="openai:my-fine-tune"
          />
        </Field>
        <div className="flex items-center justify-between gap-3">
          <div className="text-muted-foreground flex flex-col gap-1 text-xs">
            <span className="font-medium">Running now</span>
            {(
              [
                ["Main", data.active.smart],
                ["Quick", data.active.fast],
              ] as const
            ).map(([role, a]) => (
              <span key={role} className="flex items-center gap-2">
                {a.model && <ProviderMark provider={a.model.split(":")[0]!} className="size-5" />}
                <span className="font-mono">{a.model ?? "not set"}</span> ({role})
                {!a.ready && <span className="text-destructive">· a key is missing</span>}
              </span>
            ))}
          </div>
          <Button loading={isPending("models")} disabled={!dirty} onClick={saveModels}>
            Save models
          </Button>
        </div>
      </section>
    </div>
  );
}
