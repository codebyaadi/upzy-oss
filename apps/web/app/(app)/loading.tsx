import { Skeleton } from "@upzy/ui/components/skeleton";

import { ListSkeleton } from "@/components/app/ui";

/** Instant fallback while a dashboard route loads: the shape of a page (heading, description, action, list). */
export default function Loading() {
  return (
    <div role="status" aria-label="Loading">
      <div className="mb-8 flex flex-wrap items-end justify-between gap-4">
        <div className="space-y-3">
          <Skeleton className="h-10 w-64" />
          <Skeleton className="h-4 w-80 max-w-full" />
        </div>
        <Skeleton className="h-11 w-36 rounded-full" />
      </div>
      <ListSkeleton rows={4} />
    </div>
  );
}
