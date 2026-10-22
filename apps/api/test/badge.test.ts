import { describe, expect, test } from "bun:test";

import { badge } from "../src/lib/badge";

describe("badge", () => {
  test("is a well-formed, labelled SVG", () => {
    const svg = badge("security", "A", "good");
    expect(svg.startsWith("<svg")).toBe(true);
    expect(svg).toContain('aria-label="security: A"');
    expect(svg).toContain("#0f7a6a");
    expect(svg.endsWith("</svg>")).toBe(true);
  });

  test("text is escaped, so nothing can break out of the markup", () => {
    const svg = badge("<script>alert(1)</script>", "\"&'", "bad");
    expect(svg).not.toContain("<script>");
    expect(svg).toContain("&lt;script&gt;");
    expect(svg).toContain("&quot;&amp;&#39;");
  });

  test("a longer value makes a wider badge", () => {
    const width = (s: string) => Number(/width="(\d+)"/.exec(s)![1]);
    expect(width(badge("status", "operational", "good"))).toBeGreaterThan(
      width(badge("status", "A", "good")),
    );
  });
});
