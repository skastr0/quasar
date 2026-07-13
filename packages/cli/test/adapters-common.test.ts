import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, test } from "bun:test";

import {
  buildSession,
  numberValue,
  parseJsonString,
  readJsonFile,
  readJsonLines,
  recordFrom,
  sessionIdFor,
  stringValue,
} from "../src/adapters/common";
import { ClaudeSessionId } from "../src/core/identity";

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

  test("readJsonLines distinguishes missing from unreadable even with custom diagnosticName", () => {
    const missingPath = join(root, "lines-missing.jsonl");
    const missingDiagnostics: { name: string; message: string }[] = [];
    expect(readJsonLines(missingPath, {
      diagnosticName: "test.line.invalid_json",
      diagnostics: missingDiagnostics,
      sourcePath: "/fixture/lines-missing.jsonl",
    })).toEqual([]);
    expect(missingDiagnostics[0]!.name).toBe("test.line.missing");
    expect(missingDiagnostics[0]!.message).toContain("(missing)");

    const unreadablePath = join(root, "lines-unreadable.jsonl");
    writeFileSync(unreadablePath, "{\"ok\":true}\n", "utf8");
    chmodSync(unreadablePath, 0);
    try {
      const unreadableDiagnostics: { name: string; message: string }[] = [];
      expect(readJsonLines(unreadablePath, {
        diagnosticName: "test.line.invalid_json",
        diagnostics: unreadableDiagnostics,
        sourcePath: "/fixture/lines-unreadable.jsonl",
      })).toEqual([]);
      expect(unreadableDiagnostics[0]!.name).toBe("test.line.unreadable");
      expect(unreadableDiagnostics[0]!.message).toContain("(unreadable)");
    } finally {
      chmodSync(unreadablePath, 0o600);
    }
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

  test("recordFrom returns explicit absence for wrong shape (never empty object)", () => {
    expect(recordFrom({ a: 1 })).toEqual({ a: 1 });
    expect(recordFrom(null)).toBeUndefined();
    expect(recordFrom(undefined)).toBeUndefined();
    expect(recordFrom("string")).toBeUndefined();
    expect(recordFrom([1, 2])).toBeUndefined();
    const diagnostics: { name: string; message: string }[] = [];
    expect(recordFrom(42, { diagnostics, diagnosticName: "test.record.wrong_shape" })).toBeUndefined();
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]!.name).toBe("test.record.wrong_shape");
    // without sink: still absence, no invented {}
    expect(recordFrom(42)).toBeUndefined();
  });

  test("numberValue and stringValue use visible Schema decode for optional fields", () => {
    expect(numberValue(3)).toBe(3);
    expect(numberValue(Number.NaN)).toBeUndefined();
    expect(numberValue("3")).toBeUndefined();
    expect(stringValue("ok")).toBe("ok");
    expect(stringValue("")).toBeUndefined();
    expect(stringValue(1)).toBeUndefined();
  });

  test("parseJsonString returns absence on invalid JSON and names failure when sink provided", () => {
    expect(parseJsonString("{\"a\":1}")).toEqual({ a: 1 });
    // fail-closed: never preserve the original invalid string
    expect(parseJsonString("not-json")).toBeUndefined();
    expect(parseJsonString(12)).toBe(12);
    const diagnostics: { name: string; message: string }[] = [];
    expect(parseJsonString("not-json", {
      diagnostics,
      diagnosticName: "test.json.string.invalid",
    })).toBeUndefined();
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]!.name).toBe("test.json.string.invalid");
  });

  test("buildSession redacts explicit content blocks without collapsing formatting", () => {
    const nativeSessionId = "common-content-block-redaction";
    const sessionId = sessionIdFor("claude", ClaudeSessionId(nativeSessionId));
    const secret = "should-not-leak";
    const text = `Text line one
  Bearer ${secret}
Text line three`;
    const markdown = `# Exact heading

\`\`\`ts
const authorization = "Bearer ${secret}";
\`\`\``;
    const thinking = `First thought
  Bearer ${secret}

Final thought`;

    const session = buildSession({
      provider: "claude",
      agentName: "claude",
      machine: {
        machineId: "machine:common-content-block-redaction",
        hostname: "test-host",
        platform: "darwin",
      },
      sessionId,
      nativeSessionId,
      nativeProjectKey: "common:test",
      sourceRoot: "/fixtures",
      sourcePath: "/fixtures/session.jsonl",
      events: [
        {
          id: `${sessionId}:event:explicit-blocks`,
          sequence: 0,
          role: "assistant",
          kind: "reasoning",
          contentText: `Search line one
Bearer ${secret}
Search line three`,
          contentBlocks: [
            {
              id: "block:text",
              sequence: 0,
              kind: "text",
              text,
            },
            {
              id: "block:markdown",
              sequence: 1,
              kind: "markdown",
              markdown,
              metadata: {
                nested: {
                  apiKey: secret,
                  note: `Bearer ${secret}`,
                },
              },
            },
            {
              id: "block:thinking",
              sequence: 2,
              kind: "thinking",
              thinking,
            },
            {
              id: "block:json",
              sequence: 3,
              kind: "json",
              value: {
                nested: [
                  { password: secret },
                  { note: `Bearer ${secret}` },
                ],
              },
            },
          ],
          rawReference: {
            sourcePath: "/fixtures/session.jsonl",
            line: 1,
          },
        },
      ],
    });

    expect(session.events[0]!.contentText).toBe(
      "Search line one Bearer [redacted] Search line three",
    );
    expect(session.events[0]!.contentBlocks).toEqual([
      {
        id: "block:text",
        sequence: 0,
        kind: "text",
        text: "Text line one\n  Bearer [redacted]\nText line three",
      },
      {
        id: "block:markdown",
        sequence: 1,
        kind: "markdown",
        markdown:
          '# Exact heading\n\n```ts\nconst authorization = "Bearer [redacted]";\n```',
        metadata: {
          nested: {
            apiKey: "[redacted]",
            note: "Bearer [redacted]",
          },
        },
      },
      {
        id: "block:thinking",
        sequence: 2,
        kind: "thinking",
        thinking: "First thought\n  Bearer [redacted]\n\nFinal thought",
      },
      {
        id: "block:json",
        sequence: 3,
        kind: "json",
        value: {
          nested: [
            { password: "[redacted]" },
            { note: "Bearer [redacted]" },
          ],
        },
      },
    ]);
    expect(JSON.stringify(session.events[0]!.contentBlocks)).not.toContain(secret);
  });
});
