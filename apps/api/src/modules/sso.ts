import { ssoTrustedOrigins } from "@upzy/auth/sso-origins";
import type { Auth } from "@upzy/auth/types";
import { schema, type Db } from "@upzy/db";
import { resolvePublic, safeFetch } from "@upzy/probes/egress";
import { eq } from "drizzle-orm";
import { Elysia } from "elysia";
import { z } from "zod";

import type { Billing } from "../lib/billing";
import type { AuthPlugin } from "../plugins/auth";
import { HttpError } from "../plugins/errors";

const DOMAIN = /^(?=.{4,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

/** The provider id in sign-in links and the DNS record's name, stable per organization and short enough for a label. */
export const ssoProviderId = (orgId: string) =>
  `sso-${orgId
    .replace(/[^a-z0-9]/gi, "")
    .toLowerCase()
    .slice(0, 16)}`;

/**
 * The identity provider is a server the customer names, and we fetch from it (discovery, keys, tokens). Like every
 * other outbound request here, it must be a public address, unless the installation's operator listed its origin in
 * SSO_TRUSTED_ORIGINS (a self-hosted provider on a private network).
 */
async function assertReachable(url: string, trusted: string[]) {
  const u = new URL(url);
  if (trusted.includes(u.origin)) return;
  if (u.protocol !== "https:") throw new HttpError(400, `${u.origin} must be an https address.`);
  try {
    await resolvePublic(u.hostname);
  } catch {
    throw new HttpError(
      400,
      `${u.hostname} is not a public address, so Upzy won't connect to it. Use your identity provider's public URL.`,
    );
  }
}

interface Discovered {
  authorizationEndpoint: string;
  tokenEndpoint: string;
  jwksEndpoint: string;
  userInfoEndpoint?: string;
  basicAuth: boolean;
}

/**
 * Reads the provider's /.well-known/openid-configuration ourselves, so the fetch goes through the same guarded client
 * as every other outbound request, then hands the plugin explicit endpoints.
 */
async function discover(issuer: string, trusted: string[]): Promise<Discovered> {
  const url = `${issuer}/.well-known/openid-configuration`;
  await assertReachable(url, trusted);
  let doc: Record<string, unknown>;
  try {
    const text = trusted.includes(new URL(url).origin)
      ? await fetch(url, { signal: AbortSignal.timeout(10_000) }).then((r) => r.text())
      : (await safeFetch(url, { timeoutMs: 10_000, maxBodyBytes: 200_000 })).body;
    doc = JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw new HttpError(
      400,
      `Couldn't read ${url}. Check the issuer address: it is the URL your provider lists as its "issuer".`,
    );
  }
  const str = (k: string) => (typeof doc[k] === "string" ? (doc[k] as string) : undefined);
  if ((str("issuer") ?? "").replace(/\/+$/, "") !== issuer)
    throw new HttpError(400, "The provider reports a different issuer than the one you entered.");
  const authorizationEndpoint = str("authorization_endpoint");
  const tokenEndpoint = str("token_endpoint");
  const jwksEndpoint = str("jwks_uri");
  if (!authorizationEndpoint || !tokenEndpoint || !jwksEndpoint)
    throw new HttpError(
      400,
      "The provider's configuration is missing its login, token or key address.",
    );
  const userInfoEndpoint = str("userinfo_endpoint");
  for (const e of [authorizationEndpoint, tokenEndpoint, jwksEndpoint, userInfoEndpoint])
    if (e) await assertReachable(e, trusted);
  const methods = Array.isArray(doc.token_endpoint_auth_methods_supported)
    ? (doc.token_endpoint_auth_methods_supported as string[])
    : ["client_secret_basic"];
  if (!methods.includes("client_secret_basic") && !methods.includes("client_secret_post"))
    throw new HttpError(
      400,
      "The provider only supports sign-in methods Upzy doesn't (client secret is required).",
    );
  return {
    authorizationEndpoint,
    tokenEndpoint,
    jwksEndpoint,
    userInfoEndpoint,
    basicAuth: methods.includes("client_secret_basic"),
  };
}

export interface SsoOptions {
  /** Origins of identity providers on a private network that may be used. Default: SSO_TRUSTED_ORIGINS. */
  trustedOrigins?: string[];
}

/**
 * Single sign-on for an organization with OpenID Connect. better-auth's sso plugin does the protocol (discovery, the
 * code exchange, signature checks, signing people in and adding them to the organization); these routes are the
 * administration around it, behind the plan check and the admin role.
 */
export const ssoModule = (
  db: Db,
  authP: AuthPlugin,
  auth: Pick<Auth, "api">,
  billing: Billing,
  opts: SsoOptions = {},
) => {
  const trusted = opts.trustedOrigins ?? ssoTrustedOrigins();
  const { ssoProviders } = schema;
  const redirectFor = (providerId: string) =>
    `${(process.env.BETTER_AUTH_URL || "http://localhost:3000").replace(/\/+$/, "")}/api/auth/sso/callback/${providerId}`;

  async function current(orgId: string) {
    const [row] = await db
      .select({
        providerId: ssoProviders.providerId,
        issuer: ssoProviders.issuer,
        domain: ssoProviders.domain,
        domainVerified: ssoProviders.domainVerified,
        oidcConfig: ssoProviders.oidcConfig,
      })
      .from(ssoProviders)
      .where(eq(ssoProviders.organizationId, orgId))
      .limit(1);
    return row ?? null;
  }

  /** What the admin sees: never the secret. */
  const view = (row: NonNullable<Awaited<ReturnType<typeof current>>>) => {
    let clientId = "";
    try {
      clientId = String(
        (JSON.parse(row.oidcConfig ?? "{}") as { clientId?: string }).clientId ?? "",
      );
    } catch {
      /* unreadable config shows no client id */
    }
    return {
      providerId: row.providerId,
      issuer: row.issuer,
      domain: row.domain,
      domainVerified: row.domainVerified,
      clientId,
      redirectUri: redirectFor(row.providerId),
    };
  };

  const dnsRecord = (row: { providerId: string; domain: string }, token: string) => ({
    name: `_better-auth-token-${row.providerId}.${row.domain}`,
    type: "TXT",
    value: token,
  });

  return new Elysia()
    .use(authP)
    .get(
      "/sso",
      async ({ orgId, request }) => {
        const row = await current(orgId);
        if (!row) return { provider: null, verification: null };
        let verification = null;
        if (!row.domainVerified) {
          const r = (await auth.api
            .requestDomainVerification({
              headers: request.headers,
              body: { providerId: row.providerId },
            })
            .catch(() => null)) as { domainVerificationToken?: string } | null;
          if (r?.domainVerificationToken) verification = dnsRecord(row, r.domainVerificationToken);
        }
        return { provider: view(row), verification };
      },
      { org: "admin" },
    )
    .post(
      "/sso",
      async ({ orgId, request, body }) => {
        await billing.assertSso(db, orgId);
        if (await current(orgId))
          throw new HttpError(
            409,
            "This organization already has single sign-on. Remove it first to change it.",
          );
        const issuer = body.issuer.trim().replace(/\/+$/, "");
        const found = await discover(issuer, trusted);
        const domain = body.domain.trim().toLowerCase().replace(/^@/, "");
        if (!DOMAIN.test(domain))
          throw new HttpError(
            400,
            "Enter the email domain people sign in with, such as example.com.",
          );

        const providerId = ssoProviderId(orgId);
        let created: { domainVerificationToken?: string };
        try {
          created = (await auth.api.registerSSOProvider({
            headers: request.headers,
            body: {
              providerId,
              issuer,
              domain,
              organizationId: orgId,
              oidcConfig: {
                clientId: body.clientId.trim(),
                clientSecret: body.clientSecret,
                pkce: true,
                skipDiscovery: true,
                authorizationEndpoint: found.authorizationEndpoint,
                tokenEndpoint: found.tokenEndpoint,
                jwksEndpoint: found.jwksEndpoint,
                ...(found.userInfoEndpoint ? { userInfoEndpoint: found.userInfoEndpoint } : {}),
                tokenEndpointAuthentication: found.basicAuth
                  ? "client_secret_basic"
                  : "client_secret_post",
              },
            },
          })) as { domainVerificationToken?: string };
        } catch (e) {
          const message = (e as { body?: { message?: string } }).body?.message;
          throw new HttpError(
            400,
            message
              ? `Couldn't set up single sign-on: ${message}`
              : "Couldn't set up single sign-on.",
          );
        }
        const row = await current(orgId);

        return {
          provider: view(row!),
          verification: created.domainVerificationToken
            ? dnsRecord(row!, created.domainVerificationToken)
            : null,
        };
      },
      {
        org: "admin",
        body: z.object({
          issuer: z.string().url().max(500),
          domain: z.string().min(3).max(253),
          clientId: z.string().min(1).max(500),
          clientSecret: z.string().min(1).max(2000),
        }),
      },
    )
    .post(
      "/sso/verify",
      async ({ orgId, request }) => {
        await billing.assertSso(db, orgId);
        const row = await current(orgId);
        if (!row) throw new HttpError(404, "Single sign-on isn't set up yet.");
        if (row.domainVerified) return { provider: view(row), verified: true };
        try {
          await auth.api.verifyDomain({
            headers: request.headers,
            body: { providerId: row.providerId },
          });
        } catch {
          throw new HttpError(
            400,
            `Couldn't find the DNS record for ${row.domain} yet. DNS changes can take a few minutes; try again shortly.`,
          );
        }
        return { provider: view((await current(orgId))!), verified: true };
      },
      { org: "admin" },
    )
    .delete(
      "/sso",
      async ({ orgId, request }) => {
        const row = await current(orgId);
        if (!row) return { ok: true };
        await auth.api.deleteSSOProvider({
          headers: request.headers,
          body: { providerId: row.providerId },
        });
        return { ok: true };
      },
      { org: "admin" },
    );
};
