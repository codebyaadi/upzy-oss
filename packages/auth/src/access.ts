import { createAccessControl } from "better-auth/plugins/access";
import {
  adminAc,
  defaultStatements,
  memberAc,
  ownerAc,
} from "better-auth/plugins/organization/access";

// better-auth only accepts roles it knows about, so "viewer" is registered with no organization powers.
// Shared by the server and the browser client so both agree on the role names.
export const ac = createAccessControl(defaultStatements);
export const orgRoles = {
  owner: ownerAc,
  admin: adminAc,
  member: memberAc,
  viewer: ac.newRole({ organization: [], member: [], invitation: [] }),
};
