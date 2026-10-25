import { schema, type Db } from "@upzy/db";
import { and, desc, eq, isNull } from "drizzle-orm";
import { Elysia } from "elysia";
import { z } from "zod";

import { API_KEY_SCOPES, newKey } from "../lib/api-keys";
import type { AuthPlugin } from "../plugins/auth";
import { HttpError } from "../plugins/errors";

const { apiKeys } = schema;

const CreateKey = z.object({
  name: z.string().trim().min(1).max(80),
  scopes: z.array(z.enum(API_KEY_SCOPES)).min(1),
  /** Keys should not live forever by default. */
  expiresInDays: z.number().int().min(1).max(365).default(90),
});

const shape = (k: typeof apiKeys.$inferSelect) => ({
  id: k.id,
  name: k.name,
  prefix: k.prefix,
  scopes: k.scopes,
  createdAt: k.createdAt,
  expiresAt: k.expiresAt,
  lastUsedAt: k.lastUsedAt,
});

/**
 * Keys for the MCP server (docs/guides/MCP.md). An admin makes them; each acts as the admin who made it, read-only,
 * limited to the chosen scopes. The key is returned once and never again.
 */
export const apiKeyModule = (db: Db, authP: AuthPlugin) =>
  new Elysia({ prefix: "/api-keys" })
    .use(authP)
    .get(
      "/",
      async ({ orgId }) => {
        const rows = await db
          .select()
          .from(apiKeys)
          .where(and(eq(apiKeys.organizationId, orgId), isNull(apiKeys.revokedAt)))
          .orderBy(desc(apiKeys.createdAt));
        return rows.map(shape);
      },
      { org: "admin" },
    )
    .post(
      "/",
      async ({ user, orgId, body, set }) => {
        const { key, prefix, hashedKey } = newKey();
        const [row] = await db
          .insert(apiKeys)
          .values({
            organizationId: orgId,
            userId: user.id,
            name: body.name,
            hashedKey,
            prefix,
            scopes: [...new Set(body.scopes)],
            role: "viewer",
            expiresAt: new Date(Date.now() + body.expiresInDays * 86_400_000),
          })
          .returning();
        set.status = 201;
        return { ...shape(row!), key };
      },
      { org: "admin", body: CreateKey },
    )
    .delete(
      "/:id",
      async ({ orgId, params }) => {
        const [row] = await db
          .update(apiKeys)
          .set({ revokedAt: new Date() })
          .where(
            and(
              eq(apiKeys.id, params.id),
              eq(apiKeys.organizationId, orgId),
              isNull(apiKeys.revokedAt),
            ),
          )
          .returning({ id: apiKeys.id });
        if (!row) throw new HttpError(404, "Key not found");
        return { ok: true };
      },
      { org: "admin", params: z.object({ id: z.uuid() }) },
    );
