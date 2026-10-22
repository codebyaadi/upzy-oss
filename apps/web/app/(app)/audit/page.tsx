"use client";

import { Button } from "@upzy/ui/components/button";
import { toast } from "@upzy/ui/components/sonner";
import { cn } from "@upzy/ui/lib/utils";
import { useEffect, useState } from "react";

import { ViewOnlyNote } from "@/components/app/can";
import { SelectField } from "@/components/app/select-field";
import { EmptyState, ErrorNote, ListSkeleton, PageHeader } from "@/components/app/ui";
import { useWorkspace } from "@/components/app/workspace";
import { api } from "@/lib/api";
import { dateTime } from "@/lib/format";
import { unwrap } from "@/lib/use-api";

const TYPES = [
  "workspace",
  "monitor",
  "channel",
  "alert-rule",
  "asset",
  "finding",
  "discovery",
  "incident",
  "organization",
  "member",
  "invitation",
];

type Item = Awaited<ReturnType<typeof fetchPage>>["items"][number];

const fetchPage = (resourceType: string, before?: string) =>
  unwrap(
    api.audit.get({
      query: {
        limit: 50,
        ...(resourceType ? { resourceType } : {}),
        ...(before ? { before } : {}),
      },
    }),
  );

export default function AuditPage() {
  const { can } = useWorkspace();
  const [filter, setFilter] = useState("all");
  const resourceType = filter === "all" ? "" : filter;
  const [exporting, setExporting] = useState(false);
  const [items, setItems] = useState<Item[]>([]);
  const [next, setNext] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const allowed = can("admin");

  useEffect(() => {
    if (!allowed) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetchPage(resourceType)
      .then((page) => {
        if (cancelled) return;
        setItems(page.items);
        setNext(page.next);
      })
      .catch((e) => !cancelled && setError(e))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [resourceType, allowed]);

  async function loadMore() {
    if (!next) return;
    setLoading(true);
    try {
      const page = await fetchPage(resourceType, next);
      setItems((prev) => [...prev, ...page.items]);
      setNext(page.next);
    } catch (e) {
      setError(e);
    }
    setLoading(false);
  }

  async function exportCsv() {
    setExporting(true);
    try {
      const base = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3000";
      const res = await fetch(
        `${base}/audit/export${resourceType ? `?resourceType=${encodeURIComponent(resourceType)}` : ""}`,
        { credentials: "include" },
      );
      if (!res.ok) throw new Error("The server refused the export");
      const url = URL.createObjectURL(await res.blob());
      const a = document.createElement("a");
      a.href = url;
      a.download = `audit-log-${new Date().toISOString().slice(0, 10)}.csv`;
      a.click();
      URL.revokeObjectURL(url);
      toast.success("Audit log exported");
    } catch (e) {
      toast.error("Couldn't export the audit log", {
        description: e instanceof Error ? e.message : undefined,
      });
    }
    setExporting(false);
  }

  if (!allowed) {
    return (
      <>
        <PageHeader title="Audit log" />
        <ViewOnlyNote what="the audit log" />
        <p className="text-muted-foreground text-sm">
          The audit log is visible to admins and owners.
        </p>
      </>
    );
  }

  return (
    <>
      <PageHeader
        title="Audit log"
        description="Every change made in this organization, including attempts that were refused."
        actions={
          <div className="flex gap-2">
            <SelectField
              aria-label="Filter by resource"
              className="w-44"
              value={filter}
              onValueChange={setFilter}
              options={[
                { value: "all", label: "All resources" },
                ...TYPES.map((t) => ({ value: t, label: t })),
              ]}
            />
            <Button variant="outline" loading={exporting} onClick={exportCsv}>
              Export CSV
            </Button>
          </div>
        }
      />
      <ErrorNote error={error} />
      {loading && items.length === 0 && <ListSkeleton rows={5} />}
      {!loading && items.length === 0 && (
        <EmptyState
          title="Nothing recorded yet"
          body="Changes made by your team will show up here."
        />
      )}
      {items.length > 0 && (
        <div className="bg-card/70 overflow-x-auto rounded-3xl border backdrop-blur">
          <table className="w-full min-w-[44rem] text-left text-sm">
            <thead className="text-muted-foreground text-xs">
              <tr className="border-b">
                <th className="px-5 py-3 font-medium">When</th>
                <th className="px-3 py-3 font-medium">Who</th>
                <th className="px-3 py-3 font-medium">Action</th>
                <th className="px-3 py-3 font-medium">Result</th>
                <th className="px-5 py-3 font-medium">From</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {items.map((i) => (
                <tr key={i.id} className="align-top">
                  <td className="px-5 py-3 whitespace-nowrap">{dateTime(i.createdAt)}</td>
                  <td className="px-3 py-3">
                    <span className="font-semibold">{i.userName ?? "Unknown"}</span>
                    <span className="text-muted-foreground block text-xs">{i.userEmail}</span>
                  </td>
                  <td className="px-3 py-3">
                    <code className="font-mono text-xs">{i.action}</code>
                    {i.resourceId && (
                      <span className="text-muted-foreground block max-w-60 truncate font-mono text-xs">
                        {i.resourceId}
                      </span>
                    )}
                  </td>
                  <td className="px-3 py-3 whitespace-nowrap">
                    <span
                      className={cn(
                        "inline-flex h-5 items-center rounded-full px-2.5 text-xs font-semibold",
                        (i.status ?? 200) >= 400
                          ? "bg-destructive/15 text-destructive"
                          : "bg-secondary text-secondary-foreground",
                      )}
                    >
                      {(i.status ?? 200) >= 400 ? `Refused/failed (${i.status})` : "OK"}
                    </span>
                  </td>
                  <td className="text-muted-foreground px-5 py-3 text-xs whitespace-nowrap">
                    {i.ip ?? "–"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {next && (
        <div className="mt-4 text-center">
          <Button variant="outline" onClick={loadMore} loading={loading}>
            Load more
          </Button>
        </div>
      )}
    </>
  );
}
