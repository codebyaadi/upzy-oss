"use client";

import { Button } from "@upzy/ui/components/button";
import { toast } from "@upzy/ui/components/sonner";

import { Panel } from "@/components/app/ui";

export interface FixData {
  target: string;
  detected: string;
  steps: string[];
  snippets: { label: string; language: string; code: string }[];
  caveat?: string | undefined;
}

async function copy(text: string) {
  try {
    await navigator.clipboard.writeText(text);
    toast.success("Copied");
  } catch {
    toast.error("Couldn't copy", { description: "Select the text and copy it by hand." });
  }
}

/** Instructions written for the stack we detected, with copy-ready snippets. Shown even when AI is off. */
export function FixForStack({
  fix,
  title = "Fix it for your stack",
  children,
}: {
  fix: FixData;
  title?: string;
  /** Extra controls under the instructions, e.g. the Verify fix button. */
  children?: React.ReactNode;
}) {
  return (
    <Panel>
      <h2 className="text-xl font-bold tracking-tight">{title}</h2>
      <p className="text-muted-foreground mt-1 mb-4 text-sm">
        {fix.detected === "Unknown" ? (
          "We couldn't tell what this site runs on, so these cover the common setups."
        ) : (
          <>
            We detected <strong className="text-foreground">{fix.detected}</strong>. If that&apos;s
            wrong, use the snippet that matches what you run.
          </>
        )}
      </p>
      <ol className="mb-4 list-decimal space-y-2 pl-5 text-sm leading-relaxed">
        {fix.steps.map((s, i) => (
          <li key={i}>{s}</li>
        ))}
      </ol>
      <div className="space-y-3">
        {fix.snippets.map((s, i) => (
          <div key={i}>
            <div className="mb-1 flex items-center justify-between gap-2">
              <span className="text-muted-foreground text-xs font-semibold">{s.label}</span>
              <Button variant="ghost" size="sm" onClick={() => copy(s.code)}>
                Copy
              </Button>
            </div>
            <pre className="bg-muted overflow-x-auto rounded-xl px-4 py-3 font-mono text-xs leading-relaxed whitespace-pre">
              {s.code}
            </pre>
          </div>
        ))}
      </div>
      {fix.caveat && <p className="text-muted-foreground mt-4 text-xs">{fix.caveat}</p>}
      {children}
    </Panel>
  );
}
