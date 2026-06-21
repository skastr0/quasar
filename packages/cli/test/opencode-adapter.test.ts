import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, test } from "bun:test";

import { opencodeAdapter } from "../src/adapters/opencode";
import { OpenCodeSessionId } from "../src/core/identity";
import { sessionIdFor } from "../src/adapters/common";
import { mapSession } from "../src/map";

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
      expect(session.events).toHaveLength(5);

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

      // Machinery-only turn carries no content at all.
      const machineryEvent = session.events[2]!;
      expect(machineryEvent.contentText).toBeUndefined();
      expect(machineryEvent.contentBlocks).toHaveLength(0);

      // The garbage row: SQL pruning removed summary.diffs from the projected
      // content, and rawBytes reports the pre-prune size for the ingest line.
      const garbageEvent = session.events[3]!;
      expect(garbageEvent.rawReference.rawBytes).toBeGreaterThanOrEqual(1_048_576);
      expect(JSON.stringify(garbageEvent.contentBlocks).length).toBeLessThan(10_000);
      // Sound rows still report small raw byte counts.
      expect(userEvent.rawReference.rawBytes).toBeLessThan(1_000);

      // Empty stubs (blank reasoning plaintext, blank text) are machinery: the
      // event carries no turn content, so no {"type":"reasoning"} envelope dump
      // can reach the search surface.
      const emptyEvent = session.events[4]!;
      expect(emptyEvent.role).toBe("assistant");
      expect(emptyEvent.contentText).toBeUndefined();
      expect(emptyEvent.contentBlocks).toHaveLength(0);
      expect(JSON.stringify(emptyEvent)).not.toContain("gAAAAAB");
    },
    15_000,
  );
});
