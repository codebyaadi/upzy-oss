import { describe, expect, test } from "bun:test";

import { csvCell, csvRow } from "../src/lib/csv";

describe("csv", () => {
  test("plain values pass through; separators and quotes are escaped", () => {
    expect(csvCell("hello")).toBe("hello");
    expect(csvCell('say "hi", ok')).toBe('"say ""hi"", ok"');
    expect(csvCell("line1\nline2")).toBe('"line1\nline2"');
  });
  test("nulls, dates and objects are serialised", () => {
    expect(csvCell(null)).toBe("");
    expect(csvCell(new Date("2026-01-01T00:00:00Z"))).toBe("2026-01-01T00:00:00.000Z");
    expect(csvCell({ a: 1 })).toBe('"{""a"":1}"');
  });
  test("spreadsheet formulas are neutralised", () => {
    for (const evil of ['=HYPERLINK("http://evil")', "+1+1", "-2+3", "@SUM(A1)", "\tcmd"])
      expect(csvCell(evil).replace(/^"/, "").startsWith("'")).toBe(true);
    expect(csvCell("-")).toBe("'-");
  });
  test("a row joins cells", () => expect(csvRow(["a", "b,c", 3])).toBe('a,"b,c",3'));
});
