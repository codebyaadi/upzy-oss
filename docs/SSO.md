# Single sign-on

Let your team sign in with your own identity provider (Okta, Microsoft Entra, Google Workspace, Keycloak, any **OpenID Connect** provider) instead of a separate Upzy password. SAML is not supported yet.

It is included in the **Agency** plan (and wherever billing is switched off).

## For people using Upzy

An organization admin sets it up under **Settings → Security → Single sign-on**.

1. **Create an application at your provider**: type "web", grant "authorization code". Keep its **client ID** and **client secret**.
2. In Upzy, enter the **issuer URL** (the address your provider lists as its `issuer`, such as `https://your-company.okta.com`), your **email domain** and the client ID and secret, then **Connect**.
3. Register the **redirect URI** Upzy shows (it ends in `/api/auth/sso/callback/sso-…`) as the application's redirect at your provider.
4. **Prove the domain.** Add the TXT record Upzy shows to your DNS, wait a few minutes and press **Verify domain**. Until then nobody can sign in through the provider, so nobody else can claim your domain's addresses.

After that, people sign in from the login page with **Sign in with single sign-on** and their work email. Upzy finds the organization from the email's domain, sends them to your provider and back.

- **Accounts:** the first sign-in creates the account if there isn't one (even when the server only allows invited sign-ups, because you verified the domain) and adds the person to the organization as a **member**. An existing account with the same email is signed in to and linked. Change roles afterwards under Settings → Team.
- **Two-factor:** if your organization requires two-factor, people who can only get in through single sign-on aren't asked for Upzy's own, because your provider does the second factor. Anyone who has a password on the account is still held to the rule.
- **One provider per organization.** To change anything, remove it and connect again. Removing it doesn't delete anyone's account or access.
- The client secret is stored in the database next to the rest of the provider's settings and is never shown again.

## For the person running the server

Nothing to turn on. Public providers just work. Requirements:

- `BETTER_AUTH_URL` is the API's public address; the redirect URI is built from it.
- The provider must be on a **public https address**. Upzy fetches the provider's configuration, keys and tokens and refuses private or loopback addresses like everywhere else it makes requests for customers.
- For a self-hosted provider on a private network, list its origin in `SSO_TRUSTED_ORIGINS` (comma-separated, for example `https://keycloak.internal:8443`). This also makes it a better-auth trusted origin, so list only providers you control.
- The DNS check uses the server's own resolver.

## What it doesn't do

- SAML, SCIM provisioning (people removed at the provider stay in Upzy until removed there) or "SSO only" enforcement (password sign-in stays available; people can remove their password only by not having one).
- Role mapping from provider groups. Everyone joins as a member.
