import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, test } from "bun:test";

import { sessionIdFor, sourceFingerprintFor } from "../src/adapters/common";
import { classifyPrimeRecord } from "../src/adapters/prime-schema";
import { primeAdapter } from "../src/adapters/prime";
import { PrimeSessionId } from "../src/core/identity";

const MACHINE = {
  machineId: "machine:test",
  hostname: "qsr-fabricated-host",
  platform: "darwin",
};
const NOW = "2026-07-13T00:00:00.000Z";
const SESSION_TIME = "2026-07-12T10:00:00.000Z";
const CWD = "/qsr/fabricated/prime-project";
const ROOT = mkdtempSync(join(tmpdir(), "quasar-prime-adapter-"));

const jsonl = (records: readonly unknown[]): string => records.map((record) =>
  typeof record === "string" ? record : JSON.stringify(record)
).join("\n");

const usage = {
  input: 12,
  output: 8,
  cacheRead: 3,
  cacheWrite: 2,
  totalTokens: 25,
  cost: { input: 0.01, output: 0.02, cacheRead: 0.001, cacheWrite: 0.002, total: 0.033 },
};

const assistantMessage = (
  content: readonly unknown[],
  timestamp: number,
  stopReason: "stop" | "toolUse" = "stop",
) => ({
  role: "assistant",
  content,
  api: "fabricated-api",
  provider: "fabricated-provider",
  model: "fabricated-model",
  usage,
  stopReason,
  timestamp,
});

const diagnosticName = (diagnostic: { readonly details?: unknown }): string | undefined => {
  if (typeof diagnostic.details !== "object" || diagnostic.details === null || !("diagnostic" in diagnostic.details)) return undefined;
  return typeof diagnostic.details.diagnostic === "string" ? diagnostic.details.diagnostic : undefined;
};

const header = (id: string, extra: Record<string, unknown> = {}) => ({
  type: "session",
  version: 3,
  id,
  timestamp: SESSION_TIME,
  cwd: CWD,
  ...extra,
});

afterAll(() => {
  rmSync(ROOT, { recursive: true, force: true });
});

describe("Prime Agent adapter", () => {
  test("normalizes v3 semantic content, tools, usage, lifecycle context, tree edges, and subagent lineage", async () => {
    const root = join(ROOT, "v3");
    mkdirSync(join(root, "sessions"), { recursive: true });
    const sourcePath = join(root, "sessions", "fabricated-parent.jsonl");
    const opaqueSignature = "qsr-fabricated-opaque-signature";
    const embeddedBase64 = "ZmFicmljYXRlZC1pbWFnZS1ieXRlcw==";
    writeFileSync(sourcePath, jsonl([
      header("prime-fabricated-parent", {
        rlmDepth: 0,
        git: { repoUrl: "git@github.com:qsr/fabricated.git", commit: "abc123", branch: "main" },
      }),
      { type: "model_change", id: "entry-model", parentId: null, timestamp: SESSION_TIME, provider: "fabricated-provider", modelId: "fabricated-model" },
      { type: "thinking_level_change", id: "entry-thinking", parentId: "entry-model", timestamp: SESSION_TIME, thinkingLevel: "xhigh" },
      { type: "service_tier_change", id: "entry-tier", parentId: "entry-thinking", timestamp: SESSION_TIME, serviceTier: "default" },
      { type: "message", id: "entry-user", parentId: "entry-tier", timestamp: SESSION_TIME, message: { role: "user", content: [{ type: "text", text: "fabricated root turn", textSignature: opaqueSignature }, { type: "image", data: embeddedBase64, mimeType: "image/png" }], timestamp: 1_752_400_000_000 } },
      { type: "message", id: "entry-assistant", parentId: "entry-user", timestamp: SESSION_TIME, message: assistantMessage([
        { type: "thinking", thinking: "fabricated reasoning", thinkingSignature: opaqueSignature },
        { type: "text", text: "fabricated answer", textSignature: opaqueSignature },
        { type: "toolCall", id: "call-fabricated", name: "fabricated_tool", arguments: { path: "/qsr/fabricated/file", token: "secret-fabricated" }, thoughtSignature: opaqueSignature },
      ], 1_752_400_001_000, "toolUse") },
      "{malformed-json",
      { type: "message", id: "entry-result", parentId: "entry-assistant", timestamp: SESSION_TIME, message: { role: "toolResult", toolCallId: "call-fabricated", toolName: "fabricated_tool", content: [{ type: "text", text: "fabricated tool output" }, { type: "image", data: embeddedBase64, mimeType: "image/png" }], details: { textSignature: opaqueSignature, image: { data: embeddedBase64, mimeType: "image/png" } }, isError: false, timestamp: 1_752_400_002_000 } },
      { type: "future_entry", id: "entry-unknown", parentId: "entry-user", timestamp: SESSION_TIME },
      { type: "session_state", id: "entry-state", parentId: "entry-result", timestamp: SESSION_TIME, state: { status: "active" } },
      { type: "git_state", id: "entry-git", parentId: "entry-state", timestamp: SESSION_TIME, git: { repoUrl: "git@github.com:qsr/fabricated.git", commit: "def456", branch: "main" } },
      { type: "custom", id: "entry-custom", parentId: "entry-git", timestamp: SESSION_TIME, customType: "extension.state", data: { marker: "kept" } },
      { type: "agent_status", id: "status-1", parentId: "entry-custom", timestamp: SESSION_TIME, status: { summary: "", taskState: "needs_input", basedOnMessageCount: 3 } },
      { type: "child_usage_attributed", id: "entry-child-usage", parentId: "status-1", timestamp: SESSION_TIME, targetId: "entry-assistant", childUsage: usage, aggregateUsage: usage, origin: "spawn_task" },
      { type: "custom_message", id: "entry-custom-message", parentId: "entry-child-usage", timestamp: SESSION_TIME, customType: "notice", content: "latest semantic entry", display: true },
      { type: "compaction", id: "entry-compaction", parentId: "entry-custom-message", timestamp: SESSION_TIME, summary: "fabricated summary", firstKeptEntryId: "entry-user", tokensBefore: 9000 },
    ]));

    const childDir = join(root, "session-artifacts", "prime-fabricated-parent", "sub-abc12345");
    mkdirSync(childDir, { recursive: true });
    const childPath = join(childDir, "fabricated-child.jsonl");
    writeFileSync(childPath, jsonl([
      header("prime-fabricated-child", { parentSession: sourcePath, rlmDepth: 1 }),
      { type: "session_info", id: "child-info", parentId: null, timestamp: SESSION_TIME, name: "fabricated-child-agent" },
      { type: "message", id: "child-user", parentId: "child-info", timestamp: SESSION_TIME, message: { role: "user", content: "fabricated child turn", timestamp: 1_752_400_005_000 } },
      { type: "message", id: "child-answer", parentId: "child-user", timestamp: SESSION_TIME, message: assistantMessage([{ type: "text", text: "fabricated child answer" }], 1_752_400_006_000) },
    ]));

    // A fork (depth 0, parentSession) must map to forked_from, not subagent_of.
    const forkDir = join(root, "sessions");
    const forkPath = join(forkDir, "fabricated-fork.jsonl");
    writeFileSync(forkPath, jsonl([
      header("prime-fabricated-fork", { parentSession: sourcePath, rlmDepth: 0 }),
      { type: "message", id: "fork-user", parentId: null, timestamp: SESSION_TIME, message: { role: "user", content: "fabricated fork turn", timestamp: 1_752_400_007_000 } },
    ]));

    const first = await primeAdapter.read({ machine: MACHINE, now: NOW, roots: { prime: root } });
    const second = await primeAdapter.read({ machine: MACHINE, now: NOW, roots: { prime: root } });
    expect(first.sessions).toHaveLength(3);
    const parent = first.sessions.find((session) => session.nativeSessionId === "prime-fabricated-parent");
    const child = first.sessions.find((session) => session.nativeSessionId === "prime-fabricated-child");
    const fork = first.sessions.find((session) => session.nativeSessionId === "prime-fabricated-fork");
    expect(parent).toBeDefined();
    expect(child).toBeDefined();
    expect(fork).toBeDefined();
    expect(parent!.id).toBe(sessionIdFor("prime", PrimeSessionId("prime-fabricated-parent")));
    expect(second.sessions.find((session) => session.nativeSessionId === "prime-fabricated-parent")?.events.map((event) => event.id)).toEqual(parent!.events.map((event) => event.id));

    // Agent status ticks are dropped (machinery), and the entry tree chains
    // THROUGH them: child_usage_attributed's parent resolves past status-1.
    expect(parent!.events.map((event) => event.kind)).toEqual([
      "lifecycle",
      "lifecycle",
      "lifecycle",
      "message",
      "reasoning",
      "message",
      "tool_call",
      "tool_result",
      "lifecycle",
      "lifecycle",
      "lifecycle",
      "lifecycle",
      "preamble",
      "summary",
    ]);
    expect(parent!.events.map((event) => event.contentText).filter(Boolean)).toEqual([
      "fabricated root turn",
      "fabricated reasoning",
      "fabricated answer",
      "latest semantic entry",
      "fabricated summary",
    ]);
    expect(parent!.toolCalls).toHaveLength(1);
    expect(parent!.toolCalls[0]).toMatchObject({
      toolName: "fabricated_tool",
      status: "completed",
      output: {
        content: [
          { type: "text", text: "fabricated tool output" },
          { type: "image", mimeType: "image/png", embedded: true },
        ],
      },
    });
    expect(parent!.usageRecords).toHaveLength(1);
    expect(parent!.usageRecords[0]).toMatchObject({
      inputTokens: 12,
      outputTokens: 8,
      cacheReadInputTokens: 3,
      cacheCreationInputTokens: 2,
      totalTokens: 25,
      cost: 0.033,
      currency: "USD",
      model: "fabricated-model",
      modelProvider: "fabricated-provider",
    });
    // Turn-scoped execution context carries model + reasoning effort + tier.
    expect(parent!.executionContexts).toHaveLength(1);
    expect(parent!.executionContexts[0]).toMatchObject({
      scope: "turn",
      model: "fabricated-model",
      modelProvider: "fabricated-provider",
      reasoningEffort: "xhigh",
      serviceTier: "default",
    });
    expect(parent!.assignment).toEqual({ depth: 0 });
    expect(parent!.projectIdentity.gitRemote).toBe("git@github.com:qsr/fabricated.git");

    const rootEvent = parent!.events.find((event) => event.contentText === "fabricated root turn")!;
    const mainReasoning = parent!.events.find((event) => event.contentText === "fabricated reasoning")!;
    const childUsageEvent = parent!.events.find((event) => event.kind === "lifecycle" && event.rawReference.nativeType === "child_usage_attributed")!;
    // The entry tree chains THROUGH the dropped agent_status tick: the
    // child_usage_attributed parent edge targets the nearest KEPT ancestor
    // (the `custom` lifecycle event), never the status entry.
    const customEvent = parent!.events.find((event) => event.kind === "lifecycle" && event.rawReference.nativeType === "custom")!;
    expect(parent!.sessionEdges).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "parent", fromEventId: rootEvent.id, toEventId: mainReasoning.id }),
      expect.objectContaining({ kind: "parent", fromEventId: customEvent.id, toEventId: childUsageEvent.id }),
    ]));
    expect(parent!.sessionEdges).toContainEqual(expect.objectContaining({
      kind: "compacted_into",
      fromEventId: rootEvent.id,
      toEventId: parent!.events.find((event) => event.kind === "summary")!.id,
    }));

    // Subagent lineage: rlmDepth >= 1 emits subagent_of; depth-0 forks do not.
    expect(child!.assignment).toEqual({ depth: 1 });
    expect(child!.sessionEdges).toContainEqual(expect.objectContaining({
      kind: "subagent_of",
      fromId: parent!.id,
      toId: child!.id,
    }));
    expect(fork!.sessionEdges).toContainEqual(expect.objectContaining({
      kind: "forked_from",
      fromId: parent!.id,
      toId: fork!.id,
    }));
    expect(child!.agentName).toBe("fabricated-child-agent");
    expect(child!.title).toBe("fabricated-child-agent");

    const normalized = JSON.stringify(parent);
    expect(normalized).not.toContain(opaqueSignature);
    expect(normalized).not.toContain(embeddedBase64);
    expect(normalized).not.toContain("textSignature");
    expect(normalized).not.toContain("thinkingSignature");
    expect(normalized).not.toContain("thoughtSignature");
    expect(parent!.events.find((event) => event.contentText === "fabricated root turn")?.contentBlocks).toContainEqual(expect.objectContaining({ kind: "image", mediaType: "image/png", metadata: expect.objectContaining({ embedded: true }) }));

    const names = first.diagnostics.map(diagnosticName).filter(Boolean);
    expect(names).toContain("prime.line.invalid_json");
    expect(names).toContain("prime.entry.unknown_type");
    // agent_status drops are silent: no diagnostic for the status tick.
    expect(names).not.toContain("prime.entry.agent_status");
  });

  test("resolves subagent lineage when the parent file falls outside the window", async () => {
    const root = join(ROOT, "windowed");
    mkdirSync(join(root, "sessions"), { recursive: true });
    const parentPath = join(root, "sessions", "windowed-parent.jsonl");
    writeFileSync(parentPath, jsonl([
      header("prime-windowed-parent"),
      { type: "message", id: "wp-user", parentId: null, timestamp: SESSION_TIME, message: { role: "user", content: "windowed parent turn", timestamp: 1_752_400_000_000 } },
    ]));
    const childDir = join(root, "session-artifacts", "prime-windowed-parent", "sub-00000001");
    mkdirSync(childDir, { recursive: true });
    writeFileSync(join(childDir, "windowed-child.jsonl"), jsonl([
      header("prime-windowed-child", { parentSession: parentPath, rlmDepth: 1 }),
      { type: "message", id: "wc-user", parentId: null, timestamp: SESSION_TIME, message: { role: "user", content: "windowed child turn", timestamp: 1_752_400_001_000 } },
    ]));

    const result = await primeAdapter.read({
      machine: MACHINE,
      now: NOW,
      roots: { prime: root },
      // Window drops the parent; the child's subagent_of edge must still resolve.
      // (session-artifacts/ sorts before sessions/, so the child is file #1.)
      limit: 1,
    });
    expect(result.sessions).toHaveLength(1);
    expect(result.sessions[0]!.nativeSessionId).toBe("prime-windowed-child");
    expect(result.sessions[0]!.sessionEdges).toContainEqual(expect.objectContaining({
      kind: "subagent_of",
      fromId: sessionIdFor("prime", PrimeSessionId("prime-windowed-parent")),
    }));
    expect(result.diagnostics.map(diagnosticName).filter(Boolean)).not.toContain("prime.parent_session.unresolved");
  });

  test("advances updatedAt from tool results and semantic entries without conversational messages", async () => {
    const root = join(ROOT, "updated-at");
    mkdirSync(join(root, "sessions"), { recursive: true });

    writeFileSync(join(root, "sessions", "tool-result-latest.jsonl"), jsonl([
      header("prime-tool-result-latest"),
      {
        type: "message",
        id: "assistant-tool-call",
        parentId: null,
        timestamp: SESSION_TIME,
        message: assistantMessage([
          { type: "toolCall", id: "updated-at-call", name: "updated_at_tool", arguments: {} },
        ], 1_752_400_000_000, "toolUse"),
      },
      {
        type: "message",
        id: "later-tool-result",
        parentId: "assistant-tool-call",
        timestamp: SESSION_TIME,
        message: {
          role: "toolResult",
          toolCallId: "updated-at-call",
          toolName: "updated_at_tool",
          content: [{ type: "text", text: "later tool output" }],
          isError: false,
          timestamp: 1_752_400_010_000,
        },
      },
    ]));

    writeFileSync(join(root, "sessions", "non-conversational.jsonl"), jsonl([
      header("prime-non-conversational"),
      {
        type: "message",
        id: "standalone-result",
        parentId: null,
        timestamp: SESSION_TIME,
        message: {
          role: "toolResult",
          toolCallId: "missing-call",
          toolName: "standalone_tool",
          content: [{ type: "text", text: "standalone output" }],
          isError: false,
          timestamp: 1_752_400_010_000,
        },
      },
      {
        type: "message",
        id: "custom-message",
        parentId: "standalone-result",
        timestamp: SESSION_TIME,
        message: {
          role: "custom",
          customType: "status",
          content: "custom status",
          display: true,
          timestamp: 1_752_400_015_000,
        },
      },
      {
        type: "custom_message",
        id: "semantic-entry",
        parentId: "custom-message",
        timestamp: "2025-07-13T09:47:00.000Z",
        customType: "notice",
        content: "latest semantic entry",
        display: true,
      },
      {
        type: "custom",
        id: "out-of-range-entry",
        parentId: "semantic-entry",
        timestamp: "+275760-09-13T00:00:00.001Z",
        customType: "invalid-date",
      },
    ]));

    const result = await primeAdapter.read({ machine: MACHINE, now: NOW, roots: { prime: root } });
    const toolResultLatest = result.sessions.find((session) => session.nativeSessionId === "prime-tool-result-latest")!;
    const nonConversational = result.sessions.find((session) => session.nativeSessionId === "prime-non-conversational")!;

    expect(toolResultLatest.updatedAt).toBe("2025-07-13T09:46:50.000Z");
    expect(nonConversational.events.map((event) => event.kind)).toEqual([
      "tool_result",
      "preamble",
      "preamble",
      "lifecycle",
    ]);
    expect(nonConversational.updatedAt).toBe("2025-07-13T09:47:00.000Z");
    expect(result.diagnostics.map(diagnosticName).filter(Boolean)).toContain("prime.timestamp.invalid");
  });

  test("rejects invalid usage and falls back from out-of-range nested timestamps", async () => {
    const root = join(ROOT, "numeric-boundaries");
    mkdirSync(join(root, "sessions"), { recursive: true });
    writeFileSync(join(root, "sessions", "numeric-boundaries.jsonl"), jsonl([
      header("prime-numeric-boundaries"),
      {
        type: "message",
        id: "bad-time",
        parentId: null,
        timestamp: SESSION_TIME,
        message: assistantMessage([{ type: "text", text: "timestamp fallback answer" }], 1e100),
      },
      {
        type: "message",
        id: "bad-usage",
        parentId: "bad-time",
        timestamp: SESSION_TIME,
        message: {
          ...assistantMessage([{ type: "text", text: "invalid usage must not survive" }], 1_752_400_001_000),
          usage: { ...usage, input: -1 },
        },
      },
      {
        type: "message",
        id: "valid-after",
        parentId: "bad-time",
        timestamp: SESSION_TIME,
        message: { role: "user", content: "API_KEY=prime-secret", timestamp: 1_752_400_002_000 },
      },
    ]));

    const result = await primeAdapter.read({ machine: MACHINE, now: NOW, roots: { prime: root } });
    expect(result.sessions).toHaveLength(1);
    expect(result.sessions[0]!.events.map((event) => event.contentText)).toEqual([
      "timestamp fallback answer",
      "API_KEY=[redacted]",
    ]);
    expect(result.sessions[0]!.events[0]!.timestamp).toBe(SESSION_TIME);
    expect(JSON.stringify(result.sessions[0])).not.toContain("prime-secret");
    const names = result.diagnostics.map(diagnosticName).filter(Boolean);
    expect(names).toContain("prime.timestamp.invalid");
    expect(names).toContain("prime.message.decode_failed");
  });

  test("accepts streaming-abort toolCall artifacts (partialArgs/streamIndex) and v2 hookMessage migration", async () => {
    const root = join(ROOT, "streaming");
    mkdirSync(join(root, "sessions"), { recursive: true });
    writeFileSync(join(root, "sessions", "streaming.jsonl"), jsonl([
      header("prime-streaming"),
      {
        type: "message",
        id: "aborted",
        parentId: null,
        timestamp: SESSION_TIME,
        message: {
          role: "assistant",
          content: [
            {
              type: "toolCall",
              id: "call-partial",
              name: "ipython",
              arguments: { code: "print(1)" },
              partialArgs: "{\"code\": \"print(1)\"}",
              streamIndex: 0,
            },
          ],
          api: "fabricated-api",
          provider: "fabricated-provider",
          model: "fabricated-model",
          usage,
          stopReason: "aborted",
          errorMessage: "Request was aborted",
          timestamp: 1_752_400_000_000,
        },
      },
    ]));
    writeFileSync(join(root, "sessions", "v2.jsonl"), jsonl([
      { ...header("prime-v2"), version: 2 },
      { type: "message", id: "v2-message", parentId: null, timestamp: SESSION_TIME, message: { role: "hookMessage", customType: "fabricated-hook", content: "fabricated v2 hook", display: true, timestamp: 1_752_400_000_000 } },
    ]));
    writeFileSync(join(root, "sessions", "v1.jsonl"), jsonl([
      { ...header("prime-v1"), version: 1 },
      { type: "message", timestamp: SESSION_TIME, message: { role: "user", content: "ancient", timestamp: 1_752_400_000_000 } },
    ]));

    const result = await primeAdapter.read({ machine: MACHINE, now: NOW, roots: { prime: root } });
    const streaming = result.sessions.find((session) => session.nativeSessionId === "prime-streaming")!;
    const v2 = result.sessions.find((session) => session.nativeSessionId === "prime-v2")!;
    expect(streaming.toolCalls).toHaveLength(1);
    expect(streaming.toolCalls[0]).toMatchObject({ toolName: "ipython", status: "error" });
    expect(streaming.events.find((event) => event.kind === "tool_call")?.contentBlocks).toHaveLength(1);
    expect(JSON.stringify(streaming)).not.toContain("partialArgs");
    expect(v2.events).toHaveLength(1);
    expect(v2.events[0]).toMatchObject({ kind: "preamble", role: "system", contentText: "fabricated v2 hook" });
    // v1 is the Pi format lineage: named drop, never normalized here.
    expect(result.sessions.find((session) => session.nativeSessionId === "prime-v1")).toBeUndefined();
    const names = result.diagnostics.map(diagnosticName).filter(Boolean);
    expect(names).toContain("prime.header.unsupported_version");
  });

  test("fails closed for malformed headers, entries, roles, and content", () => {
    const cases = [
      [{ type: "session", version: 3, id: "id", timestamp: SESSION_TIME, cwd: CWD, extra: true }, { header: true as const }, "prime.header.decode_failed"],
      [{ type: "unknown", id: "e", parentId: null, timestamp: SESSION_TIME }, {}, "prime.entry.unknown_type"],
      [{ type: "message", id: "e", parentId: null, timestamp: SESSION_TIME, message: { role: "alien", content: "x", timestamp: 1 } }, {}, "prime.message.unknown_role"],
      [{ type: "message", id: "e", parentId: null, timestamp: SESSION_TIME, message: { role: "user", content: [{ type: "alien", text: "x" }], timestamp: 1 } }, {}, "prime.content.unknown_type"],
      [{ type: "agent_status", id: "s", parentId: null, timestamp: SESSION_TIME, status: { summary: "", basedOnMessageCount: 1 } }, {}, "prime.entry.agent_status"],
    ] as const;
    for (const [record, options, expectedName] of cases) {
      const diagnostics: { name: string; message: string }[] = [];
      const result = classifyPrimeRecord(record, { ...options, diagnostics });
      expect(result._tag).toBe("drop");
      if (expectedName === "prime.entry.agent_status") {
        // Named silent drop: no decode diagnostic is raised for expected noise.
        expect(diagnostics).toHaveLength(0);
        if (result._tag !== "drop") throw new Error("expected drop");
        expect(result.reason).toContain(expectedName);
      } else {
        expect(diagnostics.map((diagnostic) => diagnostic.name)).toContain(expectedName);
      }
    }
  });

  test("uses header IDs and honors stat and parse gates", async () => {
    const root = join(ROOT, "gates");
    mkdirSync(join(root, "sessions"), { recursive: true });
    const path = join(root, "sessions", "filename-is-not-the-session-id.jsonl");
    writeFileSync(path, jsonl([
      header("prime-fabricated-gated"),
      { type: "message", id: "e1", parentId: null, timestamp: SESSION_TIME, message: { role: "user", content: "gated content", timestamp: 1_752_400_000_000 } },
    ]));
    let readGateCalls = 0;
    const unread = await primeAdapter.read({
      machine: MACHINE,
      now: NOW,
      roots: { prime: root },
      shouldReadFile: () => {
        readGateCalls += 1;
        return false;
      },
    });
    expect(readGateCalls).toBe(1);
    expect(unread.sessions).toHaveLength(0);

    let probe: { sessionId: string; sourceFingerprint: string } | undefined;
    const unparsed = await primeAdapter.read({
      machine: MACHINE,
      now: NOW,
      roots: { prime: root },
      shouldParseSession: (value) => {
        probe = value;
        return false;
      },
    });
    expect(unparsed.sessions).toHaveLength(0);
    expect(probe).toEqual({
      sessionId: sessionIdFor("prime", PrimeSessionId("prime-fabricated-gated")),
      sourceFingerprint: sourceFingerprintFor(statSync(path)),
    });
  });

  test("unreadable parent session file never throws and emits parent_session.unresolved", async () => {
    const root = join(ROOT, "unreadable-parent");
    mkdirSync(join(root, "sessions"), { recursive: true });
    const parentPath = join(root, "sessions", "locked-parent.jsonl");
    writeFileSync(parentPath, jsonl([
      header("prime-locked-parent"),
      { type: "message", id: "lp-user", parentId: null, timestamp: SESSION_TIME, message: { role: "user", content: "locked parent turn", timestamp: 1_752_400_000_000 } },
    ]));
    const childDir = join(root, "session-artifacts", "prime-locked-parent", "sub-00000002");
    mkdirSync(childDir, { recursive: true });
    writeFileSync(join(childDir, "locked-child.jsonl"), jsonl([
      header("prime-locked-child", { parentSession: parentPath, rlmDepth: 1 }),
      { type: "message", id: "lc-user", parentId: null, timestamp: SESSION_TIME, message: { role: "user", content: "locked child turn", timestamp: 1_752_400_001_000 } },
    ]));
    chmodSync(parentPath, 0);
    try {
      const result = await primeAdapter.read({ machine: MACHINE, now: NOW, roots: { prime: root } });
      // The child still ingests; the locked parent cannot be probed for the
      // lineage map (prime.line.unreadable) so its subagent_of edge degrades
      // to a named unresolved diagnostic. Never a throw.
      expect(result.sessions.map((session) => session.nativeSessionId)).toContain("prime-locked-child");
      const names = result.diagnostics.map(diagnosticName).filter(Boolean);
      expect(names).toContain("prime.line.unreadable");
      expect(names).toContain("prime.parent_session.unresolved");
    } finally {
      chmodSync(parentPath, 0o644);
    }
  });

  test("skips rlm-subagents.jsonl registry files and duplicate session ids", async () => {
    const root = join(ROOT, "registry");
    const sessionsDir = join(root, "sessions");
    mkdirSync(sessionsDir, { recursive: true });
    writeFileSync(join(sessionsDir, "duplicate-a.jsonl"), jsonl([
      header("prime-duplicate"),
      { type: "message", id: "d1", parentId: null, timestamp: SESSION_TIME, message: { role: "user", content: "first copy", timestamp: 1_752_400_000_000 } },
    ]));
    writeFileSync(join(sessionsDir, "duplicate-b.jsonl"), jsonl([
      header("prime-duplicate"),
      { type: "message", id: "d2", parentId: null, timestamp: SESSION_TIME, message: { role: "user", content: "second copy", timestamp: 1_752_400_001_000 } },
    ]));
    const artifactsDir = join(root, "session-artifacts", "prime-duplicate");
    mkdirSync(artifactsDir, { recursive: true });
    writeFileSync(join(artifactsDir, "rlm-subagents.jsonl"), JSON.stringify({
      type: "rlm_subagent",
      childId: "sub-1",
      sessionName: "registry-only",
    }));

    const result = await primeAdapter.read({ machine: MACHINE, now: NOW, roots: { prime: root } });
    // duplicate-b sorts after duplicate-a: only the first copy survives.
    expect(result.sessions).toHaveLength(1);
    expect(result.sessions[0]!.events[0]!.contentText).toBe("first copy");
    const names = result.diagnostics.map(diagnosticName).filter(Boolean);
    expect(names).toContain("prime.session.duplicate_id");
    expect(names).not.toContain("prime.header.not_first_valid_record");
  });
});
