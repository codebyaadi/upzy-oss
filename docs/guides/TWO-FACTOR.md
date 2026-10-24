# Two-factor sign-in

Anyone can protect their account with an authenticator app (1Password, Authy, Google or Microsoft Authenticator). An organization owner or admin can then require it for everyone.

## For a person

**Account menu → Security → Set up two-factor.** Enter your password (leave it empty if you sign in with GitHub and have no password), scan the QR code, and type the 6-digit code. You are shown ten backup codes once; each works one time if you lose your phone.

At sign-in you are asked for a code after your password (or GitHub). "Don't ask again on this device for 30 days" skips the prompt on that browser. The same page can make new backup codes (the old ones stop working) and turn two-factor off.

## For an admin

**Security → Require it for everyone.** The switch is available once you have set up two-factor yourself, so you cannot lock yourself out. The page lists who in the organization has not set it up yet.

While the rule is on, a member without two-factor can sign in but sees only a setup screen until they finish it. Every organization route in the API refuses them with `403` and `code: "two_factor_required"`, and so do the organization actions better-auth handles itself (inviting, removing, changing roles, renaming and deleting). Turning the rule off lifts all of it at once.

The rule applies per organization. Someone in two organizations is only blocked in the one that requires it.

## Lost device and backup codes

Self-service recovery is not offered, because it would be the weak point. An organization owner who is locked out has to be reset by whoever runs the server:

```sql
update users set two_factor_enabled = false where email = 'person@example.com';
delete from two_factors where user_id = (select id from users where email = 'person@example.com');
```

They can then sign in with their password and set up again. If the rule is on and the person is the only admin, switch it off first with:

```sql
update organization_security set require_two_factor = false where organization_id = '<id>';
```

## How it works

- Built on better-auth's `twoFactor` plugin: TOTP (RFC 6238, SHA-1, 6 digits, 30 seconds). Secrets and backup codes are encrypted at rest. Repeated wrong codes lock verification for a short time.
- The rule lives in `organization_security` (one row per organization). The API checks it in the `org` auth macro (one small lookup, only for requests from people without two-factor), and a better-auth before-hook covers the organization endpoints that are not ours.
- `GET /security` needs only a session, so a blocked person can always find out why and reach the setup screen.
- SSO and passkeys are not part of this.
