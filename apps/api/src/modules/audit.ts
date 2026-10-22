import { schema, type Db } from "@upzy/db";
import { and, desc, eq, lt } from "drizzle-orm";
import { Elysia } from "elysia";
import { z } from "zod";

import { csvRow } from "../lib/csv";
import type { AuthPlugin } from "../plugins/auth";

const { auditLogs: logs, users } = schema;

const Filters = z.object({
  before: z.uuid().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  userId: z.string().min(1).max(100).optional(),
  resourceType: z.string().min(1).max(50).optional(),
});
const EXPORT_LIMIT = 10_000;

const columns = {
  id: logs.id,
  createdAt: logs.createdAt,
  userId: logs.userId,
  userEmail: users.email,
  userName: users.name,
  action: logs.action,
  resourceType: logs.resourceType,
  resourceId: logs.resourceId,
  status: logs.status,
  ip: logs.ip,
  userAgent: logs.userAgent,
  payload: logs.payload,
};

/** Admin-only view of the organization's audit trail, with cursor pagination and CSV export. */
export const auditModule = (db: Db, authP: AuthPlugin) => {
  const query = (orgId: string, f: z.infer<typeof Filters>, limit: number) =>
    db
      .select(columns)
      .from(logs)
      .leftJoin(users, eq(users.id, logs.userId))
      .where(
        and(
          eq(logs.organizationId, orgId),
          f.before ? lt(logs.id, f.before) : undefined,
          f.userId ? eq(logs.userId, f.userId) : undefined,
          f.resourceType ? eq(logs.resourceType, f.resourceType) : undefined,
        ),
      )
      // uuidv7 ids sort by creation time, which makes `before` a stable cursor.
      .orderBy(desc(logs.id))
      .limit(limit);

  return new Elysia({ prefix: "/audit" })
    .use(authP)
    .get(
      "/",
      async ({ orgId, query: f }) => {
        const rows = await query(orgId, f, f.limit + 1);
        const items = rows.slice(0, f.limit);
        return { items, next: rows.length > f.limit ? items[items.length - 1]!.id : null };
      },
      { org: "admin", query: Filters },
    )
    .get(
      "/export",
      async ({ orgId, query: f, set }) => {
        const rows = await query(orgId, { ...f, limit: EXPORT_LIMIT }, EXPORT_LIMIT);
        set.headers["content-type"] = "text/csv; charset=utf-8";
        set.headers["content-disposition"] =
          `attachment; filename="audit-log-${new Date().toISOString().slice(0, 10)}.csv"`;
        const header = csvRow([
          "time",
          "user",
          "email",
          "action",
          "resource_type",
          "resource_id",
          "status",
          "ip",
          "user_agent",
          "details",
        ]);
        return [
          header,
          ...rows.map((r) =>
            csvRow([
              r.createdAt,
              r.userName,
              r.userEmail,
              r.action,
              r.resourceType,
              r.resourceId,
              r.status,
              r.ip,
              r.userAgent,
              r.payload,
            ]),
          ),
        ].join("\n");
      },
      { org: "admin", query: Filters.omit({ before: true, limit: true }) },
    );
};
