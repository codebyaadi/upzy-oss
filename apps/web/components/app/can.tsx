"use client";

import type { Role } from "@upzy/auth/roles";

import { useWorkspace } from "./workspace";

/** Renders children only if the caller's role is at least `min`. The API enforces the same rule. */
export function Can({
  min,
  children,
  fallback = null,
}: {
  min: Role;
  children: React.ReactNode;
  fallback?: React.ReactNode;
}) {
  const { can } = useWorkspace();
  return <>{can(min) ? children : fallback}</>;
}

export function ViewOnlyNote({ what }: { what: string }) {
  return (
    <p
      role="note"
      className="bg-secondary text-muted-foreground mb-4 rounded-2xl px-4 py-3 text-sm"
    >
      You have view-only access, so you can look at {what} but not change it. Ask an admin if you
      need more.
    </p>
  );
}
