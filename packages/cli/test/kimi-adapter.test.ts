import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, test } from "bun:test";

import { kimiAdapter } from "../src/adapters/kimi";

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
