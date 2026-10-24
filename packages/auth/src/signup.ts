import type { Db } from "@upzy/db";
import * as schema from "@upzy/db/schema";
import { and, count, eq, gt, sql } from "drizzle-orm";

/**
 *  open    anyone can create an account (development, or a public product)
 *  invite  only people who are expected: the very first account (unless you set an allow-list), an allow-listed
 *          email or domain, or someone
 *          who holds a pending organization invitation. This is the production default in deploy/compose.yml.
 *  closed  nobody new, apart from the very first account
 */
export type SignupMode = "open" | "invite" | "closed";

export interface SignupPolicy {
  mode: SignupMode;
  allowedEmails: string[];
  allowedDomains: string[];
}

export const parseSignupPolicy = (
  env: Record<string, string | undefined> = process.env,
): SignupPolicy => {
  const mode = (env.SIGNUP_MODE ?? "open").trim().toLowerCase();
  if (mode !== "open" && mode !== "invite" && mode !== "closed")
    throw new Error(`SIGNUP_MODE must be open, invite or closed (got "${env.SIGNUP_MODE}")`);
  const list = (v?: string) =>
    (v ?? "")
      .split(",")
      .map((s) => s.trim().toLowerCase().replace(/^@/, ""))
      .filter(Boolean);
  return {
    mode,
    allowedEmails: list(env.SIGNUP_ALLOWED_EMAILS),
    allowedDomains: list(env.SIGNUP_ALLOWED_DOMAINS),
  };
};

export interface SignupFacts {
  userCount: number;
  hasPendingInvitation: boolean;
  /** An organization has verified this email's domain for single sign-on, so its people are expected. */
  hasSsoDomain?: boolean;
}

/** Pure decision, so the rules are easy to read and test. Returns null when allowed, or the reason it isn't. */
export function signupBlockedReason(
  policy: SignupPolicy,
  email: string,
  facts: SignupFacts,
): string | null {
  if (policy.mode === "open") return null;
  // Someone has to be able to create the first account on a fresh install. If you named who that is (an allow-list),
  // the list decides instead, so a stranger can't claim a fresh install before you do.
  const listed = policy.allowedEmails.length > 0 || policy.allowedDomains.length > 0;
  if (facts.userCount === 0 && !listed) return null;
  if (policy.mode === "closed") return "Sign-ups are closed.";
  const e = email.trim().toLowerCase();
  const domain = e.split("@")[1] ?? "";
  if (policy.allowedEmails.includes(e) || policy.allowedDomains.includes(domain)) return null;
  if (facts.hasPendingInvitation || facts.hasSsoDomain) return null;
  return "Sign-ups are by invitation only. Ask a team admin to invite you.";
}

/** Reads the two facts the decision needs from the database. */
export async function signupFacts(db: Db, email: string): Promise<SignupFacts> {
  const { users, invitations, ssoProviders } = schema;
  const [{ n }] = (await db.select({ n: count() }).from(users)) as [{ n: number }];
  const [inv] = await db
    .select({ id: invitations.id })
    .from(invitations)
    .where(
      and(
        sql`lower(${invitations.email}) = ${email.trim().toLowerCase()}`,
        eq(invitations.status, "pending"),
        gt(invitations.expiresAt, new Date()),
      ),
    )
    .limit(1);
  const [sso] = await db
    .select({ id: ssoProviders.id })
    .from(ssoProviders)
    .where(
      and(
        eq(ssoProviders.domainVerified, true),
        sql`lower(${ssoProviders.domain}) = ${email.trim().toLowerCase().split("@")[1] ?? ""}`,
      ),
    )
    .limit(1);
  return { userCount: Number(n), hasPendingInvitation: !!inv, hasSsoDomain: !!sso };
}
