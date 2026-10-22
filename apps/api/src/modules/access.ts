import { effectiveRole, hasRole } from "@upzy/auth/roles";
import { schema, setMemberAccess, setPendingAccess, type Db } from "@upzy/db";
import { and, eq, inArray } from "drizzle-orm";
import { Elysia } from "elysia";
import { z } from "zod";

import { allOrgWorkspaceIds } from "../lib/scope";
import type { AuthPlugin } from "../plugins/auth";
import { HttpError } from "../plugins/errors";

const {
  members,
  users,
  invitations,
  workspaces,
  restrictedMembers,
  workspaceAccess,
  pendingWorkspaceAccess,
} = schema;

const Limit = z.object({
  /** false lifts the limit (they see every workspace again). */
  restricted: z.boolean(),
  workspaceIds: z.array(z.uuid()).max(500).default([]),
});

/**
 * Who may see which workspaces. By default everyone in an organization sees all of them; an admin can limit a viewer
 * or member (an agency's client, a contractor) to chosen ones. Only admins manage this, and a limited person is capped
 * below admin everywhere (see plugins/auth.ts), so they can never lift their own limit.
 */
export const accessModule = (db: Db, authP: AuthPlugin) => {
  /** The ids must all be workspaces of this organization: an admin sees all of them, so this is a plain org check. */
  async function checkWorkspaces(orgId: string, ids: string[]) {
    if (ids.length === 0) return;
    const found = await db
      .select({ id: workspaces.id })
      .from(workspaces)
      .where(
        and(inArray(workspaces.id, ids), inArray(workspaces.id, allOrgWorkspaceIds(db, orgId))),
      );
    if (found.length !== new Set(ids).size)
      throw new HttpError(422, "One of the chosen workspaces isn't in this organization.");
  }

  const onlyLimitable = (role: string | null | undefined) => {
    if (hasRole(role, "admin"))
      throw new HttpError(
        422,
        "Only viewers and members can be limited to some workspaces. Admins and owners always see everything.",
      );
  };

  return (
    new Elysia({ prefix: "/access" })
      .use(authP)
      .get(
        "/",
        async ({ orgId }) => {
          const people = await db
            .select({
              userId: members.userId,
              role: members.role,
              name: users.name,
              email: users.email,
            })
            .from(members)
            .innerJoin(users, eq(users.id, members.userId))
            .where(eq(members.organizationId, orgId));
          const restricted = new Set(
            (
              await db
                .select({ userId: restrictedMembers.userId })
                .from(restrictedMembers)
                .where(eq(restrictedMembers.organizationId, orgId))
            ).map((r) => r.userId),
          );
          const grants = await db
            .select({ userId: workspaceAccess.userId, workspaceId: workspaceAccess.workspaceId })
            .from(workspaceAccess)
            .where(inArray(workspaceAccess.workspaceId, allOrgWorkspaceIds(db, orgId)));

          const pending = await db
            .select({
              email: pendingWorkspaceAccess.email,
              workspaceId: pendingWorkspaceAccess.workspaceId,
            })
            .from(pendingWorkspaceAccess)
            .where(eq(pendingWorkspaceAccess.organizationId, orgId));
          const pendingEmails = [...new Set(pending.map((p) => p.email))];

          return {
            members: people.map((p) => ({
              userId: p.userId,
              name: p.name,
              email: p.email,
              role: effectiveRole(p.role) ?? "viewer",
              restricted: restricted.has(p.userId),
              workspaceIds: grants.filter((g) => g.userId === p.userId).map((g) => g.workspaceId),
            })),
            invited: pendingEmails.map((email) => ({
              email,
              workspaceIds: pending
                .filter((p) => p.email === email && p.workspaceId)
                .map((p) => p.workspaceId!),
            })),
          };
        },
        { org: "admin" },
      )
      .put(
        "/member/:userId",
        async ({ params, body, orgId }) => {
          const [target] = await db
            .select({ role: members.role })
            .from(members)
            .where(and(eq(members.organizationId, orgId), eq(members.userId, params.userId)));
          if (!target) throw new HttpError(404, "That person isn't in this organization.");
          if (body.restricted) {
            onlyLimitable(target.role);
            await checkWorkspaces(orgId, body.workspaceIds);
          }
          await setMemberAccess(
            db,
            orgId,
            params.userId,
            body.restricted ? body.workspaceIds : null,
          );
          return { ok: true as const };
        },
        { org: "admin", params: z.object({ userId: z.string().min(1).max(200) }), body: Limit },
      )
      // Recorded before the invitation is sent, and applied the moment it is accepted.
      .put(
        "/invited",
        async ({ body, orgId }) => {
          if (body.restricted) {
            onlyLimitable(body.role);
            await checkWorkspaces(orgId, body.workspaceIds);
          }
          await setPendingAccess(db, orgId, body.email, body.restricted ? body.workspaceIds : null);
          return { ok: true as const };
        },
        {
          org: "admin",
          body: Limit.extend({
            email: z.email().max(254),
            role: z.string().max(40).default("viewer"),
          }),
        },
      )
      // The invitation was cancelled: forget its limit too.
      .delete(
        "/invited",
        async ({ query, orgId, set }) => {
          const [open] = await db
            .select({ id: invitations.id })
            .from(invitations)
            .where(
              and(
                eq(invitations.organizationId, orgId),
                eq(invitations.email, query.email.toLowerCase()),
                eq(invitations.status, "pending"),
              ),
            );
          // A live invitation still needs its limit; clearing it would widen access.
          if (open) throw new HttpError(409, "Cancel the invitation first.");
          await setPendingAccess(db, orgId, query.email, null);
          set.status = 204;
        },
        { org: "admin", query: z.object({ email: z.email().max(254) }) },
      )
  );
};
