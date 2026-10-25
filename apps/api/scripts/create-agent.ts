/**
 * Makes a token for a probe agent or the active scanner. Run by whoever operates the installation:
 *
 *   DATABASE_URL=... bun apps/api/scripts/create-agent.ts <region> <name>      a probe agent for a region
 *   DATABASE_URL=... bun apps/api/scripts/create-agent.ts --scanner <name>     the active scanner (upzy-scan)
 *
 * The token is printed once; only its hash is stored.
 */
import { createDb, offeredRegions, schema } from "@upzy/db";

import { newAgentToken } from "../src/lib/agent-auth";

const args = process.argv.slice(2);
const scanner = args[0] === "--scanner";
const [region, name] = scanner ? ["-", args[1]] : args;
if (!region || !name) {
  console.error("Usage: bun apps/api/scripts/create-agent.ts <region> <name>");
  console.error("       bun apps/api/scripts/create-agent.ts --scanner <name>");
  process.exit(1);
}
const offered = offeredRegions();
if (!scanner && !offered.includes(region)) {
  console.error(
    `"${region}" is not one of this installation's regions (PROBE_REGIONS=${offered.join(",") || "unset"}).`,
  );
  process.exit(1);
}
const db = createDb(process.env.DATABASE_URL);
const { token, prefix, hashedToken } = newAgentToken();
await db
  .insert(schema.probeAgents)
  .values({ name, region, hashedToken, prefix, kind: scanner ? "scanner" : "probe" });
const what = scanner ? `Scanner "${name}"` : `Agent "${name}" for region ${region}`;
console.log(`${what} created. Its token (shown once):\n\n${token}\n`);
process.exit(0);
