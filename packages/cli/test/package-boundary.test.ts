import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, test } from "bun:test";

const srcRoot = join(import.meta.dir, "..", "src");

const tsFiles = (root: string): readonly string[] =>
  readdirSync(root, { recursive: true })
    .filter((entry): entry is string => typeof entry === "string" && entry.endsWith(".ts"))
    .map((entry) => join(root, entry));

const offenders = (predicate: (source: string) => boolean): readonly string[] =>
  tsFiles(srcRoot).filter((file) => predicate(readFileSync(file, "utf8")));

describe("cli package boundary", () => {
  test("imports nothing from the server package", () => {
    expect(offenders((src) => src.includes("../../server") || src.includes("@skastr0/quasar-server"))).toEqual([]);
  });

  test("never runs Quasar's own store or search runtime (it is an HTTP client)", () => {
    // The CLI may read a provider's own sqlite history (opencode/hermes) via bun:sqlite —
    // that is parsing input. What it must never do is run the server's SQLite store,
    // LanceDB search, or the server Effect runtime in-process.
    expect(offenders((src) => /\bLocalStore\b/.test(src))).toEqual([]);
    expect(offenders((src) => /\bAppRuntime\b/.test(src))).toEqual([]);
    expect(offenders((src) => src.includes("@lancedb/lancedb"))).toEqual([]);
  });
});
