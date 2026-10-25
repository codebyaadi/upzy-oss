import { schema, type Db } from "@upzy/db";
import { sql } from "drizzle-orm";
import { Elysia } from "elysia";
import { z } from "zod";

import { requireWorkspace } from "../lib/scope";
import type { AuthPlugin } from "../plugins/auth";

const { monitors, incidents } = schema;

/**
 * A fingerprint of what the dashboard shows as state: each monitor's status and whether it is paused, and which
 * incidents are open or were resolved recently. The web app polls this every few seconds, which is cheap (two indexed
 * reads of one workspace, no checks or rollups), and refetches the heavier pages only when it changes. So a state
 * change shows up within seconds, while an idle tab reads no aggregates.
 */
export const changesModule = (db: Db, authP: AuthPlugin) =>
  new Elysia({ prefix: "/changes" }).use(authP).get(
    "/",
    async ({ user, orgId, query }) => {
      await requireWorkspace(db, orgId, query.workspaceId, user.id);
      const [m] = [
        ...(await db.execute<{ v: string }>(sql`
          select md5(coalesce(string_agg(id || ':' || last_status || ':' || active::text, ',' order by id), '')) as v
          from ${monitors} where workspace_id = ${query.workspaceId}`)),
      ];
      const [i] = [
        ...(await db.execute<{ v: string }>(sql`
          select md5(coalesce(string_agg(id || ':' || status || ':' || coalesce(resolved_at::text, ''), ',' order by id), '')) as v
          from ${incidents}
          where workspace_id = ${query.workspaceId}
            and (status <> 'resolved' or resolved_at > now() - interval '1 day')`)),
      ];
      return { monitors: m?.v ?? "", incidents: i?.v ?? "" };
    },
    { org: true, query: z.object({ workspaceId: z.uuid() }) },
  );
