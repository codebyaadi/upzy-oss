import { describe, expect, test } from "bun:test";

import { BrowserStepSchema, CreateMonitorSchema, describeStep } from "../src";

const ws = "00000000-0000-4000-8000-000000000001";
const monitor = (config: object, over: object = {}) =>
  CreateMonitorSchema.safeParse({
    workspaceId: ws,
    name: "login",
    type: "synthetic",
    target: "https://example.com/login",
    interval: 300,
    config,
    ...over,
  });

describe("browser steps", () => {
  test("each action takes only what it needs", () => {
    for (const step of [
      { do: "goto", url: "https://example.com/a" },
      { do: "click", selector: "#go" },
      { do: "fill", selector: "#pw", value: "{{secret.PW}}" },
      { do: "press", key: "Enter" },
      { do: "wait_for", selector: "text=Welcome" },
      { do: "expect_text", text: "Welcome" },
      { do: "expect_text", text: "Welcome", selector: "h1" },
      { do: "expect_url", contains: "/dashboard" },
      { do: "wait", ms: 500 },
    ])
      expect(BrowserStepSchema.safeParse(step).success, JSON.stringify(step)).toBe(true);
  });

  test("there is no way to run code: unknown actions and extra fields are refused", () => {
    for (const step of [
      { do: "evaluate", script: "alert(1)" },
      { do: "click" },
      { do: "click", selector: "" },
      { do: "press", key: "F12" },
      { do: "wait", ms: 60_000 },
      { do: "wait", ms: 10 },
      { do: "expect_text", text: "" },
      { do: "click", selector: "x".repeat(201) },
    ])
      expect(BrowserStepSchema.safeParse(step).success, JSON.stringify(step)).toBe(false);
  });

  test("steps read as plain sentences", () => {
    expect(describeStep({ do: "click", selector: "#go" })).toBe("click #go");
    expect(describeStep({ do: "fill", selector: "#pw", value: "{{secret.PW}}" })).toBe(
      "type into #pw",
    );
    expect(describeStep({ do: "expect_text", text: "Hi", selector: "h1" })).toBe(
      'expect the text "Hi" in h1',
    );
  });
});

describe("a browser monitor", () => {
  test("is a page plus steps, with secrets for anything typed in", () => {
    const r = monitor(
      { browser: [{ do: "fill", selector: "#pw", value: "{{secret.PW}}" }] },
      { secrets: { PW: "hunter22" } },
    );
    expect(r.success).toBe(true);
  });

  test("may be just a page that has to load", () => {
    expect(monitor({}).success).toBe(true);
    expect(monitor({ browser: [] }).success).toBe(true);
  });

  test("a secret that isn't defined is caught before it ever runs", () => {
    const r = monitor({ browser: [{ do: "fill", selector: "#pw", value: "{{secret.NOPE}}" }] });
    expect(r.success).toBe(false);
    expect(JSON.stringify(r.error?.issues)).toContain("NOPE");
  });

  test("a variable from an earlier step makes no sense here", () => {
    const r = monitor({ browser: [{ do: "fill", selector: "#a", value: "{{token}}" }] });
    expect(r.success).toBe(false);
  });

  test("another page must be a public address", () => {
    for (const url of ["http://169.254.169.254/", "http://localhost:3000/", "ftp://example.com/"])
      expect(monitor({ browser: [{ do: "goto", url }] }).success, url).toBe(false);
    expect(monitor({ browser: [{ do: "goto", url: "https://example.com/next" }] }).success).toBe(
      true,
    );
  });

  test("the first page can't be a private address either", () => {
    expect(monitor({}, { target: "http://10.0.0.5/" }).success).toBe(false);
  });

  test("no more than 20 steps", () => {
    const steps = Array.from({ length: 21 }, () => ({ do: "wait", ms: 100 }));
    expect(monitor({ browser: steps }).success).toBe(false);
  });

  test("other monitor types can't carry browser steps", () => {
    const r = CreateMonitorSchema.safeParse({
      workspaceId: ws,
      name: "site",
      type: "http",
      target: "https://example.com",
      interval: 60,
      config: { browser: [{ do: "click", selector: "#x" }] },
    });
    expect(r.success).toBe(false);
  });
});
