import { schema, type Db } from "@upzy/db";
import { CreateWorkspaceSchema, UpdateWorkspaceSchema } from "@upzy/validator";
import { and, asc, eq, inArray } from "drizzle-orm";
import { Elysia } from "elysia";
import { z } from "zod";

import { orgWorkspaceIds } from "../lib/scope";
import type { AuthPlugin } from "../plugins/auth";
import { HttpError } from "../plugins/errors";

const { workspaces } = schema;
const columns = { id: workspaces.id, name: workspaces.name };
const Params = z.object({ id: z.uuid() });

export const workspaceModule = (db: Db, authP: AuthPlugin) =>
  new Elysia({ prefix: "/workspace" })
    .use(authP)
    .post(
      "/",
      async ({ body, orgId, set }) => {
        const [row] = await db
          .insert(workspaces)
          .values({ orgId, name: body.name })
          .returning(columns);
        set.status = 201;
        return row;
      },
      { org: "admin", body: CreateWorkspaceSchema },
    )
    .get(
      "/",
      ({ orgId, user }) =>
        db
          .select(columns)
          .from(workspaces)
          .where(inArray(workspaces.id, orgWorkspaceIds(db, orgId, user.id)))
          .orderBy(asc(workspaces.name)),
      {
        org: true,
      },
    )
    .get(
      "/:id",
      async ({ params, orgId, user }) => {
        const [row] = await db
          .select(columns)
          .from(workspaces)
          .where(
            and(
              eq(workspaces.id, params.id),
              inArray(workspaces.id, orgWorkspaceIds(db, orgId, user.id)),
            ),
          );
        if (!row) throw new HttpError(404, "Workspace not found");
        return row;
      },
      { org: true, params: Params },
    )
    .patch(
      "/:id",
      async ({ params, body, orgId }) => {
        const [row] = await db
          .update(workspaces)
          .set(body)
          .where(and(eq(workspaces.id, params.id), eq(workspaces.orgId, orgId)))
          .returning(columns);
        if (!row) throw new HttpError(404, "Workspace not found");
        return row;
      },
      { org: "admin", params: Params, body: UpdateWorkspaceSchema },
    )
    .delete(
      "/:id",
      async ({ params, orgId, set }) => {
        const rows = await db
          .delete(workspaces)
          .where(and(eq(workspaces.id, params.id), eq(workspaces.orgId, orgId)))
          .returning({ id: workspaces.id });
        if (rows.length === 0) throw new HttpError(404, "Workspace not found");
        set.status = 204;
      },
      { org: "admin", params: Params },
    );
