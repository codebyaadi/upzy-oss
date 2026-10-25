"use client";

import { Button } from "@upzy/ui/components/button";
import { Input } from "@upzy/ui/components/input";
import { useState } from "react";

import { useConfirm } from "@/components/app/confirm";
import { ErrorNote, Field, Panel } from "@/components/app/ui";
import { api } from "@/lib/api";
import { timeAgo } from "@/lib/format";
import { useAction } from "@/lib/use-action";
import { unwrap, useApi } from "@/lib/use-api";

const SCOPES = [
  { id: "monitors:read", label: "Monitors", hint: "status, uptime, response times, certificates" },
  { id: "incidents:read", label: "Incidents", hint: "open and past incidents" },
  { id: "security:read", label: "Security", hint: "assets and findings" },
] as const;

/** Keys for the MCP server: let an AI assistant such as Claude Code read (never change) monitoring data. */
export function ApiKeysPanel({ orgId }: { orgId: string }) {
  const keys = useApi(`api-keys:${orgId}`, () => unwrap(api["api-keys"].get()));
  const { run, isPending } = useAction();
  const confirm = useConfirm();
  const [name, setName] = useState("");
  const [scopes, setScopes] = useState<string[]>(["monitors:read", "incidents:read"]);
  const [created, setCreated] = useState<string | null>(null);

  const toggle = (id: string) =>
    setScopes((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]));

  const create = (e: React.FormEvent) => {
    e.preventDefault();
    void run(
      "create",
      async () => {
        const k = await unwrap(
          api["api-keys"].post({
            name,
            expiresInDays: 90,
            scopes: scopes as ("monitors:read" | "incidents:read" | "security:read")[],
          }),
        );
        setCreated(k.key);
        setName("");
        await keys.mutate();
      },
      { error: "Couldn't create the key" },
    );
  };

  const revoke = async (id: string, keyName: string) => {
    if (
      !(await confirm({
        title: `Revoke "${keyName}"?`,
        description: "Anything using this key stops working straight away.",
        confirmLabel: "Revoke",
        destructive: true,
      }))
    )
      return;
    await run(
      `revoke:${id}`,
      async () => {
        await unwrap(api["api-keys"]({ id }).delete());
        await keys.mutate();
      },
      { success: "Key revoked", error: "Couldn't revoke it" },
    );
  };

  return (
    <Panel>
      <h2 className="text-xl font-bold tracking-tight">AI assistant access (MCP)</h2>
      <p className="text-muted-foreground mt-1 text-sm">
        Create a key so an assistant such as Claude Code can read your monitors, incidents and
        findings. Keys are read-only, act as you (so they see only what you can), and expire after
        90 days.
      </p>
      <ErrorNote error={keys.error} />

      {created && (
        <div className="mt-4 space-y-2 rounded-lg border p-3 text-sm">
          <p className="font-semibold">Copy your key now. It won&apos;t be shown again.</p>
          <code className="bg-muted block rounded-md px-2 py-1.5 text-xs break-all select-all">
            {created}
          </code>
          <Button size="sm" variant="outline" onClick={() => setCreated(null)}>
            I&apos;ve saved it
          </Button>
        </div>
      )}

      {keys.data && keys.data.length > 0 && (
        <ul className="mt-4 divide-y text-sm">
          {keys.data.map((k) => (
            <li key={k.id} className="flex items-center justify-between gap-3 py-2">
              <span className="min-w-0">
                <span className="font-semibold">{k.name}</span>{" "}
                <code className="text-muted-foreground text-xs">{k.prefix}…</code>
                <span className="text-muted-foreground block text-xs">
                  {k.scopes.join(", ")} ·{" "}
                  {k.lastUsedAt ? `used ${timeAgo(k.lastUsedAt)}` : "never used"}
                  {k.expiresAt ? ` · expires ${new Date(k.expiresAt).toLocaleDateString()}` : ""}
                </span>
              </span>
              <Button
                size="sm"
                variant="outline"
                loading={isPending(`revoke:${k.id}`)}
                onClick={() => void revoke(k.id, k.name)}
              >
                Revoke
              </Button>
            </li>
          ))}
        </ul>
      )}

      <form onSubmit={create} className="mt-4 space-y-3">
        <Field label="Key name" htmlFor="key-name">
          <Input
            id="key-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Claude Code on my laptop"
            maxLength={80}
            required
          />
        </Field>
        <fieldset className="space-y-1.5">
          <legend className="mb-1 text-sm font-medium">What it can read</legend>
          {SCOPES.map((s) => (
            <label key={s.id} className="flex items-start gap-2 text-sm">
              <input
                type="checkbox"
                className="mt-1"
                checked={scopes.includes(s.id)}
                onChange={() => toggle(s.id)}
              />
              <span>
                <span className="font-semibold">{s.label}</span>
                <span className="text-muted-foreground block text-xs">{s.hint}</span>
              </span>
            </label>
          ))}
        </fieldset>
        <Button
          type="submit"
          loading={isPending("create")}
          disabled={!name.trim() || scopes.length === 0}
        >
          Create key
        </Button>
      </form>
    </Panel>
  );
}
