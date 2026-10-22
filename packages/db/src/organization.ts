import { and, eq, ne } from "drizzle-orm";

import type { Db } from "./drizzle";
import { lifecycleEmails, members, organizations, sessions, subscriptions } from "./schema";

export interface OwnedOrganization {
  id: string;
  name: string;
  /** Other people in the organization, whatever their role. */
  otherMembers: number;
  /** Other owners; with one, this user can leave or be deleted without orphaning the organization. */
  otherOwners: number;
}

/** The organizations this user owns, and who else is in them. Decides what deleting the user has to do. */
export async function ownedOrganizations(db: Db, userId: string): Promise<OwnedOrganization[]> {
  const mine = await db
    .select({ id: organizations.id, name: organizations.name, role: members.role })
    .from(members)
    .innerJoin(organizations, eq(organizations.id, members.organizationId))
    .where(eq(members.userId, userId));
  const owned = mine.filter((m) =>
    m.role
      .split(",")
      .map((r) => r.trim())
      .includes("owner"),
  );
  const out: OwnedOrganization[] = [];
  for (const o of owned) {
    const others = await db
      .select({ role: members.role })
      .from(members)
      .where(and(eq(members.organizationId, o.id), ne(members.userId, userId)));
    out.push({
      id: o.id,
      name: o.name,
      otherMembers: others.length,
      otherOwners: others.filter((m) =>
        m.role
          .split(",")
          .map((r) => r.trim())
          .includes("owner"),
      ).length,
    });
  }
  return out;
}

/**
 * Deletes an organization and everything under it (workspaces, monitors, incidents, assets, findings, status pages,
 * channels, memberships, invitations, audit log: all of it cascades from the organization row).
 *
 * A paid subscription is cancelled at the payment provider first, through `cancelSubscription`. If that fails nothing
 * is deleted, so a deleted organization can never keep being billed.
 */
export async function deleteOrganization(
  db: Db,
  orgId: string,
  opts: { cancelSubscription?: (providerSubscriptionId: string) => Promise<void> } = {},
) {
  const [sub] = await db
    .select({
      providerSubscriptionId: subscriptions.providerSubscriptionId,
      status: subscriptions.status,
    })
    .from(subscriptions)
    .where(eq(subscriptions.organizationId, orgId));
  if (sub?.providerSubscriptionId && (sub.status === "active" || sub.status === "past_due")) {
    if (!opts.cancelSubscription)
      throw new Error("This organization has a paid subscription and no way to cancel it.");
    await opts.cancelSubscription(sub.providerSubscriptionId);
  }
  await db.transaction(async (tx) => {
    // Sessions remember the active organization in a plain column, so point them at nothing.
    await tx
      .update(sessions)
      .set({ activeOrganizationId: null })
      .where(eq(sessions.activeOrganizationId, orgId));
    await tx.delete(lifecycleEmails).where(eq(lifecycleEmails.subject, orgId));
    await tx.delete(organizations).where(eq(organizations.id, orgId));
  });
}
