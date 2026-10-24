/**
 * Identity providers on a private network (a self-hosted Keycloak, say) that this installation may connect to. Public
 * providers need nothing here. Comma-separated origins in SSO_TRUSTED_ORIGINS, such as https://keycloak.internal:8443.
 * These are also better-auth trusted origins, which is what lets it fetch from a non-public address.
 */
export const ssoTrustedOrigins = (
  env: Record<string, string | undefined> = process.env,
): string[] =>
  (env.SSO_TRUSTED_ORIGINS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .flatMap((s) => {
      try {
        return [new URL(s).origin];
      } catch {
        return [];
      }
    });
