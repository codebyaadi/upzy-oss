import { and, eq, inArray } from "drizzle-orm";

import type { Db } from "./drizzle";
import { pendingWorkspaceAccess, restrictedMembers, workspaceAccess, workspaces } from "./schema";

export async function isRestrictedMember(db: Db, organizationId: string, userId: string) {
  const [row] = await db
    .select({ userId: restrictedMembers.userId })
    .from(restrictedMembers)
    .where(
      and(
        eq(restrictedMembers.organizationId, organizationId),
        eq(restrictedMembers.userId, userId),
      ),
    );
  return !!row;
}

/** Replaces a member's limit: which workspaces they may see, or none (`null`) to lift it. */
export async function setMemberAccess(
  db: Db,
  organizationId: string,
  userId: string,
  workspaceIds: string[] | null,
) {
  await db.transaction(async (tx) => {
    const inOrg = tx
      .select({ id: workspaces.id })
      .from(workspaces)
      .where(eq(workspaces.orgId, organizationId));
    await tx
      .delete(workspaceAccess)
      .where(and(eq(workspaceAccess.userId, userId), inArray(workspaceAccess.workspaceId, inOrg)));
    await tx
      .delete(restrictedMembers)
      .where(
        and(
          eq(restrictedMembers.organizationId, organizationId),
          eq(restrictedMembers.userId, userId),
        ),
      );
    if (workspaceIds === null) return;
    await tx.insert(restrictedMembers).values({ organizationId, userId });
    if (workspaceIds.length)
      await tx
        .insert(workspaceAccess)
        .values([...new Set(workspaceIds)].map((workspaceId) => ({ userId, workspaceId })));
  });
}

/** Records the limit for someone who has been invited but hasn't joined (replaces any earlier one for that address). */
export async function setPendingAccess(
  db: Db,
  organizationId: string,
  email: string,
  workspaceIds: string[] | null,
) {
  const address = email.trim().toLowerCase();
  await db.transaction(async (tx) => {
    await tx
      .delete(pendingWorkspaceAccess)
      .where(
        and(
          eq(pendingWorkspaceAccess.organizationId, organizationId),
          eq(pendingWorkspaceAccess.email, address),
        ),
      );
    if (workspaceIds === null) return;
    const ids = [...new Set(workspaceIds)];
    await tx
      .insert(pendingWorkspaceAccess)
      .values(
        ids.length
          ? ids.map((workspaceId) => ({ organizationId, email: address, workspaceId }))
          : [{ organizationId, email: address, workspaceId: null }],
      );
  });
}

/**
 * Turns an invitation's recorded limit into the person's real one. "none": nothing was recorded, so they join
 * unrestricted. "refused": a limit was recorded but the role can't be limited (admin or owner), so they must not join.
 */
export async function applyPendingAccess(
  db: Db,
  opts: { organizationId: string; email: string; userId: string; allowed: boolean },
): Promise<"none" | "applied" | "refused"> {
  const address = opts.email.trim().toLowerCase();
  const rows = await db
    .select({ workspaceId: pendingWorkspaceAccess.workspaceId })
    .from(pendingWorkspaceAccess)
    .where(
      and(
        eq(pendingWorkspaceAccess.organizationId, opts.organizationId),
        eq(pendingWorkspaceAccess.email, address),
      ),
    );
  if (rows.length === 0) return "none";
  if (!opts.allowed) return "refused";
  await setMemberAccess(
    db,
    opts.organizationId,
    opts.userId,
    rows.flatMap((r) => (r.workspaceId ? [r.workspaceId] : [])),
  );
  await db
    .delete(pendingWorkspaceAccess)
    .where(
      and(
        eq(pendingWorkspaceAccess.organizationId, opts.organizationId),
        eq(pendingWorkspaceAccess.email, address),
      ),
    );
  return "applied";
}
