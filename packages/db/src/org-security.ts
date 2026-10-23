import { and, eq, sql } from "drizzle-orm";

import type { Db } from "./drizzle";
import { members, organizationSecurity, users } from "./schema";

/** Whether this organization insists that everyone signs in with two-factor authentication. */
export async function orgRequiresTwoFactor(db: Db, organizationId: string): Promise<boolean> {
  const [row] = await db
    .select({ on: organizationSecurity.requireTwoFactor })
    .from(organizationSecurity)
    .where(eq(organizationSecurity.organizationId, organizationId));
  return row?.on ?? false;
}

/** The people in an organization who haven't set up two-factor sign-in yet. */
export async function membersWithoutTwoFactor(db: Db, organizationId: string) {
  return db
    .select({ id: users.id, name: users.name, email: users.email })
    .from(members)
    .innerJoin(users, eq(users.id, members.userId))
    .where(and(eq(members.organizationId, organizationId), eq(users.twoFactorEnabled, false)))
    .orderBy(sql`lower(${users.name})`);
}
