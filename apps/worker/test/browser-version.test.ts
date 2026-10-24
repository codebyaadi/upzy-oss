import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const read = (path: string) => readFileSync(new URL(`../../../${path}`, import.meta.url), "utf8");

describe("the browser image and the client agree", () => {
  test("Dockerfile.browser installs the playwright-core version the worker uses, exactly", () => {
    const client = JSON.parse(read("apps/worker/package.json")).dependencies["playwright-core"];
    expect(client).toMatch(/^\d+\.\d+\.\d+$/); // pinned, not a range
    const image = read("docker/Dockerfile.browser").match(/^ARG PLAYWRIGHT_VERSION=(\S+)/m)?.[1];
    expect(image).toBe(client);
  });
});
