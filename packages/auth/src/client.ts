import { organizationClient } from "better-auth/client/plugins";
import { createAuthClient } from "better-auth/react";

import { ac, orgRoles } from "./access";

export const authClient = createAuthClient({
  /** The base URL of the server (optional if you're using the same domain) */
  baseURL: process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3000",
  plugins: [
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
  requestPasswordReset,
  resetPassword,
  sendVerificationEmail,
} = authClient;
