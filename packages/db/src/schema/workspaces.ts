import { index, pgTable, text, uniqueIndex, uuid } from "drizzle-orm/pg-core";

import { createdAt, id } from "./_helpers";
import { organizations } from "./auth";

export const workspaces = pgTable(
  "workspaces",
  {
    id: id(),
    orgId: text("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("workspaces_org_id_name_key").on(t.orgId, t.name),
    index("workspaces_org_id_idx").on(t.orgId),
  ],
);

/** FK column pointing at a workspace; cascades on delete. */
export const workspaceId = () =>
  uuid("workspace_id")
    .notNull()
    .references(() => workspaces.id, { onDelete: "cascade" });
