import { describe, expect, test } from "bun:test";

import { parseSignupPolicy, signupBlockedReason, type SignupPolicy } from "../src/signup";

const policy = (over: Partial<SignupPolicy> = {}): SignupPolicy => ({
  mode: "invite",
  allowedEmails: [],
  allowedDomains: [],
  ...over,
});
const none = { userCount: 3, hasPendingInvitation: false };

describe("sign-up policy", () => {
  test("open lets anyone in", () => {
    expect(signupBlockedReason(policy({ mode: "open" }), "x@y.com", none)).toBeNull();
  });

  test("the very first account is always allowed, even when closed", () => {
    for (const mode of ["invite", "closed"] as const)
      expect(
        signupBlockedReason(policy({ mode }), "me@y.com", { ...none, userCount: 0 }),
      ).toBeNull();
  });

  test("naming an allow-list stops a stranger claiming a fresh install", () => {
    const fresh = { userCount: 0, hasPendingInvitation: false };
    const p = policy({ allowedEmails: ["me@y.com"] });
    expect(signupBlockedReason(p, "me@y.com", fresh)).toBeNull();
    expect(signupBlockedReason(p, "stranger@y.com", fresh)).not.toBeNull();
  });

  test("invite mode blocks strangers and says how to get in", () => {
    expect(signupBlockedReason(policy(), "x@y.com", none)).toContain("invitation");
  });

  test("an allow-listed email or domain, or a pending invitation, gets in (case-insensitively)", () => {
    const p = policy({ allowedEmails: ["boss@y.com"], allowedDomains: ["team.com"] });
    expect(signupBlockedReason(p, "Boss@Y.com", none)).toBeNull();
    expect(signupBlockedReason(p, "anyone@TEAM.com", none)).toBeNull();
    expect(signupBlockedReason(p, "anyone@team.com.evil.io", none)).not.toBeNull();
    expect(
      signupBlockedReason(policy(), "x@y.com", { ...none, hasPendingInvitation: true }),
    ).toBeNull();
  });

  test("a domain an organization has verified for single sign-on gets in", () => {
    expect(
      signupBlockedReason(policy(), "x@corp.com", { ...none, hasSsoDomain: true }),
    ).toBeNull();
    expect(
      signupBlockedReason(policy({ mode: "closed" }), "x@corp.com", { ...none, hasSsoDomain: true }),
    ).not.toBeNull();
  });

  test("closed ignores allow-lists and invitations", () => {
    const p = policy({ mode: "closed", allowedEmails: ["boss@y.com"] });
    expect(signupBlockedReason(p, "boss@y.com", { ...none, hasPendingInvitation: true })).toContain(
      "closed",
    );
  });

  test("the environment is parsed strictly", () => {
    expect(parseSignupPolicy({})).toEqual({ mode: "open", allowedEmails: [], allowedDomains: [] });
    expect(
      parseSignupPolicy({
        SIGNUP_MODE: " Invite ",
        SIGNUP_ALLOWED_EMAILS: "A@b.com, c@d.com",
        SIGNUP_ALLOWED_DOMAINS: "@team.com",
      }),
    ).toEqual({
      mode: "invite",
      allowedEmails: ["a@b.com", "c@d.com"],
      allowedDomains: ["team.com"],
    });
    expect(() => parseSignupPolicy({ SIGNUP_MODE: "invites" })).toThrow(/SIGNUP_MODE/);
  });
});
