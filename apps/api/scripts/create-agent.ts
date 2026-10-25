/**
 * Makes a probe agent token for a region. Run by whoever operates the installation:
 *
 *   DATABASE_URL=... bun apps/api/scripts/create-agent.ts <region> <name>
 *
 * The token is printed once; only its hash is stored.
 */
import { createDb, offeredRegions, schema } from "@upzy/db";

import { newAgentToken } from "../src/lib/agent-auth";

const [region, name] = process.argv.slice(2);
if (!region || !name) {
  console.error("Usage: bun apps/api/scripts/create-agent.ts <region> <name>");
  process.exit(1);
}
const offered = offeredRegions();
if (!offered.includes(region)) {
  console.error(
    `"${region}" is not one of this installation's regions (PROBE_REGIONS=${offered.join(",") || "unset"}).`,
  );
  process.exit(1);
}
const db = createDb(process.env.DATABASE_URL);
const { token, prefix, hashedToken } = newAgentToken();
await db.insert(schema.probeAgents).values({ name, region, hashedToken, prefix });
console.log(`Agent "${name}" for region ${region} created. Its token (shown once):\n\n${token}\n`);
process.exit(0);
