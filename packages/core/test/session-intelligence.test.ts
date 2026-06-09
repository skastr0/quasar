import { describe, expect, test } from "vitest";

import {
  CONVEX_SAFE_INGEST_BUDGETS,
  assertConvexSafeSessionIntelligenceBatch,
  jsonByteLength,
  toConvexSafeSessionIntelligenceBatch,
} from "../src/session-intelligence";
import type { IngestBatch } from "../src/schemas";

const baseBatch = (overrides: Partial<IngestBatch["sessions"][number]> = {}): IngestBatch => ({
  protocolVersion: "quasar.ingest/v1",
  machine: { machineId: "machine:test" },
  sourceRoots: [],
  diagnostics: [],
  generatedAt: "2026-06-09T00:00:00.000Z",
  sessions: [
    {
      id: "session:test",
      nativeSessionId: "native:test",
      provider: "opencode",
      agentName: "opencode",
      machineId: "machine:test",
      projectIdentity: {
        projectIdentityKey: "project:test",
        displayName: "test",
        confidence: "low",
        signals: [],
      },
      sourceRoot: "/tmp",
      sourcePath: "/tmp/opencode.db",
      events: [],
      toolCalls: [],
      sessionEdges: [],
      usageRecords: [],
      artifacts: [],
      ...overrides,
    },
  ],
});

describe("session intelligence contract", () => {
  test("keeps OpenCode-style summary diffs out of Convex-shaped event content", () => {
    const vendorFile = "not-session-intelligence\n".repeat(30_000);
    const batch = baseBatch({
      events: [
        {
          id: "event:test",
          sessionId: "session:test",
          sequence: 0,
          machineId: "machine:test",
          provider: "opencode",
          agentName: "opencode",
          projectIdentityKey: "project:test",
          role: "user",
          kind: "message",
          contentText: "Please wire the CLI.",
          content: {
            role: "user",
            content: "Please wire the CLI.",
            summary: {
              diffs: [
                {
                  file: "node_modules/typescript/lib/typescript.js",
                  status: "added",
                  after: vendorFile,
                },
              ],
            },
          },
          contentBlocks: [
            {
              id: "block:test",
              sequence: 0,
              kind: "json",
              value: {
                summary: {
                  diffs: [
                    {
                      file: "node_modules/typescript/lib/typescript.js",
                      after: vendorFile,
                    },
                  ],
                },
              },
            },
          ],
          rawReference: { sourcePath: "/tmp/opencode.db", table: "message", rowId: "m1" },
          raw: { should: "not survive" },
        },
      ],
    });

    const sanitized = toConvexSafeSessionIntelligenceBatch(batch);
    const encoded = JSON.stringify(sanitized);

    expect(encoded).toContain("Please wire the CLI.");
    expect(encoded).toContain("native_non_session_intelligence");
    expect(JSON.stringify(sanitized.sessions[0]!.events[0]!.content)).not.toContain("diffs");
    expect(encoded).not.toContain("not-session-intelligence");
    expect(encoded).not.toContain("should");
    expect(jsonByteLength(sanitized.sessions[0]!.events[0])).toBeLessThanOrEqual(
      CONVEX_SAFE_INGEST_BUDGETS.eventRecordBytes,
    );
  });

  test("truncates giant tool output while preserving tool-call intelligence", () => {
    const hugeOutput = "line with useful command output\n".repeat(20_000);
    const batch = baseBatch({
      toolCalls: [
        {
          id: "tool:test",
          sessionId: "session:test",
          eventId: "event:test",
          machineId: "machine:test",
          provider: "opencode",
          agentName: "opencode",
          projectIdentityKey: "project:test",
          toolName: "bash",
          status: "completed",
          input: { command: "cat long.log" },
          output: hugeOutput,
          raw: { duplicate: hugeOutput },
        },
      ],
    });

    const sanitized = toConvexSafeSessionIntelligenceBatch(batch);
    const [toolCall] = sanitized.sessions[0]!.toolCalls;

    expect(toolCall?.toolName).toBe("bash");
    expect(toolCall?.input).toEqual({ command: "cat long.log" });
    expect(toolCall?.output).toContain("[truncated for Convex ingest]");
    expect(JSON.stringify(toolCall)).not.toContain("duplicate");
    expect(jsonByteLength(toolCall)).toBeLessThanOrEqual(
      CONVEX_SAFE_INGEST_BUDGETS.toolCallRecordBytes,
    );
  });

  test("replaces binary and base64 payloads with bounded refs", () => {
    const base64 = "a".repeat(8_192);
    const dataUri = `data:image/png;base64,${base64}`;
    const batch = baseBatch({
      events: [
        {
          id: "event:image",
          sessionId: "session:test",
          sequence: 0,
          machineId: "machine:test",
          provider: "claude",
          agentName: "claude",
          projectIdentityKey: "project:test",
          role: "user",
          kind: "message",
          content: {
            type: "input_image",
            image_url: dataUri,
          },
          contentBlocks: [
            {
              id: "block:image",
              sequence: 0,
              kind: "image",
              mediaType: "image/png",
              uri: dataUri,
              value: { type: "base64", data: base64 },
              metadata: { source: { type: "base64", data: base64 } },
            },
          ],
          rawReference: { sourcePath: "/tmp/session.jsonl" },
        },
      ],
    });

    const sanitized = toConvexSafeSessionIntelligenceBatch(batch);
    const encoded = JSON.stringify(sanitized);

    expect(encoded).toContain("binary_or_base64");
    expect(encoded).toContain("uri_omitted");
    expect(encoded).not.toContain(base64);
    expect(encoded).not.toContain("data:image/png;base64");
    expect(sanitized.sessions[0]!.events[0]!.contentBlocks[0]?.uri).toBeUndefined();
    assertConvexSafeSessionIntelligenceBatch(sanitized);
  });
});
