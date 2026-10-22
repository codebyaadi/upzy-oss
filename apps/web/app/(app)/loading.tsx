import { Skeleton } from "@upzy/ui/components/skeleton";

import { ListSkeleton } from "@/components/app/ui";

/** Instant fallback while a dashboard route loads. */
export default function Loading() {
  return (
    <div>
      <Skeleton className="mb-8 h-10 w-64" />
      <ListSkeleton />
    </div>
  );
}
