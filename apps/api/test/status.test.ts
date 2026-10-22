import { describe, expect, test } from "bun:test";

import { dailyUptime, overallStatus, overallUptime } from "../src/lib/status";

const at = (s: string) => new Date(s);
const NOW = at("2026-03-10T12:00:00Z");
const OLD = at("2025-01-01T00:00:00Z");

describe("daily uptime", () => {
  test("returns one entry per UTC day, oldest first, ending today", () => {
    const d = dailyUptime([], OLD, NOW, 90);
    expect(d).toHaveLength(90);
    expect(d[0]!.date).toBe("2025-12-11");
    expect(d.at(-1)!.date).toBe("2026-03-10");
    expect(d.every((x) => x.uptime === 100)).toBe(true);
  });

  test("an outage lowers only the days it covered, by the share of the day", () => {
    const d = dailyUptime(
      [{ start: at("2026-03-08T06:00:00Z"), end: at("2026-03-08T12:00:00Z") }],
      OLD,
      NOW,
      5,
    );
    expect(d.map((x) => x.uptime)).toEqual([100, 100, 75, 100, 100]);
  });

  test("an outage across midnight is split between the days", () => {
    const d = dailyUptime(
      [{ start: at("2026-03-08T18:00:00Z"), end: at("2026-03-09T06:00:00Z") }],
      OLD,
      NOW,
      4,
    );
    expect(d.find((x) => x.date === "2026-03-08")!.uptime).toBe(75);
    expect(d.find((x) => x.date === "2026-03-09")!.uptime).toBe(75);
  });

  test("an outage that is still going on counts up to now, and today is only measured to now", () => {
    const d = dailyUptime([{ start: at("2026-03-10T06:00:00Z"), end: null }], OLD, NOW, 2);
    // Today so far is 12 hours, 6 of them down.
    expect(d.at(-1)!.uptime).toBe(50);
  });

  test("days before the monitor existed are null, and the first day counts only from its creation", () => {
    const d = dailyUptime([], at("2026-03-09T12:00:00Z"), NOW, 4);
    expect(d.map((x) => x.uptime)).toEqual([null, null, 100, 100]);
    const half = dailyUptime(
      [{ start: at("2026-03-09T12:00:00Z"), end: at("2026-03-09T18:00:00Z") }],
      at("2026-03-09T12:00:00Z"),
      NOW,
      2,
    );
    // Existed for 12 hours of that day, 6 of them down.
    expect(half[0]!.uptime).toBe(50);
  });

  test("overlapping outages don't count a minute twice", () => {
    const d = dailyUptime(
      [
        { start: at("2026-03-09T00:00:00Z"), end: at("2026-03-09T12:00:00Z") },
        { start: at("2026-03-09T06:00:00Z"), end: at("2026-03-09T12:00:00Z") },
      ],
      OLD,
      NOW,
      2,
    );
    expect(d[0]!.uptime).toBe(50);
  });
});

describe("summary", () => {
  test("overall uptime averages the days that have data", () => {
    expect(
      overallUptime([
        { date: "a", uptime: null },
        { date: "b", uptime: 100 },
        { date: "c", uptime: 50 },
      ]),
    ).toBe(75);
    expect(overallUptime([{ date: "a", uptime: null }])).toBeNull();
  });

  test("overall status", () => {
    expect(overallStatus([{ status: "operational" }, { status: "operational" }])).toBe(
      "operational",
    );
    expect(overallStatus([{ status: "operational" }, { status: "outage" }])).toBe("partial");
    expect(overallStatus([{ status: "outage" }, { status: "outage" }])).toBe("major");
    expect(overallStatus([{ status: "paused" }, { status: "operational" }])).toBe("operational");
    expect(overallStatus([])).toBe("operational");
  });

  test("slow or planned work is shown when nothing is down, and an outage outranks both", () => {
    expect(overallStatus([{ status: "operational" }, { status: "degraded" }])).toBe("degraded");
    expect(overallStatus([{ status: "operational" }, { status: "maintenance" }])).toBe(
      "maintenance",
    );
    expect(overallStatus([{ status: "degraded" }, { status: "maintenance" }])).toBe("degraded");
    expect(overallStatus([{ status: "maintenance" }, { status: "outage" }])).toBe("partial");
    expect(overallStatus([{ status: "degraded" }, { status: "outage" }])).toBe("partial");
    expect(overallStatus([{ status: "maintenance" }, { status: "paused" }])).toBe("maintenance");
    expect(overallStatus([{ status: "paused" }])).toBe("operational");
  });
});
