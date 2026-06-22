import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, test } from "bun:test";

import { sessionIdFor } from "../src/adapters/common";
import { hermesAdapter } from "../src/adapters/hermes";
import { HermesSessionId } from "../src/core/identity";

// ---------------------------------------------------------------------------
// Regression tests for hermes message-text extraction (content envelope peeling).
//
// Bug: ~25% of messages.content stores a JSON blob (harness envelope) rather
// than plain prose. contentText was the raw blob, making those messages
// unsearchable.
//
// Fix:
//   • Plain prose → kept VERBATIM (no classification, no reformatting).
//   • JSON blob (starts with '{' or '[') → envelope peeled; only the leaf
//     text (.content or .parts[*].text) surfaces in contentText.
//   • Codex-bridged fallback → codex_message_items[*].content[*].text.
//   • Reasoning (reasoning_content, then reasoning) → emitted as a SEPARATE
//     event with kind="reasoning", role="thinking" so it is independently
//     searchable via contentText (not only in contentBlocks).
//
// EXTRACTION RULE: peel known harness envelope → leaf value VERBATIM.
//   NEVER classify prose-vs-json. NEVER reformat or flatten content.
//   Agent-generated JSON inside the leaf IS legitimate content and is kept.
//
// All fixtures are FABRICATED (year 2099 sentinel IDs) and resolve to ZERO
// rows on any real ~/.hermes estate.
// ---------------------------------------------------------------------------

const MACHINE = {
  machineId: "machine:test-extraction",
  hostname: "test-host",
  platform: "darwin",
};

const NOW = "2026-06-22T00:00:00.000Z";

// Minimal real schema shape (sessions + messages tables). Kept identical to
// the schema in hermes-adapter.test.ts to ensure fixture tables are compatible.
const SESSION_SCHEMA = `
create table sessions (
  id text primary key,
  source text not null,
  user_id text,
  model text,
  model_config text,
  system_prompt text,
  parent_session_id text,
  started_at real not null,
  ended_at real,
  end_reason text,
  message_count integer default 0,
  tool_call_count integer default 0,
  input_tokens integer default 0,
  output_tokens integer default 0,
  cache_read_tokens integer default 0,
  cache_write_tokens integer default 0,
  reasoning_tokens integer default 0,
  billing_provider text,
  billing_base_url text,
  billing_mode text,
  estimated_cost_usd real,
  actual_cost_usd real,
  cost_status text,
  cost_source text,
  pricing_version text,
  title text,
  api_call_count integer default 0,
  handoff_state text,
  handoff_platform text,
  handoff_error text,
  cwd text,
  rewind_count integer not null default 0,
  archived integer not null default 0,
  foreign key (parent_session_id) references sessions(id)
);
create table messages (
  id integer primary key autoincrement,
  session_id text not null references sessions(id),
  role text not null,
  content text,
  tool_call_id text,
  tool_calls text,
  tool_name text,
  timestamp real not null,
  token_count integer,
  finish_reason text,
  reasoning text,
  reasoning_content text,
  reasoning_details text,
  codex_reasoning_items text,
  codex_message_items text,
  platform_message_id text,
  observed integer default 0,
  active integer not null default 1
);
`;

const testRoot = mkdtempSync(join(tmpdir(), "quasar-hermes-extract-test-"));

afterAll(() => {
  rmSync(testRoot, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Helper: escape a string value for an SQLite literal.
// ---------------------------------------------------------------------------
const sqlStr = (value: string) => `'${value.replaceAll("'", "''")}'`;

// ---------------------------------------------------------------------------
// Fixture 1: JSON-blob content → prose extraction
//
// ~25% of real hermes messages.content is a JSON-encoded envelope such as:
//   {"content": "the actual assistant reply", "role": "assistant"}
// or the OpenAI array form:
//   [{"type": "text", "text": "the actual reply"}]
//
// contentText MUST be the leaf prose, NOT the raw JSON blob.
// ---------------------------------------------------------------------------
describe("content-extraction: JSON-blob row extracts to prose (not '{'-prefixed)", () => {
  const root = join(testRoot, "json-blob");
  mkdirSync(root, { recursive: true });

  const SID = "20990101_120000_11111111";
  // Object envelope: {content: "<prose>"}
  const jsonObjectBlob = JSON.stringify({ content: "the actual assistant reply", role: "assistant" });
  // Array envelope: [{type:"text", text:"<prose>"}]
  const jsonArrayBlob = JSON.stringify([{ type: "text", text: "the actual user message" }]);
  // parts envelope: {parts: [{text: "<prose>"}]}
  const jsonPartsBlob = JSON.stringify({ parts: [{ text: "reply from parts" }] });

  execFileSync("sqlite3", [
    join(root, "state.db"),
    SESSION_SCHEMA
    + `insert into sessions (id, source, title, cwd, started_at, message_count) values (${sqlStr(SID)}, 'cli', 'Blob fixture', NULL, 1000, 3);`
    + `insert into messages (session_id, role, content, timestamp) values (${sqlStr(SID)}, 'assistant', ${sqlStr(jsonObjectBlob)}, 1001);`
    + `insert into messages (session_id, role, content, timestamp) values (${sqlStr(SID)}, 'user', ${sqlStr(jsonArrayBlob)}, 1002);`
    + `insert into messages (session_id, role, content, timestamp) values (${sqlStr(SID)}, 'assistant', ${sqlStr(jsonPartsBlob)}, 1003);`,
  ]);

  test(
    "object-envelope blob: contentText is the inner prose, not a '{'-prefixed string",
    async () => {
      const result = await hermesAdapter.read({ machine: MACHINE, now: NOW, roots: { hermes: root } });
      const session = result.sessions.find((s) => s.id === sessionIdFor("hermes", HermesSessionId(SID)));
      expect(session).toBeDefined();

      // The first message event is the object-envelope blob.
      const assistantEvent = session!.events.find(
        (e) => e.role === "assistant" && e.sequence === 0,
      );
      expect(assistantEvent).toBeDefined();
      // contentText must NOT start with '{' or '['.
      expect(assistantEvent!.contentText).toBeDefined();
      expect(assistantEvent!.contentText!.startsWith("{")).toBe(false);
      expect(assistantEvent!.contentText!.startsWith("[")).toBe(false);
      // Must contain the actual prose.
      expect(assistantEvent!.contentText).toContain("actual assistant reply");
    },
    15_000,
  );

  test(
    "array-envelope blob: contentText is the leaf text, not a '['-prefixed string",
    async () => {
      const result = await hermesAdapter.read({ machine: MACHINE, now: NOW, roots: { hermes: root } });
      const session = result.sessions.find((s) => s.id === sessionIdFor("hermes", HermesSessionId(SID)));
      expect(session).toBeDefined();

      const userEvent = session!.events.find(
        (e) => e.role === "user",
      );
      expect(userEvent).toBeDefined();
      expect(userEvent!.contentText!.startsWith("[")).toBe(false);
      expect(userEvent!.contentText).toContain("actual user message");
    },
    15_000,
  );

  test(
    "parts-envelope blob: contentText joins parts[*].text",
    async () => {
      const result = await hermesAdapter.read({ machine: MACHINE, now: NOW, roots: { hermes: root } });
      const session = result.sessions.find((s) => s.id === sessionIdFor("hermes", HermesSessionId(SID)));
      expect(session).toBeDefined();

      // Third message (sequence 2) is the parts-envelope blob.
      const partsEvent = session!.events.find(
        (e) => e.role === "assistant" && e.sequence === 2,
      );
      expect(partsEvent).toBeDefined();
      expect(partsEvent!.contentText!.startsWith("{")).toBe(false);
      expect(partsEvent!.contentText).toContain("reply from parts");
    },
    15_000,
  );
});

// ---------------------------------------------------------------------------
// Fixture 2: Plain-prose row is unchanged
//
// A messages.content value that does NOT start with '{' or '[' must be kept
// VERBATIM — no compaction, no classification, no reformatting.
// ---------------------------------------------------------------------------
describe("content-extraction: plain-prose row is unchanged (verbatim)", () => {
  const root = join(testRoot, "plain-prose");
  mkdirSync(root, { recursive: true });

  const SID = "20990101_120000_22222222";
  const PROSE = "Hello, this is a plain prose message with no JSON wrapper.";

  execFileSync("sqlite3", [
    join(root, "state.db"),
    SESSION_SCHEMA
    + `insert into sessions (id, source, title, cwd, started_at, message_count) values (${sqlStr(SID)}, 'cli', 'Plain fixture', NULL, 1000, 1);`
    + `insert into messages (session_id, role, content, timestamp) values (${sqlStr(SID)}, 'user', ${sqlStr(PROSE)}, 1001);`,
  ]);

  test(
    "prose message: contentText equals the original prose (verbatim, not reformatted)",
    async () => {
      const result = await hermesAdapter.read({ machine: MACHINE, now: NOW, roots: { hermes: root } });
      const session = result.sessions.find((s) => s.id === sessionIdFor("hermes", HermesSessionId(SID)));
      expect(session).toBeDefined();

      const event = session!.events.find((e) => e.role === "user");
      expect(event).toBeDefined();
      // compactText normalises whitespace but keeps the prose content intact.
      expect(event!.contentText).toBeDefined();
      expect(event!.contentText).toContain("plain prose message");
      // Must not start with '{' or '[' (unchanged path).
      expect(event!.contentText!.startsWith("{")).toBe(false);
      expect(event!.contentText!.startsWith("[")).toBe(false);
    },
    15_000,
  );
});

// ---------------------------------------------------------------------------
// Fixture 3: Reasoning surfaces as role="thinking" + kind="reasoning"
//
// When messages.reasoning_content (or messages.reasoning) is present alongside
// a conversational content column, a SEPARATE event with kind="reasoning" and
// role="thinking" MUST be emitted so reasoning is independently searchable via
// contentText. The main content event is also emitted (two events from one row).
//
// When reasoning is present WITHOUT content (reasoning-only assistant turn),
// the single event's contentText must be the reasoning prose (not a JSON blob).
// ---------------------------------------------------------------------------
describe("content-extraction: reasoning surfaces as separate role=thinking event", () => {
  const root = join(testRoot, "reasoning");
  mkdirSync(root, { recursive: true });

  const SID = "20990101_120000_33333333";
  const PROSE_CONTENT = "Here is the final answer to your question.";
  const REASONING_TEXT = "Let me think step by step about this problem carefully.";
  const REASONING_ONLY_TEXT = "This is pure reasoning with no final content.";

  execFileSync("sqlite3", [
    join(root, "state.db"),
    SESSION_SCHEMA
    + `insert into sessions (id, source, title, cwd, started_at, message_count) values (${sqlStr(SID)}, 'cli', 'Reasoning fixture', NULL, 1000, 2);`
    // Row 1: assistant with BOTH content AND reasoning_content → should produce 2 events.
    + `insert into messages (session_id, role, content, reasoning_content, timestamp) values (${sqlStr(SID)}, 'assistant', ${sqlStr(PROSE_CONTENT)}, ${sqlStr(REASONING_TEXT)}, 1001);`
    // Row 2: assistant with reasoning_content ONLY (no content) → 1 event with kind=reasoning.
    + `insert into messages (session_id, role, content, reasoning_content, timestamp) values (${sqlStr(SID)}, 'assistant', NULL, ${sqlStr(REASONING_ONLY_TEXT)}, 1002);`,
  ]);

  test(
    "co-occurring content+reasoning: emits a role=thinking, kind=reasoning event with reasoning prose in contentText",
    async () => {
      const result = await hermesAdapter.read({ machine: MACHINE, now: NOW, roots: { hermes: root } });
      const session = result.sessions.find((s) => s.id === sessionIdFor("hermes", HermesSessionId(SID)));
      expect(session).toBeDefined();

      // Find the reasoning event emitted from the co-occurring row.
      const reasoningEvent = session!.events.find(
        (e) => e.role === "thinking" && e.kind === "reasoning",
      );
      expect(reasoningEvent).toBeDefined();
      // contentText must be the reasoning prose (searchable).
      expect(reasoningEvent!.contentText).toBeDefined();
      expect(reasoningEvent!.contentText).toContain("step by step");
      // Must NOT start with '{' or '['.
      expect(reasoningEvent!.contentText!.startsWith("{")).toBe(false);
    },
    15_000,
  );

  test(
    "co-occurring content+reasoning: the main message event still carries the prose content",
    async () => {
      const result = await hermesAdapter.read({ machine: MACHINE, now: NOW, roots: { hermes: root } });
      const session = result.sessions.find((s) => s.id === sessionIdFor("hermes", HermesSessionId(SID)));
      expect(session).toBeDefined();

      // The main event from the co-occurring row has kind="message", role="assistant".
      const mainEvent = session!.events.find(
        (e) => e.role === "assistant" && e.kind === "message",
      );
      expect(mainEvent).toBeDefined();
      expect(mainEvent!.contentText).toContain("final answer");
    },
    15_000,
  );

  test(
    "reasoning-only row: contentText is the reasoning prose (not a JSON blob or undefined)",
    async () => {
      const result = await hermesAdapter.read({ machine: MACHINE, now: NOW, roots: { hermes: root } });
      const session = result.sessions.find((s) => s.id === sessionIdFor("hermes", HermesSessionId(SID)));
      expect(session).toBeDefined();

      // The reasoning-only row (sequence after the co-occurring pair) produces
      // a single event with kind="reasoning", role="assistant" (no content).
      const reasoningOnlyEvent = session!.events.find(
        (e) => e.kind === "reasoning" && e.role === "assistant",
      );
      expect(reasoningOnlyEvent).toBeDefined();
      expect(reasoningOnlyEvent!.contentText).toBeDefined();
      expect(reasoningOnlyEvent!.contentText).toContain("pure reasoning");
      // Must not be a raw JSON blob.
      expect(reasoningOnlyEvent!.contentText!.startsWith("{")).toBe(false);
      expect(reasoningOnlyEvent!.contentText!.startsWith("[")).toBe(false);
    },
    15_000,
  );
});

// ---------------------------------------------------------------------------
// Fixture 4: Codex-bridged fallback
//
// When messages.content is absent or a JSON blob that yields no text, and
// codex_message_items is present, the fallback joins
// items[*].content[*].text for contentText.
// ---------------------------------------------------------------------------
describe("content-extraction: codex_message_items fallback when content is absent", () => {
  const root = join(testRoot, "codex-fallback");
  mkdirSync(root, { recursive: true });

  const SID = "20990101_120000_44444444";
  const codexItems = JSON.stringify([
    {
      type: "message",
      role: "assistant",
      status: "completed",
      id: "msg_fabricated_44444444",
      content: [
        { type: "output_text", text: "First part of codex reply." },
        { type: "output_text", text: "Second part of codex reply." },
      ],
    },
  ]);

  execFileSync("sqlite3", [
    join(root, "state.db"),
    SESSION_SCHEMA
    + `insert into sessions (id, source, title, cwd, started_at, message_count) values (${sqlStr(SID)}, 'cli', 'Codex fallback fixture', NULL, 1000, 1);`
    + `insert into messages (session_id, role, content, codex_message_items, timestamp) values (${sqlStr(SID)}, 'assistant', NULL, ${sqlStr(codexItems)}, 1001);`,
  ]);

  test(
    "codex-bridged message: contentText joins codex_message_items[*].content[*].text when content is absent",
    async () => {
      const result = await hermesAdapter.read({ machine: MACHINE, now: NOW, roots: { hermes: root } });
      const session = result.sessions.find((s) => s.id === sessionIdFor("hermes", HermesSessionId(SID)));
      expect(session).toBeDefined();

      // The assistant event from a codex-bridged row (no content column).
      const event = session!.events.find((e) => e.role === "assistant");
      expect(event).toBeDefined();
      expect(event!.contentText).toBeDefined();
      expect(event!.contentText).toContain("First part of codex reply");
      expect(event!.contentText).toContain("Second part of codex reply");
      expect(event!.contentText!.startsWith("{")).toBe(false);
      expect(event!.contentText!.startsWith("[")).toBe(false);
    },
    15_000,
  );
});
