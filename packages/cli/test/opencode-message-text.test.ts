/**
 * Regression test for opencode message-text extraction.
 *
 * Bug: eventFromMessage previously passed the entire content record to
 * compactText, which JSON-serialised the envelope when no top-level .text /
 * .content string field was present.  For messages whose visible text lives
 * in part rows (the normal opencode case), contentText was raw JSON starting
 * with '{'.
 *
 * Fix: partsContentText joins type==="text" part leaf .text fields in part
 * order, never touching the envelope and never including reasoning parts.
 * Reasoning parts surface as a SEPARATE kind="reasoning"/role="thinking" event
 * so reasoning is independently role-filterable in the search index.
 *
 * NON-NEGOTIABLE EXTRACTION RULE asserted here:
 *   - contentText must equal what the user/agent actually wrote, envelope stripped.
 *   - contentText must NOT start with '{' (raw JSON envelope dump).
 *   - Reasoning text must NOT appear in the assistant event's contentText.
 *   - Reasoning text must appear in a separate kind="reasoning"/role="thinking"
 *     event whose contentText is the reasoning prose.
 *   - Agent-generated JSON inside a text part is legitimate content and is
 *     kept verbatim (no isMostlyProse gate).
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, test } from "bun:test";

import { opencodeAdapter } from "../src/adapters/opencode";

const MACHINE = {
  machineId: "machine:test-msg-text",
  hostname: "test-host-msg",
  platform: "darwin",
};

const NOW = "2026-06-22T00:00:00.000Z";

// ---------------------------------------------------------------------------
// Fixture: a single session with a multi-part assistant message that has
// both a reasoning part and a visible-text part.  The message row itself
// carries no top-level .content / .text string — all content lives in the
// part rows.  This is the normal opencode on-disk shape.
// ---------------------------------------------------------------------------
const SESSION_ID = "ses_msgtxt0001";

const FIXTURE_SQL = `
create table session (id text primary key, title text, directory text, time_created integer, time_updated integer);
create table message (id text primary key, session_id text, time_created integer, data text);
create table part (id text primary key, message_id text, session_id text, time_created integer, data text);

insert into session values ('${SESSION_ID}', 'msg-text regression', '/tmp/msgtext', 1, 10);

-- User turn: single text part, content lives in the part row only.
insert into message values ('msg_u', '${SESSION_ID}', 1, json_object('role', 'user', 'time', json_object('created', 1)));
insert into part values ('prt_u_text', 'msg_u', '${SESSION_ID}', 1, json_object('type', 'text', 'text', 'explain the plan'));

-- Assistant turn: reasoning first, then visible text, then a tool call.
-- No .content / .text string on the message row itself.
insert into message values ('msg_a', '${SESSION_ID}', 2, json_object('role', 'assistant', 'time', json_object('created', 2)));
insert into part values ('prt_step_start', 'msg_a', '${SESSION_ID}', 2, json_object('type', 'step-start'));
insert into part values ('prt_reasoning', 'msg_a', '${SESSION_ID}', 3, json_object('type', 'reasoning', 'text', 'step one: reason about the plan'));
insert into part values ('prt_text', 'msg_a', '${SESSION_ID}', 4, json_object('type', 'text', 'text', 'Here is the plan.'));
insert into part values ('prt_tool', 'msg_a', '${SESSION_ID}', 5, json_object('type', 'tool', 'tool', 'bash', 'callID', 'call_r1', 'state', json_object('status', 'completed', 'input', json_object('command', 'echo hi'), 'output', 'hi')));
insert into part values ('prt_step_finish', 'msg_a', '${SESSION_ID}', 6, json_object('type', 'step-finish', 'reason', 'stop'));

-- Agent-generated JSON in a text part: must be kept verbatim, no isMostlyProse gate.
insert into message values ('msg_json', '${SESSION_ID}', 3, json_object('role', 'assistant', 'time', json_object('created', 3)));
insert into part values ('prt_json_text', 'msg_json', '${SESSION_ID}', 7, json_object('type', 'text', 'text', '{"result":"ok","count":3}'));
`;

const root = mkdtempSync(join(tmpdir(), "quasar-oc-msgtext-"));
const dbPath = join(root, "opencode.db");
execFileSync("sqlite3", [dbPath, FIXTURE_SQL]);

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("opencode message-text extraction", () => {
  test(
    "contentText is joined part prose, not a JSON envelope dump",
    async () => {
      const result = await opencodeAdapter.read({
        machine: MACHINE,
        now: NOW,
        roots: { opencode: root },
      });

      expect(result.sessions).toHaveLength(1);
      const session = result.sessions[0]!;

      // The assistant message with reasoning emits TWO events (assistant +
      // reasoning), so the session has 4 events total:
      //   [0] user turn
      //   [1] assistant turn (visible text only, NO reasoning)
      //   [2] reasoning turn (kind="reasoning", role="thinking")
      //   [3] agent-JSON assistant turn
      expect(session.events).toHaveLength(4);

      // --- user turn ---
      const userEvent = session.events[0]!;
      expect(userEvent.role).toBe("user");
      // contentText must be the leaf part text, not a JSON envelope.
      expect(userEvent.contentText).toBe("explain the plan");
      expect(userEvent.contentText).not.toMatch(/^\{/);

      // --- assistant turn ---
      const assistantEvent = session.events[1]!;
      expect(assistantEvent.role).toBe("assistant");

      // contentText must NOT be raw JSON (the envelope bug).
      expect(assistantEvent.contentText).toBeDefined();
      expect(assistantEvent.contentText).not.toMatch(/^\{/);

      // contentText must contain ONLY the visible text part — reasoning is
      // excluded from the assistant event and surfaces separately.
      expect(assistantEvent.contentText).toContain("Here is the plan.");
      expect(assistantEvent.contentText).not.toContain("step one: reason about the plan");

      // Visible text part surfaces as kind="text" block.
      const textBlock = assistantEvent.contentBlocks.find(
        (b) => b.kind === "text" && b.text === "Here is the plan.",
      );
      expect(textBlock).toBeDefined();

      // Step markers never leak into content.
      expect(JSON.stringify(assistantEvent.contentBlocks)).not.toContain("step-start");
      expect(JSON.stringify(assistantEvent.contentBlocks)).not.toContain("step-finish");

      // --- reasoning turn (co-occurring with the assistant message) ---
      const reasoningEvent = session.events[2]!;
      expect(reasoningEvent.kind).toBe("reasoning");
      expect(reasoningEvent.role).toBe("thinking");

      // contentText must be the reasoning prose verbatim.
      expect(reasoningEvent.contentText).toBeDefined();
      expect(reasoningEvent.contentText).toContain("step one: reason about the plan");
      // Reasoning event must NOT contain the assistant's visible text.
      expect(reasoningEvent.contentText).not.toContain("Here is the plan.");

      // --- agent-generated JSON turn ---
      // A text part whose value is JSON must be kept verbatim: no isMostlyProse
      // gate, no reformatting, no dropping.
      const jsonEvent = session.events[3]!;
      expect(jsonEvent.contentText).toBeDefined();
      // The raw JSON string is the content — it must appear as-is.
      expect(jsonEvent.contentText).toContain('{"result":"ok","count":3}');
      // It must NOT be double-serialised (no outer envelope wrapping the inner JSON).
      expect(jsonEvent.contentText).not.toMatch(/^\{.*"parts":/s);
    },
    15_000,
  );
});
