# Checking from several regions

A monitor normally checks your site from the main server. With regions, the same monitor is also checked from other places, and it only counts as down when **most of them** can't reach it. One region's network trouble no longer wakes anyone up, and you can see when a site is slow or blocked only for some visitors.

## For people using Upzy

When the installation offers more than one region, **New monitor** and **Edit monitor** show a **Check from** row. Pick one or more.

- Nothing selected: checked from the main server, as before.
- One or more selected: each region checks on its own schedule. The monitor page shows each region's last result, and every check in the list says where it ran.
- The monitor is **down** when more than half of the regions that reported recently have failed the number of checks in a row set under "Down after". With two regions both must agree; with three, two.
- A region that has stopped reporting for a few intervals (its machine is off) is left out of the count instead of being counted as up or down, so one dead prober can neither hide an outage nor cause one.
- The incident title names the regions that saw it: `api is down from eu-west, us-east`.

How many regions one monitor can use depends on the plan: Free 1, Starter 2, Pro 3, Agency 5. Heartbeat monitors have no region (the job pings you).

## For the person running the server

A region is a worker running the prober role somewhere else. It reads its checks from the same database over the network, so it needs two things from the main server: database access, and the encryption key (monitor secrets are decrypted for the length of one check).

1. **Name the regions** on the main server, then restart the API:

   ```env
   PROBE_REGIONS=eu-west,us-east
   ```

   Names are lowercase letters, digits and dashes (2 to 24 characters). `local`, `primary` and `main` mean the main server and can't be used.

2. **Run a prober** on a small machine in each region, with the same image as the worker:

   ```yaml
   services:
     prober:
       image: ghcr.io/<UPZY_IMAGE_REPO>-server:<same tag as the main server>
       command: ["bun", "apps/worker/src/index.ts"]
       restart: unless-stopped
       environment:
         DATABASE_URL: postgres://upzy:<password>@<db-host>:5432/upzy?sslmode=require
         UPZY_ENCRYPTION_KEY: <same as the main server>
         WORKER_ROLES: prober
         WORKER_REGION: eu-west
   ```

   Each region listens on its own queue (`check.eu-west`), so a prober only ever receives work for its region. The scheduler on the main server queues one job per region of each monitor.

3. **Open the database to those machines only**: a firewall allow-list of their addresses, TLS, and a user with just the access the worker needs. A prober that can reach Postgres can read everything the worker can, so run these on machines you control. If that is not acceptable, the next step is a probe agent that talks to the API instead of the database (planned, not built).

The main server's own worker keeps using `WORKER_REGION=primary` (or unset); that is the `local` region.

## Notes

- Existing monitors have no regions and behave exactly as before. History rows from before regions say `primary` as their place.
- Changing a monitor's regions takes effect on the next scheduled check. A job already queued for a region the monitor no longer uses is dropped when it runs.
- Deleting a region from `PROBE_REGIONS` hides it in the picker but leaves monitors that already use it alone; remove it from those monitors, or its checks simply stop being picked up when its prober is turned off.
- Status pages and the 90-day uptime figure use incidents, so they follow the same "most regions" rule.
