import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, test } from "bun:test";
import { Schema } from "effect";

import { claudeAdapter } from "../src/adapters/claude";
import {
  ClaudeAgentNameSchema,
  ClaudeAgentSettingSchema,
  ClaudeAiTitleSchema,
  ClaudeAssistantRecordSchema,
  ClaudeFileHistorySnapshotSchema,
  ClaudeLastPromptSchema,
  ClaudeModeSchema,
  ClaudePermissionModeSchema,
  ClaudeQueueOperationSchema,
  ClaudeSystemApiErrorSchema,
  ClaudeSystemAwaySummarySchema,
  ClaudeSystemCompactBoundarySchema,
  ClaudeSystemInformationalSchema,
  ClaudeSystemLocalCommandSchema,
  ClaudeSystemScheduledTaskFireSchema,
  ClaudeSystemStopHookSummarySchema,
  ClaudeSystemTurnDurationSchema,
  ClaudeUserRecordSchema,
  classifyClaudeRecord,
} from "../src/adapters/claude-schema";
import type { DecodeDiagnostic } from "../src/adapters/harness-schema";

const MACHINE = {
  machineId: "machine:test",
  hostname: "test-host",
  platform: "darwin",
};

const NOW = "2026-06-21T00:00:00.000Z";

// Root for all tests — cleaned up once at the end.
const testRoot = mkdtempSync(join(tmpdir(), "quasar-claude-adapter-"));

afterAll(() => {
  rmSync(testRoot, { recursive: true, force: true });
});

const line = (value: unknown) => JSON.stringify(value);

/**
 * Minimal main-session records carrying an in-record `sessionId`.
 * The native id is read from this field, NOT from the file path, so the same
 * records placed at any two paths yield the same canonical session.id.
 */
const mainSessionRecords = (sessionId: string) =>
  [
    line({ sessionId, type: "user", message: { role: "user", content: [{ type: "text", text: "hello" }] } }),
    line({ sessionId, type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "hello back" }] } }),
  ].join("\n");

/**
 * Minimal subagent records carrying an in-record `agentId`.
 * Subagent files are named `agent-<uuid>.jsonl` and live under a `subagents/`
 * directory. Their native id is the in-record `agentId`, not the parent
 * sessionId and not the file's path components.
 */
const subagentRecords = (agentId: string) =>
  [
    line({ agentId, type: "user", message: { role: "user", content: [{ type: "text", text: "sub task" }] } }),
    line({ agentId, type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "sub result" }] } }),
  ].join("\n");

// ---------------------------------------------------------------------------
// T1: basic session discovery
// ---------------------------------------------------------------------------
describe("T1: discovers sessions under projects/", () => {
  const root = join(testRoot, "t1");
  const projectDir = join(root, "projects", "-Users-me-myapp");
  mkdirSync(projectDir, { recursive: true });
  writeFileSync(join(projectDir, "aaaa1111-0001-0001-0001-000000000001.jsonl"), mainSessionRecords("aaaa1111-0001-0001-0001-000000000001"));

  test("discovers 1 session", async () => {
    const result = await claudeAdapter.read({
      machine: MACHINE,
      now: NOW,
      roots: { claude: root },
    });
    expect(result.sessions).toHaveLength(1);
    expect(result.sessions[0]!.provider).toBe("claude");
  });

  test("journal.jsonl is excluded", async () => {
    writeFileSync(join(projectDir, "journal.jsonl"), line({ started: NOW, type: "started" }));
    const result = await claudeAdapter.read({
      machine: MACHINE,
      now: NOW,
      roots: { claude: root },
    });
    // Still 1, not 2.
    expect(result.sessions).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// AC#5 — idempotency proof: main session (content-id, `sessionId` field)
//
// The native id is the in-record `sessionId` field. Place the SAME records
// at TWO DIFFERENT source paths (simulating a host vs Docker /history mount).
// Both adapter reads must produce byte-identical session.id values. The
// sourcePaths must differ — that is the whole point.
// ---------------------------------------------------------------------------
describe("AC#5 idempotency: main session — same in-record sessionId at different paths", () => {
  // Two independent roots simulating different machines/mounts.
  const hostRoot = mkdtempSync(join(tmpdir(), "quasar-claude-host-"));
  const dockerRoot = mkdtempSync(join(tmpdir(), "quasar-claude-docker-"));

  afterAll(() => {
    rmSync(hostRoot, { recursive: true, force: true });
    rmSync(dockerRoot, { recursive: true, force: true });
  });

  const NATIVE_SESSION_ID = "bbbb2222-0002-0002-0002-000000000002";
  const FILENAME = `${NATIVE_SESSION_ID}.jsonl`;
  const CONTENT = mainSessionRecords(NATIVE_SESSION_ID);

  // Place the same file content at two different project paths.
  // Project key and parent directory differ between roots.
  const hostProjectDir = join(hostRoot, "projects", "-Users-alice-work");
  const dockerProjectDir = join(dockerRoot, "projects", "-history-alice-work");
  mkdirSync(hostProjectDir, { recursive: true });
  mkdirSync(dockerProjectDir, { recursive: true });
  writeFileSync(join(hostProjectDir, FILENAME), CONTENT);
  writeFileSync(join(dockerProjectDir, FILENAME), CONTENT);

  test("host and docker reads produce byte-identical session.id", async () => {
    const hostResult = await claudeAdapter.read({
      machine: MACHINE,
      now: NOW,
      roots: { claude: hostRoot },
    });
    const dockerResult = await claudeAdapter.read({
      machine: MACHINE,
      now: NOW,
      roots: { claude: dockerRoot },
    });

    expect(hostResult.sessions).toHaveLength(1);
    expect(dockerResult.sessions).toHaveLength(1);
    // The canonical session.id must be byte-identical regardless of path.
    expect(hostResult.sessions[0]!.id).toBe(dockerResult.sessions[0]!.id);
    // The sourcePaths must differ — proving the id is path-independent.
    expect(hostResult.sessions[0]!.sourcePath).not.toBe(dockerResult.sessions[0]!.sourcePath);
  });
});

// ---------------------------------------------------------------------------
// AC#5 idempotency: subagent file (content-id, `agentId` field)
//
// Subagent files use the in-record `agentId` as native id.  Same content at
// two different subagents/ paths → same canonical session.id.
// ---------------------------------------------------------------------------
describe("AC#5 idempotency: subagent — same in-record agentId at different paths", () => {
  const hostRoot = mkdtempSync(join(tmpdir(), "quasar-claude-sub-host-"));
  const dockerRoot = mkdtempSync(join(tmpdir(), "quasar-claude-sub-docker-"));

  afterAll(() => {
    rmSync(hostRoot, { recursive: true, force: true });
    rmSync(dockerRoot, { recursive: true, force: true });
  });

  const AGENT_ID = "cccc3333-0003-0003-0003-000000000003";
  const FILENAME = `agent-${AGENT_ID}.jsonl`;
  const CONTENT = subagentRecords(AGENT_ID);

  // Two different parent session directories but the same agent file content.
  const hostSubDir = join(hostRoot, "projects", "-Users-alice-work", "subagents");
  const dockerSubDir = join(dockerRoot, "projects", "-history-alice-work", "subagents");
  mkdirSync(hostSubDir, { recursive: true });
  mkdirSync(dockerSubDir, { recursive: true });
  writeFileSync(join(hostSubDir, FILENAME), CONTENT);
  writeFileSync(join(dockerSubDir, FILENAME), CONTENT);

  test("host and docker reads produce byte-identical session.id for subagent", async () => {
    const hostResult = await claudeAdapter.read({
      machine: MACHINE,
      now: NOW,
      roots: { claude: hostRoot },
    });
    const dockerResult = await claudeAdapter.read({
      machine: MACHINE,
      now: NOW,
      roots: { claude: dockerRoot },
    });

    expect(hostResult.sessions).toHaveLength(1);
    expect(dockerResult.sessions).toHaveLength(1);
    expect(hostResult.sessions[0]!.id).toBe(dockerResult.sessions[0]!.id);
    expect(hostResult.sessions[0]!.sourcePath).not.toBe(dockerResult.sessions[0]!.sourcePath);
  });
});

// ===========================================================================
// QSR-220 FULL DATA FIDELITY — declarative per-record-type signal/drop dispatch.
//
// Every distinct on-disk record type (and system/attachment subtype) is modeled
// by a fail-closed Effect Schema and classified EXPLICITLY as signal(kind) or
// drop(named reason). ZERO records fall through to "unknown" pass-through.
//
// PRIVACY: every id / name / path / label below is FABRICATED and verified to
// resolve to zero real on-disk data. Fixtures are built FROM the schemas via
// Schema.decodeUnknownSync so a schema change BREAKS the fixture (no loose JSON).
// ===========================================================================

// Fully-synthetic identifiers (grepped to zero hits against the real root).
const FAB = {
  sessionId: "deadbeef-0000-4000-8000-000000000001",
  agentId: "feedface-0000-4000-8000-000000000002",
  uuid: "ffffaaaa-0000-4000-8000-000000000abc",
  parentUuid: "ffffbbbb-0000-4000-8000-000000000def",
  cwd: "/Users/fixtureuser/fixtureapp",
  ts: "2026-06-21T00:00:00.000Z",
};

/**
 * Build a fixture FROM a schema: decoding it asserts the fixture matches the
 * schema's shape (a drifted schema throws here), then we hand the same object
 * to the classifier. This is the "fixtures-from-schema" guarantee.
 */
const fromSchema = <A, I>(schema: Schema.Schema<A, I>, value: Record<string, unknown>): Record<string, unknown> => {
  // Runtime guard: if the schema drifts from this fixture, decode throws here
  // and the test fails — the "fixtures-from-schema" guarantee.
  Schema.decodeUnknownSync(schema)(value);
  return value;
};

const envelope = {
  uuid: FAB.uuid,
  parentUuid: FAB.parentUuid,
  sessionId: FAB.sessionId,
  timestamp: FAB.ts,
  cwd: FAB.cwd,
};

// ---------------------------------------------------------------------------
// QSR-220 / signal: conversation records map to the correct conversation kind.
// ---------------------------------------------------------------------------
describe("QSR-220 signal: user/assistant conversation kinds", () => {
  test("user text -> signal(message)", () => {
    const rec = fromSchema(ClaudeUserRecordSchema, {
      ...envelope,
      type: "user",
      message: { role: "user", content: [{ type: "text", text: "synthetic prompt" }] },
    });
    const d = classifyClaudeRecord(rec);
    expect(d._tag).toBe("signal");
    if (d._tag === "signal") expect(d.kind).toBe("message");
  });

  test("user tool_result -> signal(tool_result)", () => {
    const rec = fromSchema(ClaudeUserRecordSchema, {
      ...envelope,
      type: "user",
      message: { role: "user", content: [{ type: "tool_result", tool_use_id: "tu_synthetic", content: "ok" }] },
    });
    const d = classifyClaudeRecord(rec);
    expect(d._tag === "signal" && d.kind).toBe("tool_result");
  });

  test("assistant text -> signal(message)", () => {
    const rec = fromSchema(ClaudeAssistantRecordSchema, {
      ...envelope,
      type: "assistant",
      message: { role: "assistant", content: [{ type: "text", text: "synthetic reply" }] },
    });
    const d = classifyClaudeRecord(rec);
    expect(d._tag === "signal" && d.kind).toBe("message");
  });

  test("assistant tool_use -> signal(tool_call)", () => {
    const rec = fromSchema(ClaudeAssistantRecordSchema, {
      ...envelope,
      type: "assistant",
      message: { role: "assistant", content: [{ type: "tool_use", id: "tu_synthetic", name: "ZzfabricatedToolQqq", input: {} }] },
    });
    const d = classifyClaudeRecord(rec);
    expect(d._tag === "signal" && d.kind).toBe("tool_call");
  });

  test("assistant thinking-only -> signal(reasoning)", () => {
    const rec = fromSchema(ClaudeAssistantRecordSchema, {
      ...envelope,
      type: "assistant",
      message: { role: "assistant", content: [{ type: "thinking", thinking: "synthetic reasoning" }] },
    });
    const d = classifyClaudeRecord(rec);
    expect(d._tag === "signal" && d.kind).toBe("reasoning");
  });
});

// ---------------------------------------------------------------------------
// QSR-220 / system subtypes: explicit signal(kind) or drop(reason).
// ---------------------------------------------------------------------------
describe("QSR-220 system subtype dispatch", () => {
  const sys = (subtype: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
    ...envelope,
    type: "system",
    subtype,
    ...extra,
  });

  test("away_summary -> signal(summary)", () => {
    const rec = fromSchema(ClaudeSystemAwaySummarySchema, sys("away_summary", { content: "synthetic away summary" }));
    const d = classifyClaudeRecord(rec);
    expect(d._tag === "signal" && d.kind).toBe("summary");
  });

  test("compact_boundary -> signal(summary)", () => {
    const rec = fromSchema(ClaudeSystemCompactBoundarySchema, sys("compact_boundary", { content: "synthetic compaction", level: "info" }));
    const d = classifyClaudeRecord(rec);
    expect(d._tag === "signal" && d.kind).toBe("summary");
  });

  test("local_command -> signal(message)", () => {
    const rec = fromSchema(ClaudeSystemLocalCommandSchema, sys("local_command", { content: "synthetic command", level: "info" }));
    const d = classifyClaudeRecord(rec);
    expect(d._tag === "signal" && d.kind).toBe("message");
  });

  test("scheduled_task_fire -> signal(message)", () => {
    const rec = fromSchema(ClaudeSystemScheduledTaskFireSchema, sys("scheduled_task_fire", { content: "synthetic fire" }));
    const d = classifyClaudeRecord(rec);
    expect(d._tag === "signal" && d.kind).toBe("message");
  });

  test("informational -> signal(system)", () => {
    const rec = fromSchema(ClaudeSystemInformationalSchema, sys("informational", { content: "synthetic notice", level: "notice" }));
    const d = classifyClaudeRecord(rec);
    expect(d._tag === "signal" && d.kind).toBe("system");
  });

  test("turn_duration -> drop(telemetry)", () => {
    const rec = fromSchema(ClaudeSystemTurnDurationSchema, sys("turn_duration", { durationMs: 1, messageCount: 1 }));
    const d = classifyClaudeRecord(rec);
    expect(d._tag).toBe("drop");
    if (d._tag === "drop") expect(d.reason).toContain("telemetry");
  });

  test("stop_hook_summary -> drop(telemetry)", () => {
    const rec = fromSchema(ClaudeSystemStopHookSummarySchema, sys("stop_hook_summary", { level: "suggestion", hookCount: 1 }));
    const d = classifyClaudeRecord(rec);
    expect(d._tag === "drop" && d.reason).toContain("stop-hook");
  });

  test("api_error -> drop(telemetry)", () => {
    const rec = fromSchema(ClaudeSystemApiErrorSchema, sys("api_error", { level: "error", error: "synthetic error" }));
    const d = classifyClaudeRecord(rec);
    expect(d._tag === "drop" && d.reason).toContain("api error");
  });

  test("unmodeled system subtype -> drop + named diagnostic (no throw)", () => {
    const diags: DecodeDiagnostic[] = [];
    const d = classifyClaudeRecord({ ...envelope, type: "system", subtype: "totally_fabricated_subtype" }, diags);
    expect(d._tag).toBe("drop");
    expect(diags.some((x) => x.name === "claude.system.unknown_subtype")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// QSR-220 / attachment subtypes: every modeled subtype is signal or drop.
// ---------------------------------------------------------------------------
describe("QSR-220 attachment subtype dispatch", () => {
  const att = (inner: Record<string, unknown>) => ({
    ...envelope,
    type: "attachment" as const,
    attachment: inner,
  });

  const SIGNAL_SUBTYPES: ReadonlyArray<[string, Record<string, unknown>]> = [
    ["queued_command", { commandMode: "prompt", prompt: "synthetic queued prompt" }],
    ["edited_text_file", { filename: "synthetic.txt", snippet: "synthetic snippet" }],
    ["file", { content: "synthetic content", displayPath: "synthetic.txt", filename: "synthetic.txt" }],
    ["directory", { content: "synthetic listing", displayPath: "syn/", path: FAB.cwd }],
    ["plan_file_reference", { planContent: "synthetic plan", planFilePath: "PLAN.md" }],
    ["compact_file_reference", { displayPath: "syn", filename: "syn.md" }],
    ["skill_listing", { content: "synthetic-skill-zzz", isInitial: true, names: ["synthetic-skill-zzz"], skillCount: 1 }],
    ["invoked_skills", { skills: ["synthetic-skill-zzz"] }],
    ["hook_success", { command: "synthetic", content: "synthetic out", exitCode: 0, hookEvent: "PostToolUse", hookName: "syn" }],
  ];

  for (const [subtype, inner] of SIGNAL_SUBTYPES) {
    test(`${subtype} -> signal(message)`, () => {
      const d = classifyClaudeRecord(att({ type: subtype, ...inner }));
      expect(d._tag).toBe("signal");
      if (d._tag === "signal") expect(d.kind).toBe("message");
    });
  }

  const DROP_SUBTYPES: ReadonlyArray<string> = [
    "deferred_tools_delta",
    "task_reminder",
    "command_permissions",
    "agent_listing_delta",
    "goal_status",
    "date_change",
    "ultra_effort_enter",
    "ultra_effort_exit",
    "plan_mode",
    "plan_mode_exit",
    "plan_mode_reentry",
    "workflow_keyword_request",
    "budget_usd",
  ];

  for (const subtype of DROP_SUBTYPES) {
    test(`${subtype} -> drop(bookkeeping)`, () => {
      const d = classifyClaudeRecord(att({ type: subtype }));
      expect(d._tag).toBe("drop");
      if (d._tag === "drop") expect(d.reason).toContain("bookkeeping");
    });
  }

  test("unmodeled attachment subtype -> drop + named diagnostic (no throw)", () => {
    const diags: DecodeDiagnostic[] = [];
    const d = classifyClaudeRecord(att({ type: "totally_fabricated_attachment" }), diags);
    expect(d._tag).toBe("drop");
    expect(diags.some((x) => x.name === "claude.attachment.unknown_subtype")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// QSR-220 / remaining top-level types.
// ---------------------------------------------------------------------------
describe("QSR-220 top-level type dispatch", () => {
  test("file-history-snapshot -> signal(snapshot)", () => {
    const rec = fromSchema(ClaudeFileHistorySnapshotSchema, {
      type: "file-history-snapshot",
      messageId: FAB.uuid,
      isSnapshotUpdate: false,
      snapshot: { trackedFileBackups: {} },
    });
    const d = classifyClaudeRecord(rec);
    expect(d._tag === "signal" && d.kind).toBe("snapshot");
  });

  test("ai-title -> signal(summary)", () => {
    const rec = fromSchema(ClaudeAiTitleSchema, { type: "ai-title", sessionId: FAB.sessionId, aiTitle: "synthetic title" });
    const d = classifyClaudeRecord(rec);
    expect(d._tag === "signal" && d.kind).toBe("summary");
  });

  const BOOKKEEPING: ReadonlyArray<[Schema.Schema<any, any>, Record<string, unknown>]> = [
    [ClaudeLastPromptSchema, { type: "last-prompt", sessionId: FAB.sessionId, lastPrompt: "x", leafUuid: FAB.uuid }],
    [ClaudeModeSchema, { type: "mode", sessionId: FAB.sessionId, mode: "default" }],
    [ClaudePermissionModeSchema, { type: "permission-mode", sessionId: FAB.sessionId, permissionMode: "default" }],
    [ClaudeQueueOperationSchema, { type: "queue-operation", sessionId: FAB.sessionId, operation: "enqueue", content: "x", timestamp: FAB.ts }],
    [ClaudeAgentSettingSchema, { type: "agent-setting", sessionId: FAB.sessionId, agentSetting: {} }],
    [ClaudeAgentNameSchema, { type: "agent-name", sessionId: FAB.sessionId, agentName: "synthetic-agent" }],
  ];

  for (const [schema, value] of BOOKKEEPING) {
    test(`${value.type} -> drop(session ui state)`, () => {
      const rec = fromSchema(schema, value);
      const d = classifyClaudeRecord(rec);
      expect(d._tag).toBe("drop");
      if (d._tag === "drop") expect(d.reason).toContain("session ui state");
    });
  }

  test("unmodeled top-level type -> drop + named diagnostic (no throw)", () => {
    const diags: DecodeDiagnostic[] = [];
    const d = classifyClaudeRecord({ type: "totally_fabricated_type", sessionId: FAB.sessionId }, diags);
    expect(d._tag).toBe("drop");
    expect(diags.some((x) => x.name === "claude.unknown_type")).toBe(true);
  });

  test("no record falls through to a generic unknown pass-through", () => {
    // A record with no type at all is still an EXPLICIT named drop, never a
    // silently-kept "unknown" event.
    const diags: DecodeDiagnostic[] = [];
    const d = classifyClaudeRecord({ sessionId: FAB.sessionId }, diags);
    expect(d._tag).toBe("drop");
    expect(diags.some((x) => x.name === "claude.unknown_type")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// QSR-220 / malformed records: NAMED diagnostic + drop, never a throw.
// ---------------------------------------------------------------------------
describe("QSR-220 malformed records -> named diagnostic + drop (no throw)", () => {
  test("user with non-object message -> claude.user.decode_failed", () => {
    const diags: DecodeDiagnostic[] = [];
    const d = classifyClaudeRecord({ type: "user", message: "not-an-object", sessionId: FAB.sessionId }, diags);
    expect(d._tag).toBe("drop");
    expect(diags.some((x) => x.name === "claude.user.decode_failed")).toBe(true);
  });

  test("assistant missing role -> claude.assistant.decode_failed", () => {
    const diags: DecodeDiagnostic[] = [];
    const d = classifyClaudeRecord({ type: "assistant", message: { content: [] }, sessionId: FAB.sessionId }, diags);
    expect(d._tag).toBe("drop");
    expect(diags.some((x) => x.name === "claude.assistant.decode_failed")).toBe(true);
  });

  test("system away_summary missing required content -> claude.system.decode_failed", () => {
    const diags: DecodeDiagnostic[] = [];
    const d = classifyClaudeRecord({ ...envelope, type: "system", subtype: "away_summary" }, diags);
    expect(d._tag).toBe("drop");
    expect(diags.some((x) => x.name === "claude.system.decode_failed")).toBe(true);
  });

  test("attachment with non-object attachment -> claude.attachment.unknown_subtype", () => {
    const diags: DecodeDiagnostic[] = [];
    const d = classifyClaudeRecord({ ...envelope, type: "attachment", attachment: 42 }, diags);
    expect(d._tag).toBe("drop");
    // A non-object attachment has no inner type -> named unknown-subtype drop.
    expect(diags.some((x) => x.name === "claude.attachment.unknown_subtype")).toBe(true);
  });

  test("file-history-snapshot wrong type literal -> claude.unknown_type", () => {
    const diags: DecodeDiagnostic[] = [];
    const d = classifyClaudeRecord({ type: "file-history-snapshotX" }, diags);
    expect(d._tag).toBe("drop");
    expect(diags.some((x) => x.name === "claude.unknown_type")).toBe(true);
  });

  test("classifier never throws on arbitrary garbage", () => {
    expect(() => classifyClaudeRecord(null)).not.toThrow();
    expect(() => classifyClaudeRecord(12345)).not.toThrow();
    expect(() => classifyClaudeRecord([{ nope: true }])).not.toThrow();
    expect(() => classifyClaudeRecord({ type: 99 })).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// QSR-220 / end-to-end: drops never become events; signals do; lineage intact.
// ---------------------------------------------------------------------------
describe("QSR-220 end-to-end through the adapter", () => {
  const root = mkdtempSync(join(tmpdir(), "quasar-claude-fidelity-"));
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  const SID = "deadbeef-0000-4000-8000-0000000000ee";
  const projectDir = join(root, "projects", "-Users-fixtureuser-fixtureapp");
  mkdirSync(projectDir, { recursive: true });

  const records = [
    // signal: user message (kept)
    { type: "user", sessionId: SID, uuid: "u1", message: { role: "user", content: [{ type: "text", text: "syn 1" }] } },
    // drop: harness bookkeeping attachment (NOT an event)
    { type: "attachment", sessionId: SID, uuid: "a1", parentUuid: "u1", attachment: { type: "deferred_tools_delta", addedNames: [] } },
    // drop: telemetry system (NOT an event)
    { type: "system", sessionId: SID, uuid: "s1", parentUuid: "u1", subtype: "turn_duration", durationMs: 5 },
    // signal: assistant message, parent points past the dropped records to u1
    { type: "assistant", sessionId: SID, uuid: "a2", parentUuid: "u1", message: { role: "assistant", content: [{ type: "text", text: "syn 2" }] } },
    // drop: session ui bookkeeping (NOT an event)
    { type: "mode", sessionId: SID, mode: "default" },
  ];
  writeFileSync(join(projectDir, `${SID}.jsonl`), records.map((r) => JSON.stringify(r)).join("\n"));

  test("only signal records become events", async () => {
    const result = await claudeAdapter.read({ machine: MACHINE, now: NOW, roots: { claude: root } });
    expect(result.sessions).toHaveLength(1);
    const session = result.sessions[0]!;
    // 5 on-disk records -> 2 kept events (user + assistant).
    expect(session.events).toHaveLength(2);
    expect(session.events.map((e) => e.kind)).toEqual(["message", "message"]);
    expect(session.events.map((e) => e.role)).toEqual(["user", "assistant"]);
  });

  test("lineage (parent edges) survives intervening dropped records", async () => {
    const result = await claudeAdapter.read({ machine: MACHINE, now: NOW, roots: { claude: root } });
    const session = result.sessions[0]!;
    // The assistant's parentUuid u1 must resolve to the kept user event id.
    const userEvent = session.events.find((e) => e.nativeEventId === "u1")!;
    const assistantEvent = session.events.find((e) => e.nativeEventId === "a2")!;
    expect(userEvent).toBeDefined();
    expect(assistantEvent.parentEventId).toBe(userEvent.id);
  });
});
