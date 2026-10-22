"use client";

import { toast } from "@upzy/ui/components/sonner";
import { useCallback, useState } from "react";

export const errorMessage = (e: unknown) =>
  e instanceof Error && e.message ? e.message : "Something went wrong. Please try again.";

interface Options<T> {
  /** Toast shown on success. A function receives the result. */
  success?: string | ((result: T) => string);
  /** Overrides the error toast title; the underlying message becomes its description. */
  error?: string;
}

/**
 * Runs async actions with a pending state and toast feedback.
 *
 *   const { run, isPending } = useAction();
 *   <Button loading={isPending("delete")} onClick={() => run("delete", () => api…, { success: "Deleted" })} />
 *
 * Returns the result, or `undefined` if the action threw (the error is already shown as a toast).
 */
export function useAction() {
  const [pending, setPending] = useState<Set<string>>(new Set());

  const run = useCallback(
    async <T>(key: string, fn: () => Promise<T>, opts: Options<T> = {}): Promise<T | undefined> => {
      setPending((p) => new Set(p).add(key));
      try {
        const result = await fn();
        if (opts.success)
          toast.success(typeof opts.success === "function" ? opts.success(result) : opts.success);
        return result;
      } catch (e) {
        if (opts.error) toast.error(opts.error, { description: errorMessage(e) });
        else toast.error(errorMessage(e));
        return undefined;
      } finally {
        setPending((p) => {
          const next = new Set(p);
          next.delete(key);
          return next;
        });
      }
    },
    [],
  );

  return { run, isPending: (key: string) => pending.has(key), busy: pending.size > 0 };
}
