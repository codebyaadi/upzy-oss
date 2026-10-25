# upzy-scan

Upzy's active security scan. It runs a curated, non-intrusive set of [nuclei](https://github.com/projectdiscovery/nuclei) templates against assets whose owners have proved they own them, at a rate the server sets, and reports what it found. It needs only the API address and a token.

- Embeds nuclei as a library (`v3.11.1`); there is no nuclei install to keep up to date.
- The template set is inside the binary and fixed when it is built: `templates/upzy` (generated from the built-in exposed-path list, so both engines look for the same files) and `templates/upstream` (a few MIT-licensed upstream templates, pinned: see `templates/UPSTREAM.md`). Nothing is downloaded at run time.
- Findings use the same fingerprint format as the rest of Upzy. A template we generated carries the key and subject of the built-in check it replaces, so the two engines never report the same file twice.
- Every scan leaves a provenance record (engine and set version, templates that ran, requests at most, rate limit, times), shown to the owner.

## Build it yourself

Upzy does not publish built `upzy-scan` binaries. nuclei depends on one GPL-2.0 module (`projectdiscovery/ldapserver`, for its LDAP server), so a built binary is a GPL-2.0 combined work; building it yourself from this source, for your own use, carries no such obligation. You need Go 1.26 or newer:

```bash
cd scan && go build -trimpath -ldflags "-s -w -X main.version=local" -o upzy-scan .
```

## Run it

1. Create a scanner token on the server. It is printed once:

   ```bash
   DATABASE_URL=... bun apps/api/scripts/create-agent.ts --scanner "scanner 1"
   ```

2. Tell the worker to hand exposed-file checks to the scanner (`ACTIVE_SCAN_ENGINE=nuclei`; the default, `builtin`, keeps them in the worker).

3. Start the scanner anywhere that can reach the API and the internet:

   ```bash
   UPZY_API_URL=https://your-api-address UPZY_SCANNER_TOKEN=upzy_agent_... ./upzy-scan
   ```

A scanner token and a probe agent token are different kinds: neither works on the other's endpoints.

## Safety

- **Verified assets only.** The server checks that an asset is verified when the scan is queued, when it is handed out and when the result is recorded. If verification was withdrawn while a scan ran, the result is dropped.
- **Public addresses only.** The target is resolved and must be public before anything is sent; nuclei itself is run with local network access restricted, so redirects and DNS answers that change afterwards cannot reach private addresses.
- **Non-intrusive.** Only `http` templates that `GET` files and pages a visitor could request. Templates tagged intrusive, dos, fuzz, bruteforce, rce, sqli, xss, ssrf, oast, headless, code, default-login or takeover never run, whatever the set holds.
- **Rate limit** set by the server (5 requests a second to one site, across all templates), and a time limit per scan (15 minutes).
- **No copies of secrets.** The evidence of a finding names the template and the path. It never includes the response, the matched text or any extracted value, because an exposed file may hold secrets.
- **No updates.** The scanner does not check for or download templates or a newer nuclei.

## Develop

```bash
cd scan
go vet ./... && go test ./...
go build -ldflags "-X main.version=dev" -o upzy-scan .
```

- `bun scan/scripts/gen-templates.ts` regenerates `templates/upzy` from `packages/security/src/checks/active.ts` (`--check` fails if they differ; CI runs it).
- `bun scan/scripts/licenses.ts` rewrites `THIRD_PARTY_LICENSES.md`, the licence of every Go module in the binary (`--check` in CI). It fails on a copyleft or unrecognised licence until someone has looked at it.
- The first build compiles nuclei and its dependencies and takes several minutes.
- There is no release workflow on purpose (see _Build it yourself_). Do not add one without settling the GPL-2.0 module.
