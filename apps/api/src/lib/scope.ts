import { schema, type Db } from "@upzy/db";
import { and, eq, inArray } from "drizzle-orm";

import { HttpError } from "../plugins/errors";

const { workspaces, monitors } = schema;

/** Subquery of workspace ids owned by the caller's organization. */
export const orgWorkspaceIds = (db: Db, orgId: string) =>
  db.select({ id: workspaces.id }).from(workspaces).where(eq(workspaces.orgId, orgId));

export async function requireWorkspace(db: Db, orgId: string, workspaceId: string) {
  const [ws] = await db
    .select({ id: workspaces.id })
    .from(workspaces)
    .where(and(eq(workspaces.id, workspaceId), eq(workspaces.orgId, orgId)));
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
