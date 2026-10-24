import { and, eq, isNotNull, sql } from "drizzle-orm";

import type { Db } from "./drizzle";
import { accounts, members, organizationSecurity, ssoProviders, users } from "./schema";

/** Whether this organization insists that everyone signs in with two-factor authentication. */
export async function orgRequiresTwoFactor(db: Db, organizationId: string): Promise<boolean> {
  const [row] = await db
    .select({ on: organizationSecurity.requireTwoFactor })
    .from(organizationSecurity)
    .where(eq(organizationSecurity.organizationId, organizationId));
  return row?.on ?? false;
}

/**
 * Whether this person can only get in through the organization's single sign-on: they have an account at its verified
 * identity provider and no password. The provider does the second factor, so Upzy's own is not asked of them.
 */
export async function usesOrgSso(db: Db, userId: string, organizationId: string): Promise<boolean> {
  const [viaSso] = await db
    .select({ id: accounts.id })
    .from(accounts)
    .innerJoin(ssoProviders, eq(ssoProviders.providerId, accounts.providerId))
    .where(
      and(
        eq(accounts.userId, userId),
        eq(ssoProviders.organizationId, organizationId),
        eq(ssoProviders.domainVerified, true),
      ),
    )
    .limit(1);
  if (!viaSso) return false;
  const [password] = await db
    .select({ id: accounts.id })
    .from(accounts)
    .where(and(eq(accounts.userId, userId), isNotNull(accounts.password)))
    .limit(1);
  return !password;
}

/** The organization insists on two-factor and this person has neither it nor a single sign-on that covers it. */
export async function twoFactorMissing(
  db: Db,
  user: { id: string; twoFactorEnabled?: boolean | null },
  organizationId: string,
): Promise<boolean> {
  if (user.twoFactorEnabled) return false;
  if (!(await orgRequiresTwoFactor(db, organizationId))) return false;
  return !(await usesOrgSso(db, user.id, organizationId));
}

/** The people in an organization who haven't set up two-factor sign-in yet. */
export async function membersWithoutTwoFactor(db: Db, organizationId: string) {
  const rows = await db
    .select({ id: users.id, name: users.name, email: users.email })
    .from(members)
    .innerJoin(users, eq(users.id, members.userId))
    .where(and(eq(members.organizationId, organizationId), eq(users.twoFactorEnabled, false)))
    .orderBy(sql`lower(${users.name})`);
  const out: typeof rows = [];
  for (const r of rows) if (!(await usesOrgSso(db, r.id, organizationId))) out.push(r);
  return out;
}
