"use client";

import { Badge } from "@upzy/ui/components/badge";
import { Button } from "@upzy/ui/components/button";
import { Checkbox } from "@upzy/ui/components/checkbox";
import { Spinner } from "@upzy/ui/components/spinner";
import { useMemo, useState } from "react";

import { Panel } from "@/components/app/ui";
import { api } from "@/lib/api";
import { timeAgo } from "@/lib/format";
import { useAction } from "@/lib/use-action";
import { unwrap, useApi } from "@/lib/use-api";

const PAGE = 500;

const KINDS: Record<string, string> = {
  production: "Production",
  staging: "Staging",
  development: "Development",
  admin_or_internal_tool: "Admin / internal tool",
  third_party_service: "Third-party service",
  marketing_or_docs: "Marketing / docs",
  mail_or_infrastructure: "Mail / infrastructure",
  unknown: "Unclear",
};
const FLAGS: Record<string, string> = {
  non_production_exposed: "Non-production exposed",
  admin_login_exposed: "Admin login exposed",
  ci_cd_or_devtool_exposed: "Dev tool exposed",
  default_or_error_page: "Default or error page",
  directory_listing: "Directory listing",
  debug_or_verbose_errors: "Verbose errors",
  outdated_software_banner: "Outdated software banner",
  no_https: "No HTTPS",
};
const ACTIONS: Record<string, string> = {
  add_monitor_and_scan: "Suggested: add and monitor",
  add_scan_only: "Suggested: add for scanning",
  investigate: "Suggested: look into it first",
  ignore: "Suggested: ignore",
};
interface Verdict {
  kind: string;
  confidence: string;
  riskFlags: string[];
  rationale: string;
  suggestedAction: string;
}
interface Profile {
  http?: {
    status?: number;
    title?: string | null;
    server?: string | null;
    redirectedTo?: string | null;
    error?: string;
  };
}

/** Subdomains found in certificate logs. Nothing is scanned until one is added. */
export function DiscoveredHosts({
  workspaceId,
  onChange,
}: {
  workspaceId: string;
  onChange: () => void;
}) {
  const ai = useApi("ai-settings", () => unwrap(api.ai.settings.get()));
  const list = useApi(
    `discovery:${workspaceId}`,
    () => unwrap(api.discovery.get({ query: { workspaceId, status: "new", limit: PAGE } })),
    { refreshInterval: (d) => (d?.some((h) => h.aiStatus === "pending") ? 3_000 : 0) },
  );
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const { run, isPending } = useAction();

  const groups = useMemo(() => {
    const byParent = new Map<string, NonNullable<typeof list.data>>();
    for (const h of list.data ?? []) byParent.set(h.parent, [...(byParent.get(h.parent) ?? []), h]);
    return [...byParent.entries()];
  }, [list.data]);

  if (!list.data || list.data.length === 0) return null;
  const capped = list.data.length >= PAGE;

  const setMany = (ids: string[], on: boolean) =>
    setSelected((s) => {
      const next = new Set(s);
      for (const id of ids) {
        if (on) next.add(id);
        else next.delete(id);
      }
      return next;
    });

  const analyse = () =>
    run(
      "analyse",
      async () => {
        const r = (await unwrap(api.discovery.classify.post({ workspaceId }))) as {
          queued: number;
        };
        await list.mutate();
        return r;
      },
      {
        success: (r) =>
          r.queued > 0
            ? `Analysing ${r.queued} host${r.queued === 1 ? "" : "s"}…`
            : "Nothing new to analyse",
        error: "Couldn't start the analysis",
      },
    );
  const waiting = list.data.filter(
    (h) => h.resolves === true && !h.aiClassification && h.aiStatus !== "pending",
  );
  const analysing = list.data.some((h) => h.aiStatus === "pending");

  async function act(kind: "accept" | "dismiss") {
    const ids = [...selected].slice(0, 100);
    if (ids.length === 0) return;
    const done = await run(
      kind,
      async () => {
        if (kind === "accept")
          return (await unwrap(api.discovery.accept.post({ ids }))) as { accepted: number };
        await unwrap(api.discovery.dismiss.post({ ids }));
        return { accepted: 0 };
      },
      {
        success: (r) =>
          kind === "accept"
            ? `Added ${r.accepted} subdomain${r.accepted === 1 ? "" : "s"}. Scans start shortly.`
            : `Dismissed ${ids.length} suggestion${ids.length === 1 ? "" : "s"}`,
        error:
          kind === "accept" ? "Couldn't add the subdomains" : "Couldn't dismiss the suggestions",
      },
    );
    if (!done) return;
    setSelected(new Set());
    await list.mutate();
    onChange();
  }

  return (
    <Panel className="mb-4">
      <div className="mb-1 flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-xl font-bold tracking-tight">Discovered subdomains</h2>
        <div className="flex flex-wrap gap-2">
          {ai.data?.enabled && waiting.length > 0 && (
            <Button size="sm" variant="outline" loading={isPending("analyse")} onClick={analyse}>
              Analyse with AI
            </Button>
          )}
          <Button
            size="sm"
            disabled={selected.size === 0 || isPending("dismiss")}
            loading={isPending("accept")}
            onClick={() => act("accept")}
          >
            Add selected{selected.size > 0 ? ` (${Math.min(selected.size, 100)})` : ""}
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={selected.size === 0 || isPending("accept")}
            loading={isPending("dismiss")}
            onClick={() => act("dismiss")}
          >
            Dismiss
          </Button>
        </div>
      </div>
      <p className="text-muted-foreground mb-4 text-sm">
        Found in public certificate logs. Upzy won&rsquo;t scan these until you add them. Hosts that
        resolve in DNS are listed first.
        {analysing && (
          <span role="status" className="text-foreground ml-2 inline-flex items-center gap-1.5">
            <Spinner aria-hidden /> Looking at what each live host shows…
          </span>
        )}
      </p>
      <div className="space-y-5">
        {groups.map(([parent, hosts]) => {
          const ids = hosts.map((h) => h.id);
          const all = ids.every((id) => selected.has(id));
          const some = !all && ids.some((id) => selected.has(id));
          return (
            <section key={parent} aria-label={`Subdomains of ${parent}`}>
              <label className="mb-2 flex items-center gap-2 text-sm font-semibold">
                <Checkbox
                  checked={all}
                  indeterminate={some}
                  onCheckedChange={(on) => setMany(ids, on)}
                  aria-label={`Select all subdomains of ${parent}`}
                />
                {parent}{" "}
                <span className="text-muted-foreground font-normal">
                  ({hosts.length}
                  {capped ? "+" : ""})
                </span>
              </label>
              <ul className="bg-card/60 max-h-72 divide-y overflow-y-auto rounded-2xl border">
                {hosts.map((h) => (
                  <li key={h.id}>
                    <label className="hover:bg-accent/40 flex cursor-pointer items-center justify-between gap-3 px-4 py-2.5 text-sm">
                      <span className="flex min-w-0 items-center gap-3">
                        <Checkbox
                          checked={selected.has(h.id)}
                          onCheckedChange={(on) => setMany([h.id], on)}
                        />
                        <span className="min-w-0">
                          <span className="break-all">{h.host}</span>
                          <HostInsight
                            verdict={h.aiClassification as unknown as Verdict | null}
                            profile={h.profile as unknown as Profile | null}
                            status={h.aiStatus}
                            error={h.aiError}
                          />
                        </span>
                      </span>
                      <span className="flex shrink-0 items-center gap-3">
                        <span className="text-muted-foreground hidden text-xs sm:inline">
                          seen {timeAgo(h.firstSeen)}
                        </span>
                        {h.resolves === true ? (
                          <Badge>Live</Badge>
                        ) : h.resolves === false ? (
                          <Badge variant="outline">No DNS</Badge>
                        ) : (
                          <Badge variant="outline">Unknown</Badge>
                        )}
                      </span>
                    </label>
                  </li>
                ))}
              </ul>
            </section>
          );
        })}
      </div>
      {capped && (
        <p className="text-muted-foreground mt-3 text-xs">
          Showing the first {PAGE}. Add or dismiss some to see more.
        </p>
      )}
    </Panel>
  );
}

/** What the AI made of one host and what it was based on. Text only, from a fixed vocabulary plus one sentence. */
function HostInsight({
  verdict,
  profile,
  status,
  error,
}: {
  verdict: Verdict | null;
  profile: Profile | null;
  status: "pending" | "failed" | null;
  error: string | null;
}) {
  if (status === "pending")
    return <span className="text-muted-foreground mt-0.5 block text-xs">Analysing…</span>;
  if (status === "failed")
    return (
      <span className="text-destructive mt-0.5 block text-xs">{error ?? "Analysis failed"}</span>
    );
  if (!verdict) return null;
  const seen = profile?.http;
  return (
    <span className="mt-1 block space-y-1">
      <span className="flex flex-wrap items-center gap-1.5">
        <Badge variant="secondary">{KINDS[verdict.kind] ?? verdict.kind}</Badge>
        {verdict.riskFlags.map((f) => (
          <Badge key={f} variant="outline" className="border-destructive/40 text-destructive">
            {FLAGS[f] ?? f}
          </Badge>
        ))}
        <span className="text-muted-foreground text-xs">
          {ACTIONS[verdict.suggestedAction] ?? ""} · {verdict.confidence} confidence
        </span>
      </span>
      <span className="text-muted-foreground block text-xs">{verdict.rationale}</span>
      {seen && (
        <span className="text-muted-foreground block text-xs">
          Saw:{" "}
          {seen.error
            ? seen.error
            : [
                seen.status && `HTTP ${seen.status}`,
                seen.title && `“${seen.title}”`,
                seen.server,
                seen.redirectedTo && `redirects to ${seen.redirectedTo}`,
              ]
                .filter(Boolean)
                .join(" · ")}
        </span>
      )}
    </span>
  );
}
