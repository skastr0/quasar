/**
 * Regression test for the codex message-text extraction fix.
 *
 * Bug (pre-fix): streamCodexSessionFromFile projected the whole payload object
 * into contentText via compactText(projectSessionNativeValue(payloadValue)).
 * For event_msg.user_message / event_msg.agent_message the payload has no
 * `text` or `content` field, so compactText fell through to JSON.stringify,
 * producing '{"type":"user_message","message":"..."}' for 100% of codex messages.
 *
 * Fix: codexMessageText() peels the known per-harness envelope and returns the
 * verbatim leaf. The adapter uses the leaf for contentText; contentSource still
 * holds the full projected payload for content-block construction.
 *
 * NON-NEGOTIABLE EXTRACTION RULE verified here:
 *  - contentText must equal what the user/agent actually wrote (envelope removed)
 *  - contentText must NOT start with '{' or '[' due to envelope serialization
 *  - contentText must NOT equal the raw JSON record
 *  - reasoning records yield role="reasoning" (role="thinking" in SessionEvent)
 *    with prose contentText, not a serialized envelope
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, test } from "bun:test";

import { codexAdapter, codexMessageText } from "../src/adapters/codex";

const MACHINE = {
  machineId: "machine:test-msg-extract",
  hostname: "qsr-fab-extract-host",
  platform: "darwin",
};

const NOW = "2026-06-22T00:00:00.000Z";
const FIXTURE_CWD = "/qsr/fab/extract-proj";
const line = (value: unknown) => JSON.stringify(value);

// All UUIDs are fabricated in the 0fab-extract namespace — zero real matches.
const EXTRACT_UUID = "0fab0000-fab0-7fab-8fab-000000extr01";

const root = mkdtempSync(join(tmpdir(), "quasar-codex-extract-"));

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Unit tests for codexMessageText — no file I/O, pure logic.
// ---------------------------------------------------------------------------

describe("codexMessageText unit", () => {
  test("event_msg.user_message: returns payload.message verbatim", () => {
    const msg = "can you help me refactor this module?";
    const payload = { type: "user_message", message: msg };
    expect(codexMessageText("user_message", payload)).toBe(msg);
  });

  test("event_msg.user_message: agent-generated JSON body is kept verbatim", () => {
    // Agent-generated JSON is legitimate content — NOT reformatted or classified.
    const jsonBody = '{"action":"patch","files":["src/index.ts"]}';
    const payload = { type: "user_message", message: jsonBody };
    expect(codexMessageText("user_message", payload)).toBe(jsonBody);
  });

  test("event_msg.agent_message: returns payload.message verbatim", () => {
    const msg = "I have updated the file as requested.";
    const payload = { type: "agent_message", message: msg, phase: "response" };
    expect(codexMessageText("agent_message", payload)).toBe(msg);
  });

  test("event_msg.agent_message: empty message returns undefined", () => {
    const payload = { type: "agent_message", message: "", phase: "response" };
    expect(codexMessageText("agent_message", payload)).toBeUndefined();
  });

  test("response_item.message: string content is returned verbatim", () => {
    const text = "Here is the plan for the refactor.";
    const payload = { type: "message", role: "assistant", content: text };
    expect(codexMessageText("message", payload)).toBe(text);
  });

  test("response_item.message: typed content blocks — joins text fields with double newline", () => {
    const payload = {
      type: "message",
      role: "assistant",
      content: [
        { type: "output_text", text: "First paragraph." },
        { type: "output_text", text: "Second paragraph." },
      ],
    };
    const result = codexMessageText("message", payload);
    expect(result).toBe("First paragraph.\n\nSecond paragraph.");
  });

  test("response_item.message: single input_text block — returns that text", () => {
    const text = "qsr fabricated human question text";
    const payload = {
      type: "message",
      role: "user",
      content: [{ type: "input_text", text }],
    };
    expect(codexMessageText("message", payload)).toBe(text);
  });

  test("response_item.message: filters empty text blocks", () => {
    const payload = {
      type: "message",
      role: "assistant",
      content: [
        { type: "output_text", text: "" },
        { type: "output_text", text: "Non-empty content." },
      ],
    };
    expect(codexMessageText("message", payload)).toBe("Non-empty content.");
  });

  test("response_item.message: all-empty content returns undefined", () => {
    const payload = {
      type: "message",
      role: "assistant",
      content: [{ type: "output_text", text: "" }],
    };
    expect(codexMessageText("message", payload)).toBeUndefined();
  });

  test("response_item.reasoning: joins content block texts — no encrypted_content leakage", () => {
    const reasoningText = "Let me think through the algorithm step by step.";
    const payload = {
      type: "reasoning",
      content: [{ type: "thinking", text: reasoningText }],
      encrypted_content: "gAAAAAB-cipher-must-never-appear",
    };
    const result = codexMessageText("reasoning", payload);
    expect(result).toBe(reasoningText);
    expect(result).not.toContain("cipher");
    expect(result).not.toContain("gAAAAAB");
  });

  test("response_item.reasoning: falls back to summary text when content is absent/empty", () => {
    const summaryText = "Analyzed three approaches; chose approach B.";
    const payload = {
      type: "reasoning",
      summary: summaryText,
      encrypted_content: "gAAAAAB-cipher-must-never-appear",
    };
    const result = codexMessageText("reasoning", payload);
    expect(result).toBe(summaryText);
  });

  test("response_item.reasoning: empty content + empty summary → undefined", () => {
    const payload = {
      type: "reasoning",
      content: [],
      summary: [],
      encrypted_content: "gAAAAAB-cipher",
    };
    expect(codexMessageText("reasoning", payload)).toBeUndefined();
  });

  test("non-message payload type returns undefined (caller uses generic path)", () => {
    // function_call, token_count, etc. — no envelope peeling from this helper.
    expect(codexMessageText("function_call", { type: "function_call", name: "shell" })).toBeUndefined();
    expect(codexMessageText("token_count", { type: "token_count" })).toBeUndefined();
    expect(codexMessageText(undefined, {})).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Integration: verify end-to-end that messages.text in the mapped output
// does NOT contain the raw JSON envelope for the two most common shapes.
// ---------------------------------------------------------------------------

describe("codex message-text extraction (integration)", () => {
  test("event_msg.user_message contentText is the verbatim leaf — not a JSON envelope", async () => {
    const dir = join(root, "sessions", "2026", "06", "22");
    mkdirSync(dir, { recursive: true });
    const uuid = "0fab0000-fab0-7fab-8fab-000000extr01";
    const userText = "qsr fabricated user question for extraction regression";
    writeFileSync(
      join(dir, `rollout-2026-06-22T00-00-00-${uuid}.jsonl`),
      [
        line({
          timestamp: NOW,
          type: "session_meta",
          payload: { id: uuid, timestamp: NOW, cwd: FIXTURE_CWD, type: "session_meta" },
        }),
        // event_msg.user_message — this shape was broken before the fix.
        line({
          timestamp: NOW,
          type: "event_msg",
          payload: { type: "user_message", message: userText },
        }),
        // response_item.message with a typed content block (the "gold" channel).
        line({
          timestamp: NOW,
          type: "response_item",
          payload: {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "qsr fabricated assistant reply for extraction" }],
          },
        }),
      ].join("\n"),
    );

    const result = await codexAdapter.read({
      machine: MACHINE,
      now: NOW,
      roots: { codex: root },
    });

    const session = result.sessions.find((s) => s.nativeSessionId === uuid)!;
    expect(session).toBeDefined();

    // The event_msg.user_message event.
    const userMsgEvent = session.events.find(
      (ev) => ev.rawReference.nativeType === "event_msg.user_message",
    )!;
    expect(userMsgEvent).toBeDefined();
    expect(userMsgEvent.contentText).toBeDefined();
    // Must be the verbatim user text — NOT a JSON envelope.
    expect(userMsgEvent.contentText).toBe(userText);
    expect(userMsgEvent.contentText!.startsWith("{")).toBe(false);
    expect(userMsgEvent.contentText!.startsWith("[")).toBe(false);
    // Must not equal the raw serialized payload record.
    const rawPayload = JSON.stringify({ type: "user_message", message: userText });
    expect(userMsgEvent.contentText).not.toBe(rawPayload);
  });

  test("response_item.message contentText is the leaf block text — not a JSON envelope", async () => {
    // Use the session already written above.
    const uuid = "0fab0000-fab0-7fab-8fab-000000extr01";
    const result = await codexAdapter.read({
      machine: MACHINE,
      now: NOW,
      roots: { codex: root },
    });
    const session = result.sessions.find((s) => s.nativeSessionId === uuid)!;
    expect(session).toBeDefined();

    const assistantEvent = session.events.find(
      (ev) => ev.rawReference.nativeType === "response_item.message" && ev.role === "assistant",
    )!;
    expect(assistantEvent).toBeDefined();
    expect(assistantEvent.contentText).toBeDefined();
    expect(assistantEvent.contentText).toBe("qsr fabricated assistant reply for extraction");
    expect(assistantEvent.contentText!.startsWith("{")).toBe(false);
    expect(assistantEvent.contentText!.startsWith("[")).toBe(false);
  });

  test("response_item.reasoning yields role=thinking with prose contentText — no serialized envelope", async () => {
    const dir = join(root, "sessions", "2026", "06", "22", "reasoning");
    mkdirSync(dir, { recursive: true });
    const uuid = "0fab0000-fab0-7fab-8fab-000000extr02";
    const reasoningProse = "qsr fabricated reasoning: let me analyze the options carefully before responding.";
    writeFileSync(
      join(dir, `rollout-2026-06-22T01-00-00-${uuid}.jsonl`),
      [
        line({
          timestamp: NOW,
          type: "session_meta",
          payload: { id: uuid, timestamp: NOW, cwd: FIXTURE_CWD, type: "session_meta" },
        }),
        line({
          timestamp: NOW,
          type: "response_item",
          payload: {
            type: "reasoning",
            content: [{ type: "thinking", text: reasoningProse }],
            encrypted_content: "gAAAAAB-cipher-must-not-appear",
          },
        }),
        // Need a non-empty session to avoid buildCompleteSession returning undefined.
        line({
          timestamp: NOW,
          type: "response_item",
          payload: {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "qsr fabricated answer after reasoning" }],
          },
        }),
      ].join("\n"),
    );

    const result = await codexAdapter.read({
      machine: MACHINE,
      now: NOW,
      roots: { codex: root },
    });
    const session = result.sessions.find((s) => s.nativeSessionId === uuid)!;
    expect(session).toBeDefined();

    const reasoningEvent = session.events.find((ev) => ev.kind === "reasoning")!;
    expect(reasoningEvent).toBeDefined();
    // SessionRole for reasoning is "thinking" (per codexRoleFrom).
    expect(reasoningEvent.role).toBe("thinking");
    // contentText must be the verbatim reasoning prose.
    expect(reasoningEvent.contentText).toBe(reasoningProse);
    // Must NOT contain the encrypted content.
    expect(JSON.stringify(reasoningEvent)).not.toContain("gAAAAAB");
    expect(JSON.stringify(reasoningEvent)).not.toContain("cipher");
    // Must NOT be a serialized JSON envelope.
    expect(reasoningEvent.contentText!.startsWith("{")).toBe(false);
    expect(reasoningEvent.contentText!.startsWith("[")).toBe(false);
  });
});
