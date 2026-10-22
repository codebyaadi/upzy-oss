import type { Db } from "@upzy/db";
import * as schema from "@upzy/db/schema";
import { createAuthMiddleware, getSessionFromCtx } from "better-auth/api";

/** Membership and organization actions handled inside better-auth (not by our own routes). */
const AUDITED: Record<
  string,
  { resourceType: string; id: "memberId" | "invitationId" | "organizationId" | "returned" }
> = {
  "/organization/create": { resourceType: "organization", id: "returned" },
  "/organization/update": { resourceType: "organization", id: "organizationId" },
  "/organization/delete": { resourceType: "organization", id: "organizationId" },
  "/organization/invite-member": { resourceType: "invitation", id: "returned" },
  "/organization/cancel-invitation": { resourceType: "invitation", id: "invitationId" },
  "/organization/accept-invitation": { resourceType: "invitation", id: "invitationId" },
  "/organization/reject-invitation": { resourceType: "invitation", id: "invitationId" },
  "/organization/update-member-role": { resourceType: "member", id: "memberId" },
  "/organization/remove-member": { resourceType: "member", id: "memberId" },
  "/organization/leave": { resourceType: "organization", id: "organizationId" },
};

/** Fields that are safe and useful to keep: who was invited and with which role. Never tokens or passwords. */
const SAFE_FIELDS = ["role", "email", "memberIdOrEmail"] as const;

export const auditHook = (db: Db) =>
  createAuthMiddleware(async (ctx) => {
    const spec = AUDITED[ctx.path];
    if (!spec) return;
    try {
      const body = (ctx.body ?? {}) as Record<string, unknown>;
      const returned = ctx.context.returned as
        | { id?: string; statusCode?: number; status?: string | number }
        | undefined;
      const failed =
        !!returned && (returned instanceof Error || typeof returned.statusCode === "number");

      const session =
        ctx.context.session ??
        ctx.context.newSession ??
        (await getSessionFromCtx(ctx).catch(() => null));
      const userId = session?.user?.id ?? null;
      const organizationId =
        (typeof body.organizationId === "string" ? body.organizationId : null) ??
        session?.session?.activeOrganizationId ??
        (spec.id === "returned" && spec.resourceType === "organization"
          ? (returned?.id ?? null)
          : null);
      if (!organizationId) return; // cannot attribute (e.g. accepting an invitation before an org is active)

      const resourceId =
        spec.id === "returned"
          ? (returned?.id ?? null)
          : typeof body[spec.id] === "string"
            ? (body[spec.id] as string)
            : null;
      const status = failed
        ? typeof returned?.statusCode === "number"
          ? returned.statusCode
          : 400
        : 200;
      const details: Record<string, unknown> = { fields: Object.keys(body) };
      for (const k of SAFE_FIELDS) if (typeof body[k] === "string") details[k] = body[k];

      await db.insert(schema.auditLogs).values({
        organizationId,
        userId,
        action: `POST /api/auth${ctx.path}`,
        resourceType: spec.resourceType,
        resourceId,
        status,
        ip: ctx.request?.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null,
        userAgent: ctx.request?.headers.get("user-agent")?.slice(0, 300) ?? null,
        payload: details,
      });
    } catch (e) {
      // Auditing must never break authentication or membership changes.
      console.error("[audit] auth hook failed", e);
    }
  });
