import { ArrowUpRight01Icon, GithubIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { cn } from "@upzy/ui/lib/utils";

/**
 * The credit: a pill with the GitHub mark that links to the author's profile. It is for the public pages only (the
 * landing hero and under the sign-in forms); the signed-in app is a working tool and carries no credit.
 */
export function BuiltBy({ className }: { className?: string }) {
  return (
    <a
      href="https://github.com/codebyaadi"
      target="_blank"
      rel="noopener noreferrer"
      aria-label="Built by codebyaadi (opens GitHub profile in a new tab)"
      className={cn(
        "bg-card/70 text-muted-foreground hover:text-foreground hover:border-primary/40 group inline-flex h-10 items-center gap-2.5 rounded-full border pr-4 pl-3 text-sm shadow-[var(--shadow-panel)] backdrop-blur transition-colors",
        className,
      )}
    >
      <span className="bg-primary text-primary-foreground grid size-6 place-items-center rounded-full">
        <HugeiconsIcon icon={GithubIcon} className="size-3.5" aria-hidden />
      </span>
      <span>
        Built by <strong className="text-foreground font-semibold">codebyaadi</strong>
      </span>
      <HugeiconsIcon
        icon={ArrowUpRight01Icon}
        className="size-4 opacity-60 transition-transform group-hover:translate-x-0.5 group-hover:-translate-y-0.5 group-hover:opacity-100"
        aria-hidden
      />
    </a>
  );
}
