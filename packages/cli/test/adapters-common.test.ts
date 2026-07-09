import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, test } from "bun:test";

import {
  numberValue,
  parseJsonString,
  readJsonFile,
  readJsonLines,
  recordFrom,
} from "../src/adapters/common";

const root = mkdtempSync(join(tmpdir(), "quasar-adapters-common-"));

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("adapter common boundaries", () => {
  test("readJsonLines names invalid JSON lines without throwing", () => {
    const path = join(root, "lines.jsonl");
    writeFileSync(path, "{\"ok\":true}\nnot-json\n{\"still\":\"ok\"}\n", "utf8");
    const diagnostics: { name: string; message: string }[] = [];
    const lines = readJsonLines(path, {
      diagnosticName: "test.line.invalid_json",
      diagnostics,
      sourcePath: "/fixture/lines.jsonl",
    });

    expect(lines.map((line) => line.lineNumber)).toEqual([1, 3]);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]!.name).toBe("test.line.invalid_json");
    expect(diagnostics[0]!.message).toContain("/fixture/lines.jsonl:2");
  });

  test("readJsonFile names invalid JSON without throwing", () => {
    const path = join(root, "file.json");
    writeFileSync(path, "{\"ok\":", "utf8");
    const diagnostics: { name: string; message: string }[] = [];

    expect(readJsonFile(path, {
      diagnosticName: "test.file.invalid_json",
      diagnostics,
      sourcePath: "/fixture/file.json",
    })).toBeUndefined();
    expect(diagnostics[0]!.name).toBe("test.file.invalid_json");
    expect(diagnostics[0]!.message).toContain("/fixture/file.json");
  });

  test("recordFrom, numberValue, and parseJsonString keep boundary coercion explicit", () => {
    expect(recordFrom({ a: 1 })).toEqual({ a: 1 });
    expect(recordFrom(null)).toEqual({});
    expect(numberValue(3)).toBe(3);
    expect(numberValue(Number.NaN)).toBeUndefined();
    expect(parseJsonString("{\"a\":1}")).toEqual({ a: 1 });
    expect(parseJsonString("not-json")).toBe("not-json");
  });
});
