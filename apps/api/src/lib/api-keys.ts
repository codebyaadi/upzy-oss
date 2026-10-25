import { createHash, randomBytes } from "node:crypto";

import { schema, type Db } from "@upzy/db";
import { and, eq, gt, isNull, or, sql } from "drizzle-orm";

const { apiKeys, members } = schema;

/** What a key may read. Each maps to a group of the copilot's read-only tools (see TOOL_SCOPE in modules/mcp.ts). */
export const API_KEY_SCOPES = ["monitors:read", "incidents:read", "security:read"] as const;
export type ApiKeyScope = (typeof API_KEY_SCOPES)[number];

export const KEY_PREFIX = "upzy_mcp_";

/** Keys are 256 random bits, so a plain SHA-256 is enough to store them: there is nothing to brute-force. */
export const hashKey = (key: string) => createHash("sha256").update(key).digest("hex");

export function newKey(): { key: string; prefix: string; hashedKey: string } {
  const key = `${KEY_PREFIX}${randomBytes(32).toString("base64url")}`;
  return { key, prefix: key.slice(0, KEY_PREFIX.length + 6), hashedKey: hashKey(key) };
}

export interface KeyHolder {
  keyId: string;
  orgId: string;
  userId: string;
  scopes: string[];
}

/**
 * The key behind an `Authorization: Bearer ...` header, or null. A key stops working when it is revoked or expired, or
 * when the member who made it has left the organization (their access ended, so does anything acting as them).
 */
export async function authenticateKey(
  db: Db,
  header: string | null | undefined,
): Promise<KeyHolder | null> {
  const key = /^Bearer\s+(\S+)$/i.exec(header ?? "")?.[1];
  if (!key?.startsWith(KEY_PREFIX)) return null;
  const [row] = await db
    .select({
      id: apiKeys.id,
      orgId: apiKeys.organizationId,
      userId: apiKeys.userId,
      scopes: apiKeys.scopes,
      lastUsedAt: apiKeys.lastUsedAt,
    })
    .from(apiKeys)
    .innerJoin(
      members,
      and(eq(members.organizationId, apiKeys.organizationId), eq(members.userId, apiKeys.userId)),
    )
    .where(
      and(
        eq(apiKeys.hashedKey, hashKey(key)),
        isNull(apiKeys.revokedAt),
        or(isNull(apiKeys.expiresAt), gt(apiKeys.expiresAt, sql`now()`)),
      ),
    );
  if (!row?.userId) return null;
  // Remember it was used, but not on every call.
  if (!row.lastUsedAt || Date.now() - row.lastUsedAt.getTime() > 60_000)
    await db.update(apiKeys).set({ lastUsedAt: new Date() }).where(eq(apiKeys.id, row.id));
  return { keyId: row.id, orgId: row.orgId, userId: row.userId, scopes: row.scopes };
}
