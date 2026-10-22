import { describe, expect, test } from "bun:test";

import { authProviders, githubCredentials } from "../src/server";

describe("github sign-in", () => {
  test("needs both the client id and the secret", () => {
    expect(authProviders({})).toEqual({ github: false });
    expect(authProviders({ GITHUB_CLIENT_ID: "id" })).toEqual({ github: false });
    expect(authProviders({ GITHUB_CLIENT_ID: "id", GITHUB_CLIENT_SECRET: " " })).toEqual({
      github: false,
    });
    expect(authProviders({ GITHUB_CLIENT_ID: "id", GITHUB_CLIENT_SECRET: "s" })).toEqual({
      github: true,
    });
  });

  test("trims credentials", () => {
    expect(githubCredentials({ GITHUB_CLIENT_ID: " id ", GITHUB_CLIENT_SECRET: " s " })).toEqual({
      clientId: "id",
      clientSecret: "s",
    });
  });
});
