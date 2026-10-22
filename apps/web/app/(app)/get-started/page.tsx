"use client";

import { Button } from "@upzy/ui/components/button";
import { Input } from "@upzy/ui/components/input";
import { toast } from "@upzy/ui/components/sonner";
import { cn } from "@upzy/ui/lib/utils";
import Link from "next/link";
import { useEffect, useState } from "react";

import { Can } from "@/components/app/can";
import { GradeBadge, type HealthData } from "@/components/app/health";
import { Field, PageHeader, Panel, SeverityBadge, StatusPill } from "@/components/app/ui";
import { useWorkspace } from "@/components/app/workspace";
import { api } from "@/lib/api";
import { ms, timeAgo } from "@/lib/format";
import { useAction } from "@/lib/use-action";
import { unwrap, useApi } from "@/lib/use-api";

interface Started {
  assetId: string;
  monitorIds: string[];
  verification: {
    dns: { type: string; name: string; value: string };
    file: { path: string; content: string };
  } | null;
}

const PARAM = "site";

/** One row of the checklist: a mark that fills in as the thing finishes, never colour alone. */
function Step({
  done,
  title,
  children,
}: {
  done: boolean;
  title: string;
  children?: React.ReactNode;
}) {
  return (
    <li className="flex gap-4">
      <span
        aria-hidden
        className={cn(
          "mt-0.5 grid size-6 shrink-0 place-items-center rounded-full border text-xs font-bold",
          done ? "bg-brand text-background border-transparent" : "text-muted-foreground",
        )}
      >
        {done ? "✓" : ""}
      </span>
      <div className="min-w-0 flex-1">
        <p className="font-semibold">
          {title}
          <span className="sr-only">{done ? " (done)" : " (in progress)"}</span>
        </p>
        <div className="text-muted-foreground mt-1 text-sm">{children}</div>
      </div>
    </li>
  );
}

export default function GetStartedPage() {
  const { workspace, can } = useWorkspace();
  const { run, isPending } = useAction();
  const [site, setSite] = useState("");
  const [started, setStarted] = useState<Started | null>(null);

  // A refresh mid-way picks up where it was: the ids live in the address, not just in memory.
  useEffect(() => {
    try {
      const raw = new URLSearchParams(window.location.search).get(PARAM);
      if (raw) setStarted(JSON.parse(atob(raw)) as Started);
    } catch {}
  }, []);

  const assets = useApi(
    started ? `onboard-assets:${workspace.id}` : null,
    () => unwrap(api.asset.get({ query: { workspaceId: workspace.id } })),
    { refreshInterval: 3_000 },
  );
  const monitors = useApi(
    started ? `onboard-monitors:${workspace.id}` : null,
    () => unwrap(api.monitor.get({ query: { workspaceId: workspace.id } })),
    { refreshInterval: 3_000 },
  );
  const asset = assets.data?.find((a) => a.id === started?.assetId);
  const mons = monitors.data?.filter((m) => started?.monitorIds.includes(m.id)) ?? [];
  const uptime = mons.find((m) => m.type === "http");
  const cert = mons.find((m) => m.type === "ssl");
  const scanned = !!asset?.lastScanAt;
  const findings = useApi(
    started && scanned ? `onboard-findings:${started.assetId}` : null,
    () =>
      unwrap(api.finding.get({ query: { assetId: started!.assetId, status: "open", limit: 3 } })),
    { refreshInterval: 0 },
  );

  async function begin(e: React.FormEvent) {
    e.preventDefault();
    const r = await run(
      "begin",
      async () => unwrap(api.onboarding.site.post({ workspaceId: workspace.id, site })),
      { error: "Couldn't set that up" },
    );
    if (!r) return;
    const s: Started = {
      assetId: r.asset.id,
      monitorIds: r.monitors.map((m) => m.id),
      verification: r.verification,
    };
    setStarted(s);
    try {
      const url = new URL(window.location.href);
      url.searchParams.set(PARAM, btoa(JSON.stringify(s)));
      window.history.replaceState(null, "", url);
    } catch {}
    toast.success(r.asset.created ? "Watching your site" : "Already set up. Checking it again.", {
      description: "Results appear below in a moment.",
    });
  }

  async function verify() {
    if (!started) return;
    const r = await run(
      "verify",
      async () =>
        (await unwrap(api.asset({ id: started.assetId }).verify.post())) as { verified: boolean },
      { error: "Couldn't check ownership" },
    );
    if (!r) return;
    if (r.verified) {
      toast.success("Ownership verified");
      setStarted({ ...started, verification: null });
      await assets.mutate();
    } else {
      toast.info("Proof not found yet", {
        description: "DNS changes can take a few minutes to appear.",
      });
    }
  }

  return (
    <>
      <PageHeader
        title="Get started"
        description="Tell Upzy your website. It starts watching it, checks its certificate and security, and gives it a grade."
      />

      {!started && (
        <Panel className="max-w-xl">
          {can("member") ? (
            <form onSubmit={begin} className="space-y-4">
              <Field
                label="Your website"
                htmlFor="site"
                hint="A domain like example.com, or any page address. Nothing is changed on your site."
              >
                <Input
                  id="site"
                  value={site}
                  onChange={(e) => setSite(e.target.value)}
                  placeholder="example.com"
                  autoComplete="url"
                  autoFocus
                  required
                />
              </Field>
              <Button type="submit" size="lg" loading={isPending("begin")} disabled={!site.trim()}>
                Start watching
              </Button>
            </form>
          ) : (
            <p className="text-muted-foreground text-sm">
              Ask someone with the member role to add the first website.
            </p>
          )}
        </Panel>
      )}

      {started && (
        <div className="grid gap-4 lg:grid-cols-[1fr_20rem]">
          <Panel>
            <ol className="space-y-6">
              <Step done={!!uptime && uptime.lastStatus !== "unknown"} title="Watching it is up">
                {uptime ? (
                  uptime.lastStatus === "unknown" ? (
                    "Running the first check…"
                  ) : (
                    <span className="flex flex-wrap items-center gap-x-3">
                      <StatusPill status={uptime.lastStatus} />
                      {uptime.avgMs24h != null && <span>{ms(uptime.avgMs24h)} response</span>}
                      <span>every 5 minutes</span>
                    </span>
                  )
                ) : (
                  "Setting up…"
                )}
              </Step>
              <Step done={!!cert && cert.lastStatus !== "unknown"} title="Checking the certificate">
                {cert && cert.lastStatus !== "unknown" ? (
                  <span className="flex flex-wrap items-center gap-x-3">
                    <StatusPill status={cert.lastStatus} />
                    <span>You&apos;re alerted well before it expires.</span>
                  </span>
                ) : (
                  "Reading it…"
                )}
              </Step>
              <Step done={scanned} title="Scanning for security problems">
                {scanned && asset ? (
                  <div className="space-y-3">
                    <div className="flex items-center gap-3">
                      <GradeBadge health={asset.health as HealthData | null} />
                      <div>
                        <p className="text-foreground font-semibold">
                          {asset.health
                            ? `Health score ${asset.health.score} out of 100`
                            : "Scanned"}
                        </p>
                        <p>
                          {asset.stackLabel ? `Runs on ${asset.stackLabel}. ` : ""}
                          Scanned {timeAgo(asset.lastScanAt!)}.
                        </p>
                      </div>
                    </div>
                    {findings.data && findings.data.length > 0 ? (
                      <>
                        <p>Fix these first. Each one comes with instructions for your setup.</p>
                        <ul className="divide-y rounded-2xl border">
                          {findings.data.map((f) => (
                            <li key={f.id}>
                              <Link
                                href={`/findings/${f.id}`}
                                className="hover:bg-accent/40 flex items-center justify-between gap-3 px-4 py-3 transition-colors"
                              >
                                <span className="text-foreground font-medium">{f.title}</span>
                                <SeverityBadge severity={f.severity} />
                              </Link>
                            </li>
                          ))}
                        </ul>
                        <Link
                          href="/findings"
                          className="text-foreground font-semibold underline underline-offset-4"
                        >
                          See all findings
                        </Link>
                      </>
                    ) : (
                      findings.data && <p>Nothing to fix. 🎉</p>
                    )}
                  </div>
                ) : (
                  "This takes about half a minute. Only what any visitor can see is checked."
                )}
              </Step>
              {started.verification && (
                <Step done={false} title="Prove you own it (optional)">
                  <div className="space-y-3">
                    <p>
                      Passive checks work without this. Verifying unlocks deeper checks later and
                      auto-verifies your subdomains. Add this DNS record, then check:
                    </p>
                    <p>
                      <code className="font-mono">{started.verification.dns.type}</code> record on{" "}
                      <code className="font-mono">{started.verification.dns.name}</code>
                      <code className="bg-muted text-foreground mt-1 block overflow-x-auto rounded-xl px-3 py-2 font-mono text-xs">
                        {started.verification.dns.value}
                      </code>
                    </p>
                    <Can min="member">
                      <Button size="sm" loading={isPending("verify")} onClick={verify}>
                        Check now
                      </Button>
                    </Can>
                  </div>
                </Step>
              )}
            </ol>
          </Panel>

          <Panel className="h-fit">
            <h2 className="mb-3 text-xl font-bold tracking-tight">What&apos;s next</h2>
            <ul className="space-y-3 text-sm">
              <li>
                <Link href="/alerts" className="font-semibold underline underline-offset-4">
                  Get alerted
                </Link>
                <span className="text-muted-foreground block">
                  Email, Slack, Discord or a webhook when something breaks.
                </span>
              </li>
              <li>
                <Link href="/status-pages" className="font-semibold underline underline-offset-4">
                  Publish a status page
                </Link>
                <span className="text-muted-foreground block">
                  Let customers see uptime and subscribe to updates.
                </span>
              </li>
              <li>
                <Link href="/assets" className="font-semibold underline underline-offset-4">
                  See your health score
                </Link>
                <span className="text-muted-foreground block">
                  The breakdown, the trend and one snippet for every missing header.
                </span>
              </li>
              <li>
                <Link href="/settings/ai" className="font-semibold underline underline-offset-4">
                  Turn on AI help
                </Link>
                <span className="text-muted-foreground block">
                  Optional. Uses your own provider key.
                </span>
              </li>
            </ul>
            <Button
              variant="outline"
              className="mt-5 w-full"
              onClick={() => {
                setStarted(null);
                setSite("");
                window.history.replaceState(null, "", window.location.pathname);
              }}
            >
              Add another website
            </Button>
          </Panel>
        </div>
      )}
    </>
  );
}
