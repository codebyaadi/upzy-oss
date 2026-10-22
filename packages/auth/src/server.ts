import {
  applyPendingAccess,
  deleteOrganization,
  isRestrictedMember,
  ownedOrganizations,
  type Db,
} from "@upzy/db";
import * as schema from "@upzy/db/schema";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { APIError } from "better-auth/api";
import { organization, openAPI } from "better-auth/plugins";

import { ac, orgRoles } from "./access";
import { auditHook } from "./audit-hook";
import { emails, queueEmail, type SendEmail } from "./email";
import { parseSignupPolicy, signupBlockedReason, signupFacts, type SignupPolicy } from "./signup";

/** GitHub sign-in is on when both halves of an OAuth app's credentials are set. */
export const githubCredentials = (env: Record<string, string | undefined> = process.env) => {
  const clientId = env.GITHUB_CLIENT_ID?.trim();
  const clientSecret = env.GITHUB_CLIENT_SECRET?.trim();
  return clientId && clientSecret ? { clientId, clientSecret } : null;
};

/** Which sign-in methods this server offers, for the login and sign-up pages. */
export const authProviders = (env: Record<string, string | undefined> = process.env) => ({
  github: githubCredentials(env) !== null,
});

export const createAuth = (
  db: Db,
  opts: {
    sendEmail?: SendEmail;
    signup?: SignupPolicy;
    /** Cancels a paid subscription at the payment provider, so deleting an account never leaves one billing. */
    cancelSubscription?: (providerSubscriptionId: string) => Promise<void>;
  } = {},
) => {
  const signup = opts.signup ?? parseSignupPolicy();
  const webOrigin = process.env.WEB_ORIGIN || "http://localhost:3001";
  const sendEmail = opts.sendEmail ?? queueEmail(db);
  const github = githubCredentials();

  const baseURL = process.env.BETTER_AUTH_URL || "http://localhost:3000";
  // The web app and the API live on sibling subdomains in production (app.example.com, api.example.com), so the
  // session cookie must be shared across them: set COOKIE_DOMAIN=.example.com. Unset, cookies stay host-only.
  const cookieDomain = process.env.COOKIE_DOMAIN || undefined;

  return betterAuth({
    baseURL,
    advanced: {
      useSecureCookies: baseURL.startsWith("https://"),
      ...(cookieDomain ? { crossSubDomainCookies: { enabled: true, domain: cookieDomain } } : {}),
    },
    trustedOrigins: [webOrigin],
    database: drizzleAdapter(db, {
      provider: "pg",
      usePlural: true,
      schema,
    }),
    emailAndPassword: {
      enabled: true,
      autoSignIn: true,
      sendResetPassword: async ({ user, url }) =>
        sendEmail(emails.resetPassword({ to: user.email, name: user.name, url })),
      resetPasswordTokenExpiresIn: 60 * 60,
    },
    // Optional. The callback to register in the GitHub OAuth app is `${BETTER_AUTH_URL}/api/auth/callback/github`.
    // GitHub-verified emails link to an existing account with the same address; new accounts still pass the
    // sign-up policy below.
    socialProviders: github ? { github } : {},
    // Self-service account deletion (password, or a recent sign-in for GitHub-only accounts). A user who is the only
    // owner of an organization that still has other people in it must hand it over first; organizations they were
    // alone in are deleted with them, after their subscription is cancelled.
    user: {
      deleteUser: {
        enabled: true,
        beforeDelete: async (user) => {
          const owned = await ownedOrganizations(db, user.id);
          const stuck = owned.filter((o) => o.otherMembers > 0 && o.otherOwners === 0);
          if (stuck.length)
            throw new APIError("BAD_REQUEST", {
              message: `You are the only owner of ${stuck.map((o) => o.name).join(", ")}, and other people belong to it. Make someone else an owner, or remove them, before deleting your account.`,
            });
          for (const o of owned.filter((o) => o.otherMembers === 0))
            await deleteOrganization(db, o.id, {
              cancelSubscription: opts.cancelSubscription,
            }).catch((e) => {
              console.error("[account] organization delete failed", o.id, e);
              throw new APIError("BAD_GATEWAY", {
                message: `The subscription for ${o.name} couldn't be cancelled, so nothing was deleted. Try again in a moment.`,
              });
            });
        },
        afterDelete: async (user) => {
          await sendEmail(emails.accountDeleted({ to: user.email, name: user.name })).catch(
            () => {},
          );
        },
      },
    },
    // Soft verification: the email is sent on sign-up and the dashboard nudges, but sign-in is not blocked.
    emailVerification: {
      sendOnSignUp: true,
      autoSignInAfterVerification: true,
      sendVerificationEmail: async ({ user, url }) =>
        sendEmail(emails.verifyEmail({ to: user.email, name: user.name, url })),
    },
    // The sign-up lock: refuses new accounts that the policy (SIGNUP_MODE) doesn't expect.
    databaseHooks: {
      user: {
        create: {
          before: async (user) => {
            if (signup.mode === "open") return;
            const reason = signupBlockedReason(
              signup,
              user.email,
              await signupFacts(db, user.email),
            );
            if (reason) throw new APIError("FORBIDDEN", { message: reason });
          },
        },
      },
    },
    hooks: { after: auditHook(db) },
    plugins: [
      // The API reference page is a development aid: don't publish it.
      openAPI({ disableDefaultReference: process.env.NODE_ENV === "production" }),
      organization({
        ac,
        roles: orgRoles,
        teams: { enabled: true, maximumTeams: 10 },
        invitationExpiresIn: 60 * 60 * 24 * 7,
        organizationHooks: {
          // A limit set when inviting is applied before the membership exists, so there is never a moment when the
          // person can see every workspace. Someone limited to some workspaces can only be a viewer or a member.
          beforeAcceptInvitation: async ({ invitation, user }) => {
            const admin = /(^|,)s*(admin|owner)s*(,|$)/.test(invitation.role ?? "");
            const applied = await applyPendingAccess(db, {
              organizationId: invitation.organizationId,
              email: invitation.email,
              userId: user.id,
              allowed: !admin,
            });
            if (applied === "refused")
              throw new APIError("BAD_REQUEST", {
                message:
                  "This invitation limits access to some workspaces, which only works for viewers and members. Ask for a new invitation.",
              });
          },
          beforeUpdateMemberRole: async ({ member, newRole }) => {
            if (
              /(^|,)s*(admin|owner)s*(,|$)/.test(newRole) &&
              (await isRestrictedMember(db, member.organizationId, member.userId))
            )
              throw new APIError("BAD_REQUEST", {
                message:
                  "This person is limited to some workspaces. Remove that limit before making them an admin or owner.",
              });
          },
        },
        sendInvitationEmail: async ({ id, email, role, organization, inviter }) =>
          sendEmail(
            emails.invitation({
              to: email,
              organization: organization.name,
              inviter: inviter.user.name,
              role,
              url: `${webOrigin}/accept-invitation/${id}`,
            }),
          ),
      }),
    ],
  });
};
