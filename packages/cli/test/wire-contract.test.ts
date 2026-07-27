/**
 * Shared normalized-session protocol ownership guard.
 *
 * The CLI and server may alias protocol types for package-local ergonomics,
 * but neither may redeclare the wire structure.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, test } from "bun:test";

const REPO_ROOT = join(import.meta.dirname, "../../..");
const CLI_MODEL = join(REPO_ROOT, "packages/cli/src/model.ts");
const SERVER_MODEL = join(REPO_ROOT, "packages/server/src/model.ts");
const CLI_SCHEMAS = join(REPO_ROOT, "packages/cli/src/core/schemas.ts");

describe("normalized-session wire-contract ownership", () => {
  test("CLI and server consume protocol types without redeclaring source rows", () => {
    const cliModel = readFileSync(CLI_MODEL, "utf8");
    const serverModel = readFileSync(SERVER_MODEL, "utf8");
    const cliSchemas = readFileSync(CLI_SCHEMAS, "utf8");

    expect(cliModel).toContain("@skastr0/quasar-protocol");
    expect(serverModel).toContain("@skastr0/quasar-protocol");
    expect(cliSchemas).toContain("@skastr0/quasar-protocol");

    for (const source of [cliModel, serverModel]) {
      expect(source).not.toMatch(
        /interface\s+(MappedSession|ProjectRow|SessionRow|MessageRow|ToolCallRow)\b/,
      );
    }
    expect(cliSchemas).not.toMatch(
      /const\s+(NormalizedSession|SessionEvent|ToolCall|SessionEdge)\s*=/,
    );
  });
});
