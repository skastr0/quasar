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

  test("compacts top-level machine and source root rows before Convex writes", () => {
    const hugeHostname = "host-trash-".repeat(2_000);
    const hugeRootPath = `/Users/a/${"source-root-trash/".repeat(2_000)}`;
    const batch = baseBatch({
      sourceRoot: hugeRootPath,
      sourcePath: `${hugeRootPath}/session.jsonl`,
    });
    const input: IngestBatch = {
      ...batch,
      machine: {
        machineId: "machine:test",
        hostname: hugeHostname,
        platform: "darwin",
      },
      sourceRoots: [
        {
          provider: "opencode",
          adapterId: "opencode:test",
          rootPath: hugeRootPath,
          machineId: "machine:test",
          discoveredAt: "2026-06-09T00:00:00.000Z",
        },
      ],
    };

    const sanitized = toConvexSafeSessionIntelligenceBatch(input);

    expect(jsonByteLength(sanitized.machine)).toBeLessThanOrEqual(
      CONVEX_SAFE_INGEST_BUDGETS.machineRecordBytes,
    );
    expect(jsonByteLength(sanitized.sourceRoots[0])).toBeLessThanOrEqual(
      CONVEX_SAFE_INGEST_BUDGETS.sourceRootRecordBytes,
    );
    expect(sanitized.machine.hostname?.length).toBeLessThan(hugeHostname.length);
    expect(sanitized.sourceRoots[0]?.rootPath.length).toBeLessThan(hugeRootPath.length);
    expect(sanitized.sessions[0]?.sourceRoot.length).toBeLessThan(hugeRootPath.length);
    expect(sanitized.sessions[0]?.sourcePath.length).toBeLessThan(hugeRootPath.length);
    assertConvexSafeSessionIntelligenceBatch(sanitized);
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
            summaryDiffs: ["flat provider input diff trash"],
            summaryCache: { state: "flat provider input cache trash" },
            workspacePatch: "flat provider input workspace patch trash",
            summary: { diffs: ["provider input diff trash"] },
            providerUi: "provider input ui trash",
          },
          output: {
            diff: "@@ real tool result diff",
            patches: ["@@ real tool result patch list"],
            summaryState: { view: "flat provider result state trash" },
            workspaceDiffs: ["flat provider result workspace diff trash"],
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
    expect(encoded).not.toContain("flat provider input diff trash");
    expect(encoded).not.toContain("flat provider input cache trash");
    expect(encoded).not.toContain("flat provider input workspace patch trash");
    expect(encoded).not.toContain("flat provider result state trash");
    expect(encoded).not.toContain("flat provider result workspace diff trash");
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
                summaryPatches: ["flat provider event summary patch trash"],
                workspaceState: { view: "flat provider event workspace state trash" },
                providerUi: "provider event ui trash",
                summary: { diffs: ["provider event summary diff trash"] },
                workspace: {
                  diff: "provider event workspace diff trash",
                  patch: "provider event workspace patch trash",
                  patches: ["provider event workspace patches trash"],
                  cache: "provider event workspace cache trash",
                  state: "provider event workspace state trash",
                  providerUi: "provider event workspace ui trash",
                },
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
    expect(encoded).not.toContain("flat provider event summary patch trash");
    expect(encoded).not.toContain("flat provider event workspace state trash");
    expect(encoded).not.toContain("provider event ui trash");
    expect(encoded).not.toContain("provider event summary diff trash");
    expect(encoded).not.toContain("provider event workspace diff trash");
    expect(encoded).not.toContain("provider event workspace patch trash");
    expect(encoded).not.toContain("provider event workspace patches trash");
    expect(encoded).not.toContain("provider event workspace cache trash");
    expect(encoded).not.toContain("provider event workspace state trash");
    expect(encoded).not.toContain("provider event workspace ui trash");
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

  test("sanitizes envelope metadata before Convex budget assertions", () => {
    const unsafeSentinel = "UNSAFE_ENVELOPE_SENTINEL";
    const hugeMachineId = `machine:${"m".repeat(20_000)}:${unsafeSentinel}`;
    const hugeProjectKey = `path:${"p".repeat(20_000)}:${unsafeSentinel}`;
    const hugePath = `/Users/example/${"deep/".repeat(5_000)}${unsafeSentinel}`;
    const hugeTitle = `Session ${"title ".repeat(5_000)}${unsafeSentinel}`;
    const signalKinds = ["path", "workspace", "git_remote", "package"] as const;
    const batch: IngestBatch = {
      ...baseBatch({
        machineId: hugeMachineId,
        projectIdentity: {
          projectIdentityKey: hugeProjectKey,
          displayName: hugeTitle,
          confidence: "low",
          rawPath: hugePath,
          normalizedPath: hugePath,
          gitRemote: hugePath,
          gitRemoteNormalized: hugePath,
          packageName: `pkg-${"x".repeat(20_000)}-${unsafeSentinel}`,
          signals: Array.from({ length: 24 }, (_, index) => ({
            kind: signalKinds[index % signalKinds.length]!,
            value: `${hugePath}-${index}`,
            confidence: "low",
          })),
        },
        nativeProjectKey: hugePath,
        title: hugeTitle,
        sourceRoot: hugePath,
        sourcePath: hugePath,
        events: [
          {
            id: "event:envelope",
            sessionId: "session:test",
            sequence: 0,
            machineId: hugeMachineId,
            provider: "opencode",
            agentName: "opencode",
            projectIdentityKey: hugeProjectKey,
            role: "user",
            kind: "message",
            contentText: "inspect envelope",
            contentBlocks: [],
            rawReference: {
              sourcePath: hugePath,
              table: hugePath,
              rowId: hugePath,
              nativeType: hugePath,
            },
          },
        ],
        toolCalls: [
          {
            id: "tool:envelope",
            sessionId: "session:test",
            eventId: "event:envelope",
            machineId: hugeMachineId,
            provider: "opencode",
            agentName: "opencode",
            projectIdentityKey: hugeProjectKey,
            toolName: "bash",
          },
        ],
      }),
      machine: {
        machineId: hugeMachineId,
        hostname: hugePath,
        tailscaleName: hugePath,
        platform: hugePath,
      },
      sourceRoots: [
        {
          provider: "opencode",
          adapterId: hugePath,
          rootPath: hugePath,
          machineId: hugeMachineId,
          discoveredAt: hugePath,
        },
      ],
    };

    expect(() => assertConvexSafeSessionIntelligenceBatch(batch)).toThrow(
      /machine\.machineId is .* maximum is/,
    );

    const sanitized = toConvexSafeSessionIntelligenceBatch(batch);
    const session = sanitized.sessions[0]!;
    const event = session.events[0]!;
    const toolCall = session.toolCalls[0]!;
    const encoded = JSON.stringify(sanitized);

    expect(sanitized.machine.machineId).toMatch(/^machine:/);
    expect(session.machineId).toBe(sanitized.machine.machineId);
    expect(event.machineId).toBe(sanitized.machine.machineId);
    expect(toolCall.machineId).toBe(sanitized.machine.machineId);
    expect(session.projectIdentity.projectIdentityKey).toMatch(/^project:/);
    expect(event.projectIdentityKey).toBe(session.projectIdentity.projectIdentityKey);
    expect(toolCall.projectIdentityKey).toBe(session.projectIdentity.projectIdentityKey);
    expect(session.projectIdentity.signals).toHaveLength(16);
    expect(encoded).not.toContain(unsafeSentinel);
    expect(jsonByteLength(sanitized.machine)).toBeLessThanOrEqual(
      CONVEX_SAFE_INGEST_BUDGETS.machineRecordBytes,
    );
    expect(jsonByteLength(sanitized.sourceRoots[0])).toBeLessThanOrEqual(
      CONVEX_SAFE_INGEST_BUDGETS.sourceRootRecordBytes,
    );
    expect(jsonByteLength(session.projectIdentity)).toBeLessThanOrEqual(
      CONVEX_SAFE_INGEST_BUDGETS.projectIdentityRecordBytes,
    );
    assertConvexSafeSessionIntelligenceBatch(sanitized);
  });

  test("normalizes oversized indexed graph ids and references consistently", () => {
    const unsafeSentinel = "UNSAFE_GRAPH_ID_SENTINEL";
    const hugeId = (prefix: string) => `${prefix}:${"x".repeat(5_000)}:${unsafeSentinel}`;
    const rawSessionId = hugeId("session");
    const rawNativeSessionId = hugeId("native-session");
    const rawAgentName = hugeId("agent");
    const rawParentEventId = hugeId("event-parent");
    const rawChildEventId = hugeId("event-child");
    const rawBlockId = hugeId("block");
    const rawToolCallId = hugeId("tool");
    const rawToolName = hugeId("tool-name");
    const rawUsageId = hugeId("usage");
    const rawArtifactId = hugeId("artifact");
    const rawEdgeId = hugeId("edge");

    const batch = baseBatch({
      id: rawSessionId,
      nativeSessionId: rawNativeSessionId,
      agentName: rawAgentName,
      events: [
        {
          id: rawParentEventId,
          sessionId: rawSessionId,
          sequence: 0,
          machineId: "machine:test",
          provider: "opencode",
          agentName: rawAgentName,
          projectIdentityKey: "project:test",
          role: "user",
          kind: "message",
          contentText: "parent",
          contentBlocks: [],
          rawReference: { sourcePath: "/tmp/opencode.db" },
        },
        {
          id: rawChildEventId,
          sessionId: rawSessionId,
          sequence: 1,
          machineId: "machine:test",
          provider: "opencode",
          agentName: rawAgentName,
          projectIdentityKey: "project:test",
          role: "assistant",
          kind: "tool_call",
          contentText: "child",
          toolCallId: rawToolCallId,
          parentEventId: rawParentEventId,
          contentBlocks: [
            {
              id: rawBlockId,
              sequence: 0,
              kind: "text",
              text: "bounded block",
            },
          ],
          rawReference: { sourcePath: "/tmp/opencode.db" },
        },
      ],
      toolCalls: [
        {
          id: rawToolCallId,
          sessionId: rawSessionId,
          eventId: rawChildEventId,
          machineId: "machine:test",
          provider: "opencode",
          agentName: rawAgentName,
          projectIdentityKey: "project:test",
          toolName: rawToolName,
        },
      ],
      usageRecords: [
        {
          id: rawUsageId,
          sessionId: rawSessionId,
          eventId: rawChildEventId,
          machineId: "machine:test",
          provider: "opencode",
          agentName: rawAgentName,
          projectIdentityKey: "project:test",
          totalTokens: 3,
        },
      ],
      artifacts: [
        {
          id: rawArtifactId,
          sessionId: rawSessionId,
          eventId: rawChildEventId,
          machineId: "machine:test",
          provider: "opencode",
          agentName: rawAgentName,
          projectIdentityKey: "project:test",
          kind: "file",
          path: "/tmp/result.txt",
        },
      ],
      sessionEdges: [
        {
          id: rawEdgeId,
          sessionId: rawSessionId,
          machineId: "machine:test",
          provider: "opencode",
          agentName: rawAgentName,
          projectIdentityKey: "project:test",
          kind: "artifact_of",
          fromEventId: rawChildEventId,
          toEventId: rawParentEventId,
          fromId: rawToolCallId,
          toId: rawArtifactId,
        },
      ],
    });

    expect(() => assertConvexSafeSessionIntelligenceBatch(batch)).toThrow(
      /maximum is 256/,
    );

    const sanitized = toConvexSafeSessionIntelligenceBatch(batch);
    const session = sanitized.sessions[0]!;
    const [parentEvent, childEvent] = session.events;
    const block = childEvent?.contentBlocks[0]!;
    const toolCall = session.toolCalls[0]!;
    const usage = session.usageRecords[0]!;
    const artifact = session.artifacts[0]!;
    const edge = session.sessionEdges[0]!;
    const encoded = JSON.stringify(sanitized);

    expect(session.id).toMatch(/^session:/);
    expect(session.nativeSessionId).toMatch(/^native_session:/);
    expect(session.agentName).toMatch(/^agent:/);
    expect(parentEvent?.id).toMatch(/^event:/);
    expect(childEvent?.id).toMatch(/^event:/);
    expect(block.id).toMatch(/^block:/);
    expect(toolCall.id).toMatch(/^tool:/);
    expect(toolCall.toolName).toMatch(/^tool_name:/);
    expect(usage.id).toMatch(/^usage:/);
    expect(artifact.id).toMatch(/^artifact:/);
    expect(edge.id).toMatch(/^edge:/);
    expect(childEvent?.sessionId).toBe(session.id);
    expect(childEvent?.parentEventId).toBe(parentEvent?.id);
    expect(childEvent?.toolCallId).toBe(toolCall.id);
    expect(toolCall.sessionId).toBe(session.id);
    expect(toolCall.eventId).toBe(childEvent?.id);
    expect(usage.sessionId).toBe(session.id);
    expect(usage.eventId).toBe(childEvent?.id);
    expect(artifact.sessionId).toBe(session.id);
    expect(artifact.eventId).toBe(childEvent?.id);
    expect(edge.sessionId).toBe(session.id);
    expect(edge.fromEventId).toBe(childEvent?.id);
    expect(edge.toEventId).toBe(parentEvent?.id);
    expect(edge.fromId).toBe(toolCall.id);
    expect(edge.toId).toBe(artifact.id);
    expect(encoded).not.toContain(unsafeSentinel);
    assertConvexSafeSessionIntelligenceBatch(sanitized);
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
