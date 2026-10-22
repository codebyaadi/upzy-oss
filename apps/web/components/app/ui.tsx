import { Badge } from "@upzy/ui/components/badge";
import { Label } from "@upzy/ui/components/label";
import { Skeleton } from "@upzy/ui/components/skeleton";
import { cn } from "@upzy/ui/lib/utils";
import type { Route } from "next";
import Link from "next/link";

/**
 * Sets the document title. React 19 hoists a <title> rendered anywhere in the tree into <head>,
 * so client pages (which cannot export Next metadata) still get a distinct title per page.
 */
export function PageTitle({ children }: { children: string }) {
  return <title>{`${children} · Upzy`}</title>;
}

export function PageHeader({
  title,
  description,
  actions,
}: {
  title: string;
  description?: string;
  actions?: React.ReactNode;
}) {
  return (
    <div className="mb-8 flex flex-wrap items-end justify-between gap-4">
      <PageTitle>{title}</PageTitle>
      <div>
        <h1 className="text-3xl font-extrabold tracking-tighter text-balance sm:text-4xl">
          {title}
        </h1>
        {description && <p className="text-muted-foreground mt-2 max-w-xl">{description}</p>}
      </div>
      {actions}
    </div>
  );
}

export function Panel({ className, ...props }: React.ComponentProps<"section">) {
  return (
    <section
      className={cn("bg-card/70 rounded-3xl border p-6 backdrop-blur", className)}
      {...props}
    />
  );
}

type Status = "up" | "down" | "unknown" | "paused";
const statusMeta: Record<Status, { label: string; dot: string }> = {
  up: { label: "Up", dot: "bg-brand" },
  down: { label: "Down", dot: "bg-destructive" },
  unknown: { label: "Pending", dot: "bg-muted-foreground/50" },
  paused: { label: "Paused", dot: "bg-muted-foreground/50" },
};

/** Colour is never the only signal: the label always accompanies the dot. */
export function StatusPill({ status }: { status: Status }) {
  const m = statusMeta[status];
  return (
    <span className="inline-flex items-center gap-2 text-sm font-semibold">
      <span aria-hidden className={cn("size-2 rounded-full", m.dot)} />
      {m.label}
    </span>
  );
}

export function IncidentBadge({ status }: { status: "open" | "acknowledged" | "resolved" }) {
  return (
    <Badge variant={status === "resolved" ? "secondary" : "destructive"} className="capitalize">
      {status}
    </Badge>
  );
}

export function EmptyState({
  title,
  body,
  action,
}: {
  title: string;
  body: string;
  action?: React.ReactNode;
}) {
  return (
    <Panel className="py-14 text-center">
      <h2 className="text-xl font-bold tracking-tight">{title}</h2>
      <p className="text-muted-foreground mx-auto mt-2 max-w-md">{body}</p>
      {action && <div className="mt-6">{action}</div>}
    </Panel>
  );
}

export function ErrorNote({ error }: { error: unknown }) {
  if (!error) return null;
  return (
    <p role="alert" className="bg-destructive/10 text-destructive rounded-2xl px-4 py-3 text-sm">
      {error instanceof Error ? error.message : String(error)}
    </p>
  );
}

export function Field({
  label,
  hint,
  children,
  htmlFor,
}: {
  label: string;
  hint?: React.ReactNode;
  children: React.ReactNode;
  htmlFor: string;
}) {
  return (
    <div className="space-y-2">
      <Label htmlFor={htmlFor}>{label}</Label>
      {children}
      {hint && <p className="text-muted-foreground text-xs">{hint}</p>}
    </div>
  );
}

/** @deprecated use SelectField */
export const selectClass =
  "h-10 w-full rounded-full border border-input bg-transparent px-4 text-sm focus-visible:ring-1 focus-visible:ring-ring focus-visible:outline-hidden";

export function BackLink({ href, children }: { href: Route; children: React.ReactNode }) {
  return (
    <Link
      href={href}
      className="text-muted-foreground hover:text-foreground mb-4 inline-block text-sm font-semibold"
    >
      ← {children}
    </Link>
  );
}

export type Severity = "critical" | "high" | "medium" | "low" | "info";
export const SEVERITIES: Severity[] = ["critical", "high", "medium", "low", "info"];
const sevClass: Record<Severity, string> = {
  critical: "bg-destructive text-destructive-foreground",
  high: "bg-destructive/15 text-destructive",
  medium: "bg-accent text-accent-foreground",
  low: "bg-secondary text-secondary-foreground",
  info: "bg-secondary text-muted-foreground",
};

/** The label always accompanies the colour. */
export function SeverityBadge({
  severity,
  count,
  className,
}: {
  severity: Severity;
  count?: number;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "inline-flex h-5 items-center rounded-full px-2.5 text-xs font-semibold capitalize",
        sevClass[severity],
        className,
      )}
    >
      {count !== undefined && `${count} `}
      {severity}
    </span>
  );
}

/** Placeholder rows shown while a list loads. Matches the real rows' height so nothing jumps. */
export function ListSkeleton({ rows = 3, className }: { rows?: number; className?: string }) {
  return (
    <div className={cn("space-y-3", className)} role="status" aria-label="Loading">
      {Array.from({ length: rows }, (_, i) => (
        <div
          key={i}
          className="bg-card/70 flex items-center justify-between gap-6 rounded-3xl border px-6 py-5"
        >
          <div className="min-w-0 flex-1 space-y-2.5">
            <Skeleton className="h-4 w-1/3" />
            <Skeleton className="h-3.5 w-2/3" />
          </div>
          <Skeleton className="h-5 w-16 rounded-full" />
        </div>
      ))}
    </div>
  );
}

export function StatSkeleton({ count = 4 }: { count?: number }) {
  return (
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4" role="status" aria-label="Loading">
      {Array.from({ length: count }, (_, i) => (
        <Panel key={i} className="space-y-3 p-5">
          <Skeleton className="h-3.5 w-1/2" />
          <Skeleton className="h-7 w-2/3" />
        </Panel>
      ))}
    </div>
  );
}

/** A heading plus a couple of panels: the generic loading state for detail pages. */
export function DetailSkeleton() {
  return (
    <div className="space-y-6" role="status" aria-label="Loading">
      <div className="space-y-3">
        <Skeleton className="h-9 w-1/2" />
        <Skeleton className="h-4 w-1/3" />
      </div>
      <StatSkeleton />
      <Panel className="space-y-4">
        <Skeleton className="h-5 w-40" />
        <Skeleton className="h-48 w-full" />
      </Panel>
    </div>
  );
}
