/**
 * Regression test for grok message-text extraction.
 *
 * Bug: text extraction stopped at the wrapper, so messages.text was raw JSON
 * for ~85% of grok records. For user/assistant turns where `content` is an
 * array of `{type:"text", text:"..."}` blocks, `compactText` serialised the
 * whole array as JSON instead of joining the leaf `.text` values.
 *
 * Fix: `extractGrokProse` peels the known per-harness grok envelope down to the
 * leaf message value:
 *   - chat_history records: `record.content` when string, or join
 *     `record.content[*].text` where item has `.text`
 *   - updates records: `params.update.content` (string | [{text}] | {text})
 *   - reasoning: `record.reasoning.summary[*].text` or `record.reasoning.text`
 *     → emitted as kind="reasoning" (role="thinking" per schema)
 *   - leading/trailing `<user_query></user_query>` wrapper stripped
 *
 * NON-NEGOTIABLE EXTRACTION RULE asserted here:
 *   - Extraction = peel the KNOWN per-harness envelope, keep leaf VERBATIM.
 *   - NEVER classify prose-vs-json. Agent-generated JSON is kept as-is.
 *   - contentText must NOT start with '{' (raw JSON envelope dump).
 *   - <user_query> structural wrapper is stripped; inner content kept verbatim.
 *   - Reasoning text is first-class: surfaces as kind="reasoning" event.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, test } from "bun:test";

import { extractGrokProse, grokAdapter } from "../src/adapters/grok";

const MACHINE = {
  machineId: "machine:test-grok-msgtext",
  hostname: "test-host-grok-msg",
  platform: "darwin",
};

const NOW = "2026-06-22T00:00:00.000Z";

const testRoot = mkdtempSync(join(tmpdir(), "quasar-grok-msgtext-"));

afterAll(() => {
  rmSync(testRoot, { recursive: true, force: true });
});

const writeJsonLines = (path: string, records: unknown[]) =>
  writeFileSync(path, records.map((r) => JSON.stringify(r)).join("\n") + "\n", "utf8");

// ===========================================================================
// Unit tests for extractGrokProse
// ===========================================================================

describe("extractGrokProse — envelope peeling unit tests", () => {
  test("string content returned verbatim", () => {
    const result = extractGrokProse({ type: "user", content: "hello from the user" });
    expect(result).toBe("hello from the user");
  });

  test("array content [{type:'text',text:'...'}] joins leaf text values", () => {
    const result = extractGrokProse({
      type: "assistant",
      content: [
        { type: "text", text: "first part" },
        { type: "text", text: " second part" },
      ],
    });
    expect(result).toBe("first part second part");
    // Must NOT be a JSON envelope dump
    expect(result).not.toMatch(/^\{/);
    expect(result).not.toMatch(/^\[/);
  });

  test("array content with only {text} items (no type field)", () => {
    const result = extractGrokProse({
      type: "user",
      content: [
        { text: "part one" },
        { text: " part two" },
      ],
    });
    expect(result).toBe("part one part two");
  });

  test("object content {type:'text',text:'...'} returns the text field", () => {
    const result = extractGrokProse({
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "streamed chunk" },
    });
    expect(result).toBe("streamed chunk");
  });

  test("strips <user_query>...</user_query> wrapper — inner content verbatim", () => {
    const result = extractGrokProse({
      type: "user",
      content: "<user_query>please explain this code</user_query>",
    });
    expect(result).toBe("please explain this code");
    expect(result).not.toContain("<user_query>");
    expect(result).not.toContain("</user_query>");
  });

  test("strips <user_query> wrapper in array content", () => {
    const result = extractGrokProse({
      type: "user",
      content: [{ type: "text", text: "<user_query>what does this do?</user_query>" }],
    });
    // The joined text has the wrapper stripped
    expect(result).toBe("what does this do?");
    expect(result).not.toContain("<user_query>");
  });

  test("agent-generated JSON inside content kept VERBATIM — no isMostlyProse gate", () => {
    const agentJson = '{"action":"create","path":"/tmp/foo.ts","content":"export const x = 1"}';
    const result = extractGrokProse({ type: "assistant", content: agentJson });
    // The JSON string IS the message content — kept as-is
    expect(result).toBe(agentJson);
    // It may start with '{' because THAT IS the content, not an envelope
    // (the rule is: don't return the RECORD envelope as JSON, not the content)
  });

  test("agent-generated JSON inside a text block array kept verbatim", () => {
    const agentJson = '{"result":"ok","count":3}';
    const result = extractGrokProse({
      type: "assistant",
      content: [{ type: "text", text: agentJson }],
    });
    expect(result).toBe(agentJson);
    // The RECORD envelope is not present; the JSON content is the leaf value
  });

  test("updates record: content nested in params.update.content (string)", () => {
    // For updates, we call extractGrokProse(innerUpdate) where innerUpdate = params.update
    const innerUpdate = {
      sessionUpdate: "agent_message_chunk",
      content: "streamed message text",
    };
    const result = extractGrokProse(innerUpdate);
    expect(result).toBe("streamed message text");
  });

  test("updates record: content nested in params.update.content (object with text)", () => {
    const innerUpdate = {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "streamed chunk from update" },
    };
    const result = extractGrokProse(innerUpdate);
    expect(result).toBe("streamed chunk from update");
  });

  test("text field fallback when no content field", () => {
    const result = extractGrokProse({ text: "direct text field" });
    expect(result).toBe("direct text field");
  });

  test("message field fallback", () => {
    const result = extractGrokProse({ message: "message field value" });
    expect(result).toBe("message field value");
  });

  test("undefined returned for records with no extractable text", () => {
    const result = extractGrokProse({ type: "backend_tool_call", kind: { tool_type: "web_search" } });
    expect(result).toBeUndefined();
  });

  test("empty record returns undefined", () => {
    expect(extractGrokProse({})).toBeUndefined();
  });

  test("strips <user_info>...</user_info> wrapper when it is the entire content", () => {
    // Harness-injected env context: the entire text block is the wrapper.
    const result = extractGrokProse({
      type: "user",
      content: "<user_info>\nOS Version: darwin 25.4.0\nShell: zsh\n</user_info>",
    });
    expect(result).toBe("OS Version: darwin 25.4.0\nShell: zsh");
    expect(result).not.toContain("<user_info>");
    expect(result).not.toContain("</user_info>");
  });

  test("strips <user_info> wrapper in array content when it is the entire block text", () => {
    const result = extractGrokProse({
      type: "user",
      content: [{ type: "text", text: "<user_info>\ncwd: /repo\ndate: 2026-06-22\n</user_info>" }],
    });
    expect(result).toBe("cwd: /repo\ndate: 2026-06-22");
    expect(result).not.toContain("<user_info>");
  });
});

// ===========================================================================
// Integration: full on-disk session verifies contentText is prose not JSON
// ===========================================================================

describe("grok message-text extraction — end-to-end", () => {
  const SESSION_UUID = "01900000-0000-7000-8000-fab00000cafe";
  const PROJECT_KEY = encodeURIComponent("/repo/grok-msgtext");

  test(
    "contentText is prose, not JSON envelope; <user_query> stripped; reasoning surfaces as kind=reasoning",
    async () => {
      const sessionDir = join(testRoot, "sessions", PROJECT_KEY, SESSION_UUID);
      mkdirSync(sessionDir, { recursive: true });

      writeJsonLines(join(sessionDir, "chat_history.jsonl"), [
        // String content — simple case
        { type: "user", content: "what does this function do?" },

        // Array content — the common grok shape causing the 85% JSON bug
        {
          type: "assistant",
          content: [
            { type: "text", text: "This function computes the hash of its input." },
          ],
        },

        // <user_query> wrapper — must be stripped
        { type: "user", content: "<user_query>explain the caching strategy</user_query>" },

        // Reasoning field with summary array — must surface as separate reasoning event
        {
          type: "assistant",
          content: [{ type: "text", text: "The cache uses LRU eviction." }],
          reasoning: {
            summary: [
              { type: "summary_text", text: "First, consider the read/write ratio." },
              { type: "summary_text", text: " Then evaluate eviction policy." },
            ],
          },
        },

        // Agent-generated JSON content — must be kept verbatim, NOT envelope-dumped
        {
          type: "assistant",
          content: [{ type: "text", text: '{"action":"write","path":"/tmp/x.ts"}' }],
        },
      ]);

      writeJsonLines(join(sessionDir, "updates.jsonl"), [
        // Update with content object — must extract leaf text
        {
          method: "session/update",
          params: {
            sessionId: SESSION_UUID,
            update: {
              sessionUpdate: "agent_message_chunk",
              content: { type: "text", text: "streaming chunk text" },
            },
          },
        },
      ]);

      const result = await grokAdapter.read({
        machine: MACHINE,
        now: NOW,
        roots: { grok: testRoot },
      });

      expect(result.sessions).toHaveLength(1);
      const session = result.sessions[0]!;

      // Find events by their content for clarity
      const chatEvents = session.events.filter(
        (e) => e.rawReference !== undefined &&
          typeof (e.rawReference as Record<string, unknown>).sourcePath === "string" &&
          ((e.rawReference as Record<string, unknown>).sourcePath as string).includes("chat_history"),
      );

      // ---- user turn: string content ----
      const userEvent1 = chatEvents.find(
        (e) => e.role === "user" && e.contentText?.includes("what does this function do"),
      );
      expect(userEvent1).toBeDefined();
      expect(userEvent1!.contentText).toBe("what does this function do?");
      // Must not be a JSON envelope dump
      expect(userEvent1!.contentText).not.toMatch(/^\{/);

      // ---- assistant turn: array content → joined prose ----
      const assistantEvent1 = chatEvents.find(
        (e) => e.role === "assistant" && e.contentText?.includes("computes the hash"),
      );
      expect(assistantEvent1).toBeDefined();
      expect(assistantEvent1!.contentText).toBe(
        "This function computes the hash of its input.",
      );
      // Must NOT be raw JSON array
      expect(assistantEvent1!.contentText).not.toMatch(/^\[/);
      expect(assistantEvent1!.contentText).not.toMatch(/^\{/);

      // ---- user turn: <user_query> wrapper stripped ----
      const userEvent2 = chatEvents.find(
        (e) => e.role === "user" && e.contentText?.includes("caching strategy"),
      );
      expect(userEvent2).toBeDefined();
      expect(userEvent2!.contentText).toBe("explain the caching strategy");
      expect(userEvent2!.contentText).not.toContain("<user_query>");
      expect(userEvent2!.contentText).not.toContain("</user_query>");

      // ---- reasoning event: surfaces BEFORE the assistant reply ----
      const reasoningEvent = session.events.find(
        (e) => e.kind === "reasoning" && e.contentText?.includes("read/write ratio"),
      );
      expect(reasoningEvent).toBeDefined();
      // Reasoning is first-class: contentText is the prose, not dropped
      expect(reasoningEvent!.contentText).toContain("First, consider the read/write ratio.");
      expect(reasoningEvent!.contentText).toContain("Then evaluate eviction policy.");
      // Role is "thinking" (the schema value for reasoning content)
      expect(reasoningEvent!.role).toBe("thinking");
      expect(reasoningEvent!.kind).toBe("reasoning");
      // Must NOT be a JSON envelope
      expect(reasoningEvent!.contentText).not.toMatch(/^\{/);

      // The matching assistant reply also has its content extracted
      const assistantWithReasoning = chatEvents.find(
        (e) => e.role === "assistant" && e.contentText?.includes("LRU eviction"),
      );
      expect(assistantWithReasoning).toBeDefined();
      expect(assistantWithReasoning!.contentText).toBe("The cache uses LRU eviction.");

      // ---- agent-generated JSON inside text block: kept verbatim ----
      const jsonContentEvent = chatEvents.find(
        (e) => e.role === "assistant" && e.contentText?.includes('"action":"write"'),
      );
      expect(jsonContentEvent).toBeDefined();
      // The JSON IS the content, kept as-is (no isMostlyProse gate)
      expect(jsonContentEvent!.contentText).toBe('{"action":"write","path":"/tmp/x.ts"}');

      // ---- update event: content object leaf extracted ----
      const updateEvent = session.events.find(
        (e) => e.contentText?.includes("streaming chunk text"),
      );
      expect(updateEvent).toBeDefined();
      expect(updateEvent!.contentText).toBe("streaming chunk text");
      expect(updateEvent!.contentText).not.toMatch(/^\{/);
    },
    15_000,
  );
});

// ===========================================================================
// Regression: standalone {type:"reasoning"} records and <user_info> stripping
// ===========================================================================

describe("grok standalone reasoning + user_info stripping — end-to-end", () => {
  const SESSION_UUID = "01900000-0000-7000-8000-fab00000dead";
  const PROJECT_KEY = encodeURIComponent("/repo/grok-standalone-reasoning");
  // Own root so this suite is fully isolated from the prior integration test.
  const standaloneRoot = mkdtempSync(join(tmpdir(), "quasar-grok-standalone-"));
  afterAll(() => {
    rmSync(standaloneRoot, { recursive: true, force: true });
  });

  test(
    "standalone type:reasoning records surface as kind=reasoning / role=thinking with non-empty contentText",
    async () => {
      const sessionDir = join(standaloneRoot, "sessions", PROJECT_KEY, SESSION_UUID);
      mkdirSync(sessionDir, { recursive: true });

      writeJsonLines(join(sessionDir, "chat_history.jsonl"), [
        // Harness-injected env context wrapped in <user_info> — the ENTIRE text
        // block is the wrapper; must be stripped and inner content kept verbatim.
        {
          type: "user",
          content: "<user_info>\nOS Version: darwin 25.4.0\nShell: zsh\ncwd: /repo\n</user_info>",
        },

        // STANDALONE type:"reasoning" — the DOMINANT grok shape (~86% of reasoning).
        // Top-level summary[*].text carries the plaintext. There is NO `content`
        // field. The prior code path only read record.reasoning (EMBEDDED shape
        // inside an assistant record), so standalone records yielded contentText=undefined.
        {
          type: "reasoning",
          id: "rs_test-001",
          status: "completed",
          encrypted_content: "OPAQUE_CIPHERTEXT",
          summary: [
            { type: "summary_text", text: "First I need to understand the call stack." },
            { type: "summary_text", text: " Then I'll check the error path." },
          ],
        },

        // Multi-item summary (realistic multi-sentence reasoning block)
        {
          type: "reasoning",
          id: "rs_test-002",
          status: "completed",
          summary: [
            { type: "summary_text", text: "The root cause is a missing null check." },
          ],
        },

        // The assistant reply that follows the reasoning
        {
          type: "assistant",
          content: [{ type: "text", text: "Here is my analysis of the stack." }],
        },

        // Actual user query (no wrapper — just plain content)
        { type: "user", content: "what is the root cause?" },
      ]);

      const result2 = await grokAdapter.read({
        machine: MACHINE,
        now: NOW,
        roots: { grok: standaloneRoot },
      });

      expect(result2.sessions).toHaveLength(1);
      const session = result2.sessions[0]!;

      // ---- <user_info> wrapper stripped ----
      const userInfoEvent = session.events.find(
        (e) => e.role === "user" && e.contentText?.includes("OS Version"),
      );
      expect(userInfoEvent).toBeDefined();
      expect(userInfoEvent!.contentText).toContain("OS Version: darwin 25.4.0");
      expect(userInfoEvent!.contentText).not.toContain("<user_info>");
      expect(userInfoEvent!.contentText).not.toContain("</user_info>");

      // ---- standalone reasoning: multi-item summary joined ----
      const reasoning1 = session.events.find(
        (e) => e.kind === "reasoning" && e.contentText?.includes("call stack"),
      );
      expect(reasoning1).toBeDefined();
      // contentText must be non-empty prose, NOT undefined / JSON envelope
      expect(reasoning1!.contentText).toBeTruthy();
      expect(reasoning1!.contentText).toContain("First I need to understand the call stack.");
      expect(reasoning1!.contentText).toContain("Then I'll check the error path.");
      // Canonical role/kind contract
      expect(reasoning1!.role).toBe("thinking");
      expect(reasoning1!.kind).toBe("reasoning");
      // Must NOT be a JSON envelope
      expect(reasoning1!.contentText).not.toMatch(/^\{/);
      expect(reasoning1!.contentText).not.toMatch(/^OPAQUE/);

      // ---- second standalone reasoning block ----
      const reasoning2 = session.events.find(
        (e) => e.kind === "reasoning" && e.contentText?.includes("null check"),
      );
      expect(reasoning2).toBeDefined();
      expect(reasoning2!.contentText).toBe("The root cause is a missing null check.");
      expect(reasoning2!.role).toBe("thinking");
      expect(reasoning2!.kind).toBe("reasoning");

      // ---- assistant reply ----
      const assistantReply = session.events.find(
        (e) => e.role === "assistant" && e.contentText?.includes("analysis"),
      );
      expect(assistantReply).toBeDefined();
      expect(assistantReply!.contentText).toBe("Here is my analysis of the stack.");
    },
    15_000,
  );
});
