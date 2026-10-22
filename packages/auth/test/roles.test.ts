import { describe, expect, test } from "bun:test";

import { effectiveRole, hasRole } from "../src/roles";

describe("roles", () => {
  test("the highest of several comma-separated roles wins", () => {
    expect(effectiveRole("member,admin")).toBe("admin");
    expect(effectiveRole(" viewer , member ")).toBe("member");
  });

  test("unknown, empty and missing roles grant nothing", () => {
    expect(effectiveRole("superuser")).toBeNull();
    expect(effectiveRole("")).toBeNull();
    expect(effectiveRole(undefined)).toBeNull();
    expect(hasRole("superuser", "viewer")).toBe(false);
  });

  test("hierarchy", () => {
    expect(hasRole("owner", "admin")).toBe(true);
    expect(hasRole("admin", "member")).toBe(true);
    expect(hasRole("member", "member")).toBe(true);
    expect(hasRole("member", "admin")).toBe(false);
    expect(hasRole("viewer", "member")).toBe(false);
    expect(hasRole("viewer", "viewer")).toBe(true);
  });
});
