import { expect, test } from "bun:test";

import { DEGRADED_AFTER, evaluate } from "../src/evaluate";

const base = { consecutiveFailures: 0, failureThreshold: 2, hasOpenIncident: false };

test("a single failure below the threshold stays unknown and opens nothing", () => {
  expect(evaluate({ ...base, resultStatus: "down" })).toEqual({
    consecutiveFailures: 1,
    consecutiveSlow: 0,
    monitorStatus: "unknown",
    incident: "none",
    suppressedByMaintenance: false,
  });
});

test("reaching the threshold marks down and opens an incident", () => {
  expect(evaluate({ ...base, consecutiveFailures: 1, resultStatus: "down" })).toEqual({
    consecutiveFailures: 2,
    consecutiveSlow: 0,
    monitorStatus: "down",
    incident: "open",
    suppressedByMaintenance: false,
  });
});

test("continued failures do not open a second incident", () => {
  expect(
    evaluate({ ...base, consecutiveFailures: 5, hasOpenIncident: true, resultStatus: "down" })
      .incident,
  ).toBe("none");
});

test("recovery resolves the open incident and resets the streak", () => {
  expect(
    evaluate({ ...base, consecutiveFailures: 5, hasOpenIncident: true, resultStatus: "up" }),
  ).toEqual({
    consecutiveFailures: 0,
    consecutiveSlow: 0,
    monitorStatus: "up",
    incident: "resolve",
    suppressedByMaintenance: false,
  });
});

test("a success mid-streak resets without touching incidents", () => {
  expect(evaluate({ ...base, consecutiveFailures: 1, resultStatus: "up" })).toEqual({
    consecutiveFailures: 0,
    consecutiveSlow: 0,
    monitorStatus: "up",
    incident: "none",
    suppressedByMaintenance: false,
  });
});

test("slow responses only count as degraded after several in a row", () => {
  let slowStreak = 0;
  const states: string[] = [];
  for (let n = 0; n < DEGRADED_AFTER + 1; n++) {
    const r = evaluate({ ...base, resultStatus: "up", slow: true, consecutiveSlow: slowStreak });
    slowStreak = r.consecutiveSlow;
    states.push(r.monitorStatus);
    expect(r.incident).toBe("none"); // being slow never opens an incident
  }
  expect(states).toEqual(["up", "up", "degraded", "degraded"]);
});

test("one fast response clears degraded and the slow streak", () => {
  const r = evaluate({ ...base, resultStatus: "up", slow: false, consecutiveSlow: 7 });
  expect(r).toMatchObject({ monitorStatus: "up", consecutiveSlow: 0 });
});

test("a monitor with no latency threshold is never degraded", () => {
  const r = evaluate({ ...base, resultStatus: "up", consecutiveSlow: 0 });
  expect(r.monitorStatus).toBe("up");
});

test("a failure ends a slow streak, and recovery from an outage starts a fresh one", () => {
  const down = evaluate({
    ...base,
    consecutiveFailures: 1,
    resultStatus: "down",
    consecutiveSlow: 5,
  });
  expect(down.consecutiveSlow).toBe(0);
  const back = evaluate({
    ...base,
    consecutiveFailures: 2,
    hasOpenIncident: true,
    resultStatus: "up",
    slow: true,
    consecutiveSlow: down.consecutiveSlow,
  });
  expect(back).toMatchObject({ incident: "resolve", consecutiveSlow: 1, monitorStatus: "up" });
});

test("during maintenance a failure past the threshold does not open an incident, but keeps counting", () => {
  const r = evaluate({
    ...base,
    consecutiveFailures: 1,
    resultStatus: "down",
    inMaintenance: true,
  });
  expect(r).toMatchObject({
    consecutiveFailures: 2,
    monitorStatus: "down",
    incident: "none",
    suppressedByMaintenance: true,
  });
});

test("an outage that outlasts the window opens its incident on the next failed check", () => {
  const afterWindow = evaluate({
    ...base,
    consecutiveFailures: 9,
    resultStatus: "down",
    inMaintenance: false,
  });
  expect(afterWindow).toMatchObject({ incident: "open", suppressedByMaintenance: false });
});

test("maintenance never hides an incident that is already open, or its recovery", () => {
  expect(
    evaluate({
      ...base,
      consecutiveFailures: 5,
      hasOpenIncident: true,
      resultStatus: "down",
      inMaintenance: true,
    }),
  ).toMatchObject({ incident: "none", suppressedByMaintenance: false });
  expect(
    evaluate({
      ...base,
      consecutiveFailures: 5,
      hasOpenIncident: true,
      resultStatus: "up",
      inMaintenance: true,
    }).incident,
  ).toBe("resolve");
});

test("a failure below the threshold during maintenance is just a normal unknown", () => {
  expect(evaluate({ ...base, resultStatus: "down", inMaintenance: true })).toMatchObject({
    monitorStatus: "unknown",
    suppressedByMaintenance: false,
  });
});
