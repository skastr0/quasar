import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, test } from "bun:test";
import { Schema } from "effect";

import { kimiAdapter } from "../src/adapters/kimi";
import {
  classifyKimiRecord,
  KimiAppendLoopEvent,
  KimiAppendMessage,
  KimiApplyCompaction,
  KimiConfigUpdate,
  KimiFullCompactionBegin,
  KimiFullCompactionComplete,
  KimiGoalClear,
  KimiGoalCreate,
  KimiGoalUpdate,
  KimiMetadata,
  KimiMicroCompactionApply,
  KimiPermissionRecordApprovalResult,
  KimiPermissionSetMode,
  KimiPlanModeEnter,
  KimiPlanModeExit,
  KimiSwarmModeEnter,
  KimiSwarmModeExit,
  KimiToolsSetActiveTools,
  KimiToolsUpdateStore,
  KimiTurnCancel,
  KimiTurnPrompt,
  KimiTurnSteer,
  KimiUsageRecord,
  KimiWireRecordSchema,
  type KimiWireRecord,
} from "../src/adapters/kimi-schema";

// ---------------------------------------------------------------------------
// Schema-driven fixture constructors (QSR-220 FULL DATA FIDELITY).
//
// Every fixture record below is built FROM its Effect schema via
// `Schema.encodeSync(<Schema>)(<typed value>)`. The typed value is checked
// against the schema's `Type` at compile time and the encode is checked at
// runtime, so renaming or removing a schema field BREAKS the fixture (compile or
// encode error) — fixtures cannot drift away from the modeled format. All
// identifiers/content are SYNTHETIC, prefixed `ZZTEST` / `session_synthetic` /
// `agent-zz`, verified to resolve to ZERO real on-disk data.
// ---------------------------------------------------------------------------

/** Build an on-disk JSON record from a per-type schema + a typed value. */
const fromSchema = <A, I>(schema: Schema.Schema<A, I>, value: A): I =>
  Schema.encodeSync(schema)(value);

const MACHINE = {
  machineId: "machine:test",
  hostname: "test-host",
  platform: "darwin",
};

const NOW = "2026-06-01T00:00:00.000Z";

// Root for all tests — cleaned up once at the end.
const testRoot = mkdtempSync(join(tmpdir(), "quasar-kimi-test-"));

afterAll(() => {
  rmSync(testRoot, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

/** Write a JSONL file where each line is a JSON-serialised object. */
const writeJsonLines = (path: string, records: unknown[]) =>
  writeFileSync(path, records.map((r) => JSON.stringify(r)).join("\n") + "\n", "utf8");

/** Write a pretty-printed JSON file. */
const writeJson = (path: string, data: unknown) =>
  writeFileSync(path, JSON.stringify(data, null, 2), "utf8");

// ---------------------------------------------------------------------------
// AC#5 — idempotency proof (content-id provider, sessionId from session_index)
//
// Kimi native id = the `sessionId` field in session_index.jsonl.  The same
// value at two DIFFERENT root paths (different mounts, different machines)
// must produce byte-identical canonical session.id values.  The sessionDir
// paths differ between the two roots but the `sessionId` string is the same.
// ---------------------------------------------------------------------------
describe("AC#5 idempotency: same sessionId value at different root paths → byte-identical session.id", () => {
  // Two independent roots — host vs Docker /history mount.
  const hostRoot = mkdtempSync(join(tmpdir(), "quasar-kimi-host-"));
  const dockerRoot = mkdtempSync(join(tmpdir(), "quasar-kimi-docker-"));

  afterAll(() => {
    rmSync(hostRoot, { recursive: true, force: true });
    rmSync(dockerRoot, { recursive: true, force: true });
  });

  // The native id — same across both roots.
  const NATIVE_SESSION_ID = "session_test0001";

  // Build minimal session content under each root.
  const buildRoot = (root: string) => {
    const sessionsDir = join(root, "sessions");
    const sessionDir = join(sessionsDir, "wd_proj_idem", NATIVE_SESSION_ID);
    const agentDir = join(sessionDir, "agents", "main");
    mkdirSync(agentDir, { recursive: true });

    writeJson(join(sessionDir, "state.json"), {
      createdAt: "2026-06-21T10:00:00.000Z",
      updatedAt: "2026-06-21T10:01:00.000Z",
      title: "Idempotency session",
      isCustomTitle: true,
      agents: { main: { homedir: agentDir, type: "main", parentAgentId: null } },
      custom: {},
    });

    writeJsonLines(join(agentDir, "wire.jsonl"), [
      {
        type: "context.append_message",
        message: { role: "user", content: [{ type: "text", text: "idempotency check" }] },
        origin: { kind: "user" },
        time: 1000,
      },
    ]);

    // session_index.jsonl — the `sessionId` field is the native id;
    // the `sessionDir` is a per-root absolute path so the two roots differ.
    writeJsonLines(join(root, "session_index.jsonl"), [
      {
        sessionId: NATIVE_SESSION_ID,
        sessionDir: sessionDir,
        workDir: "/home/user/projects/myapp",
      },
    ]);
  };

  buildRoot(hostRoot);
  buildRoot(dockerRoot);

  test("host and docker reads produce byte-identical session.id", async () => {
    const hostResult = await kimiAdapter.read({
      machine: MACHINE,
      now: NOW,
      roots: { kimi: hostRoot },
    });
    const dockerResult = await kimiAdapter.read({
      machine: MACHINE,
      now: NOW,
      roots: { kimi: dockerRoot },
    });

    expect(hostResult.sessions).toHaveLength(1);
    expect(dockerResult.sessions).toHaveLength(1);
    // Canonical session.id is derived from the `sessionId` field in the index,
    // not from the directory path — must be byte-identical across roots.
    expect(hostResult.sessions[0]!.id).toBe(dockerResult.sessions[0]!.id);
    // The sourcePaths differ (different root → different sessionDir in index).
    expect(hostResult.sessions[0]!.sourcePath).not.toBe(dockerResult.sessions[0]!.sourcePath);
  });
});

// ---------------------------------------------------------------------------
// T1: basic single-agent session with user, assistant, reasoning, tool call/result
// ---------------------------------------------------------------------------
describe("T1: single-agent session — user, assistant, reasoning, tool events", () => {
  const root = join(testRoot, "t1");
  const sessionsDir = join(root, "sessions");
  const sessionDir = join(sessionsDir, "wd_proj_aabb1122", "session_test0002");
  const agentDir = join(sessionDir, "agents", "main");

  mkdirSync(agentDir, { recursive: true });

  // state.json
  writeJson(join(sessionDir, "state.json"), {
    createdAt: "2026-05-01T10:00:00.000Z",
    updatedAt: "2026-05-01T11:00:00.000Z",
    title: "My custom title",
    isCustomTitle: true,
    agents: {
      main: {
        homedir: agentDir,
        type: "main",
        parentAgentId: null,
      },
    },
    custom: {},
  });

  // session_index.jsonl
  writeJsonLines(join(root, "session_index.jsonl"), [
    {
      sessionId: "session_test0002",
      sessionDir: sessionDir,
      workDir: "/home/user/projects/myapp",
    },
  ]);

  // agents/main/wire.jsonl
  writeJsonLines(join(agentDir, "wire.jsonl"), [
    // User message
    {
      type: "context.append_message",
      message: {
        role: "user",
        content: [{ type: "text", text: "Hello, please list the files." }],
      },
      origin: { kind: "user" },
      time: 1000,
    },
    // Reasoning (think)
    {
      type: "context.append_loop_event",
      event: {
        type: "content.part",
        part: { type: "think", think: "I should use the Bash tool to list files." },
      },
      time: 2000,
    },
    // Assistant text
    {
      type: "context.append_loop_event",
      event: {
        type: "content.part",
        part: { type: "text", text: "Sure, let me list the files for you." },
      },
      time: 3000,
    },
    // Tool call
    {
      type: "context.append_loop_event",
      event: {
        type: "tool.call",
        toolCallId: "tc-001",
        name: "Bash",
        args: { command: "ls -la" },
      },
      time: 4000,
    },
    // Tool result
    {
      type: "context.append_loop_event",
      event: {
        type: "tool.result",
        toolCallId: "tc-001",
        result: { output: "file1.txt\nfile2.txt" },
      },
      time: 5000,
    },
  ]);

  test("discovers 1 session", async () => {
    const result = await kimiAdapter.read({
      machine: MACHINE,
      now: NOW,
      roots: { kimi: root },
    });
    expect(result.sessions).toHaveLength(1);
  });

  test("session has correct provider and agentName", async () => {
    const result = await kimiAdapter.read({
      machine: MACHINE,
      now: NOW,
      roots: { kimi: root },
    });
    const session = result.sessions[0]!;
    expect(session.provider).toBe("kimi");
    expect(session.agentName).toBe("kimi-code");
  });

  test("session has custom title from state.json", async () => {
    const result = await kimiAdapter.read({
      machine: MACHINE,
      now: NOW,
      roots: { kimi: root },
    });
    const session = result.sessions[0]!;
    expect(session.title).toBe("My custom title");
  });

  test("user message event present", async () => {
    const result = await kimiAdapter.read({
      machine: MACHINE,
      now: NOW,
      roots: { kimi: root },
    });
    const session = result.sessions[0]!;
    const userEvents = session.events.filter((e) => e.role === "user" && e.kind === "message");
    expect(userEvents).toHaveLength(1);
    expect(userEvents[0]!.contentText).toContain("Hello");
  });

  test("assistant text event present", async () => {
    const result = await kimiAdapter.read({
      machine: MACHINE,
      now: NOW,
      roots: { kimi: root },
    });
    const session = result.sessions[0]!;
    const assistantEvents = session.events.filter(
      (e) => e.role === "assistant" && e.kind === "message",
    );
    expect(assistantEvents.length).toBeGreaterThanOrEqual(1);
    expect(assistantEvents[0]!.contentText).toContain("list the files");
  });

  test("reasoning event present with thinking role", async () => {
    const result = await kimiAdapter.read({
      machine: MACHINE,
      now: NOW,
      roots: { kimi: root },
    });
    const session = result.sessions[0]!;
    const thinkEvents = session.events.filter(
      (e) => e.role === "thinking" && e.kind === "reasoning",
    );
    expect(thinkEvents).toHaveLength(1);
    expect(thinkEvents[0]!.contentText).toContain("Bash tool");
  });

  test("tool call event present and linked to a ToolCall record", async () => {
    const result = await kimiAdapter.read({
      machine: MACHINE,
      now: NOW,
      roots: { kimi: root },
    });
    const session = result.sessions[0]!;
    const toolCallEvents = session.events.filter((e) => e.kind === "tool_call");
    expect(toolCallEvents).toHaveLength(1);
    expect(toolCallEvents[0]!.toolCallId).toBeDefined();

    const toolCallId = toolCallEvents[0]!.toolCallId!;
    const toolCall = session.toolCalls.find((tc) => tc.id === toolCallId);
    expect(toolCall).toBeDefined();
    expect(toolCall!.toolName).toBe("Bash");
  });

  test("tool result event linked to same ToolCall record with completed status", async () => {
    const result = await kimiAdapter.read({
      machine: MACHINE,
      now: NOW,
      roots: { kimi: root },
    });
    const session = result.sessions[0]!;
    const toolResultEvents = session.events.filter((e) => e.kind === "tool_result");
    expect(toolResultEvents).toHaveLength(1);

    const toolCallId = toolResultEvents[0]!.toolCallId!;
    const toolCall = session.toolCalls.find((tc) => tc.id === toolCallId);
    expect(toolCall).toBeDefined();
    expect(toolCall!.status).toBe("completed");
  });
});

// ---------------------------------------------------------------------------
// T2 (QSR-220): multi-agent session UN-MERGED into first-class sessions.
//
// A session dir with main + agent-0 + agent-1 must yield THREE first-class
// sessions: the main agent (parentSessionId undefined) and each sub-agent
// (parentSessionId === the main session's canonical id, agentName set). The
// sub-agent canonical ids are derived from the COMPOUND native id
// `${sessionId}/${agentId}`, so each sub is independently addressable. Events
// are NOT merged across agents any more — each agent reads only its own wire.
// ---------------------------------------------------------------------------
describe("T2 (QSR-220): subagents become first-class sessions with lineage", () => {
  const root = join(testRoot, "t2");
  const sessionsDir = join(root, "sessions");
  const NATIVE_SESSION_ID = "session_test0003";
  const sessionDir = join(sessionsDir, "wd_proj_ccdd3344", NATIVE_SESSION_ID);
  const mainDir = join(sessionDir, "agents", "main");
  const agent0Dir = join(sessionDir, "agents", "agent-0");
  const agent1Dir = join(sessionDir, "agents", "agent-1");

  mkdirSync(mainDir, { recursive: true });
  mkdirSync(agent0Dir, { recursive: true });
  mkdirSync(agent1Dir, { recursive: true });

  writeJson(join(sessionDir, "state.json"), {
    createdAt: "2026-05-02T08:00:00.000Z",
    updatedAt: "2026-05-02T09:00:00.000Z",
    title: "Multi-agent session",
    isCustomTitle: false,
    agents: {
      main: { homedir: mainDir, type: "main", parentAgentId: null },
      "agent-0": { homedir: agent0Dir, type: "sub", parentAgentId: "main" },
      "agent-1": { homedir: agent1Dir, type: "sub", parentAgentId: "main" },
    },
    custom: {},
  });

  writeJsonLines(join(root, "session_index.jsonl"), [
    {
      sessionId: NATIVE_SESSION_ID,
      sessionDir: sessionDir,
      workDir: "/home/user/projects/other",
    },
  ]);

  writeJsonLines(join(mainDir, "wire.jsonl"), [
    {
      type: "context.append_message",
      message: { role: "user", content: [{ type: "text", text: "main user message" }] },
      origin: { kind: "user" },
      time: 100,
    },
    {
      type: "context.append_loop_event",
      event: { type: "content.part", part: { type: "text", text: "main assistant reply" } },
      time: 300,
    },
  ]);

  writeJsonLines(join(agent0Dir, "wire.jsonl"), [
    {
      type: "context.append_loop_event",
      event: { type: "content.part", part: { type: "text", text: "agent-0 result" } },
      time: 200,
    },
  ]);

  writeJsonLines(join(agent1Dir, "wire.jsonl"), [
    {
      type: "context.append_loop_event",
      event: { type: "content.part", part: { type: "text", text: "agent-1 result" } },
      time: 250,
    },
  ]);

  const read = () =>
    kimiAdapter.read({ machine: MACHINE, now: NOW, roots: { kimi: root } });

  // Replicate mapSession's projection: parentSessionId is the fromId of the
  // canonical `subagent_of` edge (never any other edge kind).
  const parentSessionIdOf = (session: { sessionEdges: readonly { kind: string; fromId?: string }[] }) =>
    session.sessionEdges.find((e) => e.kind === "subagent_of")?.fromId;

  test("yields 3 first-class sessions (main + agent-0 + agent-1)", async () => {
    const result = await read();
    expect(result.sessions).toHaveLength(3);
  });

  test("main session keyed by the unchanged native id, no parent lineage", async () => {
    const result = await read();
    const main = result.sessions.find((s) => s.nativeSessionId === NATIVE_SESSION_ID)!;
    expect(main).toBeDefined();
    expect(main.agentName).toBe("kimi-code");
    expect(parentSessionIdOf(main)).toBeUndefined();
  });

  test("agent-0 and agent-1 are first-class sessions keyed by compound native id", async () => {
    const result = await read();
    const agent0 = result.sessions.find(
      (s) => s.nativeSessionId === `${NATIVE_SESSION_ID}/agent-0`,
    );
    const agent1 = result.sessions.find(
      (s) => s.nativeSessionId === `${NATIVE_SESSION_ID}/agent-1`,
    );
    expect(agent0).toBeDefined();
    expect(agent1).toBeDefined();
    // Each sub-agent session has its own distinct canonical id.
    expect(agent0!.id).not.toBe(agent1!.id);
  });

  test("each sub-agent's parentSessionId === the main session's canonical id", async () => {
    const result = await read();
    const main = result.sessions.find((s) => s.nativeSessionId === NATIVE_SESSION_ID)!;
    const agent0 = result.sessions.find(
      (s) => s.nativeSessionId === `${NATIVE_SESSION_ID}/agent-0`,
    )!;
    const agent1 = result.sessions.find(
      (s) => s.nativeSessionId === `${NATIVE_SESSION_ID}/agent-1`,
    )!;
    expect(parentSessionIdOf(agent0)).toBe(main.id);
    expect(parentSessionIdOf(agent1)).toBe(main.id);
  });

  test("each sub-agent has agentName set and distinct from main", async () => {
    const result = await read();
    const agent0 = result.sessions.find(
      (s) => s.nativeSessionId === `${NATIVE_SESSION_ID}/agent-0`,
    )!;
    const agent1 = result.sessions.find(
      (s) => s.nativeSessionId === `${NATIVE_SESSION_ID}/agent-1`,
    )!;
    expect(agent0.agentName.length).toBeGreaterThan(0);
    expect(agent1.agentName.length).toBeGreaterThan(0);
    expect(agent0.agentName).not.toBe("kimi-code");
    expect(agent0.agentName).not.toBe(agent1.agentName);
  });

  test("each agent reads only its own wire (no cross-agent event bleed)", async () => {
    const result = await read();
    const agent0 = result.sessions.find(
      (s) => s.nativeSessionId === `${NATIVE_SESSION_ID}/agent-0`,
    )!;
    const texts = agent0.events.flatMap((e) =>
      e.contentText !== undefined ? [e.contentText] : [],
    );
    expect(texts.some((t) => t.includes("agent-0 result"))).toBe(true);
    expect(texts.some((t) => t.includes("main user message"))).toBe(false);
    expect(texts.some((t) => t.includes("agent-1 result"))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// T3: missing root → ONE no_data_found diagnostic
// ---------------------------------------------------------------------------
describe("T3: missing root", () => {
  test("yields no sessions and emits a no_data_found diagnostic", async () => {
    const result = await kimiAdapter.read({
      machine: MACHINE,
      now: NOW,
      roots: { kimi: join(testRoot, "nonexistent") },
    });
    expect(result.sessions).toHaveLength(0);
    const noData = result.diagnostics.filter((d) => d.status === "no_data_found");
    expect(noData).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// T4: stub session (4 events, no messages) → valid session, zero messages, no error
// ---------------------------------------------------------------------------
describe("T4: stub session — empty content, valid session", () => {
  const root = join(testRoot, "t4");
  const sessionsDir = join(root, "sessions");
  const sessionDir = join(sessionsDir, "wd_quasar_stub", "session_test0004");
  const agentDir = join(sessionDir, "agents", "main");

  mkdirSync(agentDir, { recursive: true });

  writeJson(join(sessionDir, "state.json"), {
    createdAt: "2026-05-03T08:00:00.000Z",
    updatedAt: "2026-05-03T08:00:00.000Z",
    title: "New Session",
    isCustomTitle: false,
    agents: { main: { homedir: agentDir, type: "main", parentAgentId: null } },
    custom: {},
  });

  writeJsonLines(join(root, "session_index.jsonl"), [
    { sessionId: "session_test0004", sessionDir: sessionDir, workDir: "/home/user/empty" },
  ]);

  // wire.jsonl with only lifecycle/metadata events (no user or assistant content)
  writeJsonLines(join(agentDir, "wire.jsonl"), [
    { type: "metadata", protocol_version: "1.4", created_at: 1781000000000, app_version: "0.14.0" },
    { type: "config.update", profileName: "agent", time: 1781000001000 },
    { type: "tools.set_active_tools", names: ["Read", "Write"], time: 1781000002000 },
    { type: "permission.set_mode", mode: "auto", time: 1781000003000 },
  ]);

  test("yields 1 session with zero message events and no error", async () => {
    const result = await kimiAdapter.read({
      machine: MACHINE,
      now: NOW,
      roots: { kimi: root },
    });
    expect(result.sessions).toHaveLength(1);
    const session = result.sessions[0]!;
    const msgEvents = session.events.filter((e) => e.kind === "message");
    expect(msgEvents).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// T5: shouldParseSession gate skips already-seen sessions
// ---------------------------------------------------------------------------
describe("T5: shouldParseSession gate", () => {
  const root = join(testRoot, "t5");
  const sessionsDir = join(root, "sessions");
  const sessionDir = join(sessionsDir, "wd_proj_gate", "session_test0005");
  const agentDir = join(sessionDir, "agents", "main");

  mkdirSync(agentDir, { recursive: true });

  writeJson(join(sessionDir, "state.json"), {
    createdAt: "2026-05-04T08:00:00.000Z",
    updatedAt: "2026-05-04T08:00:00.000Z",
    title: "Gate Session",
    isCustomTitle: true,
    agents: { main: { homedir: agentDir, type: "main", parentAgentId: null } },
    custom: {},
  });

  writeJsonLines(join(root, "session_index.jsonl"), [
    { sessionId: "session_test0005", sessionDir: sessionDir, workDir: "/home/user/gate" },
  ]);

  writeJsonLines(join(agentDir, "wire.jsonl"), [
    {
      type: "context.append_message",
      message: { role: "user", content: [{ type: "text", text: "hello gate" }] },
      origin: { kind: "user" },
      time: 1000,
    },
  ]);

  test("when shouldParseSession returns false, session is skipped", async () => {
    const result = await kimiAdapter.read({
      machine: MACHINE,
      now: NOW,
      roots: { kimi: root },
      shouldParseSession: () => false,
    });
    expect(result.sessions).toHaveLength(0);
  });

  test("when shouldParseSession returns true, session is parsed", async () => {
    const result = await kimiAdapter.read({
      machine: MACHINE,
      now: NOW,
      roots: { kimi: root },
      shouldParseSession: () => true,
    });
    expect(result.sessions).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// T6 (QSR-220): wire records are decoded fail-closed.
//
// A structurally-invalid wire record (valid JSON, wrong shape: no string
// `type`) must become a NAMED diagnostic (kimi.wire.decode_failed) and be
// dropped — it must NOT throw (the rest of the wire keeps importing) and must
// NOT silently coerce into a half-event.
// ---------------------------------------------------------------------------
describe("T6 (QSR-220): malformed wire record → named diagnostic + dropped, valid records survive", () => {
  const root = join(testRoot, "t6");
  const sessionsDir = join(root, "sessions");
  const sessionDir = join(sessionsDir, "wd_proj_decode", "session_test0006");
  const agentDir = join(sessionDir, "agents", "main");

  mkdirSync(agentDir, { recursive: true });

  writeJson(join(sessionDir, "state.json"), {
    createdAt: "2026-05-05T08:00:00.000Z",
    updatedAt: "2026-05-05T08:00:00.000Z",
    title: "Decode Session",
    isCustomTitle: true,
    agents: { main: { homedir: agentDir, type: "main", parentAgentId: null } },
    custom: {},
  });

  writeJsonLines(join(root, "session_index.jsonl"), [
    { sessionId: "session_test0006", sessionDir: sessionDir, workDir: "/home/user/decode" },
  ]);

  // Line 1: valid. Line 2: valid JSON but missing the load-bearing string `type`
  // (fails the boundary schema). Line 3: `type` present but not a string. Line 4:
  // valid again — must survive the drops on lines 2 and 3.
  writeJsonLines(join(agentDir, "wire.jsonl"), [
    {
      type: "context.append_message",
      message: { role: "user", content: [{ type: "text", text: "before the garbage" }] },
      origin: { kind: "user" },
      time: 1000,
    },
    { notAType: "garbage", time: 2000 },
    { type: 42, time: 3000 },
    {
      type: "context.append_loop_event",
      event: { type: "content.part", part: { type: "text", text: "after the garbage" } },
      time: 4000,
    },
  ]);

  const read = () =>
    kimiAdapter.read({ machine: MACHINE, now: NOW, roots: { kimi: root } });

  test("emits a named kimi.wire.decode_failed diagnostic", async () => {
    const result = await read();
    const decodeDiag = result.diagnostics.filter((d) =>
      (d.message ?? "").includes("kimi.wire.decode_failed"),
    );
    expect(decodeDiag.length).toBeGreaterThanOrEqual(1);
  });

  test("valid records survive the dropped garbage", async () => {
    const result = await read();
    expect(result.sessions).toHaveLength(1);
    const session = result.sessions[0]!;
    const texts = session.events.flatMap((e) =>
      e.contentText !== undefined ? [e.contentText] : [],
    );
    expect(texts.some((t) => t.includes("before the garbage"))).toBe(true);
    expect(texts.some((t) => t.includes("after the garbage"))).toBe(true);
  });

  test("the malformed records do not become events", async () => {
    const result = await read();
    const session = result.sessions[0]!;
    // 2 valid wire lines → 2 events; the 2 garbage lines are dropped.
    expect(session.events).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// T7 (QSR-220 review FIX B): an agents/<id>/wire.jsonl present ON DISK but
// ABSENT from state.json.agents is a provider surprise. It must NOT silently
// vanish (boundary doctrine): a NAMED diagnostic (kimi.agent.undeclared_wire)
// fires AND the orphan content is ingested as its own first-class session
// attributed to main — never dropped.
// ---------------------------------------------------------------------------
describe("T7 (QSR-220 FIX B): undeclared on-disk wire → named diagnostic + ingested orphan", () => {
  const root = join(testRoot, "t7");
  const sessionsDir = join(root, "sessions");
  const NATIVE_SESSION_ID = "session_test0007";
  const sessionDir = join(sessionsDir, "wd_proj_orphan", NATIVE_SESSION_ID);
  const mainDir = join(sessionDir, "agents", "main");
  // agent-7 exists ONLY on disk — it is NOT in state.json.agents.
  const orphanDir = join(sessionDir, "agents", "agent-7");

  mkdirSync(mainDir, { recursive: true });
  mkdirSync(orphanDir, { recursive: true });

  writeJson(join(sessionDir, "state.json"), {
    createdAt: "2026-05-06T08:00:00.000Z",
    updatedAt: "2026-05-06T09:00:00.000Z",
    title: "Orphan wire session",
    isCustomTitle: true,
    // Only main is declared — agent-7 is deliberately omitted.
    agents: { main: { homedir: mainDir, type: "main", parentAgentId: null } },
    custom: {},
  });

  writeJsonLines(join(root, "session_index.jsonl"), [
    { sessionId: NATIVE_SESSION_ID, sessionDir: sessionDir, workDir: "/home/user/orphan" },
  ]);

  writeJsonLines(join(mainDir, "wire.jsonl"), [
    {
      type: "context.append_message",
      message: { role: "user", content: [{ type: "text", text: "main orphan-parent message" }] },
      origin: { kind: "user" },
      time: 100,
    },
  ]);

  // The undeclared agent carries real transcript content that must survive.
  writeJsonLines(join(orphanDir, "wire.jsonl"), [
    {
      type: "context.append_loop_event",
      event: { type: "content.part", part: { type: "text", text: "orphan agent-7 content" } },
      time: 200,
    },
  ]);

  const read = () =>
    kimiAdapter.read({ machine: MACHINE, now: NOW, roots: { kimi: root } });

  const parentSessionIdOf = (session: { sessionEdges: readonly { kind: string; fromId?: string }[] }) =>
    session.sessionEdges.find((e) => e.kind === "subagent_of")?.fromId;

  test("emits a named kimi.agent.undeclared_wire diagnostic", async () => {
    const result = await read();
    const undeclared = result.diagnostics.filter((d) =>
      (d.message ?? "").includes("kimi.agent.undeclared_wire"),
    );
    expect(undeclared.length).toBeGreaterThanOrEqual(1);
  });

  test("the orphan content is ingested as its own session, not lost", async () => {
    const result = await read();
    // main + orphan agent-7 → 2 sessions.
    expect(result.sessions).toHaveLength(2);
    const orphan = result.sessions.find(
      (s) => s.nativeSessionId === `${NATIVE_SESSION_ID}/agent-7`,
    )!;
    expect(orphan).toBeDefined();
    const texts = orphan.events.flatMap((e) =>
      e.contentText !== undefined ? [e.contentText] : [],
    );
    expect(texts.some((t) => t.includes("orphan agent-7 content"))).toBe(true);
  });

  test("the orphan is attributed to main as its parent", async () => {
    const result = await read();
    const main = result.sessions.find((s) => s.nativeSessionId === NATIVE_SESSION_ID)!;
    const orphan = result.sessions.find(
      (s) => s.nativeSessionId === `${NATIVE_SESSION_ID}/agent-7`,
    )!;
    expect(parentSessionIdOf(orphan)).toBe(main.id);
  });
});

// ---------------------------------------------------------------------------
// T8 (QSR-220 review FIX C): a sub-agent spawned by ANOTHER sub-agent must link
// to that sub's own compound canonical id — NOT flattened onto main. The edge
// fromId honours agent.parentAgentId.
// ---------------------------------------------------------------------------
describe("T8 (QSR-220 FIX C): nested parentAgentId links to the real parent sub, not main", () => {
  const root = join(testRoot, "t8");
  const sessionsDir = join(root, "sessions");
  const NATIVE_SESSION_ID = "session_test0008";
  const sessionDir = join(sessionsDir, "wd_proj_nested", NATIVE_SESSION_ID);
  const mainDir = join(sessionDir, "agents", "main");
  const agentADir = join(sessionDir, "agents", "agent-a");
  const agentBDir = join(sessionDir, "agents", "agent-b");

  mkdirSync(mainDir, { recursive: true });
  mkdirSync(agentADir, { recursive: true });
  mkdirSync(agentBDir, { recursive: true });

  writeJson(join(sessionDir, "state.json"), {
    createdAt: "2026-05-07T08:00:00.000Z",
    updatedAt: "2026-05-07T09:00:00.000Z",
    title: "Nested lineage session",
    isCustomTitle: false,
    agents: {
      main: { homedir: mainDir, type: "main", parentAgentId: null },
      // agent-a spawned by main.
      "agent-a": { homedir: agentADir, type: "sub", parentAgentId: "main" },
      // agent-b spawned by agent-a (a sub spawning a sub).
      "agent-b": { homedir: agentBDir, type: "sub", parentAgentId: "agent-a" },
    },
    custom: {},
  });

  writeJsonLines(join(root, "session_index.jsonl"), [
    { sessionId: NATIVE_SESSION_ID, sessionDir: sessionDir, workDir: "/home/user/nested" },
  ]);

  writeJsonLines(join(mainDir, "wire.jsonl"), [
    {
      type: "context.append_message",
      message: { role: "user", content: [{ type: "text", text: "main message" }] },
      origin: { kind: "user" },
      time: 100,
    },
  ]);
  writeJsonLines(join(agentADir, "wire.jsonl"), [
    {
      type: "context.append_loop_event",
      event: { type: "content.part", part: { type: "text", text: "agent-a result" } },
      time: 200,
    },
  ]);
  writeJsonLines(join(agentBDir, "wire.jsonl"), [
    {
      type: "context.append_loop_event",
      event: { type: "content.part", part: { type: "text", text: "agent-b result" } },
      time: 300,
    },
  ]);

  const read = () =>
    kimiAdapter.read({ machine: MACHINE, now: NOW, roots: { kimi: root } });

  const parentSessionIdOf = (session: { sessionEdges: readonly { kind: string; fromId?: string }[] }) =>
    session.sessionEdges.find((e) => e.kind === "subagent_of")?.fromId;

  test("agent-a (spawned by main) links to the main session", async () => {
    const result = await read();
    const main = result.sessions.find((s) => s.nativeSessionId === NATIVE_SESSION_ID)!;
    const agentA = result.sessions.find(
      (s) => s.nativeSessionId === `${NATIVE_SESSION_ID}/agent-a`,
    )!;
    expect(parentSessionIdOf(agentA)).toBe(main.id);
  });

  test("agent-b (spawned by agent-a) links to agent-a, NOT main", async () => {
    const result = await read();
    const main = result.sessions.find((s) => s.nativeSessionId === NATIVE_SESSION_ID)!;
    const agentA = result.sessions.find(
      (s) => s.nativeSessionId === `${NATIVE_SESSION_ID}/agent-a`,
    )!;
    const agentB = result.sessions.find(
      (s) => s.nativeSessionId === `${NATIVE_SESSION_ID}/agent-b`,
    )!;
    expect(parentSessionIdOf(agentB)).toBe(agentA.id);
    expect(parentSessionIdOf(agentB)).not.toBe(main.id);
  });
});

// ===========================================================================
// T9 (QSR-220 FULL DATA FIDELITY): declarative signal/drop dispatch — ONE case
// per modeled record type. Each fixture is built FROM its Effect schema, then
// classified through `classifyKimiRecord`. The expected verdict is the
// authoritative per-type signal(kind)/drop(reason). There is NO unknown
// pass-through: every record type appears here with an explicit verdict.
// ===========================================================================
describe("T9 (QSR-220): per-record-type signal/drop classification", () => {
  type Verdict =
    | { signal: string }
    | { drop: string };

  // The full inventory: 23 outer types + the inner loop-event kinds
  // (content.part text|think, tool.call, tool.result, step.begin, step.end) +
  // content.part fallback = 30 distinct record-type cases. Each is a
  // schema-built fixture paired with its authoritative verdict.
  const cases: ReadonlyArray<readonly [string, KimiWireRecord, Verdict]> = [
    // --- context.append_message: origin decides user vs preamble ---
    [
      "append_message origin=user",
      fromSchema(KimiAppendMessage, {
        type: "context.append_message",
        time: 1000,
        message: {
          role: "user",
          content: [{ type: "text", text: "ZZTEST_USER_PROMPT" }],
          origin: { kind: "user" },
        },
      }) as KimiWireRecord,
      { signal: "message.user" },
    ],
    [
      "append_message origin=injection",
      fromSchema(KimiAppendMessage, {
        type: "context.append_message",
        time: 1001,
        message: {
          role: "user",
          content: [{ type: "text", text: "ZZTEST_INJECTION" }],
          origin: { kind: "injection" },
        },
      }) as KimiWireRecord,
      { signal: "message.preamble" },
    ],
    [
      "append_message origin=system_trigger",
      fromSchema(KimiAppendMessage, {
        type: "context.append_message",
        time: 1002,
        message: {
          role: "user",
          content: [{ type: "text", text: "ZZTEST_SYSTRIGGER" }],
          origin: { kind: "system_trigger" },
        },
      }) as KimiWireRecord,
      { signal: "message.preamble" },
    ],
    [
      "append_message origin=skill_activation",
      fromSchema(KimiAppendMessage, {
        type: "context.append_message",
        time: 1003,
        message: {
          role: "user",
          content: [{ type: "text", text: "ZZTEST_SKILL" }],
          origin: { kind: "skill_activation" },
        },
      }) as KimiWireRecord,
      { signal: "message.preamble" },
    ],
    [
      "append_message origin=background_task",
      fromSchema(KimiAppendMessage, {
        type: "context.append_message",
        time: 1004,
        message: {
          role: "user",
          content: [{ type: "text", text: "ZZTEST_BGTASK" }],
          origin: { kind: "background_task" },
        },
      }) as KimiWireRecord,
      { signal: "message.preamble" },
    ],
    // --- context.append_loop_event inner kinds ---
    [
      "loop_event content.part text",
      fromSchema(KimiAppendLoopEvent, {
        type: "context.append_loop_event",
        time: 2000,
        event: { type: "content.part", part: { type: "text", text: "ZZTEST_ASSISTANT" } },
      }) as KimiWireRecord,
      { signal: "assistant.text" },
    ],
    [
      "loop_event content.part think",
      fromSchema(KimiAppendLoopEvent, {
        type: "context.append_loop_event",
        time: 2001,
        event: { type: "content.part", part: { type: "think", think: "ZZTEST_THINK" } },
      }) as KimiWireRecord,
      { signal: "assistant.think" },
    ],
    [
      "loop_event content.part other → drop",
      fromSchema(KimiAppendLoopEvent, {
        type: "context.append_loop_event",
        time: 2002,
        event: { type: "content.part", part: { type: "zztest_future_part" } },
      }) as KimiWireRecord,
      { drop: "loop.content_part.zztest_future_part" },
    ],
    [
      "loop_event tool.call",
      fromSchema(KimiAppendLoopEvent, {
        type: "context.append_loop_event",
        time: 2003,
        event: {
          type: "tool.call",
          toolCallId: "tc-synth-1",
          name: "zztest_bash",
          args: { command: "ls" },
        },
      }) as KimiWireRecord,
      { signal: "tool.call" },
    ],
    [
      "loop_event tool.result",
      fromSchema(KimiAppendLoopEvent, {
        type: "context.append_loop_event",
        time: 2004,
        event: { type: "tool.result", toolCallId: "tc-synth-1", result: { output: "ZZTEST_TOOL_OUT" } },
      }) as KimiWireRecord,
      { signal: "tool.result" },
    ],
    [
      "loop_event step.begin → drop",
      fromSchema(KimiAppendLoopEvent, {
        type: "context.append_loop_event",
        time: 2005,
        event: { type: "step.begin" },
      }) as KimiWireRecord,
      { drop: "loop.step_begin" },
    ],
    [
      "loop_event step.end → drop",
      fromSchema(KimiAppendLoopEvent, {
        type: "context.append_loop_event",
        time: 2006,
        event: { type: "step.end" },
      }) as KimiWireRecord,
      { drop: "loop.step_end" },
    ],
    // --- compaction family ---
    [
      "context.apply_compaction → summary",
      fromSchema(KimiApplyCompaction, {
        type: "context.apply_compaction",
        time: 3000,
        summary: "ZZTEST_SUMMARY",
        compactedCount: 3,
        tokensBefore: 100,
        tokensAfter: 10,
      }) as KimiWireRecord,
      { signal: "summary" },
    ],
    [
      "micro_compaction.apply → drop",
      fromSchema(KimiMicroCompactionApply, {
        type: "micro_compaction.apply",
        time: 3001,
        cutoff: 5,
      }) as KimiWireRecord,
      { drop: "compaction.micro_apply" },
    ],
    [
      "full_compaction.begin → drop",
      fromSchema(KimiFullCompactionBegin, {
        type: "full_compaction.begin",
        time: 3002,
        source: "auto",
      }) as KimiWireRecord,
      { drop: "compaction.full_begin" },
    ],
    [
      "full_compaction.complete → drop",
      fromSchema(KimiFullCompactionComplete, {
        type: "full_compaction.complete",
        time: 3003,
      }) as KimiWireRecord,
      { drop: "compaction.full_complete" },
    ],
    // --- usage ---
    [
      "usage.record → usage",
      fromSchema(KimiUsageRecord, {
        type: "usage.record",
        time: 4000,
        model: "zztest-model",
        usage: { inputOther: 10, output: 5, inputCacheRead: 2, inputCacheCreation: 1 },
        usageScope: "turn",
      }) as KimiWireRecord,
      { signal: "usage" },
    ],
    // --- bootstrap ---
    [
      "metadata → drop",
      fromSchema(KimiMetadata, {
        type: "metadata",
        protocol_version: "1.4",
        created_at: 1781000000000,
        app_version: "0.14.0",
      }) as KimiWireRecord,
      { drop: "bootstrap.metadata" },
    ],
    // --- config / permission / tools lifecycle ---
    [
      "config.update → drop",
      fromSchema(KimiConfigUpdate, {
        type: "config.update",
        time: 5000,
        profileName: "agent",
      }) as KimiWireRecord,
      { drop: "config.update" },
    ],
    [
      "permission.set_mode → drop",
      fromSchema(KimiPermissionSetMode, {
        type: "permission.set_mode",
        time: 5001,
        mode: "auto",
      }) as KimiWireRecord,
      { drop: "permission.set_mode" },
    ],
    [
      "permission.record_approval_result → drop",
      fromSchema(KimiPermissionRecordApprovalResult, {
        type: "permission.record_approval_result",
        time: 5002,
        toolCallId: "tc-synth-2",
        toolName: "zztest_bash",
      }) as KimiWireRecord,
      { drop: "permission.record_approval_result" },
    ],
    [
      "tools.set_active_tools → drop",
      fromSchema(KimiToolsSetActiveTools, {
        type: "tools.set_active_tools",
        time: 5003,
        names: ["zztest_read", "zztest_write"],
      }) as KimiWireRecord,
      { drop: "tools.set_active_tools" },
    ],
    [
      "tools.update_store → drop",
      fromSchema(KimiToolsUpdateStore, {
        type: "tools.update_store",
        time: 5004,
        key: "zztest_key",
        value: { a: 1 },
      }) as KimiWireRecord,
      { drop: "tools.update_store" },
    ],
    // --- goal lifecycle ---
    [
      "goal.create → drop",
      fromSchema(KimiGoalCreate, {
        type: "goal.create",
        time: 6000,
        goalId: "zztest-goal",
        objective: "ZZTEST objective",
      }) as KimiWireRecord,
      { drop: "goal.create" },
    ],
    [
      "goal.update → drop",
      fromSchema(KimiGoalUpdate, {
        type: "goal.update",
        time: 6001,
        tokensUsed: 42,
      }) as KimiWireRecord,
      { drop: "goal.update" },
    ],
    [
      "goal.clear → drop",
      fromSchema(KimiGoalClear, { type: "goal.clear", time: 6002 }) as KimiWireRecord,
      { drop: "goal.clear" },
    ],
    // --- turn lifecycle ---
    [
      "turn.prompt → drop",
      fromSchema(KimiTurnPrompt, {
        type: "turn.prompt",
        time: 7000,
        input: "ZZTEST",
        origin: { kind: "user" },
      }) as KimiWireRecord,
      { drop: "turn.prompt" },
    ],
    [
      "turn.steer → drop",
      fromSchema(KimiTurnSteer, {
        type: "turn.steer",
        time: 7001,
        input: "ZZTEST",
        origin: { kind: "user" },
      }) as KimiWireRecord,
      { drop: "turn.steer" },
    ],
    [
      "turn.cancel → drop",
      fromSchema(KimiTurnCancel, {
        type: "turn.cancel",
        time: 7002,
        turnId: "zztest-turn",
      }) as KimiWireRecord,
      { drop: "turn.cancel" },
    ],
    // --- mode lifecycle ---
    [
      "swarm_mode.enter → drop",
      fromSchema(KimiSwarmModeEnter, {
        type: "swarm_mode.enter",
        time: 8000,
        trigger: "manual",
      }) as KimiWireRecord,
      { drop: "swarm_mode.enter" },
    ],
    [
      "swarm_mode.exit → drop",
      fromSchema(KimiSwarmModeExit, { type: "swarm_mode.exit", time: 8001 }) as KimiWireRecord,
      { drop: "swarm_mode.exit" },
    ],
    [
      "plan_mode.enter → drop",
      fromSchema(KimiPlanModeEnter, {
        type: "plan_mode.enter",
        time: 8002,
        id: "zztest-plan",
      }) as KimiWireRecord,
      { drop: "plan_mode.enter" },
    ],
    [
      "plan_mode.exit → drop",
      fromSchema(KimiPlanModeExit, { type: "plan_mode.exit", time: 8003 }) as KimiWireRecord,
      { drop: "plan_mode.exit" },
    ],
  ];

  for (const [label, record, expected] of cases) {
    test(`classifies ${label}`, () => {
      const verdict = classifyKimiRecord(record);
      if ("signal" in expected) {
        expect(verdict._tag).toBe("signal");
        if (verdict._tag === "signal") expect(String(verdict.kind)).toBe(expected.signal);
      } else {
        expect(verdict._tag).toBe("drop");
        if (verdict._tag === "drop") expect(verdict.reason).toBe(expected.drop);
      }
    });
  }

  test("covers every modeled record-type case (30) with an explicit verdict", () => {
    // 5 message-origin + 7 loop-event inner + 4 compaction + 1 usage +
    // 1 metadata + 5 config/permission/tools + 3 goal + 3 turn + 4 mode = 33
    // explicit cases (≥30 distinct record types, zero unknown pass-through).
    expect(cases.length).toBeGreaterThanOrEqual(30);
  });
});

// ===========================================================================
// T10 (QSR-220): full-spectrum wire through the ADAPTER. A single agent wire
// carrying one of EVERY signal + several drops must produce exactly the signal
// events/tool-calls/usage and ZERO events for the dropped lifecycle records —
// proving no unknown pass-through and no lifecycle coercion into events.
// ===========================================================================
describe("T10 (QSR-220): full-spectrum wire → only signals become events, drops vanish", () => {
  const root = join(testRoot, "t10");
  const sessionsDir = join(root, "sessions");
  const sessionDir = join(sessionsDir, "wd_zztest_full", "session_synthetic_t10");
  const agentDir = join(sessionDir, "agents", "main");
  mkdirSync(agentDir, { recursive: true });

  writeJson(join(sessionDir, "state.json"), {
    createdAt: "2026-05-10T08:00:00.000Z",
    updatedAt: "2026-05-10T09:00:00.000Z",
    title: "Full spectrum",
    isCustomTitle: true,
    agents: { main: { homedir: agentDir, type: "main", parentAgentId: null } },
    custom: {},
  });
  writeJsonLines(join(root, "session_index.jsonl"), [
    { sessionId: "session_synthetic_t10", sessionDir, workDir: "/home/zztest/full" },
  ]);

  // One signal of each kind + a representative set of drops, schema-built.
  writeJsonLines(join(agentDir, "wire.jsonl"), [
    fromSchema(KimiMetadata, { type: "metadata", protocol_version: "1.4", created_at: 100 }),
    fromSchema(KimiConfigUpdate, { type: "config.update", time: 110, profileName: "agent" }),
    fromSchema(KimiToolsSetActiveTools, { type: "tools.set_active_tools", time: 120, names: ["zztest_read"] }),
    fromSchema(KimiPermissionSetMode, { type: "permission.set_mode", time: 130, mode: "auto" }),
    fromSchema(KimiTurnPrompt, { type: "turn.prompt", time: 140, input: "ZZTEST" }),
    fromSchema(KimiAppendMessage, {
      type: "context.append_message",
      time: 200,
      message: { role: "user", content: [{ type: "text", text: "ZZTEST_USER_PROMPT" }], origin: { kind: "user" } },
    }),
    fromSchema(KimiAppendMessage, {
      type: "context.append_message",
      time: 210,
      message: { role: "user", content: [{ type: "text", text: "ZZTEST_INJECTION" }], origin: { kind: "injection" } },
    }),
    fromSchema(KimiAppendLoopEvent, {
      type: "context.append_loop_event",
      time: 300,
      event: { type: "step.begin" },
    }),
    fromSchema(KimiAppendLoopEvent, {
      type: "context.append_loop_event",
      time: 310,
      event: { type: "content.part", part: { type: "think", think: "ZZTEST_THINK" } },
    }),
    fromSchema(KimiAppendLoopEvent, {
      type: "context.append_loop_event",
      time: 320,
      event: { type: "content.part", part: { type: "text", text: "ZZTEST_ASSISTANT" } },
    }),
    fromSchema(KimiAppendLoopEvent, {
      type: "context.append_loop_event",
      time: 330,
      event: { type: "tool.call", toolCallId: "tc-synth-9", name: "zztest_bash", args: { command: "ls" } },
    }),
    fromSchema(KimiAppendLoopEvent, {
      type: "context.append_loop_event",
      time: 340,
      event: { type: "tool.result", toolCallId: "tc-synth-9", result: { output: "ZZTEST_TOOL_OUT" } },
    }),
    fromSchema(KimiAppendLoopEvent, {
      type: "context.append_loop_event",
      time: 350,
      event: { type: "step.end" },
    }),
    fromSchema(KimiUsageRecord, {
      type: "usage.record",
      time: 360,
      model: "zztest-model",
      usage: { inputOther: 10, output: 5 },
      usageScope: "turn",
    }),
    fromSchema(KimiApplyCompaction, {
      type: "context.apply_compaction",
      time: 400,
      summary: "ZZTEST_SUMMARY",
    }),
    fromSchema(KimiSwarmModeEnter, { type: "swarm_mode.enter", time: 410, trigger: "manual" }),
    fromSchema(KimiGoalUpdate, { type: "goal.update", time: 420, tokensUsed: 9 }),
  ]);

  const read = () => kimiAdapter.read({ machine: MACHINE, now: NOW, roots: { kimi: root } });

  test("signal events are exactly: 1 user, 1 preamble, 1 assistant text, 1 reasoning, 1 tool_call, 1 tool_result, 1 summary", async () => {
    const session = (await read()).sessions[0]!;
    const byKind = (kind: string) => session.events.filter((e) => e.kind === kind);
    expect(session.events.filter((e) => e.role === "user" && e.kind === "message")).toHaveLength(1);
    expect(byKind("preamble")).toHaveLength(1);
    expect(session.events.filter((e) => e.role === "assistant" && e.kind === "message")).toHaveLength(1);
    expect(byKind("reasoning")).toHaveLength(1);
    expect(byKind("tool_call")).toHaveLength(1);
    expect(byKind("tool_result")).toHaveLength(1);
    expect(byKind("summary")).toHaveLength(1);
  });

  test("NO lifecycle/unknown events leak (drops never become events)", async () => {
    const session = (await read()).sessions[0]!;
    // The only non-signal event kind that could appear historically was
    // "lifecycle"/"unknown"; with declarative drops there must be none.
    expect(session.events.filter((e) => e.kind === "lifecycle")).toHaveLength(0);
    expect(session.events.filter((e) => e.kind === "unknown")).toHaveLength(0);
    // 7 signal-producing records → exactly 7 events.
    expect(session.events).toHaveLength(7);
  });

  test("usage.record becomes a UsageRecord, not an event", async () => {
    const session = (await read()).sessions[0]!;
    expect(session.usageRecords).toHaveLength(1);
    expect(session.usageRecords[0]!.model).toBe("zztest-model");
    expect(session.usageRecords[0]!.inputTokens).toBe(10);
  });

  test("the tool.call/result merge into one completed ToolCall", async () => {
    const session = (await read()).sessions[0]!;
    expect(session.toolCalls).toHaveLength(1);
    expect(session.toolCalls[0]!.toolName).toBe("zztest_bash");
    expect(session.toolCalls[0]!.status).toBe("completed");
  });
});

// ===========================================================================
// T11 (QSR-220): malformed-record fail-closed per MAJOR type. A structurally
// invalid record for each major outer family (valid JSON, wrong shape) must:
//   - decode-fail at the boundary → named kimi.wire.decode_failed diagnostic,
//   - be DROPPED (never become an event, never throw),
//   - and the surrounding valid records must survive.
// ===========================================================================
describe("T11 (QSR-220): malformed records → named diagnostic + drop, no throw", () => {
  const root = join(testRoot, "t11");
  const sessionsDir = join(root, "sessions");
  const sessionDir = join(sessionsDir, "wd_zztest_malformed", "session_synthetic_t11");
  const agentDir = join(sessionDir, "agents", "main");
  mkdirSync(agentDir, { recursive: true });

  writeJson(join(sessionDir, "state.json"), {
    createdAt: "2026-05-11T08:00:00.000Z",
    updatedAt: "2026-05-11T09:00:00.000Z",
    title: "Malformed",
    isCustomTitle: true,
    agents: { main: { homedir: agentDir, type: "main", parentAgentId: null } },
    custom: {},
  });
  writeJsonLines(join(root, "session_index.jsonl"), [
    { sessionId: "session_synthetic_t11", sessionDir, workDir: "/home/zztest/malformed" },
  ]);

  // Each malformed record is valid JSON with the right `type` literal but the
  // WRONG inner shape for that type, so it fails its per-type schema arm.
  writeJsonLines(join(agentDir, "wire.jsonl"), [
    // valid bookend
    fromSchema(KimiAppendMessage, {
      type: "context.append_message",
      time: 1,
      message: { role: "user", content: [{ type: "text", text: "ZZTEST_USER_PROMPT" }], origin: { kind: "user" } },
    }),
    // append_message missing required message.role
    { type: "context.append_message", time: 2, message: { content: [] } },
    // loop_event with unmodeled inner event.type
    { type: "context.append_loop_event", time: 3, event: { type: "zztest_unknown_inner" } },
    // loop_event content.part missing required part.type
    { type: "context.append_loop_event", time: 4, event: { type: "content.part", part: {} } },
    // usage.record with non-object usage
    { type: "usage.record", time: 5, usage: "not-an-object" },
    // metadata with wrong-typed created_at
    { type: "metadata", created_at: "not-a-number" },
    // entirely unmodeled outer type → no union arm
    { type: "zztest.totally_unknown_outer", time: 7 },
    // valid bookend
    fromSchema(KimiAppendLoopEvent, {
      type: "context.append_loop_event",
      time: 8,
      event: { type: "content.part", part: { type: "text", text: "ZZTEST_ASSISTANT" } },
    }),
  ]);

  const read = () => kimiAdapter.read({ machine: MACHINE, now: NOW, roots: { kimi: root } });

  test("does not throw and yields the session", async () => {
    const result = await read();
    expect(result.sessions).toHaveLength(1);
  });

  test("emits named kimi.wire.decode_failed diagnostics for the malformed records", async () => {
    const result = await read();
    const decodeDiag = result.diagnostics.filter((d) =>
      (d.message ?? "").includes("kimi.wire.decode_failed"),
    );
    // One per malformed line (6 malformed records).
    expect(decodeDiag.length).toBeGreaterThanOrEqual(6);
  });

  test("only the two valid records become events; malformed records are dropped", async () => {
    const session = (await read()).sessions[0]!;
    expect(session.events).toHaveLength(2);
    const texts = session.events.flatMap((e) => (e.contentText !== undefined ? [e.contentText] : []));
    expect(texts.some((t) => t.includes("ZZTEST_USER_PROMPT"))).toBe(true);
    expect(texts.some((t) => t.includes("ZZTEST_ASSISTANT"))).toBe(true);
  });

  test("an unmodeled outer type is rejected (no unknown pass-through)", async () => {
    // The unmodeled outer type produced a decode failure (covered above) and is
    // NOT present as any event.
    const session = (await read()).sessions[0]!;
    const refs = session.events.map((e) => e.rawReference.nativeType);
    expect(refs.some((r) => (r ?? "").includes("zztest.totally_unknown_outer"))).toBe(false);
  });
});

// ===========================================================================
// T12 (QSR-220): the boundary schema is a CLOSED union — round-trip decode of a
// schema-built record succeeds, and an unmodeled outer type fails decode.
// ===========================================================================
describe("T12 (QSR-220): KimiWireRecordSchema is a closed fail-closed union", () => {
  test("a schema-built record decodes back through the union", () => {
    const onDisk = fromSchema(KimiUsageRecord, {
      type: "usage.record",
      time: 1,
      model: "zztest-model",
      usage: { output: 1 },
    });
    const decoded = Schema.decodeUnknownSync(KimiWireRecordSchema)(onDisk);
    expect(decoded.type).toBe("usage.record");
  });

  test("an unmodeled outer type does not decode", () => {
    expect(() =>
      Schema.decodeUnknownSync(KimiWireRecordSchema)({ type: "zztest.unknown", time: 1 }),
    ).toThrow();
  });
});

// ===========================================================================
// Boundary fail-closed: state.json / session_index — never invent `{}`, never
// silent-skip wrong-shape or missing load-bearing fields without a named diag.
// ===========================================================================
describe("kimi boundary fail-closed: state + session_index", () => {
  const diagnosticBlob = (d: { message: string; details?: unknown }) =>
    `${d.message}\n${JSON.stringify(d.details ?? {})}`;

  test("wrong-shape state.json emits kimi.state.wrong_shape and yields zero sessions", async () => {
    const root = join(testRoot, "boundary-state-array");
    const sessionsDir = join(root, "sessions");
    const sessionDir = join(sessionsDir, "wd_boundary", "session_state_array");
    const agentDir = join(sessionDir, "agents", "main");
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(join(sessionDir, "state.json"), "[]\n", "utf8");
    writeJsonLines(join(agentDir, "wire.jsonl"), [
      {
        type: "context.append_message",
        message: { role: "user", content: [{ type: "text", text: "should not ingest" }] },
        origin: { kind: "user" },
        time: 1000,
      },
    ]);
    writeJsonLines(join(root, "session_index.jsonl"), [
      { sessionId: "session_state_array", sessionDir, workDir: "/tmp/boundary" },
    ]);

    const result = await kimiAdapter.read({ machine: MACHINE, now: NOW, roots: { kimi: root } });
    expect(result.sessions).toHaveLength(0);
    expect(
      result.diagnostics.some((d) => diagnosticBlob(d).includes("kimi.state.wrong_shape")),
    ).toBe(true);
  });

  test("missing state.json emits json.file.missing and yields zero sessions", async () => {
    const root = join(testRoot, "boundary-state-missing");
    const sessionsDir = join(root, "sessions");
    const sessionDir = join(sessionsDir, "wd_boundary", "session_state_missing");
    const agentDir = join(sessionDir, "agents", "main");
    mkdirSync(agentDir, { recursive: true });
    writeJsonLines(join(agentDir, "wire.jsonl"), [
      {
        type: "context.append_message",
        message: { role: "user", content: [{ type: "text", text: "orphan wire" }] },
        origin: { kind: "user" },
        time: 1000,
      },
    ]);
    writeJsonLines(join(root, "session_index.jsonl"), [
      { sessionId: "session_state_missing", sessionDir, workDir: "/tmp/boundary" },
    ]);

    const result = await kimiAdapter.read({ machine: MACHINE, now: NOW, roots: { kimi: root } });
    expect(result.sessions).toHaveLength(0);
    expect(
      result.diagnostics.some((d) => diagnosticBlob(d).includes("kimi.state.missing")),
    ).toBe(true);
  });

  test("session_index entry missing sessionId/sessionDir emits kimi.index.entry.missing_fields", async () => {
    const root = join(testRoot, "boundary-index-fields");
    mkdirSync(join(root, "sessions"), { recursive: true });
    writeJsonLines(join(root, "session_index.jsonl"), [
      { workDir: "/tmp/only-workdir" },
      { sessionId: "no_dir" },
    ]);

    const result = await kimiAdapter.read({ machine: MACHINE, now: NOW, roots: { kimi: root } });
    expect(result.sessions).toHaveLength(0);
    const missingFieldCount = result.diagnostics.filter((d) =>
      diagnosticBlob(d).includes("kimi.index.entry.missing_fields"),
    ).length;
    expect(missingFieldCount).toBeGreaterThanOrEqual(2);
  });

  test("session_index wrong-shape entry emits kimi.index.entry.wrong_shape", async () => {
    const root = join(testRoot, "boundary-index-shape");
    mkdirSync(join(root, "sessions"), { recursive: true });
    writeFileSync(
      join(root, "session_index.jsonl"),
      '["not-an-object"]\nnull\n{"sessionId":"x","sessionDir":"/no/such/dir"}\n',
      "utf8",
    );

    const result = await kimiAdapter.read({ machine: MACHINE, now: NOW, roots: { kimi: root } });
    expect(result.sessions).toHaveLength(0);
    expect(
      result.diagnostics.some((d) => diagnosticBlob(d).includes("kimi.index.entry.wrong_shape")),
    ).toBe(true);
    expect(
      result.diagnostics.some((d) =>
        diagnosticBlob(d).includes("kimi.index.entry.session_dir_missing"),
      ),
    ).toBe(true);
  });

  test("state.agents wrong shape emits kimi.state.agents.wrong_shape", async () => {
    const root = join(testRoot, "boundary-agents-shape");
    const sessionsDir = join(root, "sessions");
    const sessionDir = join(sessionsDir, "wd_boundary", "session_agents_shape");
    const agentDir = join(sessionDir, "agents", "main");
    mkdirSync(agentDir, { recursive: true });
    writeJson(join(sessionDir, "state.json"), {
      createdAt: "2026-05-01T10:00:00.000Z",
      updatedAt: "2026-05-01T11:00:00.000Z",
      title: "agents wrong",
      isCustomTitle: true,
      agents: ["main"], // array — not a dict
      custom: {},
    });
    writeJsonLines(join(agentDir, "wire.jsonl"), [
      {
        type: "context.append_message",
        message: { role: "user", content: [{ type: "text", text: "via orphan path" }] },
        origin: { kind: "user" },
        time: 1000,
      },
    ]);
    writeJsonLines(join(root, "session_index.jsonl"), [
      { sessionId: "session_agents_shape", sessionDir, workDir: "/tmp/boundary" },
    ]);

    const result = await kimiAdapter.read({ machine: MACHINE, now: NOW, roots: { kimi: root } });
    expect(
      result.diagnostics.some((d) => diagnosticBlob(d).includes("kimi.state.agents.wrong_shape")),
    ).toBe(true);
    // Disk orphan still recoverable after agents-dict rejection (named + attributed).
    expect(result.sessions.length).toBeGreaterThanOrEqual(1);
    expect(
      result.diagnostics.some((d) => diagnosticBlob(d).includes("kimi.agent.undeclared_wire")),
    ).toBe(true);
  });
});
