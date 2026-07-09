import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, test } from "bun:test";

import {
  numberValue,
  parseJsonString,
  readJsonFile,
  readJsonLines,
  recordFrom,
  stringValue,
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
    // custom base + real kind: trailing .invalid_json on the base is stripped then re-applied
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
    expect(diagnostics[0]!.message).toContain("invalid_json");
    expect(diagnostics[0]!.message).toContain("/fixture/file.json");
  });

  test("readJsonFile distinguishes missing from unreadable even with custom diagnosticName", () => {
    const missingPath = join(root, "does-not-exist.json");
    const missingDiagnostics: { name: string; message: string }[] = [];
    // Custom name that would previously mask ALL kinds as invalid_json:
    expect(readJsonFile(missingPath, {
      diagnosticName: "test.file.invalid_json",
      diagnostics: missingDiagnostics,
      sourcePath: "/fixture/missing.json",
    })).toBeUndefined();
    expect(missingDiagnostics[0]!.name).toBe("test.file.missing");
    expect(missingDiagnostics[0]!.message).toContain("(missing)");

    const unreadablePath = join(root, "unreadable.json");
    writeFileSync(unreadablePath, "{\"ok\":true}\n", "utf8");
    chmodSync(unreadablePath, 0);
    try {
      const unreadableDiagnostics: { name: string; message: string }[] = [];
      expect(readJsonFile(unreadablePath, {
        diagnosticName: "test.file.invalid_json",
        diagnostics: unreadableDiagnostics,
        sourcePath: "/fixture/unreadable.json",
      })).toBeUndefined();
      expect(unreadableDiagnostics[0]!.name).toBe("test.file.unreadable");
      expect(unreadableDiagnostics[0]!.message).toContain("(unreadable)");
    } finally {
      chmodSync(unreadablePath, 0o600);
    }
  });

  test("recordFrom never returns empty object for wrong shape", () => {
    expect(recordFrom({ a: 1 })).toEqual({ a: 1 });
    expect(recordFrom(null)).toBeUndefined();
    expect(recordFrom(undefined)).toBeUndefined();
    expect(recordFrom("string")).toBeUndefined();
    expect(recordFrom([1, 2])).toBeUndefined();
    const diagnostics: { name: string; message: string }[] = [];
    expect(recordFrom(42, { diagnostics, diagnosticName: "test.record.wrong_shape" })).toBeUndefined();
    expect(diagnostics[0]!.name).toBe("test.record.wrong_shape");
  });

  test("numberValue and stringValue use visible Schema decode for optional fields", () => {
    expect(numberValue(3)).toBe(3);
    expect(numberValue(Number.NaN)).toBeUndefined();
    expect(numberValue("3")).toBeUndefined();
    expect(stringValue("ok")).toBe("ok");
    expect(stringValue("")).toBeUndefined();
    expect(stringValue(1)).toBeUndefined();
  });

  test("parseJsonString names parse failure when sink provided", () => {
    expect(parseJsonString("{\"a\":1}")).toEqual({ a: 1 });
    expect(parseJsonString("not-json")).toBe("not-json");
    const diagnostics: { name: string; message: string }[] = [];
    expect(parseJsonString("not-json", {
      diagnostics,
      diagnosticName: "test.json.string.invalid",
    })).toBe("not-json");
    expect(diagnostics[0]!.name).toBe("test.json.string.invalid");
  });
});
