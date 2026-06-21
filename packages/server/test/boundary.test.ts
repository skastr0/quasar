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

describe("server package boundary", () => {
  test("imports no CLI code and no provider parsers", () => {
    expect(offenders((src) => src.includes("@skastr0/quasar-cli") || src.includes("../cli/"))).toEqual([]);
    expect(offenders((src) => /from "\.\/adapters/.test(src) || /from "\.\.\/.*adapters/.test(src))).toEqual([]);
  });

  test("does no provider history-root discovery", () => {
    expect(offenders((src) => /QUASAR_(CODEX|CLAUDE|OPENCODE|GROK|HERMES|KIMI|ANTIGRAVITY)_ROOT/.test(src))).toEqual([]);
  });
});
