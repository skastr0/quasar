import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, test } from "bun:test";
import { Schema } from "effect";

import { opencodeAdapter } from "../src/adapters/opencode";
import { OpenCodeSessionId } from "../src/core/identity";
import { sessionIdFor } from "../src/adapters/common";
import { mapSession } from "../src/map";
import { isSignal, type DecodeDiagnostic } from "../src/adapters/harness-schema";
import {
  classifyOpenCodeMessage,
  classifyOpenCodePart,
  OpenCodeAssistantMessageSchema,
  OpenCodeCompactionPartSchema,
  OpenCodeFilePartSchema,
  OpenCodePatchPartSchema,
  OpenCodeReasoningPartSchema,
  OpenCodeStepFinishPartSchema,
  OpenCodeStepStartPartSchema,
  OpenCodeTextPartSchema,
  OpenCodeToolPartSchema,
  OpenCodeUserMessageSchema,
} from "../src/adapters/opencode-schema";

const MACHINE = {
  machineId: "machine:test",
  hostname: "test-host",
  platform: "darwin",
};

const NOW = "2026-06-11T00:00:00.000Z";

const SESSION_ID = "ses_test0001";

/**
 * Fixture mirrors the measured production shape: parts carry the session
 * content (text / reasoning / tool) plus machinery (step markers), and one
 * message row hides >1 MiB of `summary.diffs` garbage that the adapter's SQL
 * pruning guard strips before the data reaches this process.
 */
const FIXTURE_SQL = `
create table session (id text primary key, title text, directory text, time_created integer, time_updated integer);
create table message (id text primary key, session_id text, time_created integer, data text);
create table part (id text primary key, message_id text, session_id text, time_created integer, data text);

insert into session values ('${SESSION_ID}', 'profiling session', '/tmp/proj', 1, 9);

insert into message values ('msg_user', '${SESSION_ID}', 1, json_object('role', 'user', 'time', json_object('created', 1)));
insert into part values ('prt_user_text', 'msg_user', '${SESSION_ID}', 1, json_object('type', 'text', 'text', 'please profile the ingest'));

insert into message values ('msg_assistant', '${SESSION_ID}', 2, json_object('role', 'assistant', 'time', json_object('created', 2)));
insert into part values ('prt_step_start', 'msg_assistant', '${SESSION_ID}', 2, json_object('type', 'step-start'));
insert into part values ('prt_reasoning', 'msg_assistant', '${SESSION_ID}', 3, json_object('type', 'reasoning', 'text', 'I should measure first'));
insert into part values ('prt_text', 'msg_assistant', '${SESSION_ID}', 4, json_object('type', 'text', 'text', 'Measured; here is the plan.'));
insert into part values ('prt_tool', 'msg_assistant', '${SESSION_ID}', 5, json_object('type', 'tool', 'tool', 'bash', 'callID', 'call1', 'state', json_object('status', 'completed', 'input', json_object('command', 'ls'), 'output', 'file.txt')));
insert into part values ('prt_step_finish', 'msg_assistant', '${SESSION_ID}', 6, json_object('type', 'step-finish'));

-- Machinery-only turn: a compaction marker is not a session turn.
insert into message values ('msg_machinery', '${SESSION_ID}', 3, json_object('role', 'assistant', 'time', json_object('created', 3)));
insert into part values ('prt_compaction', 'msg_machinery', '${SESSION_ID}', 7, json_object('type', 'compaction', 'auto', json('true')));

-- Garbage source row: >1 MiB of summary.diffs (hex(zeroblob(600000)) is 1.2M chars),
-- pruned away in SQL — only raw_bytes can witness the breach downstream.
insert into message values ('msg_garbage', '${SESSION_ID}', 4, json_object('role', 'user', 'time', json_object('created', 4), 'summary', json_object('diffs', json_array(hex(zeroblob(600000))))));
insert into part values ('prt_garbage_text', 'msg_garbage', '${SESSION_ID}', 8, json_object('type', 'text', 'text', 'Continue'));

-- Empty stubs (measured 2026-06-11): an encrypted-reasoning part whose
-- plaintext is empty, and an empty text part. Machinery, not turns — neither
-- may surface as a JSON envelope dump.
insert into message values ('msg_empty', '${SESSION_ID}', 5, json_object('role', 'assistant', 'time', json_object('created', 5)));
insert into part values ('prt_empty_reasoning', 'msg_empty', '${SESSION_ID}', 9, json_object('type', 'reasoning', 'text', '', 'metadata', json_object('openai', json_object('reasoningEncryptedContent', 'gAAAAAB-cipher'))));
insert into part values ('prt_empty_text', 'msg_empty', '${SESSION_ID}', 10, json_object('type', 'text', 'text', ''));
`;

const root = mkdtempSync(join(tmpdir(), "quasar-opencode-test-"));
const dbPath = join(root, "opencode.db");
execFileSync("sqlite3", [dbPath, FIXTURE_SQL]);

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// AC#5 — idempotency proof (content-id provider, session.id DB field)
//
// OpenCode native id = `session.id` column from the SQLite DB.  The same id
// value at two DIFFERENT db file paths must resolve to byte-identical
// canonical session.id.  The test creates two identical DB files in separate
// temp dirs and asserts the results agree.
// ---------------------------------------------------------------------------
describe("AC#5 idempotency: same session.id in DB at different file paths → byte-identical session.id", () => {
  const IDEM_SESSION_ID = "ses_test0002";
  const IDEM_SQL = `
create table session (id text primary key, title text, directory text, time_created integer, time_updated integer);
create table message (id text primary key, session_id text, time_created integer, data text);
create table part (id text primary key, message_id text, session_id text, time_created integer, data text);
insert into session values ('${IDEM_SESSION_ID}', 'idempotency test', '/tmp/idem', 1, 2);
insert into message values ('msg_idem_user', '${IDEM_SESSION_ID}', 1, json_object('role', 'user', 'time', json_object('created', 1)));
insert into part values ('prt_idem_text', 'msg_idem_user', '${IDEM_SESSION_ID}', 1, json_object('type', 'text', 'text', 'idempotency check'));
`;

  const hostDir = mkdtempSync(join(tmpdir(), "quasar-oc-host-"));
  const dockerDir = mkdtempSync(join(tmpdir(), "quasar-oc-docker-"));

  afterAll(() => {
    rmSync(hostDir, { recursive: true, force: true });
    rmSync(dockerDir, { recursive: true, force: true });
  });

  execFileSync("sqlite3", [join(hostDir, "opencode.db"), IDEM_SQL]);
  execFileSync("sqlite3", [join(dockerDir, "opencode.db"), IDEM_SQL]);

  test(
    "host and docker reads produce byte-identical session.id",
    async () => {
      const hostResult = await opencodeAdapter.read({
        machine: MACHINE,
        now: NOW,
        roots: { opencode: hostDir },
      });
      const dockerResult = await opencodeAdapter.read({
        machine: MACHINE,
        now: NOW,
        roots: { opencode: dockerDir },
      });

      expect(hostResult.sessions).toHaveLength(1);
      expect(dockerResult.sessions).toHaveLength(1);
      // Canonical session.id must be byte-identical — the id comes from the
      // DB content, not from the file path.
      expect(hostResult.sessions[0]!.id).toBe(dockerResult.sessions[0]!.id);
      // The sourcePaths differ, proving the id is path-independent.
      expect(hostResult.sessions[0]!.sourcePath).not.toBe(dockerResult.sessions[0]!.sourcePath);
    },
    15_000,
  );
});

// ---------------------------------------------------------------------------
// QSR-220 — first-class subagents: session-to-session lineage.
//
// OpenCode subagents are rows in the same `session` table carrying their own
// `ses_` id, a non-null `parent_id` (the parent's `ses_` id), and a named
// `agent` column. The adapter must emit a canonical `subagent_of` SessionEdge
// whose `fromId` is the parent's canonical Quasar SessionId and project it onto
// `parentSessionId`, plus stamp `agentName` from the `agent` column. The
// fixture mirrors the real on-disk shape (a parent root row + a child subagent
// row); identifiers are fabricated.
// ---------------------------------------------------------------------------
describe("QSR-220 opencode subagent lineage", () => {
  // Real on-disk shape: `session` carries `parent_id` + `agent`. A child row
  // with a non-null parent_id is a subagent of the parent row.
  const PARENT_ID = "ses_fab00parent00aaaa";
  const CHILD_ID = "ses_fab00child000bbbb";
  const AGENT_NAME = "fab-subagent-role";
  const LINEAGE_SQL = `
create table session (
  id text primary key,
  parent_id text,
  title text not null,
  directory text not null,
  agent text,
  path text,
  time_created integer not null,
  time_updated integer not null
);
create table message (id text primary key, session_id text, time_created integer, data text);
create table part (id text primary key, message_id text, session_id text, time_created integer, data text);

-- Parent (root) session: parent_id NULL, no agent.
insert into session (id, parent_id, title, directory, agent, path, time_created, time_updated)
  values ('${PARENT_ID}', null, 'parent orchestration', '/tmp/proj', null, '/tmp/proj', 1, 10);
insert into message values ('msg_parent', '${PARENT_ID}', 1, json_object('role', 'user', 'time', json_object('created', 1)));
insert into part values ('prt_parent', 'msg_parent', '${PARENT_ID}', 1, json_object('type', 'text', 'text', 'spawn a subagent'));

-- Child subagent: parent_id points at the parent ses_ id, agent names the role.
insert into session (id, parent_id, title, directory, agent, path, time_created, time_updated)
  values ('${CHILD_ID}', '${PARENT_ID}', 'subagent run (@${AGENT_NAME})', '/tmp/proj', '${AGENT_NAME}', '/tmp/proj', 2, 9);
insert into message values ('msg_child', '${CHILD_ID}', 2, json_object('role', 'assistant', 'time', json_object('created', 2)));
insert into part values ('prt_child', 'msg_child', '${CHILD_ID}', 2, json_object('type', 'text', 'text', 'subagent reply'));
`;

  const lineageRoot = mkdtempSync(join(tmpdir(), "quasar-oc-lineage-"));
  execFileSync("sqlite3", [join(lineageRoot, "opencode.db"), LINEAGE_SQL]);

  afterAll(() => {
    rmSync(lineageRoot, { recursive: true, force: true });
  });

  test(
    "child's parentSessionId resolves to the parent's canonical SessionId and agentName is set",
    async () => {
      const result = await opencodeAdapter.read({
        machine: MACHINE,
        now: NOW,
        roots: { opencode: lineageRoot },
      });

      expect(result.sessions).toHaveLength(2);
      const parent = result.sessions.find((s) =>
        s.id === sessionIdFor("opencode", OpenCodeSessionId(PARENT_ID)),
      )!;
      const child = result.sessions.find((s) =>
        s.id === sessionIdFor("opencode", OpenCodeSessionId(CHILD_ID)),
      )!;
      expect(parent).toBeDefined();
      expect(child).toBeDefined();

      // Canonical lineage: the child emits a single `subagent_of` edge whose
      // fromId is the parent's canonical SessionId (toId is the child).
      const subagentEdges = child.sessionEdges.filter((edge) => edge.kind === "subagent_of");
      expect(subagentEdges).toHaveLength(1);
      expect(subagentEdges[0]!.fromId).toBe(parent.id);
      expect(subagentEdges[0]!.toId).toBe(child.id);
      // No event-threading `parent` edge masquerades as session lineage.
      // The native parent id is preserved in rawReference.
      expect((subagentEdges[0]!.rawReference as Record<string, unknown>).nativeValue).toBe(PARENT_ID);

      // The agent column becomes agentName; the root session stays "opencode".
      expect(child.agentName).toBe(AGENT_NAME);
      expect(parent.agentName).toBe("opencode");

      // mapSession projects subagent_of onto the served parentSessionId column.
      const mappedChild = mapSession(child, "fp");
      expect(mappedChild.session.parentSessionId).toBe(parent.id);
      // The root session has no parent lineage projected.
      const mappedParent = mapSession(parent, "fp");
      expect(mappedParent.session.parentSessionId).toBeUndefined();
    },
    15_000,
  );
});

describe("opencode adapter", () => {
  test(
    "maps parts to turns, drops machinery, and reports pre-prune raw bytes",
    async () => {
      const result = await opencodeAdapter.read({
        machine: MACHINE,
        now: NOW,
        roots: { opencode: root },
      });

      expect(result.sessions).toHaveLength(1);
      const session = result.sessions[0]!;
      expect(session.events).toHaveLength(6);

      // User text part becomes a text block.
      const userEvent = session.events[0]!;
      expect(userEvent.role).toBe("user");
      expect(userEvent.kind).toBe("message");
      expect(userEvent.contentBlocks.map((block) => [block.kind, block.text])).toEqual([
        ["text", "please profile the ingest"],
      ]);

      // Assistant turn: reasoning surfaces as a thinking block, visible text as
      // a text block, the tool part is tagged tool_use machinery, and step
      // markers never appear.
      const assistantEvent = session.events[1]!;
      expect(assistantEvent.kind).toBe("tool_call");
      const kinds = assistantEvent.contentBlocks.map((block) => block.kind);
      expect(kinds).toEqual(["thinking", "text", "text"]);
      expect(assistantEvent.contentBlocks[0]?.thinking).toBe("I should measure first");
      expect(assistantEvent.contentBlocks[1]?.text).toBe("Measured; here is the plan.");
      const toolBlockMetadata = assistantEvent.contentBlocks[2]?.metadata as
        | Record<string, unknown>
        | undefined;
      expect(toolBlockMetadata?.nativeType).toBe("tool_use");
      expect(JSON.stringify(assistantEvent.contentBlocks)).not.toContain("step-start");
      expect(JSON.stringify(assistantEvent.contentBlocks)).not.toContain("step-finish");

      // Tool part maps to a ToolCall with state.input/state.output payloads.
      expect(session.toolCalls).toHaveLength(1);
      expect(session.toolCalls[0]).toMatchObject({
        toolName: "bash",
        status: "completed",
        input: { command: "ls" },
        output: "file.txt",
      });

      // QSR-224: the assistant's reasoning part surfaces as a SEPARATE
      // kind="reasoning"/role="thinking" event so reasoning is role-filterable in search.
      const reasoningEvent = session.events[2]!;
      expect(reasoningEvent.role).toBe("thinking");
      expect(reasoningEvent.kind).toBe("reasoning");
      expect(reasoningEvent.contentText).toBe("I should measure first");

      // Machinery-only turn carries no content at all.
      const machineryEvent = session.events[3]!;
      expect(machineryEvent.contentText).toBeUndefined();
      expect(machineryEvent.contentBlocks).toHaveLength(0);

      // The garbage row: SQL pruning removed summary.diffs from the projected
      // content, and rawBytes reports the pre-prune size for the ingest line.
      const garbageEvent = session.events[4]!;
      expect(garbageEvent.rawReference.rawBytes).toBeGreaterThanOrEqual(1_048_576);
      expect(JSON.stringify(garbageEvent.contentBlocks).length).toBeLessThan(10_000);
      // Sound rows still report small raw byte counts.
      expect(userEvent.rawReference.rawBytes).toBeLessThan(1_000);

      // Empty stubs (blank reasoning plaintext, blank text) are machinery: the
      // event carries no turn content, so no {"type":"reasoning"} envelope dump
      // can reach the search surface.
      const emptyEvent = session.events[5]!;
      expect(emptyEvent.role).toBe("assistant");
      expect(emptyEvent.contentText).toBeUndefined();
      expect(emptyEvent.contentBlocks).toHaveLength(0);
      expect(JSON.stringify(emptyEvent)).not.toContain("gAAAAAB");
    },
    15_000,
  );
});

// ---------------------------------------------------------------------------
// QSR-220 FULL DATA FIDELITY — declarative per-record-type signal/drop dispatch.
//
// The on-disk census (measured 2026-06-21 across opencode.db +
// opencode-local.db) is EXHAUSTIVE:
//   message.data.role : { user, assistant }
//   part.data.type    : { text, reasoning, tool, step-start, step-finish,
//                         compaction, patch, file }
// Every record type is EXPLICITLY classified — signal(kind) or drop(named
// reason) — and an unrecognised type/role is itself a NAMED drop. There is NO
// "unknown" pass-through. Every fixture below is built FROM the Effect schema
// via `Schema.encodeSync`, so a schema field change breaks the fixture rather
// than letting a stale hand-typed shape sneak through. All identifiers and
// content are FABRICATED (verified to resolve to ZERO real on-disk data).
// ---------------------------------------------------------------------------
describe("QSR-220 full data fidelity: declarative per-record-type dispatch", () => {
  // Fixtures-from-schema: encode a typed value through its schema to produce the
  // on-disk JSON shape. `encodeSync` round-trips the decoded type back to the
  // unknown-input shape the classifier consumes.
  const textPart = Schema.encodeSync(OpenCodeTextPartSchema)({
    type: "text",
    text: "qsr220 fabricated visible answer",
  });
  const reasoningPart = Schema.encodeSync(OpenCodeReasoningPartSchema)({
    type: "reasoning",
    text: "qsr220 fabricated reasoning trace",
    time: { start: 1, end: 2 },
  });
  const reasoningStubPart = Schema.encodeSync(OpenCodeReasoningPartSchema)({
    type: "reasoning",
    text: "",
    time: { start: 1, end: 2 },
  });
  const toolCompletedPart = Schema.encodeSync(OpenCodeToolPartSchema)({
    type: "tool",
    tool: "qsr220-fab-tool",
    callID: "qsr220fabcall0001",
    state: { status: "completed", input: { arg: "x" }, output: "ok", time: { start: 1, end: 2 } },
  });
  const toolRunningPart = Schema.encodeSync(OpenCodeToolPartSchema)({
    type: "tool",
    tool: "qsr220-fab-tool",
    callID: "qsr220fabcall0002",
    state: { status: "running", input: { arg: "y" }, output: null, time: { start: 3, end: null } },
  });
  const toolErrorPart = Schema.encodeSync(OpenCodeToolPartSchema)({
    type: "tool",
    tool: "qsr220-fab-tool",
    callID: "qsr220fabcall0003",
    state: { status: "error", input: null, output: "boom", time: { start: 4, end: 5 } },
  });
  const stepStartPart = Schema.encodeSync(OpenCodeStepStartPartSchema)({ type: "step-start" });
  const stepFinishPart = Schema.encodeSync(OpenCodeStepFinishPartSchema)({
    type: "step-finish",
    reason: "stop",
    cost: 0.01,
  });
  const compactionPart = Schema.encodeSync(OpenCodeCompactionPartSchema)({
    type: "compaction",
    auto: true,
    tail_start_id: "qsr220fabtail0001",
  });
  const filePart = Schema.encodeSync(OpenCodeFilePartSchema)({
    type: "file",
    filename: "qsr220-fab-file.txt",
    mime: "text/plain",
    url: "file://qsr220-fab",
  });
  const patchPart = Schema.encodeSync(OpenCodePatchPartSchema)({
    type: "patch",
    hash: "qsr220fabhash000deadbeef",
    files: ["qsr220-fab-file.txt"],
  });
  const userMessage = Schema.encodeSync(OpenCodeUserMessageSchema)({
    role: "user",
    time: { created: 1, start: null, end: null },
  });
  const assistantMessage = Schema.encodeSync(OpenCodeAssistantMessageSchema)({
    role: "assistant",
    time: { created: 2, start: null, end: null },
  });

  // --- one test per PART record type: signal(kind) / drop(named reason) -----

  test("part text -> signal(message)", () => {
    const d = classifyOpenCodePart(textPart);
    expect(isSignal(d) && d.kind).toBe("message");
  });

  test("part reasoning -> signal(reasoning)", () => {
    const d = classifyOpenCodePart(reasoningPart);
    expect(isSignal(d) && d.kind).toBe("reasoning");
  });

  test("part reasoning empty-text stub still decodes -> signal(reasoning)", () => {
    // The stub is a legitimate decoded record (signal); it is the CONTENT
    // projection — not the classifier — that refuses to surface empty text.
    const d = classifyOpenCodePart(reasoningStubPart);
    expect(isSignal(d) && d.kind).toBe("reasoning");
  });

  test("part tool (completed) -> signal(tool_result)", () => {
    const d = classifyOpenCodePart(toolCompletedPart);
    expect(isSignal(d) && d.kind).toBe("tool_result");
  });

  test("part tool (error) -> signal(tool_result)", () => {
    const d = classifyOpenCodePart(toolErrorPart);
    expect(isSignal(d) && d.kind).toBe("tool_result");
  });

  test("part tool (running) -> signal(tool_call)", () => {
    const d = classifyOpenCodePart(toolRunningPart);
    expect(isSignal(d) && d.kind).toBe("tool_call");
  });

  test("part patch -> signal(artifact)", () => {
    const d = classifyOpenCodePart(patchPart);
    expect(isSignal(d) && d.kind).toBe("artifact");
  });

  test("part step-start -> drop(machinery)", () => {
    const d = classifyOpenCodePart(stepStartPart);
    expect(d._tag).toBe("drop");
    expect(d._tag === "drop" && d.reason).toBe("opencode.part.step-start.machinery");
  });

  test("part step-finish -> drop(machinery)", () => {
    const d = classifyOpenCodePart(stepFinishPart);
    expect(d._tag === "drop" && d.reason).toBe("opencode.part.step-finish.machinery");
  });

  test("part compaction -> drop(machinery)", () => {
    const d = classifyOpenCodePart(compactionPart);
    expect(d._tag === "drop" && d.reason).toBe("opencode.part.compaction.machinery");
  });

  test("part file -> drop(machinery)", () => {
    const d = classifyOpenCodePart(filePart);
    expect(d._tag === "drop" && d.reason).toBe("opencode.part.file.machinery");
  });

  // --- one test per MESSAGE record type: signal(kind) -----------------------

  test("message user -> signal(user_message)", () => {
    const d = classifyOpenCodeMessage(userMessage);
    expect(isSignal(d) && d.kind).toBe("user_message");
  });

  test("message assistant -> signal(assistant_message)", () => {
    const d = classifyOpenCodeMessage(assistantMessage);
    expect(isSignal(d) && d.kind).toBe("assistant_message");
  });

  // --- ZERO unknown pass-through: unrecognised type/role is a NAMED drop -----

  test("unrecognised part type -> NAMED drop diagnostic, no passthrough, no throw", () => {
    const diagnostics: DecodeDiagnostic[] = [];
    const d = classifyOpenCodePart(
      { type: "qsr220-fab-unknown-part", text: "should never pass through" },
      diagnostics,
    );
    expect(d._tag).toBe("drop");
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]!.name).toBe("opencode.part.decode_failed");
  });

  test("unrecognised message role -> NAMED drop diagnostic, no passthrough", () => {
    const diagnostics: DecodeDiagnostic[] = [];
    const d = classifyOpenCodeMessage({ role: "qsr220-fab-unknown-role" }, diagnostics);
    expect(d._tag).toBe("drop");
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]!.name).toBe("opencode.message.decode_failed");
  });

  // --- malformed-record test per MAJOR part type: NAMED diagnostic + drop ----

  test("malformed text part (text not a string) -> NAMED drop, no throw", () => {
    const diagnostics: DecodeDiagnostic[] = [];
    const d = classifyOpenCodePart({ type: "text", text: 42 }, diagnostics);
    expect(d._tag).toBe("drop");
    expect(diagnostics[0]!.name).toBe("opencode.part.decode_failed");
  });

  test("malformed reasoning part (missing text) -> NAMED drop, no throw", () => {
    const diagnostics: DecodeDiagnostic[] = [];
    const d = classifyOpenCodePart({ type: "reasoning", time: { start: 1, end: 2 } }, diagnostics);
    expect(d._tag).toBe("drop");
    expect(diagnostics[0]!.name).toBe("opencode.part.decode_failed");
  });

  test("malformed tool part (tool name not a string) -> NAMED drop, no throw", () => {
    const diagnostics: DecodeDiagnostic[] = [];
    const d = classifyOpenCodePart({ type: "tool", tool: { nested: true } }, diagnostics);
    expect(d._tag).toBe("drop");
    expect(diagnostics[0]!.name).toBe("opencode.part.decode_failed");
  });

  test("malformed patch part (hash wrong type) -> NAMED drop, no throw", () => {
    const diagnostics: DecodeDiagnostic[] = [];
    const d = classifyOpenCodePart({ type: "patch", hash: 7 }, diagnostics);
    expect(d._tag).toBe("drop");
    expect(diagnostics[0]!.name).toBe("opencode.part.decode_failed");
  });

  test("malformed message payload (role wrong type) -> NAMED drop, no throw", () => {
    const diagnostics: DecodeDiagnostic[] = [];
    const d = classifyOpenCodeMessage({ role: 99 }, diagnostics);
    expect(d._tag).toBe("drop");
    expect(diagnostics[0]!.name).toBe("opencode.message.decode_failed");
  });

  test("garbage payloads never throw (fail-closed boundary)", () => {
    for (const garbage of [null, undefined, 42, "raw string", [], { no: "type" }]) {
      expect(() => classifyOpenCodePart(garbage)).not.toThrow();
      expect(() => classifyOpenCodeMessage(garbage)).not.toThrow();
      expect(classifyOpenCodePart(garbage)._tag).toBe("drop");
      expect(classifyOpenCodeMessage(garbage)._tag).toBe("drop");
    }
  });
});
