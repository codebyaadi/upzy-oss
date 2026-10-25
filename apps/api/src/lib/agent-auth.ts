import { createHash, randomBytes } from "node:crypto";

import { schema, type Db } from "@upzy/db";
import { and, eq, isNull } from "drizzle-orm";

const { probeAgents } = schema;

export const AGENT_TOKEN_PREFIX = "upzy_agent_";
const hash = (t: string) => createHash("sha256").update(t).digest("hex");

export function newAgentToken() {
  const token = `${AGENT_TOKEN_PREFIX}${randomBytes(32).toString("base64url")}`;
  return { token, prefix: token.slice(0, AGENT_TOKEN_PREFIX.length + 6), hashedToken: hash(token) };
}

export interface Agent {
  id: string;
  name: string;
  region: string;
  kind: "probe" | "scanner";
}

/** The agent behind a `Bearer upzy_agent_...` header, or null when the token is unknown, revoked or of another kind (a probe token cannot call the scanner API, nor the reverse). */
export async function authenticateAgent(
  db: Db,
  header: string | null | undefined,
  kind: "probe" | "scanner" = "probe",
): Promise<Agent | null> {
  const token = /^Bearer\s+(\S+)$/i.exec(header ?? "")?.[1];
  if (!token?.startsWith(AGENT_TOKEN_PREFIX)) return null;
  const [row] = await db
    .select({
      id: probeAgents.id,
      name: probeAgents.name,
      region: probeAgents.region,
      kind: probeAgents.kind,
    })
    .from(probeAgents)
    .where(
      and(
        eq(probeAgents.hashedToken, hash(token)),
        eq(probeAgents.kind, kind),
        isNull(probeAgents.revokedAt),
      ),
    );
  return row ?? null;
}
