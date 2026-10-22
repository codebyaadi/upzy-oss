import { index, pgTable, primaryKey, text, timestamp, uuid } from "drizzle-orm/pg-core";

import { organizations, users } from "./auth";
import { workspaces } from "./workspaces";

/**
 * Members who may only see some of an organization's workspaces (an agency's client, a contractor). Everyone else in an
 * organization sees all of its workspaces, as before. A restricted member with no workspace listed sees nothing.
 */
export const restrictedMembers = pgTable(
  "restricted_members",
  {
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.organizationId, t.userId] })],
);

/** The workspaces a restricted member may see. */
export const workspaceAccess = pgTable(
  "workspace_access",
  {
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.workspaceId] }),
    index("workspace_access_workspace_idx").on(t.workspaceId),
  ],
);

/**
 * The same limit, recorded before the person has joined: set when inviting, applied the moment the invitation is
 * accepted (before the membership exists), so there is never a moment when they can see everything.
 */
export const pendingWorkspaceAccess = pgTable(
  "pending_workspace_access",
  {
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    /** Lowercased, as on the invitation. */
    email: text("email").notNull(),
    /** Null: restricted to no workspace yet (the row still marks the invitation as restricted). */
    workspaceId: uuid("workspace_id").references(() => workspaces.id, { onDelete: "cascade" }),
  },
  (t) => [index("pending_workspace_access_idx").on(t.organizationId, t.email)],
);
