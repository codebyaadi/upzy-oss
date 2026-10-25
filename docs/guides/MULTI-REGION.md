# Checking from several regions

A monitor normally checks your site from the main server. With regions, the same monitor is also checked from other places, and it only counts as down when **most of them** can't reach it. One region's network trouble no longer wakes anyone up, and you can see when a site is slow or blocked only for some visitors.

## For people using Upzy

When the installation offers more than one region, **New monitor** and **Edit monitor** show a **Check from** row. Pick one or more.

- Nothing selected: checked from the main server, as before.
- One or more selected: each region checks on its own schedule. The monitor page shows each region's last result, and every check in the list says where it ran.
- The monitor is **down** when more than half of the regions that reported recently have failed the number of checks in a row set under "Down after". With two regions both must agree; with three, two.
- A region that has stopped reporting for a few intervals (its agent is off) is left out of the count instead of being counted as up or down, so one dead prober can neither hide an outage nor cause one.
- The incident title names the regions that saw it: `api is down from eu-west, us-east`.

How many regions one monitor can use depends on the plan: Free 1, Starter 2, Pro 3, Agency 5. Heartbeat monitors have no region (the job pings you).

## For the person running the server

A region is a machine somewhere else running **`upzy-agent`**, a small program (one static binary, about 7 MB) that fetches the checks for its region from your API over HTTPS, runs them, and reports what it measured. It needs your API address and a token. It does **not** need database access or the encryption key, so you can run one on any small VPS, or inside a customer's network, without trusting that machine with your data.

1. **Name the regions** on the main server, then restart the API:

   ```env
   PROBE_REGIONS=eu-west,us-east
   ```

   Names are lowercase letters, digits and dashes (2 to 24 characters). `local`, `primary` and `main` mean the main server and can't be used.

2. **Create a token** for each agent. It is printed once; only its hash is kept:

   ```bash
   DATABASE_URL=... bun apps/api/scripts/create-agent.ts eu-west "eu-west vps 1"
   ```

3. **Run the agent** in that region. Download the binary for the machine from the latest `agent-v*` release (linux amd64 or arm64, windows, macOS), then:

   ```bash
   UPZY_API_URL=https://your-api-address UPZY_AGENT_TOKEN=upzy_agent_... ./upzy-agent
   ```

   Run it under systemd, a container or a Windows service so it restarts. The machine only needs to reach your API and the sites it checks. Options and a systemd example are in [agent/README.md](../../agent/README.md). The scheduler on the main server queues one check per region of each monitor, and the agent for that region takes them.

Things worth knowing:

- **The agent only measures.** Whether a monitor is down, the incidents and the alerts are decided on the main server with the same code as for its own checks.
- **Secrets stay sealed.** When a monitor has secrets (`{{secret.NAME}}`), they are encrypted to the agent's own key, made when it starts, so only that process can read them. A check that needs secrets is not handed to an agent that sent no key.
- **The same SSRF rules** as the main server apply: the agent only connects to public addresses, and checks that again at connect time and on every redirect.
- **A crashed agent loses nothing.** A check not reported back within minutes goes to another taker. Several agents can serve one region with the same or separate tokens.
- **Revoke an agent** by setting `revoked_at` on its row in `probe_agents`; its token stops working immediately.
- Browser and heartbeat monitors have no region and always run on the main server. An agent runs http, tcp, dns, ssl and flow monitors.

### The old way: a worker that reads the database (retired)

Earlier, a region was a worker started with `WORKER_ROLES=prober` and its own `WORKER_REGION`, which needed `DATABASE_URL` (reachable from the region) and `UPZY_ENCRYPTION_KEY`. That is being retired because it puts the database and the key on a remote machine. Such a worker now **does not start its prober** unless you set `ALLOW_DB_REGIONAL_PROBER=true`, and it prints a deprecation notice when it does. The flag stops working on **2027-03-01**. To move a region: create a token for it, start the agent there, then stop the old worker. Queued checks are shared by queue, so nothing is lost in between.

## Notes

- Existing monitors have no regions and behave exactly as before. History rows from before regions say `primary` as their place.
- Changing a monitor's regions takes effect on the next scheduled check. A job already queued for a region the monitor no longer uses is dropped when it runs.
- Deleting a region from `PROBE_REGIONS` hides it in the picker but leaves monitors that already use it alone; remove it from those monitors, or its checks simply stop being picked up when its prober is turned off.
- Status pages and the 90-day uptime figure use incidents, so they follow the same "most regions" rule.
