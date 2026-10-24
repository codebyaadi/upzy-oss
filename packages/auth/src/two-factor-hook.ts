import { twoFactorMissing, type Db } from "@upzy/db";
import { APIError, createAuthMiddleware, getSessionFromCtx } from "better-auth/api";

/**
 * Organization actions that better-auth handles itself (not our routes, which check the same rule in the auth
 * plugin). Without this, someone who skipped two-factor setup could still add members or change roles.
 */
const GUARDED = new Set([
  "/organization/update",
  "/organization/delete",
  "/organization/invite-member",
  "/organization/cancel-invitation",
  "/organization/update-member-role",
  "/organization/remove-member",
]);

export const TWO_FACTOR_REQUIRED =
  "This organization requires two-factor authentication. Set it up under Account → Security first.";

export const twoFactorHook = (db: Db) =>
  createAuthMiddleware(async (ctx) => {
    if (!GUARDED.has(ctx.path)) return;
    const session = await getSessionFromCtx(ctx).catch(() => null);
    if (!session) return;
    const body = (ctx.body ?? {}) as { organizationId?: unknown };
    const orgId =
      typeof body.organizationId === "string"
        ? body.organizationId
        : session.session.activeOrganizationId;
    if (orgId && (await twoFactorMissing(db, session.user, orgId)))
      throw new APIError("FORBIDDEN", { message: TWO_FACTOR_REQUIRED });
  });
