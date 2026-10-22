import { effectiveRole, hasRole, type Role } from "@upzy/auth/roles";
import type { Auth } from "@upzy/auth/types";
import { Elysia } from "elysia";

import { HttpError } from "./errors";

/**
 * Mounts better-auth and exposes macros:
 *   { auth: true }  requires a session
 *   { org: true }   requires an active organization and membership (any role, including viewer)
 *   { org: "admin" } additionally requires that role or higher (viewer < member < admin < owner)
 * `org` injects `user`, `session`, `orgId` and the caller's effective `role`.
 */
export const authPlugin = (auth: Pick<Auth, "handler" | "api">) =>
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
          const role = effectiveRole(stored);
          if (!role) throw new HttpError(403, "You are not a member of this organization.");

          const required: Role = minimum === true ? "viewer" : minimum;
          if (!hasRole(stored, required)) {
            throw new HttpError(403, `This action requires the ${required} role or higher.`, {
              organizationId: orgId,
              userId: session.user.id,
            });
          }
          return { user: session.user, session: session.session, orgId, role };
        },
      }),
    });

export type AuthPlugin = ReturnType<typeof authPlugin>;
