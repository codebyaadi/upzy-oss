import { cn } from "@upzy/ui/lib/utils";

export function LogoGlyph({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 32" fill="none" aria-hidden className={className}>
      <path
        d="M2.5 17h6.2l3.3-8.5 5.6 16 3.4-9.5h8.5"
        stroke="currentColor"
        strokeWidth="4.2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function Logo({
  className,
  tone = "default",
  markOnly,
}: {
  className?: string;
  tone?: "default" | "inverted";
  markOnly?: boolean;
}) {
  const inverted = tone === "inverted";
  return (
    <span className={cn("inline-flex items-center gap-2.5", className)}>
      <span
        className={cn(
          "grid size-9 shrink-0 place-items-center rounded-xl shadow-sm",
          inverted ? "bg-primary-foreground text-primary" : "bg-primary text-primary-foreground",
        )}
      >
        <LogoGlyph className="size-6" />
      </span>
      {!markOnly && (
        <span className="text-[1.4rem] leading-none font-extrabold tracking-tighter">
          Upzy<span className={inverted ? "opacity-60" : "text-brand"}>.</span>
        </span>
      )}
    </span>
  );
}
