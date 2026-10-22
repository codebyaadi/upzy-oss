import { schema, type Db } from "@upzy/db";
import { and, eq, exists, inArray, not, or } from "drizzle-orm";

import { HttpError } from "../plugins/errors";

const { workspaces, monitors, restrictedMembers, workspaceAccess } = schema;

/**
 * Subquery of the workspace ids this person may see in their organization: all of them, unless they were limited to
 * some (an agency's client, a contractor), in which case only those. The user is a required argument on purpose, so
 * no query can be written without deciding whose view it is.
 */
export const orgWorkspaceIds = (db: Db, orgId: string, userId: string) =>
  db
    .select({ id: workspaces.id })
    .from(workspaces)
    .where(
      and(
        eq(workspaces.orgId, orgId),
        or(
          not(
            exists(
              db
                .select({ one: restrictedMembers.userId })
                .from(restrictedMembers)
                .where(
                  and(
                    eq(restrictedMembers.organizationId, orgId),
                    eq(restrictedMembers.userId, userId),
                  ),
                ),
            ),
          ),
          exists(
            db
              .select({ one: workspaceAccess.userId })
              .from(workspaceAccess)
              .where(
                and(
                  eq(workspaceAccess.workspaceId, workspaces.id),
                  eq(workspaceAccess.userId, userId),
                ),
              ),
          ),
        ),
      ),
    );

/** Every workspace of the organization, for accounting that must not depend on who is asking (plan usage). Never for showing data. */
export const allOrgWorkspaceIds = (db: Db, orgId: string) =>
  db.select({ id: workspaces.id }).from(workspaces).where(eq(workspaces.orgId, orgId));

/** Whether this person was limited to some workspaces of the organization. */
export async function isRestricted(db: Db, orgId: string, userId: string) {
  const [row] = await db
    .select({ userId: restrictedMembers.userId })
    .from(restrictedMembers)
    .where(and(eq(restrictedMembers.organizationId, orgId), eq(restrictedMembers.userId, userId)));
  return !!row;
}

export async function requireWorkspace(db: Db, orgId: string, workspaceId: string, userId: string) {
  const [ws] = await db
    .select({ id: workspaces.id })
    .from(workspaces)
    .where(
      and(
        eq(workspaces.id, workspaceId),
        inArray(workspaces.id, orgWorkspaceIds(db, orgId, userId)),
      ),
    );
  if (!ws) throw new HttpError(404, "Workspace not found");
}

export async function requireMonitorIn(db: Db, workspaceId: string, monitorId: string) {
  const [m] = await db
    .select({ id: monitors.id })
    .from(monitors)
    .where(and(eq(monitors.id, monitorId), eq(monitors.workspaceId, workspaceId)));
  if (!m) throw new HttpError(404, "Monitor not found");
}

export { inArray };
