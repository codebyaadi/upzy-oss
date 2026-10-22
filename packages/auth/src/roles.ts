/**
 * Organization roles, lowest to highest privilege:
 *   viewer  read-only
 *   member  create and change monitors, assets and findings; acknowledge incidents
 *   admin   also manage workspaces, notification channels, alert rules, the audit log and the team
 *   owner   everything, including who else is an owner
 */
export const ROLES = ["viewer", "member", "admin", "owner"] as const;
export type Role = (typeof ROLES)[number];

const RANK: Record<Role, number> = { viewer: 1, member: 2, admin: 3, owner: 4 };

export const isRole = (value: string): value is Role => value in RANK;

/** better-auth stores a member's role as a string, possibly comma-separated. The highest wins. Unknown roles count for nothing. */
export function effectiveRole(stored: string | null | undefined): Role | null {
  const roles = (stored ?? "")
    .split(",")
    .map((r) => r.trim())
    .filter(isRole);
  return roles.sort((a, b) => RANK[b] - RANK[a])[0] ?? null;
}

export const hasRole = (stored: string | null | undefined, minimum: Role): boolean => {
  const role = effectiveRole(stored);
  return role !== null && RANK[role] >= RANK[minimum];
};
