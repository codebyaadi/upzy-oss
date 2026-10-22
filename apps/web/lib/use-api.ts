"use client";

import useSWR, { type SWRConfiguration } from "swr";

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

/** Polls every 15s by default; pass `null` as key to skip. */
export function useApi<T>(
  key: string | null,
  fetcher: () => Promise<T>,
  config?: SWRConfiguration<T>,
) {
  return useSWR<T>(key, fetcher, { refreshInterval: 15_000, revalidateOnFocus: true, ...config });
}
