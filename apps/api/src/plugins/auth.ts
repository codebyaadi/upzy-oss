import { effectiveRole, hasRole, type Role } from "@upzy/auth/roles";
import { TWO_FACTOR_REQUIRED } from "@upzy/auth/two-factor-hook";
import type { Auth } from "@upzy/auth/types";
import { twoFactorMissing, type Db } from "@upzy/db";
import { Elysia } from "elysia";

import { isRestricted } from "../lib/scope";
import { HttpError } from "./errors";

/**
 * Mounts better-auth and exposes macros:
 *   { auth: true }  requires a session
 *   { org: true }   requires an active organization and membership (any role, including viewer)
 *   { org: "admin" } additionally requires that role or higher (viewer < member < admin < owner)
 * `org` injects `user`, `session`, `orgId` and the caller's effective `role`. A member limited to some workspaces is
 * capped at `member` here, so they can never reach an admin-only route, whatever role is stored for them.
 */
export const authPlugin = (auth: Pick<Auth, "handler" | "api">, db?: Db) =>
  new Elysia({ name: "auth" })
    .mount(auth.handler as unknown as (req: Request) => Promise<Response>)
    .macro({
      auth: {
        async resolve({ request }) {
          const session = await auth.api.getSession({ headers: request.headers });
          if (!session) throw new HttpError(401, "Invalid or missing session.");
          return { user: session.user, session: session.session };
        },
      },
      org: (minimum: true | Role) => ({
        async resolve({ request }) {
          const session = await auth.api.getSession({ headers: request.headers });
          if (!session) throw new HttpError(401, "Invalid or missing session.");
          const orgId = session.session.activeOrganizationId;
          if (!orgId) throw new HttpError(403, "No active organization context found.");

          const stored = await auth.api.getActiveMemberRole({ headers: request.headers }).then(
            (r) => r.role as string,
            () => null,
          );
          const storedRole = effectiveRole(stored);
          if (!storedRole) throw new HttpError(403, "You are not a member of this organization.");
          // Only an admin or owner can be affected by the cap, so only they cost the extra lookup.
          const limited =
            db && hasRole(stored, "admin") ? await isRestricted(db, orgId, session.user.id) : false;
          const role: Role = limited && hasRole(stored, "admin") ? "member" : storedRole;

          const required: Role = minimum === true ? "viewer" : minimum;
          if (!hasRole(role, required)) {
            throw new HttpError(403, `This action requires the ${required} role or higher.`, {
              organizationId: orgId,
              userId: session.user.id,
            });
          }
          // An organization can require two-factor sign-in. Until the person sets it up they get only this.
          if (db && (await twoFactorMissing(db, session.user, orgId)))
            throw new HttpError(
              403,
              TWO_FACTOR_REQUIRED,
              { organizationId: orgId, userId: session.user.id },
              "two_factor_required",
            );
          return { user: session.user, session: session.session, orgId, role };
        },
      }),
    });

export type AuthPlugin = ReturnType<typeof authPlugin>;
