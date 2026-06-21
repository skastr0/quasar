/**
 * SessionRow drift guard (QSR-220 carried-forward).
 *
 * packages/cli/src/model.ts and packages/server/src/model.ts each declare a
 * `SessionRow` interface — the shared wire contract between the CLI ingest
 * writer and the server store reader. They must stay byte-for-byte identical
 * in field names, order, and types.
 *
 * This test extracts the `interface SessionRow { ... }` block from both files
 * and fails if they diverge, locking the invariant that the two surfaces are
 * always in sync.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, test } from "bun:test";

const REPO_ROOT = join(import.meta.dirname, "../../..");

const CLI_MODEL = join(REPO_ROOT, "packages/cli/src/model.ts");
const SERVER_MODEL = join(REPO_ROOT, "packages/server/src/model.ts");

/**
 * Extract the `interface SessionRow { ... }` block from a TypeScript source
 * string. Handles multi-line JSDoc comments that precede individual fields.
 * Returns the raw block content (field declarations only, without the opening
 * and closing braces), with blank lines and JSDoc comments stripped so the
 * comparison is structural: same field names, order, and types.
 */
function extractSessionRowBlock(source: string): string {
  // Find the start of `interface SessionRow {`
  const startMatch = source.match(/interface\s+SessionRow\s*\{/);
  if (startMatch === null || startMatch.index === undefined) {
    throw new Error("interface SessionRow not found");
  }
  const blockStart = startMatch.index + startMatch[0].length;

  // Walk character by character to find the matching closing `}`, respecting
  // nesting depth. (SessionRow fields may include string union types with `|`
  // but no nested `{`; this handles the general case.)
  let depth = 1;
  let i = blockStart;
  while (i < source.length && depth > 0) {
    if (source[i] === "{") depth++;
    else if (source[i] === "}") depth--;
    i++;
  }
  const rawBlock = source.slice(blockStart, i - 1);

  // Normalize: strip JSDoc comment blocks (/** ... */), single-line comments
  // (// ...), blank lines, and leading/trailing whitespace from each line.
  const normalized = rawBlock
    .split("\n")
    .map((line) => line.trim())
    // Drop JSDoc comment lines and blank lines; keep field declarations.
    .filter((line) => {
      if (line === "") return false;
      if (line.startsWith("/**") || line.startsWith("*") || line.startsWith("*/")) return false;
      if (line.startsWith("//")) return false;
      return true;
    })
    .join("\n");

  return normalized;
}

describe("SessionRow wire-contract drift guard", () => {
  test("cli/src/model.ts and server/src/model.ts declare the same SessionRow interface", () => {
    const cliSource = readFileSync(CLI_MODEL, "utf8");
    const serverSource = readFileSync(SERVER_MODEL, "utf8");

    const cliBlock = extractSessionRowBlock(cliSource);
    const serverBlock = extractSessionRowBlock(serverSource);

    expect(cliBlock).toBe(serverBlock);
  });
});
