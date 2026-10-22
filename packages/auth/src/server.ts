import type { Db } from "@upzy/db";
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

export const createAuth = (db: Db, opts: { sendEmail?: SendEmail; signup?: SignupPolicy } = {}) => {
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
