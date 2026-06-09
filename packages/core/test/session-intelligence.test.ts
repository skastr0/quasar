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
  test("rejects non-convex event ordering before ingest", () => {
    const batch = baseBatch({
      events: [
        {
          id: "event:bad-sequence",
          sessionId: "session:test",
          sequence: -1,
          machineId: "machine:test",
          provider: "opencode",
          agentName: "opencode",
          projectIdentityKey: "project:test",
          role: "user",
          kind: "message",
          contentText: "invalid event",
          contentBlocks: [],
          rawReference: { sourcePath: "/tmp/opencode.db" },
        },
      ],
    });

    expect(() => toConvexSafeSessionIntelligenceBatch(batch)).toThrow(
      /non-negative integer/,
    );
  });

  test("keeps OpenCode-style summary diffs out of Convex-shaped event content", () => {
    const vendorFile = "not-session-intelligence\n".repeat(30_000);
    const event = {
      id: "event:test",
      sessionId: "session:test",
      sequence: 0,
      machineId: "machine:test",
      provider: "opencode" as const,
      agentName: "opencode",
      projectIdentityKey: "project:test",
      role: "user" as const,
      kind: "message" as const,
      contentText: "Please wire the CLI.",
      contentBlocks: [
        {
          id: "block:test",
          sequence: 0,
          kind: "json" as const,
          value: {
            summary: {
              cache: { state: "provider-cache-trash" },
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
    };
    Object.assign(event as Record<string, unknown>, {
      content: {
        role: "user",
        content: "Please wire the CLI.",
        summary: {
          state: { cachedView: "provider-state-trash" },
          diffs: [
            {
              file: "node_modules/typescript/lib/typescript.js",
              status: "added",
              after: vendorFile,
            },
          ],
        },
      },
      raw: { should: "not survive" },
    });
    const batch = baseBatch({
      events: [event],
    });

    const sanitized = toConvexSafeSessionIntelligenceBatch(batch);
    const encoded = JSON.stringify(sanitized);

    expect(encoded).toContain("Please wire the CLI.");
    expect(encoded).toContain("native_non_session_intelligence");
    expect(Object.hasOwn(sanitized.sessions[0]!.events[0]!, "content")).toBe(false);
    expect(Object.hasOwn(sanitized.sessions[0]!.events[0]!, "raw")).toBe(false);
    expect(encoded).not.toContain("not-session-intelligence");
    expect(encoded).not.toContain("provider-cache-trash");
    expect(encoded).not.toContain("provider-state-trash");
    expect(encoded).not.toContain("should");
    expect(jsonByteLength(sanitized.sessions[0]!.events[0])).toBeLessThanOrEqual(
      CONVEX_SAFE_INGEST_BUDGETS.eventRecordBytes,
    );
  });

  test("truncates giant tool output while preserving tool-call intelligence", () => {
    const hugeOutput = "line with useful command output\n".repeat(20_000);
    const toolCall = {
      id: "tool:test",
      sessionId: "session:test",
      eventId: "event:test",
      machineId: "machine:test",
      provider: "opencode" as const,
      agentName: "opencode",
      projectIdentityKey: "project:test",
      toolName: "bash",
      status: "completed",
      input: { command: "cat long.log" },
      output: hugeOutput,
    };
    Object.assign(toolCall as Record<string, unknown>, { raw: { duplicate: hugeOutput } });
    const batch = baseBatch({
      toolCalls: [toolCall],
    });

    const sanitized = toConvexSafeSessionIntelligenceBatch(batch);
    const [sanitizedToolCall] = sanitized.sessions[0]!.toolCalls;

    expect(sanitizedToolCall?.toolName).toBe("bash");
    expect(sanitizedToolCall?.input).toEqual({ command: "cat long.log" });
    expect(sanitizedToolCall?.output).toContain("[truncated for Convex ingest]");
    expect(JSON.stringify(sanitizedToolCall)).not.toContain("duplicate");
    expect(jsonByteLength(sanitizedToolCall)).toBeLessThanOrEqual(
      CONVEX_SAFE_INGEST_BUDGETS.toolCallRecordBytes,
    );
  });

  test("preserves patch fields in tool payloads but not provider summaries", () => {
    const batch = baseBatch({
      toolCalls: [
        {
          id: "tool:patch",
          sessionId: "session:test",
          eventId: "event:test",
          machineId: "machine:test",
          provider: "opencode" as const,
          agentName: "opencode",
          projectIdentityKey: "project:test",
          toolName: "apply_patch",
          status: "completed",
          input: {
            patch: "@@ real tool input patch",
            summary: { diffs: ["provider input diff trash"] },
            providerUi: "provider input ui trash",
          },
          output: {
            diff: "@@ real tool result diff",
            patches: ["@@ real tool result patch list"],
            viewState: "provider result view trash",
            log: JSON.stringify({
              result: "visible structured tool result",
              summary: { cache: { state: "stringified provider state trash" } },
            }),
            workspaceDiff: "provider workspace diff trash",
          },
        },
      ],
    });

    const sanitized = toConvexSafeSessionIntelligenceBatch(batch);
    const encoded = JSON.stringify(sanitized.sessions[0]!.toolCalls[0]);

    expect(encoded).toContain("@@ real tool input patch");
    expect(encoded).toContain("@@ real tool result diff");
    expect(encoded).toContain("@@ real tool result patch list");
    expect(encoded).toContain("visible structured tool result");
    expect(encoded).not.toContain("provider input diff trash");
    expect(encoded).not.toContain("provider input ui trash");
    expect(encoded).not.toContain("provider result view trash");
    expect(encoded).not.toContain("provider workspace diff trash");
    expect(encoded).not.toContain("stringified provider state trash");
  });

  test("preserves real event patch content while removing provider metadata", () => {
    const batch = baseBatch({
      events: [
        {
          id: "event:patch",
          sessionId: "session:test",
          sequence: 0,
          machineId: "machine:test",
          provider: "opencode",
          agentName: "opencode",
          projectIdentityKey: "project:test",
          role: "assistant",
          kind: "edit",
          contentBlocks: [
            {
              id: "block:patch",
              sequence: 0,
              kind: "json",
              value: {
                type: "diff",
                patch: "@@ real event patch",
                diff: "@@ real event diff",
                providerUi: "provider event ui trash",
                summary: { diffs: ["provider event summary diff trash"] },
              },
            },
          ],
          rawReference: { sourcePath: "/tmp/session.jsonl", line: 1 },
        },
      ],
    });

    const sanitized = toConvexSafeSessionIntelligenceBatch(batch);
    const encoded = JSON.stringify(sanitized.sessions[0]!.events[0]);

    expect(encoded).toContain("@@ real event patch");
    expect(encoded).toContain("@@ real event diff");
    expect(encoded).not.toContain("provider event ui trash");
    expect(encoded).not.toContain("provider event summary diff trash");
    assertConvexSafeSessionIntelligenceBatch(sanitized);
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

  test("omits snapshot event payloads from Convex-shaped content", () => {
    const batch = baseBatch({
      events: [
        {
          id: "event:snapshot",
          sessionId: "session:test",
          sequence: 0,
          machineId: "machine:test",
          provider: "grok",
          agentName: "grok",
          projectIdentityKey: "project:test",
          role: "system",
          kind: "snapshot",
          contentText: "provider workspace snapshot trash",
          contentBlocks: [
            {
              id: "block:snapshot",
              sequence: 0,
              kind: "text",
              text: "provider snapshot block trash",
            },
          ],
          rawReference: { sourcePath: "/tmp/events.jsonl", line: 1, nativeType: "diff" },
        },
      ],
    });

    const sanitized = toConvexSafeSessionIntelligenceBatch(batch);
    const event = sanitized.sessions[0]!.events[0]!;
    const encoded = JSON.stringify(sanitized);

    expect(event.kind).toBe("snapshot");
    expect(event.contentText).toBeUndefined();
    expect(event.contentBlocks).toEqual([]);
    expect(encoded).not.toContain("provider workspace snapshot trash");
    expect(encoded).not.toContain("provider snapshot block trash");
  });

  test("bounds artifact locators like content block locators", () => {
    const base64 = "c".repeat(8_192);
    const dataUri = `data:text/plain;base64,${base64}`;
    const batch = baseBatch({
      artifacts: [
        {
          id: "artifact:data-uri",
          sessionId: "session:test",
          eventId: "event:test",
          machineId: "machine:test",
          provider: "claude",
          agentName: "claude",
          projectIdentityKey: "project:test",
          kind: "file",
          path: dataUri,
          uri: dataUri,
          sourcePath: dataUri,
          sourceRef: { sourcePath: "/tmp/session.jsonl" },
        },
      ],
    });

    const sanitized = toConvexSafeSessionIntelligenceBatch(batch);
    const artifact = sanitized.sessions[0]!.artifacts[0]!;
    const encoded = JSON.stringify(artifact);

    expect(artifact.path).toBeUndefined();
    expect(artifact.uri).toBeUndefined();
    expect(artifact.sourcePath).toBeUndefined();
    expect(encoded).toContain("artifact_locator_fields");
    expect(encoded).not.toContain("data:text/plain;base64");
    expect(encoded).not.toContain(base64);
  });
});
