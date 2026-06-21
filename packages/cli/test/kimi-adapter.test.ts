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
  const NATIVE_SESSION_ID = "session_idem0001";

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
  const sessionDir = join(sessionsDir, "wd_proj_aabb1122", "session_abc123");
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
      sessionId: "session_abc123",
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
// T2: multi-agent session — events merged by outer time order
// ---------------------------------------------------------------------------
describe("T2: multi-agent session — time-ordered merge", () => {
  const root = join(testRoot, "t2");
  const sessionsDir = join(root, "sessions");
  const sessionDir = join(sessionsDir, "wd_proj_ccdd3344", "session_multi99");
  const mainDir = join(sessionDir, "agents", "main");
  const agent0Dir = join(sessionDir, "agents", "agent-0");

  mkdirSync(mainDir, { recursive: true });
  mkdirSync(agent0Dir, { recursive: true });

  writeJson(join(sessionDir, "state.json"), {
    createdAt: "2026-05-02T08:00:00.000Z",
    updatedAt: "2026-05-02T09:00:00.000Z",
    title: "Multi-agent session",
    isCustomTitle: false,
    agents: {
      main: { homedir: mainDir, type: "main", parentAgentId: null },
      "agent-0": { homedir: agent0Dir, type: "sub", parentAgentId: "main" },
    },
    custom: {},
  });

  writeJsonLines(join(root, "session_index.jsonl"), [
    {
      sessionId: "session_multi99",
      sessionDir: sessionDir,
      workDir: "/home/user/projects/other",
    },
  ]);

  // main agent: events at t=100 and t=300
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

  // agent-0: event at t=200 (interleaved between main's t=100 and t=300)
  writeJsonLines(join(agent0Dir, "wire.jsonl"), [
    {
      type: "context.append_loop_event",
      event: { type: "content.part", part: { type: "text", text: "sub-agent result" } },
      time: 200,
    },
  ]);

  test("discovers 1 session with 3 content-bearing events", async () => {
    const result = await kimiAdapter.read({
      machine: MACHINE,
      now: NOW,
      roots: { kimi: root },
    });
    expect(result.sessions).toHaveLength(1);
    const session = result.sessions[0]!;
    const contentEvents = session.events.filter(
      (e) => e.kind === "message" || e.kind === "preamble",
    );
    expect(contentEvents).toHaveLength(3);
  });

  test("events are ordered by outer time (t=100, t=200, t=300)", async () => {
    const result = await kimiAdapter.read({
      machine: MACHINE,
      now: NOW,
      roots: { kimi: root },
    });
    const session = result.sessions[0]!;
    const msgEvents = session.events.filter((e) => e.kind === "message");
    // Should be: t=100 (user), t=200 (sub-agent text), t=300 (main reply)
    expect(msgEvents).toHaveLength(3);
    // Each successive event has a higher or equal sequence number
    for (let i = 1; i < msgEvents.length; i++) {
      expect(msgEvents[i]!.sequence).toBeGreaterThan(msgEvents[i - 1]!.sequence);
    }
    // Content order matches time order
    expect(msgEvents[0]!.contentText).toContain("main user message");
    expect(msgEvents[1]!.contentText).toContain("sub-agent result");
    expect(msgEvents[2]!.contentText).toContain("main assistant reply");
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
  const sessionDir = join(sessionsDir, "wd_quasar_stub", "session_stub01");
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
    { sessionId: "session_stub01", sessionDir: sessionDir, workDir: "/home/user/empty" },
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
  const sessionDir = join(sessionsDir, "wd_proj_gate", "session_gate01");
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
    { sessionId: "session_gate01", sessionDir: sessionDir, workDir: "/home/user/gate" },
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
