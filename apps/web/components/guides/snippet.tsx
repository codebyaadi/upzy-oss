"use client";

import { Button } from "@upzy/ui/components/button";
import { useState } from "react";

/** A block of code with a copy button. */
export function CodeBlock({ label, code }: { label: string; code: string }) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard blocked (an insecure page, a strict browser): the text is still there to select.
    }
  }
  return (
    <figure className="my-3">
      <figcaption className="mb-1 flex items-center justify-between gap-2">
        <span className="text-muted-foreground text-xs font-semibold">{label}</span>
        <Button variant="ghost" size="sm" onClick={copy}>
          {copied ? "Copied" : "Copy"}
        </Button>
      </figcaption>
      <pre className="bg-muted overflow-x-auto rounded-xl px-4 py-3 font-mono text-xs leading-relaxed whitespace-pre">
        {code}
      </pre>
    </figure>
  );
}
