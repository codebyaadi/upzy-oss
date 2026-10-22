import { describe, expect, test } from "bun:test";

import {
  CreateMaintenanceSchema,
  MAX_WINDOW_DAYS,
  maintenancePhase,
  UpdateMaintenanceSchema,
  windowProblem,
} from "../src/maintenance";

const NOW = new Date("2026-10-20T12:00:00Z");
const h = (hours: number) => new Date(NOW.getTime() + hours * 3_600_000);
const ok = { startsAt: h(1), endsAt: h(3), allMonitors: true, monitorIds: [] as string[] };
const WS = "01a1650e-7e4f-7514-bf21-358872bb8bb4";

describe("window rules", () => {
  test("a normal window is fine", () => {
    expect(windowProblem(ok, NOW)).toBeNull();
    expect(windowProblem({ ...ok, startsAt: h(-1) }, NOW)).toBeNull(); // already started
  });

  test("it must end after it starts and in the future", () => {
    expect(windowProblem({ ...ok, endsAt: ok.startsAt }, NOW)).toMatch(/after it starts/);
    expect(windowProblem({ ...ok, startsAt: h(-5), endsAt: h(-1) }, NOW)).toMatch(/in the future/);
  });

  test("it can't be very long or very far ahead", () => {
    expect(windowProblem({ ...ok, endsAt: h(24 * MAX_WINDOW_DAYS + 2) }, NOW)).toMatch(
      /at most 14/,
    );
    expect(windowProblem({ ...ok, startsAt: h(24 * 400), endsAt: h(24 * 400 + 2) }, NOW)).toMatch(
      /ahead/,
    );
  });

  test("it needs monitors unless it covers all of them", () => {
    expect(windowProblem({ ...ok, allMonitors: false, monitorIds: [] }, NOW)).toMatch(/Choose/);
    expect(windowProblem({ ...ok, allMonitors: false, monitorIds: [WS] }, NOW)).toBeNull();
  });

  test("an invalid date is reported", () => {
    expect(windowProblem({ ...ok, startsAt: new Date("nope") }, NOW)).toMatch(/valid/);
  });
});

describe("phases", () => {
  test("upcoming, active and past, with the end exclusive", () => {
    const w = { startsAt: h(1), endsAt: h(3) };
    expect(maintenancePhase(w, NOW)).toBe("upcoming");
    expect(maintenancePhase(w, h(1))).toBe("active");
    expect(maintenancePhase(w, h(2))).toBe("active");
    expect(maintenancePhase(w, h(3))).toBe("past");
  });
});

describe("request shapes", () => {
  test("create fills in defaults and trims the name", () => {
    const r = CreateMaintenanceSchema.parse({
      workspaceId: WS,
      name: "  DB upgrade ",
      startsAt: "2026-10-21T01:00:00Z",
      endsAt: "2026-10-21T02:00:00+05:30",
    });
    expect(r).toMatchObject({
      name: "DB upgrade",
      allMonitors: false,
      monitorIds: [],
      showOnStatusPage: true,
    });
  });

  test("dates must be full ISO instants, and the name is required", () => {
    expect(
      CreateMaintenanceSchema.safeParse({
        workspaceId: WS,
        name: "x",
        startsAt: "tomorrow",
        endsAt: "later",
      }).success,
    ).toBe(false);
    expect(
      CreateMaintenanceSchema.safeParse({
        workspaceId: WS,
        name: "   ",
        startsAt: "2026-10-21T01:00:00Z",
        endsAt: "2026-10-21T02:00:00Z",
      }).success,
    ).toBe(false);
  });

  test("update changes only what is sent", () => {
    expect(UpdateMaintenanceSchema.parse({})).toEqual({});
    expect(UpdateMaintenanceSchema.parse({ name: " New " })).toEqual({ name: "New" });
  });
});
