import { and, eq, gt, inArray, isNotNull, lt, or } from "drizzle-orm";
import type { PgDatabase } from "drizzle-orm/pg-core";

import { maintenanceWindowMonitors, maintenanceWindows, monitors } from "./schema";

// Works with the database and with a transaction.
type Executor = PgDatabase<any, any, any>;

export interface MaintenanceWindowRef {
  id: string;
  name: string;
  startsAt: Date;
  endsAt: Date;
  showOnStatusPage: boolean;
}

/**
 * Which of these monitors a window covers, among the windows that overlap [from, to). A window covers a monitor when
 * it is set to "all monitors" of the monitor's workspace, or lists it. Returns every covering window per monitor,
 * the one ending last first.
 */
export async function windowsCovering(
  db: Executor,
  monitorIds: string[],
  from: Date,
  to: Date,
): Promise<Map<string, MaintenanceWindowRef[]>> {
  const out = new Map<string, MaintenanceWindowRef[]>();
  if (monitorIds.length === 0) return out;
  const rows = await db
    .select({
      monitorId: monitors.id,
      id: maintenanceWindows.id,
      name: maintenanceWindows.name,
      startsAt: maintenanceWindows.startsAt,
      endsAt: maintenanceWindows.endsAt,
      showOnStatusPage: maintenanceWindows.showOnStatusPage,
    })
    .from(monitors)
    .innerJoin(maintenanceWindows, eq(maintenanceWindows.workspaceId, monitors.workspaceId))
    .leftJoin(
      maintenanceWindowMonitors,
      and(
        eq(maintenanceWindowMonitors.windowId, maintenanceWindows.id),
        eq(maintenanceWindowMonitors.monitorId, monitors.id),
      ),
    )
    .where(
      and(
        inArray(monitors.id, monitorIds),
        lt(maintenanceWindows.startsAt, to),
        gt(maintenanceWindows.endsAt, from),
        or(
          eq(maintenanceWindows.allMonitors, true),
          isNotNull(maintenanceWindowMonitors.monitorId),
        ),
      ),
    );
  for (const { monitorId, ...w } of rows) out.set(monitorId, [...(out.get(monitorId) ?? []), w]);
  for (const list of out.values()) list.sort((a, b) => b.endsAt.getTime() - a.endsAt.getTime());
  return out;
}

/** The window covering each monitor at `now` (the one that ends last), for the monitors that have one. */
export async function activeMaintenance(
  db: Executor,
  monitorIds: string[],
  now: Date = new Date(),
): Promise<Map<string, MaintenanceWindowRef>> {
  // A window is active when starts_at <= now < ends_at: ask for [now, now + 1 ms) and filter on the start.
  const covering = await windowsCovering(db, monitorIds, now, new Date(now.getTime() + 1));
  const active = new Map<string, MaintenanceWindowRef>();
  for (const [id, list] of covering) {
    const current = list.find((w) => w.startsAt.getTime() <= now.getTime());
    if (current) active.set(id, current);
  }
  return active;
}
