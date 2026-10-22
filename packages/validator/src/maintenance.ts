import z from "zod";

/** A window longer than this is almost certainly a mistake, and would silence alerts for a very long time. */
export const MAX_WINDOW_DAYS = 14;
/** Longest a window can be scheduled ahead, so an old typo in the year doesn't hide a monitor for months. */
export const MAX_WINDOW_AHEAD_DAYS = 365;

const DAY_MS = 86_400_000;

/** ISO 8601 with an offset, e.g. 2026-11-02T01:00:00Z. The API turns it into a Date. */
const Instant = z.iso.datetime({ offset: true, error: "Use a full date and time" });

const Name = z.string().trim().min(1, "Name the window").max(100, "At most 100 characters");

export interface WindowShape {
  startsAt: Date;
  endsAt: Date;
  allMonitors: boolean;
  monitorIds: string[];
}

/** The rules that depend on several fields, shared by creating and updating. Null when the window is fine. */
export function windowProblem(w: WindowShape, now: Date = new Date()): string | null {
  if (Number.isNaN(w.startsAt.getTime()) || Number.isNaN(w.endsAt.getTime()))
    return "Enter a valid start and end";
  if (w.endsAt.getTime() <= w.startsAt.getTime()) return "It must end after it starts";
  if (w.endsAt.getTime() - w.startsAt.getTime() > MAX_WINDOW_DAYS * DAY_MS)
    return `A window can last at most ${MAX_WINDOW_DAYS} days`;
  if (w.endsAt.getTime() <= now.getTime()) return "It must end in the future";
  if (w.startsAt.getTime() - now.getTime() > MAX_WINDOW_AHEAD_DAYS * DAY_MS)
    return `Schedule it at most ${MAX_WINDOW_AHEAD_DAYS} days ahead`;
  if (!w.allMonitors && w.monitorIds.length === 0) return "Choose the monitors it covers";
  return null;
}

export const CreateMaintenanceSchema = z.object({
  workspaceId: z.uuid(),
  name: Name,
  startsAt: Instant,
  endsAt: Instant,
  /** Every monitor in the workspace. When true, `monitorIds` is ignored. */
  allMonitors: z.boolean().default(false),
  monitorIds: z.array(z.uuid()).max(200).default([]),
  /** Show the window's name and times on public status pages that include an affected monitor. */
  showOnStatusPage: z.boolean().default(true),
});
export type CreateMaintenanceInput = z.infer<typeof CreateMaintenanceSchema>;

/** Only what is sent changes. The cross-field rules are checked against the merged result. */
export const UpdateMaintenanceSchema = z.object({
  name: Name.optional(),
  startsAt: Instant.optional(),
  endsAt: Instant.optional(),
  allMonitors: z.boolean().optional(),
  monitorIds: z.array(z.uuid()).max(200).optional(),
  showOnStatusPage: z.boolean().optional(),
});
export type UpdateMaintenanceInput = z.infer<typeof UpdateMaintenanceSchema>;

export type MaintenancePhase = "upcoming" | "active" | "past";

export function maintenancePhase(w: { startsAt: Date; endsAt: Date }, now: Date): MaintenancePhase {
  if (now.getTime() < w.startsAt.getTime()) return "upcoming";
  return now.getTime() < w.endsAt.getTime() ? "active" : "past";
}
