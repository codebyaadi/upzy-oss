import { expect, test } from "bun:test";

import { evaluate } from "../src/evaluate";

const base = { consecutiveFailures: 0, failureThreshold: 2, hasOpenIncident: false };

test("a single failure below the threshold stays unknown and opens nothing", () => {
  expect(evaluate({ ...base, resultStatus: "down" })).toEqual({
    consecutiveFailures: 1,
    monitorStatus: "unknown",
    incident: "none",
  });
});

test("reaching the threshold marks down and opens an incident", () => {
  expect(evaluate({ ...base, consecutiveFailures: 1, resultStatus: "down" })).toEqual({
    consecutiveFailures: 2,
    monitorStatus: "down",
    incident: "open",
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
  ).toEqual({ consecutiveFailures: 0, monitorStatus: "up", incident: "resolve" });
});

test("a success mid-streak resets without touching incidents", () => {
  expect(evaluate({ ...base, consecutiveFailures: 1, resultStatus: "up" })).toEqual({
    consecutiveFailures: 0,
    monitorStatus: "up",
    incident: "none",
  });
});
