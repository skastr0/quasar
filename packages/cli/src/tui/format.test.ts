import { expect, test } from "bun:test";

import { matchRanges, queryTerms, snippet, truncate, windowSlice } from "./format";

test("windowSlice keeps the selection visible and clamps at the ends", () => {
  expect(windowSlice(0, 3, 10)).toEqual({ start: 0, end: 3 });
  expect(windowSlice(0, 100, 10)).toEqual({ start: 0, end: 10 });
  expect(windowSlice(50, 100, 10)).toEqual({ start: 45, end: 55 });
  expect(windowSlice(99, 100, 10)).toEqual({ start: 90, end: 100 });
  expect(windowSlice(5, 0, 10)).toEqual({ start: 0, end: 0 });
});

test("queryTerms tokenizes, lowercases, drops noise", () => {
  expect(queryTerms("Vector Index  a")).toEqual(["vector", "index"]);
  expect(queryTerms("  ")).toEqual([]);
});

test("matchRanges finds non-overlapping ordered hits", () => {
  const text = "create vector index then vector table";
  const ranges = matchRanges(text, "vector");
  expect(ranges).toEqual([
    [7, 13],
    [25, 31],
  ]);
});

test("matchRanges merges overlapping term hits", () => {
  // "index" and "dex" both hit; ranges must not double-count
  const ranges = matchRanges("the index here", "index dex");
  expect(ranges).toEqual([[4, 9]]);
});

test("snippet windows around the first hit with ellipses", () => {
  const long = `${"x ".repeat(80)}the vector index lives here ${"y ".repeat(80)}`;
  const out = snippet(long, "vector index", 60);
  expect(out).toContain("vector index");
  expect(out.startsWith("…")).toBe(true);
  expect(out.endsWith("…")).toBe(true);
  expect(out.length).toBeLessThanOrEqual(64);
});

test("snippet returns full flattened text when short", () => {
  expect(snippet("  short   text ", "none", 100)).toBe("short text");
});

test("snippet falls back to head when nothing matches", () => {
  const out = snippet("a".repeat(200), "zzz", 50);
  expect(out.endsWith("…")).toBe(true);
  expect(out.length).toBe(50);
});

test("truncate respects the limit", () => {
  expect(truncate("hello", 10)).toBe("hello");
  expect(truncate("hello world", 5)).toBe("hell…");
});
