import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, test } from "bun:test";

import { sessionIdFor, sourceFingerprintFor } from "../src/adapters/common";
import { classifyPiRecord } from "../src/adapters/pi-schema";
import { piAdapter } from "../src/adapters/pi";
import { PiSessionId } from "../src/core/identity";

const MACHINE = {
  machineId: "machine:test",
  hostname: "qsr-fabricated-host",
  platform: "darwin",
};
const NOW = "2026-07-13T00:00:00.000Z";
const SESSION_TIME = "2026-07-12T10:00:00.000Z";
const CWD = "/qsr/fabricated/pi-project";
const ROOT = mkdtempSync(join(tmpdir(), "quasar-pi-adapter-"));

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

afterAll(() => {
  rmSync(ROOT, { recursive: true, force: true });
});

describe("Pi adapter", () => {
  test("normalizes v3 semantic content, tools, usage, append-tree branches, and surrounding valid records", async () => {
    const root = join(ROOT, "v3");
    const nested = join(root, "--qsr-fabricated-pi-project--");
    mkdirSync(nested, { recursive: true });
    const sourcePath = join(nested, "fabricated-parent.jsonl");
    const opaqueSignature = "qsr-fabricated-opaque-signature";
    const embeddedBase64 = "ZmFicmljYXRlZC1pbWFnZS1ieXRlcw==";
    writeFileSync(sourcePath, jsonl([
      { type: "session", version: 3, id: "pi-fabricated-parent", timestamp: SESSION_TIME, cwd: CWD },
      { type: "model_change", id: "entry-model", parentId: null, timestamp: SESSION_TIME, provider: "fabricated-provider", modelId: "fabricated-model" },
      { type: "message", id: "entry-user", parentId: "entry-model", timestamp: SESSION_TIME, message: { role: "user", content: [{ type: "text", text: "fabricated root turn", textSignature: opaqueSignature }, { type: "image", data: embeddedBase64, mimeType: "image/png" }], timestamp: 1_752_400_000_000 } },
      { type: "message", id: "entry-assistant", parentId: "entry-user", timestamp: SESSION_TIME, message: assistantMessage([
        { type: "thinking", thinking: "fabricated reasoning", thinkingSignature: opaqueSignature },
        { type: "text", text: "fabricated answer", textSignature: opaqueSignature },
        { type: "toolCall", id: "call-fabricated", name: "fabricated_tool", arguments: { path: "/qsr/fabricated/file", token: "secret-fabricated" }, thoughtSignature: opaqueSignature },
      ], 1_752_400_001_000, "toolUse") },
      "{malformed-json",
      { type: "message", id: "entry-result", parentId: "entry-assistant", timestamp: SESSION_TIME, message: { role: "toolResult", toolCallId: "call-fabricated", toolName: "fabricated_tool", content: [{ type: "text", text: "fabricated tool output" }, { type: "image", data: embeddedBase64, mimeType: "image/png" }], details: { textSignature: opaqueSignature, image: { data: embeddedBase64, mimeType: "image/png" } }, isError: false, timestamp: 1_752_400_002_000 } },
      { type: "future_entry", id: "entry-unknown", parentId: "entry-user", timestamp: SESSION_TIME },
      { type: "message", id: "entry-malformed", parentId: "entry-user", timestamp: SESSION_TIME, message: { role: "assistant", content: [], timestamp: 1_752_400_002_500 } },
      { type: "message", id: "entry-branch", parentId: "entry-user", timestamp: SESSION_TIME, message: { role: "user", content: "fabricated branch turn", timestamp: 1_752_400_003_000 } },
      { type: "message", id: "entry-branch-answer", parentId: "entry-branch", timestamp: SESSION_TIME, message: assistantMessage([{ type: "text", text: "fabricated branch answer" }], 1_752_400_004_000) },
    ]));

    const childPath = join(nested, "fabricated-child.jsonl");
    writeFileSync(childPath, jsonl([
      { type: "session", version: 3, id: "pi-fabricated-child", timestamp: SESSION_TIME, cwd: CWD, parentSession: sourcePath },
      { type: "message", id: "child-user", parentId: null, timestamp: SESSION_TIME, message: { role: "user", content: "fabricated child turn", timestamp: 1_752_400_005_000 } },
    ]));

    const first = await piAdapter.read({ machine: MACHINE, now: NOW, roots: { pi: root } });
    const second = await piAdapter.read({ machine: MACHINE, now: NOW, roots: { pi: root } });
    expect(first.sessions).toHaveLength(2);
    const parent = first.sessions.find((session) => session.nativeSessionId === "pi-fabricated-parent");
    const child = first.sessions.find((session) => session.nativeSessionId === "pi-fabricated-child");
    expect(parent).toBeDefined();
    expect(child).toBeDefined();
    expect(parent!.id).toBe(sessionIdFor("pi", PiSessionId("pi-fabricated-parent")));
    expect(second.sessions.find((session) => session.nativeSessionId === "pi-fabricated-parent")?.events.map((event) => event.id)).toEqual(parent!.events.map((event) => event.id));

    expect(parent!.events.map((event) => event.kind)).toEqual([
      "lifecycle",
      "message",
      "reasoning",
      "message",
      "tool_call",
      "tool_result",
      "message",
      "message",
    ]);
    expect(parent!.events.map((event) => event.contentText).filter(Boolean)).toEqual([
      "fabricated root turn",
      "fabricated reasoning",
      "fabricated answer",
      "fabricated branch turn",
      "fabricated branch answer",
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
    expect(parent!.usageRecords).toHaveLength(2);
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

    const rootEvent = parent!.events.find((event) => event.contentText === "fabricated root turn")!;
    const mainReasoning = parent!.events.find((event) => event.contentText === "fabricated reasoning")!;
    const branchEvent = parent!.events.find((event) => event.contentText === "fabricated branch turn")!;
    expect(parent!.sessionEdges).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "parent", fromEventId: rootEvent.id, toEventId: mainReasoning.id }),
      expect.objectContaining({ kind: "parent", fromEventId: rootEvent.id, toEventId: branchEvent.id }),
    ]));
    expect(child!.sessionEdges).toContainEqual(expect.objectContaining({
      kind: "forked_from",
      fromId: parent!.id,
      toId: child!.id,
    }));

    const normalized = JSON.stringify(parent);
    expect(normalized).not.toContain(opaqueSignature);
    expect(normalized).not.toContain(embeddedBase64);
    expect(normalized).not.toContain("textSignature");
    expect(normalized).not.toContain("thinkingSignature");
    expect(normalized).not.toContain("thoughtSignature");
    expect(parent!.events.find((event) => event.contentText === "fabricated root turn")?.contentBlocks).toContainEqual(expect.objectContaining({ kind: "image", mediaType: "image/png", metadata: expect.objectContaining({ embedded: true }) }));

    const names = first.diagnostics.map(diagnosticName).filter(Boolean);
    expect(names).toContain("pi.line.invalid_json");
    expect(names).toContain("pi.entry.unknown_type");
    expect(names).toContain("pi.message.decode_failed");
  });

  test("advances updatedAt from tool results and semantic entries without conversational messages", async () => {
    const root = join(ROOT, "updated-at");
    mkdirSync(root, { recursive: true });

    writeFileSync(join(root, "tool-result-latest.jsonl"), jsonl([
      { type: "session", version: 3, id: "pi-tool-result-latest", timestamp: SESSION_TIME, cwd: CWD },
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

    writeFileSync(join(root, "non-conversational.jsonl"), jsonl([
      { type: "session", version: 3, id: "pi-non-conversational", timestamp: SESSION_TIME, cwd: CWD },
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

    const result = await piAdapter.read({ machine: MACHINE, now: NOW, roots: { pi: root } });
    const toolResultLatest = result.sessions.find((session) => session.nativeSessionId === "pi-tool-result-latest")!;
    const nonConversational = result.sessions.find((session) => session.nativeSessionId === "pi-non-conversational")!;

    expect(toolResultLatest.updatedAt).toBe("2025-07-13T09:46:50.000Z");
    expect(nonConversational.events.map((event) => event.kind)).toEqual([
      "tool_result",
      "preamble",
      "preamble",
      "lifecycle",
    ]);
    expect(nonConversational.updatedAt).toBe("2025-07-13T09:47:00.000Z");
    expect(result.diagnostics.map(diagnosticName).filter(Boolean)).toContain("pi.timestamp.invalid");
  });

  test("rejects invalid usage and falls back from out-of-range nested timestamps", async () => {
    const root = join(ROOT, "numeric-boundaries");
    mkdirSync(root, { recursive: true });
    const sourcePath = join(root, "numeric-boundaries.jsonl");
    writeFileSync(sourcePath, jsonl([
      { type: "session", version: 3, id: "pi-numeric-boundaries", timestamp: SESSION_TIME, cwd: CWD },
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
        message: { role: "user", content: "API_KEY=pi-secret", timestamp: 1_752_400_002_000 },
      },
    ]));

    const result = await piAdapter.read({ machine: MACHINE, now: NOW, roots: { pi: root } });
    expect(result.sessions).toHaveLength(1);
    expect(result.sessions[0]!.events.map((event) => event.contentText)).toEqual([
      "timestamp fallback answer",
      "API_KEY=[redacted]",
    ]);
    expect(result.sessions[0]!.events[0]!.timestamp).toBe(SESSION_TIME);
    expect(JSON.stringify(result.sessions[0])).not.toContain("pi-secret");
    const names = result.diagnostics.map(diagnosticName).filter(Boolean);
    expect(names).toContain("pi.timestamp.invalid");
    expect(names).toContain("pi.message.decode_failed");
  });

  test("fails closed for malformed headers, entries, roles, and content", () => {
    const cases = [
      [{ type: "session", version: 3, id: "id", timestamp: SESSION_TIME, cwd: CWD, extra: true }, { header: true as const }, "pi.header.decode_failed"],
      [{ type: "unknown", id: "e", parentId: null, timestamp: SESSION_TIME }, {}, "pi.entry.unknown_type"],
      [{ type: "message", id: "e", parentId: null, timestamp: SESSION_TIME, message: { role: "alien", content: "x", timestamp: 1 } }, {}, "pi.message.unknown_role"],
      [{ type: "message", id: "e", parentId: null, timestamp: SESSION_TIME, message: { role: "user", content: [{ type: "alien", text: "x" }], timestamp: 1 } }, {}, "pi.content.unknown_type"],
    ] as const;
    for (const [record, options, expectedName] of cases) {
      const diagnostics: { name: string; message: string }[] = [];
      const result = classifyPiRecord(record, { ...options, diagnostics });
      expect(result._tag).toBe("drop");
      expect(diagnostics.map((diagnostic) => diagnostic.name)).toContain(expectedName);
    }
  });

  test("uses header IDs and honors stat and parse gates", async () => {
    const root = join(ROOT, "gates");
    mkdirSync(root, { recursive: true });
    const path = join(root, "filename-is-not-the-session-id.jsonl");
    writeFileSync(path, jsonl([
      { type: "session", version: 3, id: "pi-fabricated-gated", timestamp: SESSION_TIME, cwd: CWD },
      { type: "message", id: "e1", parentId: null, timestamp: SESSION_TIME, message: { role: "user", content: "gated content", timestamp: 1_752_400_000_000 } },
    ]));
    let readGateCalls = 0;
    const unread = await piAdapter.read({
      machine: MACHINE,
      now: NOW,
      roots: { pi: root },
      shouldReadFile: () => {
        readGateCalls += 1;
        return false;
      },
    });
    expect(readGateCalls).toBe(1);
    expect(unread.sessions).toHaveLength(0);

    let probe: { sessionId: string; sourceFingerprint: string } | undefined;
    const unparsed = await piAdapter.read({
      machine: MACHINE,
      now: NOW,
      roots: { pi: root },
      shouldParseSession: (value) => {
        probe = value;
        return false;
      },
    });
    expect(unparsed.sessions).toHaveLength(0);
    expect(probe).toEqual({
      sessionId: sessionIdFor("pi", PiSessionId("pi-fabricated-gated")),
      sourceFingerprint: sourceFingerprintFor(statSync(path)),
    });
  });
  test("migrates documented v1 and v2 records deterministically without writing sources", async () => {
    const root = join(ROOT, "legacy");
    mkdirSync(root, { recursive: true });
    const v1Path = join(root, "fabricated-v1.jsonl");
    writeFileSync(v1Path, jsonl([
      { type: "session", version: 1, id: "pi-fabricated-v1", timestamp: SESSION_TIME, cwd: CWD },
      { type: "model_change", timestamp: SESSION_TIME, provider: "fabricated-provider", modelId: "fabricated-model" },
      { type: "message", timestamp: SESSION_TIME, message: { role: "user", content: "fabricated v1 turn", timestamp: 1_752_400_000_000 } },
      { type: "compaction", timestamp: SESSION_TIME, summary: "fabricated v1 summary", firstKeptEntryIndex: 0, tokensBefore: 42 },
    ]));
    const v2Path = join(root, "fabricated-v2.jsonl");
    writeFileSync(v2Path, jsonl([
      { type: "session", version: 2, id: "pi-fabricated-v2", timestamp: SESSION_TIME, cwd: CWD },
      { type: "message", id: "v2-message", parentId: null, timestamp: SESSION_TIME, message: { role: "hookMessage", customType: "fabricated-hook", content: "fabricated v2 hook", display: true, timestamp: 1_752_400_000_000 } },
    ]));
    const v1Before = readFileSync(v1Path, "utf8");
    const v2Before = readFileSync(v2Path, "utf8");
    const first = await piAdapter.read({ machine: MACHINE, now: NOW, roots: { pi: root } });
    const second = await piAdapter.read({ machine: MACHINE, now: NOW, roots: { pi: root } });
    const v1 = first.sessions.find((session) => session.nativeSessionId === "pi-fabricated-v1")!;
    const v2 = first.sessions.find((session) => session.nativeSessionId === "pi-fabricated-v2")!;
    expect(v1.events.map((event) => event.kind)).toEqual(["lifecycle", "message", "summary"]);
    expect(v2.events).toHaveLength(1);
    expect(v2.events[0]).toMatchObject({ kind: "preamble", role: "system", contentText: "fabricated v2 hook" });
    expect(second.sessions.find((session) => session.nativeSessionId === "pi-fabricated-v1")?.events.map((event) => event.id)).toEqual(v1.events.map((event) => event.id));
    expect(readFileSync(v1Path, "utf8")).toBe(v1Before);
    expect(readFileSync(v2Path, "utf8")).toBe(v2Before);
    const names = first.diagnostics.map(diagnosticName).filter(Boolean);
    expect(names).toContain("pi.session.legacy_v1");
    expect(names).toContain("pi.session.legacy_v2");
  });
});
