import { emails, queueEmail } from "@upzy/auth/email";
import { validUnsubscribeToken } from "@upzy/auth/unsubscribe";
import { deleteOrganization, ownedOrganizations, schema, type Db } from "@upzy/db";
import { eq } from "drizzle-orm";
import { Elysia } from "elysia";
import { z } from "zod";

import { forgetAllStatusPages } from "../lib/status-cache";
import type { AuthPlugin } from "../plugins/auth";
import { HttpError } from "../plugins/errors";

const { users, organizations, members } = schema;

const page = (title: string, body: string) =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${title}</title></head><body style="font-family:system-ui,sans-serif;max-width:32rem;margin:4rem auto;padding:0 1rem;line-height:1.5"><h1 style="font-size:1.25rem">${title}</h1><p>${body}</p></body></html>`;

export interface AccountDeps {
  /** Cancels a paid subscription at the payment provider. Absent when billing is off. */
  cancelSubscription?: (providerSubscriptionId: string) => Promise<void>;
  /** Signs unsubscribe links. */
  secret: string;
}

/**
 * Things about the signed-in person and their organization that aren't tied to a workspace: whether they get product
 * emails, and deleting the organization. (Deleting the account itself is better-auth's /api/auth/delete-user.)
 */
export const accountModule = (db: Db, authP: AuthPlugin, deps: AccountDeps) =>
  new Elysia()
    .use(authP)
    // Public: the link in a lifecycle email. A link scanner opening it just unsubscribes, which is harmless.
    .get(
      "/lifecycle/unsubscribe",
      async ({ query, set }) => {
        set.headers["content-type"] = "text/html; charset=utf-8";
        if (!validUnsubscribeToken(deps.secret, query.u, query.t)) {
          set.status = 400;
          return page("This link isn't valid", "It may have been copied incorrectly.");
        }
        await db.update(users).set({ lifecycleEmails: false }).where(eq(users.id, query.u));
        return page(
          "You're unsubscribed",
          "You won't get Upzy's welcome, tips or trial emails any more. Alerts and account emails (password resets, invitations) still arrive.",
        );
      },
      { query: z.object({ u: z.string().min(1).max(200), t: z.string().min(1).max(200) }) },
    )
    .get(
      "/account",
      async ({ user }) => {
        const [row] = await db
          .select({ lifecycleEmails: users.lifecycleEmails })
          .from(users)
          .where(eq(users.id, user.id));
        const owned = await ownedOrganizations(db, user.id);
        return {
          lifecycleEmails: row?.lifecycleEmails ?? true,
          // Organizations that block deleting the account: this user is their only owner and others belong to them.
          blockedBy: owned
            .filter((o) => o.otherMembers > 0 && o.otherOwners === 0)
            .map((o) => ({ id: o.id, name: o.name })),
        };
      },
      { auth: true },
    )
    .patch(
      "/account",
      async ({ user, body }) => {
        await db
          .update(users)
          .set({ lifecycleEmails: body.lifecycleEmails })
          .where(eq(users.id, user.id));
        return { lifecycleEmails: body.lifecycleEmails };
      },
      { auth: true, body: z.object({ lifecycleEmails: z.boolean() }) },
    )
    // The active organization and all of its data. Typing its exact name guards against deleting the wrong one.
    .delete(
      "/organization",
      async ({ orgId, user, body, set }) => {
        const [org] = await db
          .select({ name: organizations.name })
          .from(organizations)
          .where(eq(organizations.id, orgId));
        if (!org) throw new HttpError(404, "Organization not found");
        if (body.confirm.trim() !== org.name)
          throw new HttpError(422, "Type the organization's name exactly to confirm.");

        const people = await db
          .select({ name: users.name, email: users.email, id: users.id })
          .from(members)
          .innerJoin(users, eq(users.id, members.userId))
          .where(eq(members.organizationId, orgId));

        try {
          await deleteOrganization(db, orgId, { cancelSubscription: deps.cancelSubscription });
        } catch (e) {
          console.error("[organization] delete failed", orgId, e);
          throw new HttpError(
            502,
            "The subscription couldn't be cancelled, so nothing was deleted. Try again in a moment.",
          );
        }
        forgetAllStatusPages();

        const send = queueEmail(db);
        for (const p of people.filter((x) => x.id !== user.id))
          await send(
            emails.organizationDeleted({
              to: p.email,
              name: p.name,
              organization: org.name,
              by: user.name,
            }),
          ).catch(() => {});
        set.status = 204;
      },
      { org: "owner", body: z.object({ confirm: z.string().min(1).max(200) }) },
    );
