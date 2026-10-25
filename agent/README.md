# upzy-agent

A small program that runs Upzy checks from a machine of your own and reports what it measured. It is how you check from another region, or from inside a private network, **without giving that machine database access or the encryption key**: it only needs the API address and a token.

- One static binary, no runtime, no dependencies beyond the Go standard library (about 7 MB).
- Runs `http`, `tcp`, `dns`, `ssl` and `flow` monitors. Browser and heartbeat monitors stay on the main server.
- Follows the same rules as the server's own checks about which addresses it may touch (see _Safety_).
- It only measures. Whether a monitor is down, and every alert, is decided by the server.

## Run it

1. Name the region on the server (`PROBE_REGIONS=eu-west`) and create a token for it. The token is printed once:

   ```bash
   DATABASE_URL=... bun apps/api/scripts/create-agent.ts eu-west "eu-west vps 1"
   ```

2. Start the agent on the machine in that region:

   ```bash
   UPZY_API_URL=https://your-api-address \
   UPZY_AGENT_TOKEN=upzy_agent_... \
   ./upzy-agent
   ```

   | Variable                 | Meaning                                                                |
   | ------------------------ | ---------------------------------------------------------------------- |
   | `UPZY_API_URL`           | the API address (required)                                             |
   | `UPZY_AGENT_TOKEN`       | the token from step 1 (required)                                       |
   | `UPZY_AGENT_CONCURRENCY` | checks at once, 1 to 500 (default 50)                                  |
   | `WEB_ORIGIN`             | optional: your app's `https://` address, shown in the bot's user agent |

   It logs to stderr, retries when the server is unreachable, stops with a clear message if its token is refused, and on SIGINT or SIGTERM lets checks in flight finish and report (up to 20 seconds).

3. Run it under systemd, a container or a Windows service so it restarts. Example unit:

   ```ini
   [Service]
   ExecStart=/usr/local/bin/upzy-agent
   Environment=UPZY_API_URL=https://your-api-address
   EnvironmentFile=/etc/upzy-agent.env   # holds UPZY_AGENT_TOKEN
   Restart=always
   DynamicUser=yes
   ```

Binaries for linux (amd64, arm64), windows and macOS are attached to each `agent-v*` release.

## Safety

- **Public addresses only.** A name is resolved and every address must be public (one private record rejects the name). The socket itself also refuses a private address at connect time, so redirects, number spellings such as `2130706433` or `0x7f.1`, IPv4-in-IPv6 forms and DNS rebinding cannot get around the first check. Every redirect hop is checked again. Environment proxies are ignored.
- **Secrets.** A monitor's secrets arrive for one check, over TLS, are used in that check and are scrubbed from any error before it is reported. They are never written to disk or logged.
- **The token** can only fetch checks for its own region and answer checks it was handed. Revoke it by setting `revoked_at` on its `probe_agents` row.

## Develop

```bash
cd agent
go vet ./... && go test ./...
go build -ldflags "-X main.version=dev" -o upzy-agent .
```

The messages it exchanges with the API are defined in `packages/validator` and published as JSON Schema in `schemas/`. The checks are ports of `packages/probes` and use the same wording for errors, so a monitor reads the same whichever side ran it.
