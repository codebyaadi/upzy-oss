"use client";

import { Button } from "@upzy/ui/components/button";
import { toast } from "@upzy/ui/components/sonner";
import { cn } from "@upzy/ui/lib/utils";
import { useState } from "react";

import { Segmented } from "@/components/app/segmented";

const API = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3000";

type Format = "html" | "markdown" | "url";
type Kind = "status" | "security";

const COPY: Record<Kind, { title: string; what: string; alt: string }> = {
  status: {
    title: "Status badge",
    what: "Shows whether everything is up right now.",
    alt: "Service status",
  },
  security: {
    title: "Security badge",
    what: "Shows your current security grade.",
    alt: "Security grade",
  },
};

/** One badge: a preview on light and dark backgrounds, and its code in the format you need. */
function BadgeCard({ page, kind }: { page: { slug: string }; kind: Kind }) {
  const [format, setFormat] = useState<Format>("html");
  const [copied, setCopied] = useState(false);
  // The security badge only exists once the asset has been scanned.
  const [missing, setMissing] = useState(false);
  const origin = typeof window === "undefined" ? "" : window.location.origin;
  const image = `${API}/public/status/${page.slug}/badge.svg?type=${kind}`;
  const link = `${origin}/status/${page.slug}`;
  const code = {
    html: `<a href="${link}"><img src="${image}" alt="${COPY[kind].alt}" height="20"></a>`,
    markdown: `[![${COPY[kind].alt}](${image})](${link})`,
    url: image,
  }[format];

  async function copy() {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      toast.success("Copied");
      setTimeout(() => setCopied(false), 2000);
    } catch {
      toast.error("Couldn't copy", { description: "Select the code and copy it by hand." });
    }
  }

  return (
    <div className="bg-card rounded-2xl border p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="font-semibold">{COPY[kind].title}</p>
        <p className="text-muted-foreground text-xs">{COPY[kind].what}</p>
      </div>
      {missing ? (
        <p className="text-muted-foreground bg-muted mt-3 rounded-xl px-3 py-4 text-center text-xs">
          Not available yet: the asset hasn&apos;t finished its first scan. The code below will work
          as soon as it has.
        </p>
      ) : (
        <div
          className="mt-3 grid grid-cols-2 overflow-hidden rounded-xl border text-center"
          aria-hidden
        >
          {["bg-white", "bg-neutral-900"].map((bg) => (
            <div key={bg} className={cn("grid place-items-center py-4", bg)}>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={image} alt="" height={20} onError={() => setMissing(true)} />
            </div>
          ))}
        </div>
      )}
      <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
        <Segmented
          label={`${COPY[kind].title} format`}
          value={format}
          onValueChange={setFormat}
          options={[
            { value: "html", label: "HTML" },
            { value: "markdown", label: "Markdown" },
            { value: "url", label: "Image URL" },
          ]}
        />
        <Button size="sm" variant={copied ? "secondary" : "default"} onClick={copy}>
          {copied ? "Copied ✓" : "Copy"}
        </Button>
      </div>
      <pre
        tabIndex={0}
        aria-label={`${COPY[kind].title} code`}
        className="bg-muted mt-3 overflow-x-auto rounded-xl px-3 py-2.5 font-mono text-xs leading-relaxed break-all whitespace-pre-wrap"
      >
        {code}
      </pre>
    </div>
  );
}

/** Embeddable badges for a published status page, shown as a collapsible section on its card. */
export function BadgeEmbeds({ page }: { page: { slug: string; securityAssetId: string | null } }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="mt-3">
      <button
        type="button"
        className="text-muted-foreground hover:text-foreground text-xs font-semibold underline underline-offset-4"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        {open ? "Hide" : "Show"} embeddable badges
      </button>
      {open && (
        <div className="bg-accent/40 mt-3 space-y-3 rounded-2xl p-4">
          <p className="text-muted-foreground text-sm">
            Paste one into a README or your site&apos;s footer. It updates by itself and links to
            your status page.
          </p>
          <div className="grid gap-3 xl:grid-cols-2">
            <BadgeCard page={page} kind="status" />
            {page.securityAssetId ? (
              <BadgeCard page={page} kind="security" />
            ) : (
              <div className="text-muted-foreground grid place-items-center rounded-2xl border border-dashed p-6 text-center text-sm">
                <p>
                  <strong className="text-foreground">Security badge</strong>
                  <br />
                  Turn it on under Edit → &ldquo;Show a security grade&rdquo;.
                </p>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
