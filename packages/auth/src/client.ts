import { organizationClient, twoFactorClient } from "better-auth/client/plugins";
import { createAuthClient } from "better-auth/react";

import { ac, orgRoles } from "./access";

export const authClient = createAuthClient({
  /** The base URL of the server (optional if you're using the same domain) */
  baseURL: process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3000",
  plugins: [
    // Sign-in answers with twoFactorRedirect when a code is needed; the login page then asks for it.
    twoFactorClient({
      onTwoFactorRedirect() {
        // A full load, so the half-finished sign-in cookie is read fresh. Keep where they were headed.
        const next = new URLSearchParams(window.location.search).get("next");
        window.location.assign(
          next ? `/two-factor?next=${encodeURIComponent(next)}` : "/two-factor",
        );
      },
    }),
    organizationClient({
      ac,
      roles: orgRoles,
      teams: {
        enabled: true,
        maximumTeams: 10,
      },
    }),
  ],
});

export const {
  signIn,
  signUp,
  signOut,
  useSession,
  organization,
  useActiveOrganization,
  deleteUser,
  requestPasswordReset,
  resetPassword,
  sendVerificationEmail,
  twoFactor,
} = authClient;
