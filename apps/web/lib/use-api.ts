"use client";

import { useEffect, useRef } from "react";
import useSWR, { useSWRConfig, type SWRConfiguration } from "swr";

import { api } from "@/lib/api";

/** Eden returns `{ data, error }`; turn failures into thrown errors so SWR can surface them. */
export async function unwrap<T>(
  p: Promise<{ data: T | null; error: { status: unknown; value: unknown } | null }>,
): Promise<T> {
  const { data, error } = await p;
  if (error) {
    const v = error.value as { message?: string } | undefined;
    throw new Error(v?.message ?? `Request failed (${String(error.status)})`);
  }
  return data as T;
}

/**
 * Refreshes every minute by default (and not at all while the tab is hidden: SWR pauses hidden tabs unless told
 * otherwise); pass `null` as key to skip. State that changes (monitor status, incidents) is refetched sooner by
 * `useLiveChanges`, which watches a cheap feed, so a short interval here is only for pages that wait on a job.
 */
export function useApi<T>(
  key: string | null,
  fetcher: () => Promise<T>,
  config?: SWRConfiguration<T>,
) {
  return useSWR<T>(key, fetcher, { refreshInterval: 60_000, revalidateOnFocus: true, ...config });
}

/** Cache keys holding monitor state, refetched when the monitors change. */
const MONITOR_KEYS = ["monitors:", "monitor:", "overview"];
/** Cache keys holding incidents, refetched when the incidents change. */
const INCIDENT_KEYS = ["incidents:", "incident:", "incident-group:", "overview", "monitor:"];

/**
 * Watches the workspace's change feed every 5 seconds (only while the tab is visible) and refetches the pages that
 * show monitor state or incidents when their fingerprint changes. Mount it once, inside the workspace.
 */
export function useLiveChanges(workspaceId: string) {
  const { data } = useSWR(
    `changes:${workspaceId}`,
    () => unwrap(api.changes.get({ query: { workspaceId } })),
    { refreshInterval: 5_000, revalidateOnFocus: true, dedupingInterval: 2_000 },
  );
  const { mutate } = useSWRConfig();
  const last = useRef<typeof data>(undefined);
  useEffect(() => {
    const before = last.current;
    last.current = data;
    // The first reading is the baseline: the pages just loaded it themselves.
    if (!data || !before) return;
    const prefixes = [
      ...(data.monitors !== before.monitors ? MONITOR_KEYS : []),
      ...(data.incidents !== before.incidents ? INCIDENT_KEYS : []),
    ];
    if (prefixes.length === 0) return;
    void mutate((k) => typeof k === "string" && prefixes.some((p) => k.startsWith(p)));
  }, [data, mutate]);
}
