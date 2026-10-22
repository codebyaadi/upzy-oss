"use client";

import { Badge } from "@upzy/ui/components/badge";
import { Button } from "@upzy/ui/components/button";
import { toast } from "@upzy/ui/components/sonner";
import { useState } from "react";

import { BadgeEmbeds } from "@/components/app/badge-embeds";
import { Can, ViewOnlyNote } from "@/components/app/can";
import { useConfirm } from "@/components/app/confirm";
import { StatusPageForm, type StatusPageDraft } from "@/components/app/status-page-form";
import { EmptyState, ErrorNote, ListSkeleton, PageHeader, Panel } from "@/components/app/ui";
import { useWorkspace } from "@/components/app/workspace";
import { api } from "@/lib/api";
import { useAction } from "@/lib/use-action";
import { unwrap, useApi } from "@/lib/use-api";

const EMPTY: StatusPageDraft = {
  title: "",
  slug: "",
  description: "",
  published: false,
  notice: "",
  noticeKind: "info",
  components: [],
  customDomain: "",
  securityAssetId: "",
};

interface PageRow {
  slug: string;
  securityAssetId: string | null;
  subscribers: number;
  published: boolean;
  customDomain: string | null;
  domainVerified: boolean;
  domainChallenge: { name: string; value: string } | null;
  domainTarget: string | null;
}

/** Shows how far a custom domain has got, and the two DNS records still needed. */
function CustomDomain({
  page,
  verify,
  canEdit,
}: {
  page: PageRow;
  verify: () => Promise<{ verified: boolean; txt: boolean; pointsToUs: boolean | null }>;
  onChanged: () => unknown;
  canEdit: boolean;
}) {
  const { run, isPending } = useAction();
  const [last, setLast] = useState<{ txt: boolean; pointsToUs: boolean | null } | null>(null);
  const domain = page.customDomain!;

  const check = () =>
    run(
      "verify",
      async () => {
        const r = await verify();
        setLast(r);
        if (r.verified)
          toast.success("Domain verified", {
            description:
              r.pointsToUs === false
                ? "Now point it at Upzy (the CNAME record) and it will load."
                : undefined,
          });
        else
          toast.info("Not found yet", {
            description:
              "DNS changes can take a few minutes. Check the record name and value, then try again.",
          });
      },
      { error: "Couldn't check DNS" },
    );
  const copy = async (text: string) => {
    await navigator.clipboard.writeText(text);
    toast.success("Copied");
  };

  return (
    <div className="bg-accent/50 mt-4 space-y-3 rounded-2xl p-4 text-sm">
      <p className="flex flex-wrap items-center gap-2">
        <span className="font-semibold">Custom domain</span>
        <span className="font-mono break-all">{domain}</span>
        {page.domainVerified ? (
          <Badge>Verified</Badge>
        ) : (
          <Badge variant="outline">Waiting for DNS</Badge>
        )}
      </p>
      {page.domainVerified ? (
        <p className="text-muted-foreground">
          {page.published ? (
            <>
              Live at{" "}
              <a
                href={`https://${domain}`}
                target="_blank"
                rel="noopener noreferrer"
                className="text-foreground underline underline-offset-4"
              >
                https://{domain}
              </a>
              . The first visit takes a minute while the certificate is issued.
            </>
          ) : (
            "Publish the page and it goes live on this domain."
          )}
          {last?.pointsToUs === false && (
            <span className="text-destructive block">
              The name doesn&rsquo;t point at Upzy yet. Add the CNAME record below.
            </span>
          )}
        </p>
      ) : (
        <p className="text-muted-foreground">
          Add these two records at your DNS provider, then check. The first proves the domain is
          yours; the second sends visitors here.
        </p>
      )}
      {(page.domainChallenge || page.domainVerified) && page.domainTarget && (
        <dl className="grid grid-cols-[auto_1fr_auto] items-center gap-x-3 gap-y-2 font-mono text-xs">
          {page.domainChallenge && (
            <>
              <dt className="text-muted-foreground font-sans">TXT</dt>
              <dd className="space-y-0.5 break-all">
                <span className="block">{page.domainChallenge.name}</span>
                <span className="text-muted-foreground block">{page.domainChallenge.value}</span>
              </dd>
              <dd>
                <Button variant="ghost" size="sm" onClick={() => copy(page.domainChallenge!.value)}>
                  Copy value
                </Button>
              </dd>
            </>
          )}
          <dt className="text-muted-foreground font-sans">CNAME</dt>
          <dd className="space-y-0.5 break-all">
            <span className="block">{domain}</span>
            <span className="text-muted-foreground block">{page.domainTarget}</span>
          </dd>
          <dd>
            <Button variant="ghost" size="sm" onClick={() => copy(page.domainTarget!)}>
              Copy target
            </Button>
          </dd>
        </dl>
      )}
      {canEdit && !page.domainVerified && (
        <div className="flex flex-wrap items-center gap-3">
          <Button size="sm" loading={isPending("verify")} onClick={check}>
            Check DNS
          </Button>
          {last && !last.txt && (
            <span className="text-muted-foreground text-xs">
              The TXT record wasn&rsquo;t found yet.
            </span>
          )}
        </div>
      )}
    </div>
  );
}

export default function StatusPagesPage() {
  const { workspace, can } = useWorkspace();
  const confirm = useConfirm();
  const { run, isPending } = useAction();
  const [editing, setEditing] = useState<string | "new" | null>(null);

  const pages = useApi(`status-pages:${workspace.id}`, () =>
    unwrap(api["status-page"].get({ query: { workspaceId: workspace.id } })),
  );
  const monitors = useApi(`monitors:${workspace.id}`, () =>
    unwrap(api.monitor.get({ query: { workspaceId: workspace.id } })),
  );
  const assets = useApi(`assets:${workspace.id}`, () =>
    unwrap(api.asset.get({ query: { workspaceId: workspace.id } })),
  );
  const origin = typeof window === "undefined" ? "" : window.location.origin;

  const save = (id: string | "new", draft: StatusPageDraft) =>
    run(
      "save",
      async () => {
        // An empty field means no custom domain: omitted when creating, cleared when editing.
        const common = {
          ...draft,
          securityAssetId: draft.securityAssetId || null,
        };
        if (id === "new")
          await unwrap(
            api["status-page"].post({
              workspaceId: workspace.id,
              ...common,
              customDomain: draft.customDomain || undefined,
            }),
          );
        else
          await unwrap(
            api["status-page"]({ id }).patch({
              ...common,
              customDomain: draft.customDomain || null,
            }),
          );
        await pages.mutate();
        setEditing(null);
      },
      {
        success: id === "new" ? "Status page created" : "Status page saved",
        error: "Couldn't save the status page",
      },
    );

  async function remove(id: string, title: string) {
    const ok = await confirm({
      title: `Delete “${title}”?`,
      description: "Its address stops working immediately. Your monitors are not affected.",
      confirmLabel: "Delete status page",
      destructive: true,
    });
    if (!ok) return;
    await run(
      `del:${id}`,
      async () => {
        await unwrap(api["status-page"]({ id }).delete());
        await pages.mutate();
      },
      { success: "Status page deleted", error: "Couldn't delete the status page" },
    );
  }

  const copy = async (slug: string) => {
    await navigator.clipboard.writeText(`${origin}/status/${slug}`);
    toast.success("Link copied");
  };

  const assetList = (assets.data ?? []).map((a) => ({ id: a.id, value: a.value }));
  const monitorList = (monitors.data ?? []).map((m) => ({ id: m.id, name: m.name }));
  const editingPage =
    editing && editing !== "new" ? pages.data?.find((p) => p.id === editing) : undefined;

  return (
    <>
      <PageHeader
        title="Status pages"
        description="A public page your customers can check to see whether you are up. It shows only the names you choose and whether each is working."
      />
      <ErrorNote error={pages.error} />
      {!can("admin") && <ViewOnlyNote what="status pages" />}

      <Can min="admin">
        {editing === null && (
          <div className="mb-4">
            <Button onClick={() => setEditing("new")}>New status page</Button>
          </div>
        )}
        {editing === "new" && (
          <div className="mb-4">
            <StatusPageForm
              isNew
              initial={EMPTY}
              monitors={monitorList}
              assets={assetList}
              saving={isPending("save")}
              onSave={(d) => save("new", d)}
              onCancel={() => setEditing(null)}
            />
          </div>
        )}
      </Can>

      {pages.isLoading && !pages.data && <ListSkeleton />}
      {pages.data?.length === 0 && editing !== "new" && (
        <EmptyState
          title="No status pages yet"
          body="Create one to give customers a place to check your status instead of asking you."
        />
      )}
      <div className="space-y-3">
        {pages.data?.map((p) =>
          editingPage?.id === p.id ? (
            <StatusPageForm
              key={p.id}
              isNew={false}
              initial={{
                title: p.title,
                slug: p.slug,
                description: p.description,
                published: p.published,
                notice: p.notice,
                noticeKind: p.noticeKind,
                components: p.components.map((c) => ({
                  monitorId: c.monitorId,
                  displayName: c.displayName,
                })),
                customDomain: p.customDomain ?? "",
                securityAssetId: p.securityAssetId ?? "",
              }}
              monitors={monitorList}
              assets={assetList}
              saving={isPending("save")}
              onSave={(d) => save(p.id, d)}
              onCancel={() => setEditing(null)}
            />
          ) : (
            <Panel key={p.id} className="p-5">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="flex flex-wrap items-center gap-2 font-bold tracking-tight">
                    {p.title}
                    {p.published ? (
                      <Badge>Published</Badge>
                    ) : (
                      <Badge variant="outline">Draft</Badge>
                    )}
                  </p>
                  <p className="text-muted-foreground mt-1 text-sm break-all">
                    {p.published ? (
                      <a
                        href={`/status/${p.slug}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-foreground underline underline-offset-4"
                      >
                        {origin}/status/{p.slug}
                      </a>
                    ) : (
                      <>
                        {origin}/status/{p.slug} (not public yet)
                      </>
                    )}{" "}
                    · {p.components.length} component{p.components.length === 1 ? "" : "s"} ·{" "}
                    {p.subscribers} subscriber{p.subscribers === 1 ? "" : "s"}
                  </p>
                </div>
                <Can min="admin">
                  <div className="flex items-center gap-1">
                    {p.published && (
                      <Button variant="outline" size="sm" onClick={() => copy(p.slug)}>
                        Copy link
                      </Button>
                    )}
                    <Button variant="outline" size="sm" onClick={() => setEditing(p.id)}>
                      Edit
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      loading={isPending(`del:${p.id}`)}
                      onClick={() => remove(p.id, p.title)}
                    >
                      Delete
                    </Button>
                  </div>
                </Can>
              </div>
              {p.published && <BadgeEmbeds page={p} />}
              {p.customDomain && (
                <CustomDomain
                  page={p}
                  onChanged={() => pages.mutate()}
                  verify={async () => {
                    const r = (await unwrap(
                      api["status-page"]({ id: p.id })["verify-domain"].post(),
                    )) as {
                      verified: boolean;
                      txt: boolean;
                      pointsToUs: boolean | null;
                    };
                    await pages.mutate();
                    return r;
                  }}
                  canEdit={can("admin")}
                />
              )}
            </Panel>
          ),
        )}
      </div>
    </>
  );
}
