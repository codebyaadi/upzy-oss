# Security policy

## Reporting a vulnerability

Please report security problems privately, not in a public issue.

Use GitHub's **Report a vulnerability** button under this repository's **Security** tab (private vulnerability
reporting). Include what you found, how to reproduce it, and the version or commit you tested.

You can expect an acknowledgement within a few days. Please give us reasonable time to fix the problem before
disclosing it publicly.

## Scope

In scope: this repository's code and the hosted service run from it. Of particular interest are authentication and
session handling, access control between organizations, the SSRF protections around monitors and scans, secret
storage, and the billing and webhook endpoints.

Out of scope: denial-of-service or volumetric testing, social engineering, and findings that need a compromised
account or device.

## Testing the hosted service

Only test accounts and organizations you own, and never point monitors or scans at systems you do not own. See the
Acceptable Use policy on the site.
