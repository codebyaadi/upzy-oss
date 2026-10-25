"use client";

import { Badge } from "@upzy/ui/components/badge";
import { Button } from "@upzy/ui/components/button";
import { toast } from "@upzy/ui/components/sonner";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useEffect, useRef } from "react";

import { AiExplanation } from "@/components/app/ai-explanation";
import { Can } from "@/components/app/can";
import { FixForStack } from "@/components/app/fix-for-stack";
import {
  BackLink,
  DetailSkeleton,
  ErrorNote,
  Panel,
  SeverityBadge,
  type Severity,
  PageTitle,
} from "@/components/app/ui";
import { api } from "@/lib/api";
import { dateTime, timeAgo } from "@/lib/format";
import { useAction } from "@/lib/use-action";
import { unwrap, useApi } from "@/lib/use-api";

interface Cve {
  id: string;
  severity: Severity;
  cvss: number | null;
  kev: boolean;
  epss: number | null;
  fixedIn: string | null;
  summary: string;
}

const nvdUrl = (id: string) =>
  id.startsWith("CVE-")
    ? `https://nvd.nist.gov/vuln/detail/${id}`
    : `https://github.com/advisories/${id}`;

export default function FindingDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { run, isPending } = useAction();
  const {
    data: f,
    error,
    mutate,
  } = useApi(`finding:${id}`, () => unwrap(api.finding({ id }).get()), {
    // Poll quickly while an AI explanation is being written.
    refreshInterval: (latest) =>
      latest?.aiExplainStatus === "pending" || latest?.verifyStatus === "pending" ? 2_000 : 15_000,
  });

  // A re-check finishes in the worker: say what it found when the pending state clears.
  const wasPending = useRef(false);
  useEffect(() => {
    if (!f) return;
    if (f.verifyStatus === "pending") wasPending.current = true;
    else if (wasPending.current) {
      wasPending.current = false;
      if (f.verifyStatus === "failed")
        toast.error("Couldn't re-check", { description: f.verifyError ?? undefined });
      else if (f.status === "resolved")
        toast.success("Fixed! This finding is resolved.", {
          description: "The problem is no longer there.",
        });
      else
        toast.info("Still there", {
          description: "The check ran and the problem is still present.",
        });
    }
  }, [f]);

  if (error) return <ErrorNote error={error} />;
  if (!f) return <DetailSkeleton />;

  const setStatus = (status: "open" | "ignored") =>
    run(
      "status",
      async () => {
        await unwrap(api.finding({ id }).patch({ status }));
        await mutate();
      },
      {
        success: status === "ignored" ? "Finding ignored" : "Finding reopened",
        error: "Couldn't update the finding",
      },
    );

  const verify = () =>
    run(
      "verify",
      async () => {
        await unwrap(api.finding({ id }).verify.post());
        await mutate();
      },
      { error: "Couldn't start the re-check" },
    );

  const raw = (f.evidence ?? {}) as Record<string, unknown>;
  const cves = Array.isArray(raw.cves) ? (raw.cves as Cve[]) : [];
  const total = typeof raw.total === "number" ? raw.total : cves.length;
  // The CVE list gets its own table; everything else is shown as plain evidence.
  const evidence = Object.entries(raw).filter(
    ([k]) => !["cves", "total", "kevCount", "proof"].includes(k),
  );
  const proof = parseProof(raw.proof);

  return (
    <>
      <BackLink href="/findings">Findings</BackLink>
      <PageTitle>{f.title}</PageTitle>
      <div className="mb-8 flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-3">
            <h1 className="text-3xl font-extrabold tracking-tighter text-balance sm:text-4xl">
              {f.title}
            </h1>
            <SeverityBadge severity={f.severity} />
            <Badge variant="secondary" className="capitalize">
              {f.status}
            </Badge>
          </div>
          <p className="text-muted-foreground mt-2">
            On{" "}
            <Link
              href={`/findings?assetId=${f.asset.id}`}
              className="text-foreground font-semibold underline underline-offset-4"
            >
              {f.asset.value}
            </Link>{" "}
            · <code className="font-mono text-sm">{f.checkKey}</code>
          </p>
        </div>
        <Can min="member">
          {f.status === "open" && (
            <Button
              variant="outline"
              loading={isPending("status")}
              onClick={() => setStatus("ignored")}
            >
              Ignore
            </Button>
          )}
          {f.status === "ignored" && (
            <Button
              variant="outline"
              loading={isPending("status")}
              onClick={() => setStatus("open")}
            >
              Reopen
            </Button>
          )}
        </Can>
      </div>

      {cves.length > 0 && (
        <Panel className="mb-4">
          <h2 className="text-xl font-bold tracking-tight">Known vulnerabilities</h2>
          <p className="text-muted-foreground mt-1 mb-4 text-sm">
            Most urgent first: exploited in the wild, then likelihood of exploitation (EPSS), then
            severity.
            {total > cves.length && ` Showing ${cves.length} of ${total}.`}
          </p>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[40rem] text-left text-sm">
              <thead className="text-muted-foreground text-xs">
                <tr>
                  <th className="pb-2 font-medium">ID</th>
                  <th className="pb-2 font-medium">Severity</th>
                  <th className="pb-2 font-medium">Exploited</th>
                  <th className="pb-2 font-medium">EPSS</th>
                  <th className="pb-2 font-medium">Summary</th>
                </tr>
              </thead>
              <tbody className="divide-y align-top">
                {cves.map((c) => (
                  <tr key={c.id}>
                    <td className="py-2.5 pr-3 font-mono text-xs whitespace-nowrap">
                      <a
                        href={nvdUrl(c.id)}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="font-semibold underline underline-offset-4"
                      >
                        {c.id}
                      </a>
                      {c.fixedIn && (
                        <span className="text-muted-foreground block font-sans">
                          fixed in {c.fixedIn}
                        </span>
                      )}
                    </td>
                    <td className="py-2.5 pr-3 whitespace-nowrap">
                      <SeverityBadge severity={c.severity} />
                      {c.cvss !== null && (
                        <span className="text-muted-foreground ml-2 text-xs">CVSS {c.cvss}</span>
                      )}
                    </td>
                    <td className="py-2.5 pr-3 whitespace-nowrap">
                      {c.kev ? (
                        <Badge variant="destructive">Yes (CISA KEV)</Badge>
                      ) : (
                        <span className="text-muted-foreground">Not listed</span>
                      )}
                    </td>
                    <td className="py-2.5 pr-3 whitespace-nowrap">
                      {c.epss === null ? (
                        <span className="text-muted-foreground">–</span>
                      ) : (
                        `${(c.epss * 100).toFixed(c.epss < 0.1 ? 1 : 0)}%`
                      )}
                    </td>
                    <td className="text-muted-foreground py-2.5">
                      {c.summary || "No summary published."}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="text-muted-foreground mt-3 text-xs">
            EPSS is the estimated probability of exploitation in the next 30 days. KEV is
            CISA&rsquo;s catalogue of vulnerabilities known to be exploited.
          </p>
        </Panel>
      )}

      <div className="grid gap-4 lg:grid-cols-2">
        <div className="space-y-4">
          <AiExplanation
            findingId={id}
            explanation={f.aiExplanation}
            status={f.aiExplainStatus}
            error={f.aiExplainError}
            explainedAt={f.aiExplainedAt}
            onChanged={() => mutate()}
          />
          {f.fix && (
            <FixForStack fix={f.fix}>
              {f.status === "open" && (
                <Can min="member">
                  <div className="mt-4 flex flex-wrap items-center gap-3">
                    <Button
                      loading={isPending("verify") || f.verifyStatus === "pending"}
                      onClick={verify}
                    >
                      Verify fix
                    </Button>
                    <span className="text-muted-foreground text-xs">
                      {f.verifyStatus === "failed"
                        ? `Last check couldn't run: ${f.verifyError ?? "try again"}`
                        : f.lastVerifiedAt
                          ? `Last checked ${timeAgo(f.lastVerifiedAt)}`
                          : "Re-runs just this check, right now."}
                    </span>
                  </div>
                </Can>
              )}
            </FixForStack>
          )}
          <Panel>
            <h2 className="mb-2 text-xl font-bold tracking-tight">Why it matters</h2>
            <p className="text-muted-foreground leading-relaxed">{f.description}</p>
          </Panel>
          <Panel>
            <h2 className="mb-2 text-xl font-bold tracking-tight">
              {f.fix ? "In short" : "How to fix it"}
            </h2>
            <p className="text-muted-foreground leading-relaxed">
              {f.remediation || "No remediation guidance for this check yet."}
            </p>
            {!f.fix && f.status === "open" && (
              <Can min="member">
                <div className="mt-4 flex flex-wrap items-center gap-3">
                  <Button
                    variant="outline"
                    loading={isPending("verify") || f.verifyStatus === "pending"}
                    onClick={verify}
                  >
                    Verify fix
                  </Button>
                  <span className="text-muted-foreground text-xs">
                    Re-runs just this check, right now.
                  </span>
                </div>
              </Can>
            )}
          </Panel>
        </div>
        <div className="space-y-4">
          <Panel>
            <h2 className="mb-3 text-xl font-bold tracking-tight">Details</h2>
            <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-2 text-sm">
              <dt className="text-muted-foreground">Risk score</dt>
              <dd className="font-semibold">{f.riskScore} / 100</dd>
              <dt className="text-muted-foreground">First seen</dt>
              <dd>{dateTime(f.firstSeen)}</dd>
              <dt className="text-muted-foreground">Last seen</dt>
              <dd>{timeAgo(f.lastSeen)}</dd>
              {f.resolvedAt && (
                <>
                  <dt className="text-muted-foreground">Resolved</dt>
                  <dd>{dateTime(f.resolvedAt)}</dd>
                </>
              )}
            </dl>
          </Panel>
          <Panel>
            <h2 className="mb-3 text-xl font-bold tracking-tight">Notifications</h2>
            {f.deliveries.length === 0 ? (
              <p className="text-muted-foreground text-sm">
                {["critical", "high"].includes(f.severity)
                  ? "No alert was sent. Add a channel with a rule for new security findings in Alerts."
                  : "Only critical and high findings send alerts."}
              </p>
            ) : (
              <ul className="divide-y text-sm">
                {f.deliveries.map((d) => (
                  <li key={d.id} className="flex items-center justify-between gap-3 py-2">
                    <span>
                      {d.status === "sent" ? "Sent to" : "Failed to send to"}{" "}
                      <span className="font-semibold">{d.channelName}</span>{" "}
                      <span className="text-muted-foreground">({d.channelKind})</span>
                      {d.error && <span className="text-destructive block text-xs">{d.error}</span>}
                    </span>
                    <span className="text-muted-foreground shrink-0 text-xs">
                      {timeAgo(d.createdAt)}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </Panel>
          {proof && <ProofPanel proof={proof} />}
          {evidence.length > 0 && (
            <Panel>
              <h2 className="mb-3 text-xl font-bold tracking-tight">Evidence</h2>
              <dl className="space-y-2 text-sm">
                {evidence.map(([k, v]) => (
                  <div key={k}>
                    <dt className="text-muted-foreground">{k}</dt>
                    <dd className="bg-muted overflow-x-auto rounded-xl px-3 py-2 font-mono text-xs break-all whitespace-pre-wrap">
                      {typeof v === "string" ? v : JSON.stringify(v)}
                    </dd>
                  </div>
                ))}
              </dl>
            </Panel>
          )}
        </div>
      </div>
    </>
  );
}

interface ProofRequest {
  method: string;
  url: string;
  finalUrl?: string;
  status: number;
  headers: Record<string, string>;
  cookies?: string[];
}
interface Proof {
  checkedAt: string;
  requests?: ProofRequest[];
  confirmedAt?: string;
}

/** The proof is stored with the finding; trust nothing about its shape, since it is rendered on the page. */
function parseProof(v: unknown): Proof | null {
  if (!v || typeof v !== "object") return null;
  const p = v as Partial<Proof>;
  if (typeof p.checkedAt !== "string") return null;
  return {
    checkedAt: p.checkedAt,
    confirmedAt: typeof p.confirmedAt === "string" ? p.confirmedAt : undefined,
    requests: Array.isArray(p.requests)
      ? p.requests.filter((r) => r && typeof r.url === "string" && typeof r.status === "number")
      : undefined,
  };
}

/** What Upzy asked and what came back, so the finding can be checked by hand. */
function ProofPanel({ proof }: { proof: Proof }) {
  return (
    <Panel>
      <h2 className="mb-1 text-xl font-bold tracking-tight">How we checked this</h2>
      <p className="text-muted-foreground mb-3 text-sm">
        Checked {timeAgo(proof.checkedAt)}
        {proof.confirmedAt
          ? ", and seen again by a second check before it was reported."
          : "."}{" "}
        Cookie values and page contents are never kept.
      </p>
      {proof.requests?.map((r, i) => (
        <div key={i} className="bg-muted mb-2 rounded-xl px-3 py-2 font-mono text-xs break-all">
          <p className="font-semibold">
            {r.method} {r.url} → {r.status}
          </p>
          {r.finalUrl && <p>redirected to {r.finalUrl}</p>}
          {Object.entries(r.headers ?? {}).map(([k, v]) => (
            <p key={k}>
              {k}: {String(v)}
            </p>
          ))}
          {r.cookies?.map((c) => (
            <p key={c}>set-cookie: {c}</p>
          ))}
        </div>
      ))}
    </Panel>
  );
}
