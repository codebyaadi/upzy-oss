"use client";

import { Badge } from "@upzy/ui/components/badge";
import { Button } from "@upzy/ui/components/button";
import { Input } from "@upzy/ui/components/input";
import { toast } from "@upzy/ui/components/sonner";
import { useState } from "react";

import { ActionMenu } from "@/components/app/action-menu";
import { Can, ViewOnlyNote } from "@/components/app/can";
import { useConfirm } from "@/components/app/confirm";
import { DiscoveredHosts } from "@/components/app/discovered-hosts";
import { GradeBadge, HealthPanel, type HealthData } from "@/components/app/health";
import { SelectField } from "@/components/app/select-field";
import {
  EmptyState,
  ErrorNote,
  Field,
  ListSkeleton,
  PageHeader,
  Panel,
  SeverityBadge,
  SEVERITIES,
} from "@/components/app/ui";
import { useWorkspace } from "@/components/app/workspace";
import { api } from "@/lib/api";
import { timeAgo } from "@/lib/format";
import { useAction } from "@/lib/use-action";
import { unwrap, useApi } from "@/lib/use-api";

interface Instructions {
  dns: { type: string; name: string; value: string };
  file: { path: string; content: string };
}

type Kind = "domain" | "subdomain" | "url";
const KIND_OPTIONS: { value: Kind; label: string }[] = [
  { value: "domain", label: "Domain" },
  { value: "subdomain", label: "Subdomain" },
  { value: "url", label: "URL" },
];

/** The error body Elysia returns, if there is one. */
const apiMessage = (error: { value?: unknown } | null) =>
  (error?.value as { message?: string } | undefined)?.message;

export default function AssetsPage() {
  const { workspace, can } = useWorkspace();
  const confirm = useConfirm();
  const { run, isPending } = useAction();
  const [kind, setKind] = useState<Kind>("domain");
  const [howTo, setHowTo] = useState<Record<string, Instructions>>({});
  const [open, setOpen] = useState<Record<string, boolean>>({});

  const assets = useApi(`assets:${workspace.id}`, () =>
    unwrap(api.asset.get({ query: { workspaceId: workspace.id } })),
  );

  async function add(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const value = String(new FormData(form).get("value")).trim();
    const created = await run(
      "add",
      async () =>
        (await unwrap(api.asset.post({ workspaceId: workspace.id, kind, value } as never))) as {
          id: string;
          verified: boolean;
          verification: Instructions;
        },
      {
        success: (c) =>
          c.verified
            ? "Asset added and verified. A scan starts shortly."
            : "Asset added. A scan starts shortly.",
        error: "Couldn't add the asset",
      },
    );
    if (!created) return;
    if (!created.verified) setHowTo((h) => ({ ...h, [created.id]: created.verification }));
    form.reset();
    await assets.mutate();
  }

  async function verify(id: string) {
    const r = await run(
      `verify:${id}`,
      async () => (await unwrap(api.asset({ id }).verify.post())) as { verified: boolean },
      { error: "Couldn't check ownership" },
    );
    if (!r) return;
    if (r.verified) {
      toast.success("Ownership verified");
      setHowTo((h) => {
        const next = { ...h };
        delete next[id];
        return next;
      });
    } else {
      toast.info("Proof not found yet", {
        description: "DNS changes can take a few minutes to appear.",
      });
    }
    await assets.mutate();
  }

  const showHowTo = (id: string) =>
    run(
      `howto:${id}`,
      async () => {
        const a = (await unwrap(api.asset({ id }).get())) as { verification: Instructions | null };
        if (a.verification) setHowTo((h) => ({ ...h, [id]: a.verification! }));
      },
      { error: "Couldn't load the instructions" },
    );

  async function trigger(kindOfJob: "scan" | "discover", id: string) {
    await run(
      `${kindOfJob}:${id}`,
      async () => {
        const { error } = await (kindOfJob === "scan"
          ? api.asset({ id }).scan.post()
          : api.asset({ id }).discover.post());
        if (error) throw new Error(apiMessage(error) ?? "Could not start the job");
        await assets.mutate();
      },
      {
        success:
          kindOfJob === "scan"
            ? "Scan queued. Results appear in Findings shortly."
            : "Looking for subdomains. Suggestions appear above.",
        error: kindOfJob === "scan" ? "Couldn't start a scan" : "Couldn't start the lookup",
      },
    );
  }

  async function remove(id: string, value: string) {
    const ok = await confirm({
      title: `Remove ${value}?`,
      description: "Its scan history and findings are deleted too.",
      confirmLabel: "Remove asset",
      destructive: true,
    });
    if (!ok) return;
    await run(
      `remove:${id}`,
      async () => {
        const { error } = await api.asset({ id }).delete();
        if (error) throw new Error("Could not remove the asset");
        await assets.mutate();
      },
      { success: "Asset removed" },
    );
  }

  return (
    <>
      <PageHeader
        title="Assets"
        description="Domains, subdomains and URLs Upzy checks for security issues. Passive checks look only at what any visitor can see."
      />
      <ErrorNote error={assets.error} />
      {!can("member") && <ViewOnlyNote what="assets" />}
      {can("member") && (
        <DiscoveredHosts workspaceId={workspace.id} onChange={() => assets.mutate()} />
      )}
      <div className="grid gap-4 lg:grid-cols-[1fr_22rem]">
        <div className="space-y-3">
          {assets.isLoading && !assets.data && <ListSkeleton />}
          {assets.data?.length === 0 && (
            <EmptyState
              title="No assets yet"
              body="Add a domain to scan its TLS, headers, email authentication and DNS, or use Get started to also watch it for uptime."
            />
          )}
          {assets.data?.map((a) => {
            const guide = howTo[a.id];
            const actions = [
              ...(a.kind === "domain"
                ? [{ label: "Find subdomains", onSelect: () => trigger("discover", a.id) }]
                : []),
              ...(!a.verified
                ? [{ label: "Verify ownership", onSelect: () => showHowTo(a.id) }]
                : []),
              {
                label: "Remove",
                destructive: true,
                separated: true,
                onSelect: () => remove(a.id, a.value),
              },
            ];
            return (
              <Panel key={a.id} className="p-5">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="flex min-w-0 items-start gap-4">
                    <GradeBadge health={a.health as HealthData | null} className="mt-0.5" />
                    <div className="min-w-0">
                      <p className="flex flex-wrap items-center gap-2 font-bold tracking-tight">
                        <span className="break-all">{a.value}</span>
                        <Badge variant="secondary" className="capitalize">
                          {a.kind}
                        </Badge>
                        {a.verified ? (
                          <Badge>Verified</Badge>
                        ) : (
                          <Badge variant="outline">Unverified</Badge>
                        )}
                      </p>
                      <p className="text-muted-foreground mt-1 text-sm">
                        {a.lastScanAt ? `Scanned ${timeAgo(a.lastScanAt)}` : "Not scanned yet"}
                        {a.kind === "domain" &&
                          (a.lastDiscoveryAt
                            ? ` · subdomains checked ${timeAgo(a.lastDiscoveryAt)}`
                            : " · looking for subdomains…")}
                        {a.newDiscoveries > 0 && (
                          <span className="text-foreground font-semibold">
                            {" "}
                            · {a.newDiscoveries} new subdomain{a.newDiscoveries === 1 ? "" : "s"}{" "}
                            found
                          </span>
                        )}
                      </p>
                      {!a.verified && a.verificationLostAt && (
                        <p className="text-destructive mt-1 text-xs">
                          We could no longer find the ownership record, so deeper checks (exposed
                          files and open ports) are paused. Add the record again and press Verify
                          ownership.
                        </p>
                      )}
                      {a.discoveryError && (
                        <p className="text-destructive mt-1 text-xs">
                          Subdomain lookup failed and will retry: certificate log services are
                          unreliable at times.
                        </p>
                      )}
                      <p className="mt-2 flex flex-wrap gap-1.5">
                        {SEVERITIES.filter((s) => a.openFindings[s]).map((s) => (
                          <SeverityBadge key={s} severity={s} count={a.openFindings[s]} />
                        ))}
                        {Object.keys(a.openFindings).length === 0 && a.lastScanAt && (
                          <span className="text-muted-foreground text-sm">No open findings</span>
                        )}
                      </p>
                      {a.health && (
                        <button
                          type="button"
                          className="text-muted-foreground mt-2 text-xs font-semibold underline underline-offset-4"
                          aria-expanded={!!open[a.id]}
                          onClick={() => setOpen((o) => ({ ...o, [a.id]: !o[a.id] }))}
                        >
                          {open[a.id] ? "Hide" : "Show"} health score {a.health.score}
                          {a.stackLabel ? ` · ${a.stackLabel}` : ""}
                        </button>
                      )}
                    </div>
                  </div>
                  <Can min="member">
                    <div className="flex items-center gap-1">
                      <Button
                        variant="outline"
                        size="sm"
                        loading={isPending(`scan:${a.id}`)}
                        onClick={() => trigger("scan", a.id)}
                      >
                        Scan now
                      </Button>
                      <ActionMenu label={`Actions for ${a.value}`} actions={actions} />
                    </div>
                  </Can>
                </div>
                {open[a.id] && <HealthPanel assetId={a.id} />}
                {guide && (
                  <div className="bg-accent/50 mt-4 space-y-3 rounded-2xl p-4 text-sm">
                    <p>
                      Prove you control <strong>{a.value}</strong> with either option, then check:
                    </p>
                    <p>
                      <span className="font-semibold">DNS:</span> add a{" "}
                      <code className="font-mono">{guide.dns.type}</code> record on{" "}
                      <code className="font-mono">{guide.dns.name}</code> with value
                      <code className="bg-card mt-1 block overflow-x-auto rounded-xl px-3 py-2 font-mono">
                        {guide.dns.value}
                      </code>
                    </p>
                    <p>
                      <span className="font-semibold">or file:</span> serve{" "}
                      <code className="font-mono">{guide.file.path}</code> containing
                      <code className="bg-card mt-1 block overflow-x-auto rounded-xl px-3 py-2 font-mono">
                        {guide.file.content}
                      </code>
                    </p>
                    <Button
                      size="sm"
                      loading={isPending(`verify:${a.id}`)}
                      onClick={() => verify(a.id)}
                    >
                      Check now
                    </Button>
                    <p className="text-muted-foreground text-xs">
                      Verification turns on deeper checks: exposed files and open database or
                      remote-access ports. Passive scans work without it.
                    </p>
                  </div>
                )}
              </Panel>
            );
          })}
        </div>

        <Can min="member">
          <Panel className="h-fit">
            <h2 className="mb-4 text-xl font-bold tracking-tight">Add asset</h2>
            <form onSubmit={add} className="space-y-4">
              <Field label="Type" htmlFor="kind">
                <SelectField
                  id="kind"
                  value={kind}
                  onValueChange={setKind}
                  options={KIND_OPTIONS}
                />
              </Field>
              <Field
                label={kind === "url" ? "URL" : "Hostname"}
                htmlFor="value"
                hint={
                  kind === "domain"
                    ? "Domains also get email-authentication and CAA checks."
                    : kind === "subdomain"
                      ? "Checked for dangling CNAMEs (takeover) as well as TLS and headers."
                      : "We inspect this exact page."
                }
              >
                <Input
                  id="value"
                  name="value"
                  key={kind}
                  placeholder={
                    kind === "url"
                      ? "https://app.example.com/login"
                      : kind === "domain"
                        ? "example.com"
                        : "app.example.com"
                  }
                  required
                />
              </Field>
              <Button type="submit" className="w-full" loading={isPending("add")}>
                Add and scan
              </Button>
            </form>
          </Panel>
        </Can>
      </div>
    </>
  );
}
