import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, test } from "bun:test";

import { grokAdapter } from "../src/adapters/grok";
import { GrokSessionId } from "../src/core/identity";
import { sessionIdFor } from "../src/adapters/common";
import { mapSession } from "../src/map";
import {
  GrokSubagentManifest,
  GrokChatUser,
  GrokChatAssistant,
  GrokChatReasoning,
  GrokChatToolResult,
  GrokChatSystem,
  GrokChatBackendToolCall,
  GrokEvtPhaseChanged,
  GrokEvtToolStarted,
  GrokEvtToolCompleted,
  GrokEvtPermissionRequested,
  GrokEvtPermissionResolved,
  GrokEvtLoopStarted,
  GrokEvtFirstToken,
  GrokEvtTurnStarted,
  GrokEvtTurnEnded,
  GrokEvtYoloToggled,
  GrokEvtMcpServerStarting,
  GrokEvtMcpServerFailed,
  GrokEvtMcpServerConnected,
  GrokEvtMcpManagedConfigResult,
  GrokEvtMcpConfigResolved,
  GrokEvtMcpInitCompleted,
  GrokEvtMcpToolCallStarted,
  GrokEvtMcpToolCallCompleted,
  GrokEvtMcpOauthDiscoveryTimeout,
  GrokUpdToolCall,
  GrokUpdToolCallUpdate,
  GrokUpdAvailableCommands,
  GrokUpdAgentThoughtChunk,
  GrokUpdAgentMessageChunk,
  GrokUpdUserMessageChunk,
  GrokUpdRetryState,
  GrokUpdTaskBackgrounded,
  GrokUpdTaskCompleted,
  GrokUpdSubagentSpawned,
  GrokUpdSubagentFinished,
  GrokUpdAutoCompactStarted,
  GrokUpdAutoCompactCompleted,
  GrokUpdCompactionCheckpoint,
  GrokUpdPlan,
  GrokUpdCurrentMode,
  GrokHunkAdded,
  GrokHunkUpdated,
  GrokHunkRemoved,
  classifyGrokChat,
  classifyGrokEvent,
  classifyGrokUpdate,
  classifyGrokHunk,
  GROK_DECODE_FAILED,
  GROK_UNKNOWN_TYPE,
} from "../src/adapters/grok-schema";
import { isSignal, type DecodeDiagnostic } from "../src/adapters/harness-schema";
import { Schema } from "effect";

const MACHINE = {
  machineId: "machine:test",
  hostname: "test-host",
  platform: "darwin",
};

const NOW = "2026-06-01T00:00:00.000Z";

const testRoot = mkdtempSync(join(tmpdir(), "quasar-grok-test-"));

afterAll(() => {
  rmSync(testRoot, { recursive: true, force: true });
});

const writeJsonLines = (path: string, records: unknown[]) =>
  writeFileSync(path, records.map((record) => JSON.stringify(record)).join("\n") + "\n", "utf8");

// ---------------------------------------------------------------------------
// AC#5 — idempotency proof (dirname-id provider)
//
// Grok native id = basename of the session directory (a uuid-like string).
// Two different PARENT paths pointing to the SAME session directory name must
// yield byte-identical canonical session.id values.  The test writes the same
// session uuid dir under two different host/docker roots and asserts equality.
// ---------------------------------------------------------------------------
describe("AC#5 idempotency: same session dir name at different parent paths → byte-identical session.id", () => {
  const hostRoot = mkdtempSync(join(tmpdir(), "quasar-grok-host-"));
  const dockerRoot = mkdtempSync(join(tmpdir(), "quasar-grok-docker-"));

  afterAll(() => {
    rmSync(hostRoot, { recursive: true, force: true });
    rmSync(dockerRoot, { recursive: true, force: true });
  });

  // Real on-disk shape: the grok session directory is named with a UUIDv7 and
  // that name is the native id. Only the parent path differs between the trees.
  const SESSION_UUID = "01900000-0000-7000-8000-000000000002";
  const PROJECT_KEY = encodeURIComponent("/repo/myapp");

  const writeSession = (root: string) => {
    const sessionDir = join(root, "sessions", PROJECT_KEY, SESSION_UUID);
    mkdirSync(sessionDir, { recursive: true });
    writeJsonLines(join(sessionDir, "chat_history.jsonl"), [
      { type: "user", content: "hello from idempotency test" },
      { type: "assistant", content: "hello back" },
    ]);
    // Real sidecar shape: events.jsonl carries a turn_started record whose
    // session_id equals the directory name (the native id).
    writeJsonLines(join(sessionDir, "events.jsonl"), [
      {
        ts: NOW,
        type: "turn_started",
        session_id: SESSION_UUID,
        turn_number: 0,
        model_id: "grok-build",
        schema_version: "1.0",
      },
    ]);
  };

  writeSession(hostRoot);
  writeSession(dockerRoot);

  test("host and docker reads produce byte-identical session.id", async () => {
    const hostResult = await grokAdapter.read({
      machine: MACHINE,
      now: NOW,
      roots: { grok: hostRoot },
    });
    const dockerResult = await grokAdapter.read({
      machine: MACHINE,
      now: NOW,
      roots: { grok: dockerRoot },
    });

    expect(hostResult.sessions).toHaveLength(1);
    expect(dockerResult.sessions).toHaveLength(1);
    // The canonical id must be byte-identical despite different parent paths.
    expect(hostResult.sessions[0]!.id).toBe(dockerResult.sessions[0]!.id);
    // The sourcePaths must differ — proving the id does not encode the parent.
    expect(hostResult.sessions[0]!.sourcePath).not.toBe(dockerResult.sessions[0]!.sourcePath);
  });
});

describe("grok adapter", () => {
  test("missing optional sidecars do not abort and later sidecar creation invalidates the fingerprint", async () => {
    const root = join(testRoot, "optional-sidecars");
    // Real on-disk shape: the session directory is a UUIDv7, not "session-1".
    const sessionUuid = "01900000-0000-7000-8000-000000000007";
    const sessionDir = join(root, "sessions", encodeURIComponent("/repo"), sessionUuid);
    mkdirSync(sessionDir, { recursive: true });
    writeJsonLines(join(sessionDir, "chat_history.jsonl"), [
      { type: "user", content: "please inspect this terminal run" },
      { type: "assistant", content: "Done Reading the terminal output." },
    ]);
    // events.jsonl turn_started carries session_id equal to the dir name.
    writeJsonLines(join(sessionDir, "events.jsonl"), [
      { ts: NOW, type: "turn_started", session_id: sessionUuid, turn_number: 0, schema_version: "1.0" },
    ]);

    const firstProbes: string[] = [];
    const first = await grokAdapter.read({
      machine: MACHINE,
      now: NOW,
      roots: { grok: root },
      shouldParseSession: (probe) => {
        firstProbes.push(probe.sourceFingerprint);
        return true;
      },
    });
    expect(first.sessions).toHaveLength(1);
    expect(first.diagnostics[0]?.status).toBe("available");

    writeJsonLines(join(sessionDir, "updates.jsonl"), [
      { method: "tool.update", content: "sidecar appeared after first ingest" },
    ]);

    const secondProbes: string[] = [];
    const second = await grokAdapter.read({
      machine: MACHINE,
      now: NOW,
      roots: { grok: root },
      shouldParseSession: (probe) => {
        secondProbes.push(probe.sourceFingerprint);
        return false;
      },
    });
    expect(second.sessions).toHaveLength(0);
    expect(secondProbes).toHaveLength(1);
    expect(secondProbes[0]).not.toBe(firstProbes[0]);
  });
});

// ---------------------------------------------------------------------------
// QSR-220 — first-class subagent lineage
//
// Grok writes a subagent CHILD as its OWN top-level session directory (own
// UUIDv7 + own chat_history.jsonl) and records the parent relationship ONLY in
// the parent's `<parent>/subagents/<child>/meta.json` manifest. The adapter must
// discover those manifests and, for each child session, emit a canonical
// `subagent_of` SessionEdge whose `fromId` is the PARENT's machine-independent
// Quasar SessionId, plus set the child's agentName from `subagent_type`.
// ---------------------------------------------------------------------------
describe("QSR-220 grok subagent lineage", () => {
  // Clearly-FABRICATED UUIDv7-shaped identifiers — never real on-disk ids.
  const PARENT_UUID = "01900000-0000-7000-8000-00000000aaaa";
  const CHILD_UUID = "01900000-0000-7000-8000-00000000bbbb";
  const SUBAGENT_TYPE = "fab-explore-role";
  const PROJECT_KEY = encodeURIComponent("/repo/lineage");

  const setupRoot = () => {
    const root = mkdtempSync(join(tmpdir(), "quasar-grok-lineage-"));
    const sessionsRoot = join(root, "sessions", PROJECT_KEY);
    // Parent session dir: own chat_history + a subagent manifest pointing at the child.
    const parentDir = join(sessionsRoot, PARENT_UUID);
    mkdirSync(parentDir, { recursive: true });
    writeJsonLines(join(parentDir, "chat_history.jsonl"), [
      { type: "user", content: "synthetic parent prompt" },
      { type: "assistant", content: "synthetic parent reply" },
    ]);
    const manifestDir = join(parentDir, "subagents", CHILD_UUID);
    mkdirSync(manifestDir, { recursive: true });
    writeFileSync(
      join(manifestDir, "meta.json"),
      JSON.stringify({
        subagent_id: CHILD_UUID,
        parent_session_id: PARENT_UUID,
        child_session_id: CHILD_UUID,
        subagent_type: SUBAGENT_TYPE,
        description: "synthetic subagent",
        prompt: "synthetic fabricated prompt — not real content",
        status: "completed",
      }),
      "utf8",
    );
    // Child session dir: flat, top-level, own chat_history (ingested independently).
    const childDir = join(sessionsRoot, CHILD_UUID);
    mkdirSync(childDir, { recursive: true });
    writeJsonLines(join(childDir, "chat_history.jsonl"), [
      { type: "user", content: "synthetic child prompt" },
      { type: "assistant", content: "synthetic child reply" },
    ]);
    return root;
  };

  test("child session carries subagent_of edge → parent canonical SessionId, agentName = subagent_type", async () => {
    const root = setupRoot();
    try {
      const result = await grokAdapter.read({ machine: MACHINE, now: NOW, roots: { grok: root } });
      // Both the parent and child sessions are ingested flat.
      expect(result.sessions).toHaveLength(2);

      const parentSessionId = sessionIdFor("grok", GrokSessionId(PARENT_UUID));
      const childSessionId = sessionIdFor("grok", GrokSessionId(CHILD_UUID));

      const child = result.sessions.find((s) => s.id === childSessionId);
      const parent = result.sessions.find((s) => s.id === parentSessionId);
      expect(child).toBeDefined();
      expect(parent).toBeDefined();

      // The child carries the canonical subagent_of edge → parent SessionId.
      const edge = child!.sessionEdges.find((e) => e.kind === "subagent_of");
      expect(edge).toBeDefined();
      expect(edge!.fromId).toBe(parentSessionId);
      expect(edge!.toId).toBe(childSessionId);

      // agentName is sourced from the manifest subagent_type.
      expect(child!.agentName).toBe(SUBAGENT_TYPE);

      // End-to-end: map.ts projects subagent_of onto SessionRow.parentSessionId.
      const mappedChild = mapSession(child!, "fp-child");
      expect(mappedChild.session.parentSessionId).toBe(parentSessionId);

      // The parent is a top-level session: no subagent_of edge, default agentName.
      expect(parent!.sessionEdges.find((e) => e.kind === "subagent_of")).toBeUndefined();
      const mappedParent = mapSession(parent!, "fp-parent");
      expect(mappedParent.session.parentSessionId).toBeUndefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a malformed subagent manifest is dropped fail-closed (no edge), ingest continues", async () => {
    const root = mkdtempSync(join(tmpdir(), "quasar-grok-lineage-bad-"));
    try {
      const sessionsRoot = join(root, "sessions", PROJECT_KEY);
      const parentDir = join(sessionsRoot, PARENT_UUID);
      mkdirSync(parentDir, { recursive: true });
      writeJsonLines(join(parentDir, "chat_history.jsonl"), [
        { type: "user", content: "synthetic parent prompt" },
      ]);
      // Manifest missing required parent_session_id + subagent_type → garbage.
      const manifestDir = join(parentDir, "subagents", CHILD_UUID);
      mkdirSync(manifestDir, { recursive: true });
      writeFileSync(
        join(manifestDir, "meta.json"),
        JSON.stringify({ subagent_id: CHILD_UUID, child_session_id: CHILD_UUID }),
        "utf8",
      );
      const childDir = join(sessionsRoot, CHILD_UUID);
      mkdirSync(childDir, { recursive: true });
      writeJsonLines(join(childDir, "chat_history.jsonl"), [
        { type: "user", content: "synthetic child prompt" },
      ]);

      const result = await grokAdapter.read({ machine: MACHINE, now: NOW, roots: { grok: root } });
      // Both sessions still ingest; the bad manifest just yields no lineage edge.
      expect(result.sessions).toHaveLength(2);
      const childSessionId = sessionIdFor("grok", GrokSessionId(CHILD_UUID));
      const child = result.sessions.find((s) => s.id === childSessionId);
      expect(child).toBeDefined();
      expect(child!.sessionEdges.find((e) => e.kind === "subagent_of")).toBeUndefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("the subagent manifest schema rejects records missing required lineage fields", () => {
    const decode = Schema.decodeUnknownEither(GrokSubagentManifest);
    expect(decode({ parent_session_id: "p", child_session_id: "c", subagent_type: "fab-explore-role" })._tag).toBe("Right");
    expect(decode({ child_session_id: "c", subagent_type: "fab-explore-role" })._tag).toBe("Left");
    expect(decode({ parent_session_id: "", child_session_id: "c", subagent_type: "fab-explore-role" })._tag).toBe("Left");
  });
});

// ===========================================================================
// QSR-220 FULL DATA FIDELITY — declarative signal/drop per record type
//
// Every distinct grok on-disk record type is asserted to classify to an EXPLICIT
// outcome: signal(mapped kind) or drop(named reason). ZERO records fall through
// to an `unknown` pass-through. Every fixture is built FROM the Effect schema via
// `Schema.encodeSync` (a typed constructor) so a schema change breaks the fixture
// at compile time. All identifiers are clearly-FABRICATED synthetic values that
// resolve to zero real on-disk data.
// ===========================================================================
describe("QSR-220 grok full data fidelity: declarative signal/drop dispatch", () => {
  // Typed constructor: encode a value THROUGH the schema (fail-closed at compile
  // time). The encoded JSON is then re-decoded by the classifier under test.
  const fromSchema = <A, I>(schema: Schema.Schema<A, I>, value: A): unknown =>
    Schema.encodeSync(schema)(value);

  // ---- chat_history.jsonl (6 record types) --------------------------------
  test("chat user -> signal(message)", () => {
    const d = classifyGrokChat(fromSchema(GrokChatUser, { type: "user", content: "synthetic user turn" }));
    expect(isSignal(d) && d.kind).toBe("message");
  });
  test("chat assistant -> signal(message)", () => {
    const d = classifyGrokChat(
      fromSchema(GrokChatAssistant, { type: "assistant", content: "synthetic assistant turn" }),
    );
    expect(isSignal(d) && d.kind).toBe("message");
  });
  test("chat tool_result -> signal(tool_result)", () => {
    const d = classifyGrokChat(
      fromSchema(GrokChatToolResult, { type: "tool_result", tool_call_id: "fab_call_zzz999", content: "synthetic output" }),
    );
    expect(isSignal(d) && d.kind).toBe("tool_result");
  });
  test("chat system -> signal(system)", () => {
    const d = classifyGrokChat(fromSchema(GrokChatSystem, { type: "system", content: "synthetic system" }));
    expect(isSignal(d) && d.kind).toBe("system");
  });
  test("chat backend_tool_call -> signal(tool_call)", () => {
    const d = classifyGrokChat(
      fromSchema(GrokChatBackendToolCall, {
        type: "backend_tool_call",
        kind: { tool_type: "web_search", id: "fab_call_zzz999", status: "completed" },
      }),
    );
    expect(isSignal(d) && d.kind).toBe("tool_call");
  });
  test("chat reasoning WITH plaintext summary -> signal(reasoning)", () => {
    const d = classifyGrokChat(
      fromSchema(GrokChatReasoning, {
        type: "reasoning",
        summary: [{ type: "summary_text", text: "synthetic plaintext summary" }],
      }),
    );
    expect(isSignal(d) && d.kind).toBe("reasoning");
  });
  test("chat reasoning ENCRYPTED-only -> drop(encrypted_reasoning)", () => {
    const d = classifyGrokChat(
      fromSchema(GrokChatReasoning, { type: "reasoning", encrypted_content: "ZmFic2ludGhldGlj" }),
    );
    expect(d._tag).toBe("drop");
    expect(d._tag === "drop" && d.reason).toBe("grok.drop.encrypted_reasoning");
  });

  // ---- events.jsonl (19 record types) -------------------------------------
  const signalEventCases: ReadonlyArray<readonly [string, unknown, string]> = [
    ["tool_started", fromSchema(GrokEvtToolStarted, { type: "tool_started", tool_name: "FabSyntheticTool" }), "tool_call"],
    ["tool_completed", fromSchema(GrokEvtToolCompleted, { type: "tool_completed", tool_name: "FabSyntheticTool", outcome: "success" }), "tool_result"],
    ["mcp_tool_call_started", fromSchema(GrokEvtMcpToolCallStarted, { type: "mcp_tool_call_started", server_name: "fab-server-zzz", tool_name: "fab-tool-zzz" }), "tool_call"],
    ["mcp_tool_call_completed", fromSchema(GrokEvtMcpToolCallCompleted, { type: "mcp_tool_call_completed", server_name: "fab-server-zzz", tool_name: "fab-tool-zzz", success: true }), "tool_result"],
    ["turn_started", fromSchema(GrokEvtTurnStarted, { type: "turn_started", turn_number: 0 }), "lifecycle"],
    ["turn_ended", fromSchema(GrokEvtTurnEnded, { type: "turn_ended", outcome: "completed" }), "lifecycle"],
  ];
  for (const [name, record, kind] of signalEventCases) {
    test(`event ${name} -> signal(${kind})`, () => {
      const d = classifyGrokEvent(record);
      expect(isSignal(d)).toBe(true);
      expect(isSignal(d) ? (d.kind as string) : undefined).toBe(kind);
    });
  }

  const dropEventCases: ReadonlyArray<readonly [string, unknown, string]> = [
    ["phase_changed", fromSchema(GrokEvtPhaseChanged, { type: "phase_changed", phase: "waiting_for_model" }), "grok.drop.ui_phase_telemetry"],
    ["first_token", fromSchema(GrokEvtFirstToken, { type: "first_token" }), "grok.drop.stream_timing_telemetry"],
    ["loop_started", fromSchema(GrokEvtLoopStarted, { type: "loop_started", loop_index: 0 }), "grok.drop.loop_timing_telemetry"],
    ["yolo_toggled", fromSchema(GrokEvtYoloToggled, { type: "yolo_toggled", enabled: true }), "grok.drop.ui_mode_toggle"],
    ["permission_requested", fromSchema(GrokEvtPermissionRequested, { type: "permission_requested", tool_name: "FabSyntheticTool" }), "grok.drop.permission_telemetry"],
    ["permission_resolved", fromSchema(GrokEvtPermissionResolved, { type: "permission_resolved", tool_name: "FabSyntheticTool", decision: "allow" }), "grok.drop.permission_telemetry"],
    ["mcp_server_starting", fromSchema(GrokEvtMcpServerStarting, { type: "mcp_server_starting", server_name: "fab-server-zzz" }), "grok.drop.mcp_lifecycle_telemetry"],
    ["mcp_server_failed", fromSchema(GrokEvtMcpServerFailed, { type: "mcp_server_failed", server_name: "fab-server-zzz", error_message: "synthetic failure" }), "grok.drop.mcp_lifecycle_telemetry"],
    ["mcp_server_connected", fromSchema(GrokEvtMcpServerConnected, { type: "mcp_server_connected", server_name: "fab-server-zzz", tool_count: 0 }), "grok.drop.mcp_lifecycle_telemetry"],
    ["mcp_managed_config_result", fromSchema(GrokEvtMcpManagedConfigResult, { type: "mcp_managed_config_result", server_count: 0 }), "grok.drop.mcp_config_telemetry"],
    ["mcp_config_resolved", fromSchema(GrokEvtMcpConfigResolved, { type: "mcp_config_resolved" }), "grok.drop.mcp_config_telemetry"],
    ["mcp_init_completed", fromSchema(GrokEvtMcpInitCompleted, { type: "mcp_init_completed", total_servers: 0 }), "grok.drop.mcp_config_telemetry"],
    ["mcp_oauth_discovery_timeout", fromSchema(GrokEvtMcpOauthDiscoveryTimeout, { type: "mcp_oauth_discovery_timeout", server_name: "fab-server-zzz" }), "grok.drop.mcp_oauth_telemetry"],
  ];
  for (const [name, record, reason] of dropEventCases) {
    test(`event ${name} -> drop(${reason})`, () => {
      const d = classifyGrokEvent(record);
      expect(d._tag).toBe("drop");
      expect(d._tag === "drop" && d.reason).toBe(reason);
    });
  }

  // ---- updates.jsonl (8 sessionUpdate subtypes) ---------------------------
  const XAI_SUBS = new Set([
    "retry_state",
    "task_backgrounded",
    "task_completed",
    "subagent_spawned",
    "subagent_finished",
    "auto_compact_started",
    "auto_compact_completed",
    "compaction_checkpoint",
  ]);
  const upd = <A, I>(schema: Schema.Schema<A, I>, sub: string, extra: Record<string, unknown> = {}) =>
    fromSchema(schema as Schema.Schema<any, any>, {
      method: XAI_SUBS.has(sub) ? "_x.ai/session/update" : "session/update",
      params: { update: { sessionUpdate: sub, ...extra } },
    });
  const signalUpdateCases: ReadonlyArray<readonly [string, unknown, string]> = [
    ["tool_call", upd(GrokUpdToolCall, "tool_call", { toolCallId: "fab_call_zzz999" }), "tool_call"],
    ["tool_call_update", upd(GrokUpdToolCallUpdate, "tool_call_update", { toolCallId: "fab_call_zzz999", kind: "read" }), "tool_result"],
    ["agent_thought_chunk", upd(GrokUpdAgentThoughtChunk, "agent_thought_chunk", { content: { type: "text", text: "synthetic thought" } }), "reasoning"],
    ["agent_message_chunk", upd(GrokUpdAgentMessageChunk, "agent_message_chunk", { content: { type: "text", text: "synthetic message" } }), "message"],
    ["user_message_chunk", upd(GrokUpdUserMessageChunk, "user_message_chunk", { content: { type: "text", text: "synthetic user chunk" } }), "message"],
    ["retry_state", upd(GrokUpdRetryState, "retry_state", { attempt: 1, max_retries: 3 }), "lifecycle"],
    ["task_backgrounded", upd(GrokUpdTaskBackgrounded, "task_backgrounded", { task_id: "fab-task-zzz" }), "lifecycle"],
    ["task_completed", upd(GrokUpdTaskCompleted, "task_completed", { task_snapshot: { id: "fab-task-zzz" } }), "lifecycle"],
    ["subagent_spawned", upd(GrokUpdSubagentSpawned, "subagent_spawned", { subagent_id: "fab-subagent-zzz", subagent_type: "fab-explore-role", child_session_id: "fab-child-zzz" }), "lifecycle"],
    ["subagent_finished", upd(GrokUpdSubagentFinished, "subagent_finished", { subagent_id: "fab-subagent-zzz", status: "completed" }), "lifecycle"],
    ["auto_compact_started", upd(GrokUpdAutoCompactStarted, "auto_compact_started", { reason: "synthetic", tokens_used: 1 }), "lifecycle"],
    ["auto_compact_completed", upd(GrokUpdAutoCompactCompleted, "auto_compact_completed", { tokens_before: 2, tokens_after: 1 }), "summary"],
    ["compaction_checkpoint", upd(GrokUpdCompactionCheckpoint, "compaction_checkpoint", { checkpoint_id: "fab-checkpoint-zzz" }), "lifecycle"],
    ["plan", upd(GrokUpdPlan, "plan", { entries: [] }), "message"],
  ];
  for (const [name, record, kind] of signalUpdateCases) {
    test(`update ${name} -> signal(${kind})`, () => {
      const d = classifyGrokUpdate(record);
      expect(isSignal(d)).toBe(true);
      expect(isSignal(d) ? (d.kind as string) : undefined).toBe(kind);
    });
  }
  const dropUpdateCases: ReadonlyArray<readonly [string, unknown, string]> = [
    ["available_commands_update", upd(GrokUpdAvailableCommands, "available_commands_update", { availableCommands: [] }), "grok.drop.command_palette_ui"],
    ["current_mode_update", upd(GrokUpdCurrentMode, "current_mode_update", { currentModeId: "plan" }), "grok.drop.ui_mode_toggle"],
  ];
  for (const [name, record, reason] of dropUpdateCases) {
    test(`update ${name} -> drop(${reason})`, () => {
      const d = classifyGrokUpdate(record);
      expect(d._tag).toBe("drop");
      expect(d._tag === "drop" && d.reason).toBe(reason);
    });
  }

  // ---- hunk_records.jsonl (3 record types) --------------------------------
  const hunkCases: ReadonlyArray<readonly [string, unknown]> = [
    ["added", fromSchema(GrokHunkAdded, { eventType: "added", hunkId: "fab-hunk-1", filePath: "/synthetic/file.ts" })],
    ["updated", fromSchema(GrokHunkUpdated, { eventType: "updated", hunkId: "fab-hunk-2", filePath: "/synthetic/file.ts" })],
    ["removed", fromSchema(GrokHunkRemoved, { eventType: "removed", hunkId: "fab-hunk-3", filePath: "/synthetic/file.ts" })],
  ];
  for (const [name, record] of hunkCases) {
    test(`hunk ${name} -> signal(edit)`, () => {
      const d = classifyGrokHunk(record);
      expect(isSignal(d) && d.kind).toBe("edit");
    });
  }

  // ---- zero unknown passthrough -------------------------------------------
  test("an unknown chat type is a NAMED drop, never an unknown passthrough", () => {
    const diags: DecodeDiagnostic[] = [];
    const d = classifyGrokChat({ type: "fab_brand_new_type", content: "x" }, diags);
    expect(d._tag).toBe("drop");
    expect(d._tag === "drop" && d.reason.startsWith(GROK_UNKNOWN_TYPE)).toBe(true);
    expect(diags.some((x) => x.name === GROK_UNKNOWN_TYPE)).toBe(true);
  });
  test("an unknown event type is a NAMED drop", () => {
    const diags: DecodeDiagnostic[] = [];
    const d = classifyGrokEvent({ type: "fab_unknown_event" }, diags);
    expect(d._tag === "drop" && d.reason.startsWith(GROK_UNKNOWN_TYPE)).toBe(true);
    expect(diags.some((x) => x.name === GROK_UNKNOWN_TYPE)).toBe(true);
  });
  test("an unknown update sessionUpdate is a NAMED drop", () => {
    const diags: DecodeDiagnostic[] = [];
    const d = classifyGrokUpdate(
      { method: "session/update", params: { update: { sessionUpdate: "fab_unknown_sub" } } },
      diags,
    );
    expect(d._tag === "drop" && d.reason.startsWith(GROK_UNKNOWN_TYPE)).toBe(true);
  });
  test("an unknown hunk eventType is a NAMED drop", () => {
    const diags: DecodeDiagnostic[] = [];
    const d = classifyGrokHunk({ eventType: "fab_unknown_hunk" }, diags);
    expect(d._tag === "drop" && d.reason.startsWith(GROK_UNKNOWN_TYPE)).toBe(true);
  });

  // ---- malformed-record fail-closed per major file ------------------------
  test("malformed chat record (assistant with non-array content for a string field) decodes fail-closed -> named diagnostic + drop, never throws", () => {
    const diags: DecodeDiagnostic[] = [];
    // tool_result missing required tool_call_id is provider garbage.
    const d = classifyGrokChat({ type: "tool_result", content: "x" }, diags);
    expect(d._tag).toBe("drop");
    expect(d._tag === "drop" && d.reason.startsWith(GROK_DECODE_FAILED)).toBe(true);
    expect(diags.some((x) => x.name === GROK_DECODE_FAILED)).toBe(true);
  });
  test("malformed event record (tool_started missing tool_name) -> named diagnostic + drop", () => {
    const diags: DecodeDiagnostic[] = [];
    const d = classifyGrokEvent({ type: "tool_started" }, diags);
    expect(d._tag === "drop" && d.reason.startsWith(GROK_DECODE_FAILED)).toBe(true);
    expect(diags.some((x) => x.name === GROK_DECODE_FAILED)).toBe(true);
  });
  test("malformed update record (wrong method literal) -> named diagnostic + drop", () => {
    const diags: DecodeDiagnostic[] = [];
    const d = classifyGrokUpdate(
      { method: "not/a/real/method", params: { update: { sessionUpdate: "tool_call" } } },
      diags,
    );
    expect(d._tag === "drop" && d.reason.startsWith(GROK_DECODE_FAILED)).toBe(true);
    expect(diags.some((x) => x.name === GROK_DECODE_FAILED)).toBe(true);
  });
  test("malformed hunk record (eventType not a known literal but present) -> NAMED drop", () => {
    const diags: DecodeDiagnostic[] = [];
    const d = classifyGrokHunk({ eventType: "added", hunkStart: "not-a-number" }, diags);
    expect(d._tag === "drop" && d.reason.startsWith(GROK_DECODE_FAILED)).toBe(true);
    expect(diags.some((x) => x.name === GROK_DECODE_FAILED)).toBe(true);
  });
});

// ===========================================================================
// QSR-220 — end-to-end: a full multi-file synthetic grok session yields the
// expected SIGNAL events, drops all telemetry, and surfaces a named diagnostic
// for a planted malformed record. ZERO `unknown`-kind events are emitted.
// ===========================================================================
describe("QSR-220 grok adapter end-to-end: signal kept, telemetry dropped, garbage named", () => {
  const SESSION_UUID = "01900000-0000-7000-8000-0000fab1ce11";
  const PROJECT_KEY = encodeURIComponent("/repo/fab-fidelity");

  test("full session: signal events kept, telemetry dropped, no unknown passthrough, malformed record named", async () => {
    const root = mkdtempSync(join(tmpdir(), "quasar-grok-e2e-"));
    try {
      const sessionDir = join(root, "sessions", PROJECT_KEY, SESSION_UUID);
      mkdirSync(sessionDir, { recursive: true });

      writeJsonLines(join(sessionDir, "chat_history.jsonl"), [
        { type: "user", content: "synthetic user prompt" },
        { type: "assistant", content: "synthetic assistant reply" },
        { type: "reasoning", encrypted_content: "ZmFic2ludGhldGlj" }, // dropped
        { type: "tool_result", tool_call_id: "fab_call_zzz999", content: "synthetic tool output" },
        { type: "fab_brand_new_type", content: "garbage-but-typed" }, // unknown -> named drop
      ]);
      writeJsonLines(join(sessionDir, "events.jsonl"), [
        { ts: NOW, type: "turn_started", session_id: SESSION_UUID, turn_number: 0 }, // signal(lifecycle)
        { ts: NOW, type: "phase_changed", phase: "waiting_for_model" }, // dropped
        { ts: NOW, type: "tool_started", tool_name: "FabSyntheticTool" }, // signal(tool_call)
        { ts: NOW, type: "tool_completed", tool_name: "FabSyntheticTool", outcome: "success" }, // signal(tool_result)
      ]);
      writeJsonLines(join(sessionDir, "updates.jsonl"), [
        { method: "session/update", params: { sessionId: SESSION_UUID, update: { sessionUpdate: "available_commands_update", availableCommands: [] } } }, // dropped
        { method: "session/update", params: { sessionId: SESSION_UUID, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "synthetic chunk" } } } }, // signal(message)
      ]);
      writeJsonLines(join(sessionDir, "hunk_records.jsonl"), [
        { eventType: "added", hunkId: "fab-hunk-1", filePath: "/synthetic/file.ts", linesAdded: 3 },
      ]);

      const result = await grokAdapter.read({ machine: MACHINE, now: NOW, roots: { grok: root } });
      expect(result.sessions).toHaveLength(1);
      const session = result.sessions[0]!;

      // ZERO unknown-kind events — full declarative coverage.
      expect(session.events.some((e) => e.kind === "unknown")).toBe(false);

      // Telemetry (phase_changed, available_commands_update, encrypted reasoning)
      // contributed NO events; the signal records did.
      const kinds = session.events.map((e) => e.kind).sort();
      expect(kinds).toContain("message");
      expect(kinds).toContain("tool_call");
      expect(kinds).toContain("tool_result");
      expect(kinds).toContain("lifecycle");
      // No phase_changed-derived event leaked in.
      expect(session.events.some((e) => e.rawReference !== undefined && JSON.stringify(e.rawReference).includes("phase_changed"))).toBe(false);

      // The artifact stream kept the one valid hunk.
      expect(session.artifacts).toHaveLength(1);
      expect(session.artifacts[0]!.kind).toBe("edit_hunk");

      // The unknown chat type surfaced a NAMED, fail-closed boundary diagnostic;
      // ingest still produced the session (available diagnostic present too).
      expect(result.diagnostics.some((d) => d.status === "error")).toBe(true);
      expect(result.diagnostics.some((d) => d.status === "available")).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// shouldReadFile stat-gate: an unchanged chat_history.jsonl is skipped
// before any sidecar reads.
// ---------------------------------------------------------------------------
describe("shouldReadFile stat-gate: unchanged chat_history.jsonl skipped without content read", () => {
  const GATE_SESSION_UUID = "01900000-0000-7000-8000-0000000000f1";
  const GATE_PROJECT_KEY = encodeURIComponent("/qsr/fab/grok-statgate");

  test("shouldReadFile returning false skips the session entirely — no session emitted", async () => {
    const root = mkdtempSync(join(tmpdir(), "quasar-grok-statgate-"));
    try {
      const sessionDir = join(root, "sessions", GATE_PROJECT_KEY, GATE_SESSION_UUID);
      mkdirSync(sessionDir, { recursive: true });
      const chatPath = join(sessionDir, "chat_history.jsonl");
      writeJsonLines(chatPath, [
        { type: "user", content: "gate test user message" },
        { type: "assistant", content: "gate test assistant reply" },
      ]);

      const checkedPaths: string[] = [];
      const result = await grokAdapter.read({
        machine: MACHINE,
        now: NOW,
        roots: { grok: root },
        shouldReadFile: (path, stat) => {
          checkedPaths.push(path);
          void stat;
          // Reject all files.
          return false;
        },
      });
      // Gate was consulted for the chat_history.jsonl.
      expect(checkedPaths.some((p) => p === chatPath)).toBe(true);
      // No session emitted — content was never read.
      expect(result.sessions).toHaveLength(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("shouldReadFile returning true lets the file through — session emitted", async () => {
    const root = mkdtempSync(join(tmpdir(), "quasar-grok-statgate2-"));
    try {
      const sessionDir = join(root, "sessions", GATE_PROJECT_KEY, GATE_SESSION_UUID);
      mkdirSync(sessionDir, { recursive: true });
      const chatPath = join(sessionDir, "chat_history.jsonl");
      writeJsonLines(chatPath, [
        { type: "user", content: "gate test user message" },
        { type: "assistant", content: "gate test assistant reply" },
      ]);
      const fileStat = statSync(chatPath);

      const result = await grokAdapter.read({
        machine: MACHINE,
        now: NOW,
        roots: { grok: root },
        shouldReadFile: (_path, stat) => stat.size === fileStat.size,
      });
      expect(result.sessions).toHaveLength(1);
      expect(result.sessions[0]!.provider).toBe("grok");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
