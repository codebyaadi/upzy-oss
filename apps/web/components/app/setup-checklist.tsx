import { Tick02Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { cn } from "@upzy/ui/lib/utils";
import type { Route } from "next";
import Link from "next/link";

import { Panel } from "./ui";

export interface SetupStep {
  label: string;
  hint?: string;
  done: boolean;
  href?: Route;
}

/** A short list of what is left to set up, shown while any step is open. Renders nothing once all are done. */
export function SetupChecklist({ title, steps }: { title: string; steps: SetupStep[] }) {
  const left = steps.filter((s) => !s.done).length;
  if (left === 0) return null;
  return (
    <Panel className="mb-6">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-lg font-bold tracking-tight">{title}</h2>
        <p className="text-muted-foreground text-sm">
          {steps.length - left} of {steps.length} done
        </p>
      </div>
      <ol className="mt-4 space-y-3">
        {steps.map((s) => {
          const body = (
            <>
              <span
                aria-hidden
                className={cn(
                  "mt-0.5 grid size-5 shrink-0 place-items-center rounded-full border",
                  s.done ? "bg-brand text-background border-transparent" : "border-input",
                )}
              >
                {s.done && <HugeiconsIcon icon={Tick02Icon} className="size-3.5" />}
              </span>
              <span className="min-w-0">
                <span
                  className={cn(
                    "block text-sm font-semibold",
                    s.done && "text-muted-foreground line-through",
                  )}
                >
                  {s.label}
                </span>
                {s.hint && !s.done && (
                  <span className="text-muted-foreground block text-xs">{s.hint}</span>
                )}
                <span className="sr-only">{s.done ? " (done)" : " (to do)"}</span>
              </span>
            </>
          );
          return (
            <li key={s.label}>
              {s.href && !s.done ? (
                <Link
                  href={s.href}
                  className="hover:bg-accent/60 -mx-2 flex gap-3 rounded-xl px-2 py-1"
                >
                  {body}
                </Link>
              ) : (
                <div className="flex gap-3">{body}</div>
              )}
            </li>
          );
        })}
      </ol>
    </Panel>
  );
}
