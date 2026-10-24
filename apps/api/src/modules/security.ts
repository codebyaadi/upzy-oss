import {
  membersWithoutTwoFactor,
  orgRequiresTwoFactor,
  schema,
  twoFactorMissing,
  usesOrgSso,
  type Db,
} from "@upzy/db";
import { Elysia } from "elysia";
import { z } from "zod";

import type { AuthPlugin } from "../plugins/auth";
import { HttpError } from "../plugins/errors";

/**
 * Sign-in rules for the organization. Setting up two-factor itself is better-auth's /api/auth/two-factor/*;
 * this is only the organization's rule that everyone must.
 */
export const securityModule = (db: Db, authP: AuthPlugin) =>
  new Elysia()
    .use(authP)
    // Needs only a session, so a person the rule locks out can still find out why and get to the setup page.
    .get(
      "/security",
      async ({ user, session }) => {
        const orgId = session.activeOrganizationId;
        const required = orgId ? await orgRequiresTwoFactor(db, orgId) : false;
        return {
          twoFactorEnabled: Boolean(user.twoFactorEnabled),
          /** The active organization insists on it. */
          organizationRequires: required,
          /** Signed in but not allowed in yet. Single sign-on counts: its provider asks for the second factor. */
          blocked: orgId ? await twoFactorMissing(db, user, orgId) : false,
        };
      },
      { auth: true },
    )
    .get(
      "/security/policy",
      async ({ orgId }) => {
        const missing = await membersWithoutTwoFactor(db, orgId);
        return {
          requireTwoFactor: await orgRequiresTwoFactor(db, orgId),
          withoutTwoFactor: missing.map((m) => ({ name: m.name, email: m.email })),
        };
      },
      { org: "admin" },
    )
    .put(
      "/security/policy",
      async ({ orgId, user, body }) => {
        // The person turning it on must have it themselves, or they would lock themselves out.
        if (body.requireTwoFactor && !user.twoFactorEnabled && !(await usesOrgSso(db, user.id, orgId)))
          throw new HttpError(
            400,
            "Set up two-factor authentication for your own account first (Account → Security), then require it.",
          );
        await db
          .insert(schema.organizationSecurity)
          .values({
            organizationId: orgId,
            requireTwoFactor: body.requireTwoFactor,
            updatedBy: user.id,
          })
          .onConflictDoUpdate({
            target: schema.organizationSecurity.organizationId,
            set: {
              requireTwoFactor: body.requireTwoFactor,
              updatedBy: user.id,
              updatedAt: new Date(),
            },
          });
        return { requireTwoFactor: body.requireTwoFactor };
      },
      { org: "admin", body: z.object({ requireTwoFactor: z.boolean() }) },
    );
