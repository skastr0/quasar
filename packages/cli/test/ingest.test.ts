import { describe, expect, test } from "bun:test";

import type {
  ContentBlock,
  NormalizedSession,
  SessionEvent,
  ToolCall,
} from "@skastr0/quasar-core";

import { mapClaudeSession } from "../src/commands/ingest";

const MACHINE_ID = "machine:test";
const SESSION_ID = "claude:machine:test:abc";
const PROJECT_KEY = "path:machine:test:proj";
const SOURCE_PATH = "/tmp/projects/-tmp-proj/abc.jsonl";

const baseEvent = (overrides: Partial<SessionEvent> & Pick<SessionEvent, "id" | "sequence" | "role" | "kind">): SessionEvent => ({
  sessionId: SESSION_ID,
  machineId: MACHINE_ID,
  provider: "claude",
  agentName: "claude-code",
  projectIdentityKey: PROJECT_KEY,
  contentBlocks: [],
  rawReference: { sourcePath: SOURCE_PATH },
  ...overrides,
});

const block = (overrides: Partial<ContentBlock> & Pick<ContentBlock, "kind">): ContentBlock => ({
  id: `${SESSION_ID}:block:${Math.random()}`,
  sequence: 0,
  ...overrides,
});

const toolCall = (overrides: Partial<ToolCall> & Pick<ToolCall, "id" | "eventId" | "toolName">): ToolCall => ({
  sessionId: SESSION_ID,
  machineId: MACHINE_ID,
  provider: "claude",
  agentName: "claude-code",
  projectIdentityKey: PROJECT_KEY,
  ...overrides,
});

const session = (overrides: Partial<NormalizedSession>): NormalizedSession => ({
  id: SESSION_ID,
  nativeSessionId: "abc",
  provider: "claude",
  agentName: "claude-code",
  machineId: MACHINE_ID,
  projectIdentity: {
    projectIdentityKey: PROJECT_KEY,
    displayName: "proj",
    confidence: "low",
    rawPath: "/tmp/proj",
    normalizedPath: "/tmp/proj",
    signals: [{ kind: "path", value: "/tmp/proj", confidence: "low" }],
  },
  sourceRoot: "/tmp/projects",
  sourcePath: SOURCE_PATH,
  events: [],
  toolCalls: [],
  sessionEdges: [],
  usageRecords: [],
  artifacts: [],
  ...overrides,
});

describe("mapClaudeSession", () => {
  test("maps plain user/assistant text turns with seq and ts", () => {
    const mapped = mapClaudeSession(
      session({
        events: [
          baseEvent({
            id: "e0",
            sequence: 3,
            role: "user",
            kind: "message",
            timestamp: "2026-06-09T22:09:38.654Z",
            contentText: "how do I run the tests",
          }),
          baseEvent({
            id: "e1",
            sequence: 4,
            role: "assistant",
            kind: "message",
            contentBlocks: [
              block({
                kind: "text",
                text: "run bun test",
                metadata: { nativeType: "text" },
              }),
            ],
          }),
        ],
      }),
    );
    expect(mapped.messages).toEqual([
      {
        sessionId: SESSION_ID,
        seq: 3,
        role: "user",
        text: "how do I run the tests",
        ts: "2026-06-09T22:09:38.654Z",
        projectKey: PROJECT_KEY,
      },
      {
        sessionId: SESSION_ID,
        seq: 4,
        role: "assistant",
        text: "run bun test",
        projectKey: PROJECT_KEY,
      },
    ]);
    expect(mapped.session.messageCount).toBe(2);
    expect(mapped.diagnostics).toHaveLength(0);
  });

  test("promotes non-empty thinking blocks to role reasoning and drops empty stubs", () => {
    const mapped = mapClaudeSession(
      session({
        events: [
          // Non-empty thinking + text in the same assistant event.
          baseEvent({
            id: "e0",
            sequence: 5,
            role: "assistant",
            kind: "message",
            contentBlocks: [
              block({
                kind: "thinking",
                thinking: "the user wants a JSON reply",
                metadata: { nativeType: "thinking" },
              }),
              block({
                kind: "text",
                text: "Here is the JSON.",
                sequence: 1,
                metadata: { nativeType: "text" },
              }),
            ],
          }),
          // Empty-thinking stub: adapter renders it as a text block carrying
          // the JSON marker with nativeType "thinking". Must produce no row.
          baseEvent({
            id: "e1",
            sequence: 6,
            role: "assistant",
            kind: "message",
            contentText: '{"type":"thinking"}',
            contentBlocks: [
              block({
                kind: "text",
                text: '{"type":"thinking"}',
                metadata: { nativeType: "thinking" },
              }),
            ],
          }),
        ],
      }),
    );
    expect(mapped.messages).toEqual([
      {
        sessionId: SESSION_ID,
        seq: 5,
        role: "reasoning",
        text: "the user wants a JSON reply",
        projectKey: PROJECT_KEY,
      },
      {
        sessionId: SESSION_ID,
        seq: 5,
        role: "assistant",
        text: "Here is the JSON.",
        projectKey: PROJECT_KEY,
      },
    ]);
  });

  test("excludes tool machinery from messages and maps toolCalls rows faithfully", () => {
    const mapped = mapClaudeSession(
      session({
        events: [
          baseEvent({
            id: "e-call",
            sequence: 10,
            role: "assistant",
            kind: "tool_call",
            timestamp: "2026-06-09T22:10:26.999Z",
            toolCallId: "tc1",
            contentBlocks: [
              block({
                kind: "text",
                text: '{"type":"tool_use","name":"Bash"}',
                metadata: { nativeType: "tool_use" },
              }),
            ],
          }),
          baseEvent({
            id: "e-result",
            sequence: 11,
            role: "user",
            kind: "tool_result",
            toolCallId: "tc1",
            contentBlocks: [
              block({
                kind: "text",
                text: '{"type":"tool_result"}',
                metadata: { nativeType: "tool_result" },
              }),
            ],
          }),
        ],
        toolCalls: [
          toolCall({
            id: "tc1",
            eventId: "e-call",
            toolName: "Bash",
            status: "completed",
            input: { command: "ls", description: "List files" },
            output: "file.txt",
            startedAt: "2026-06-09T22:10:26.999Z",
            completedAt: "2026-06-09T22:10:27.009Z",
          }),
        ],
      }),
    );
    // Tool machinery never becomes message rows.
    expect(mapped.messages).toHaveLength(0);
    expect(mapped.toolCalls).toEqual([
      {
        sessionId: SESSION_ID,
        seq: 10,
        toolName: "Bash",
        status: "completed",
        inputText: '{"command":"ls","description":"List files"}',
        outputText: "file.txt",
        startedAt: "2026-06-09T22:10:26.999Z",
        completedAt: "2026-06-09T22:10:27.009Z",
        projectKey: PROJECT_KEY,
        provider: "claude",
      },
    ]);
    expect(mapped.session.toolCallCount).toBe(1);
  });

  test("rejects any text at or beyond the boundary with a named diagnostic and zero rows", () => {
    const garbage = "x".repeat(900_000);
    const mapped = mapClaudeSession(
      session({
        events: [
          baseEvent({
            id: "e0",
            sequence: 0,
            role: "user",
            kind: "message",
            contentText: garbage,
          }),
          baseEvent({
            id: "e1",
            sequence: 1,
            role: "user",
            kind: "message",
            contentText: "a normal turn",
          }),
        ],
        toolCalls: [
          toolCall({
            id: "tc-big",
            eventId: "e0",
            toolName: "Bash",
            input: { command: "ok" },
            output: garbage,
          }),
        ],
      }),
    );
    expect(mapped.messages).toEqual([
      {
        sessionId: SESSION_ID,
        seq: 1,
        role: "user",
        text: "a normal turn",
        projectKey: PROJECT_KEY,
      },
    ]);
    expect(mapped.toolCalls).toHaveLength(0);
    expect(mapped.diagnostics).toEqual([
      {
        provider: "claude",
        sessionId: SESSION_ID,
        field: "messages.text",
        observedBytes: 900_000,
      },
      {
        provider: "claude",
        sessionId: SESSION_ID,
        field: "toolCalls.outputText",
        observedBytes: 900_000,
      },
    ]);
    expect(mapped.session.messageCount).toBe(1);
    expect(mapped.session.toolCallCount).toBe(0);
  });

  test("applies redactSensitive to every written text", () => {
    const mapped = mapClaudeSession(
      session({
        events: [
          baseEvent({
            id: "e0",
            sequence: 0,
            role: "user",
            kind: "message",
            contentText: "my key is sk-abcdefghijklmnopqrstuvwxyz123456",
          }),
        ],
        toolCalls: [
          toolCall({
            id: "tc1",
            eventId: "e0",
            toolName: "Bash",
            input: { command: "export API_KEY=supersecretvalue123" },
            output: "Bearer abc.def.ghi-token-value",
          }),
        ],
      }),
    );
    expect(mapped.messages[0]?.text).toBe("my key is [redacted]");
    expect(mapped.toolCalls[0]?.inputText).not.toContain("supersecretvalue123");
    expect(mapped.toolCalls[0]?.outputText).toBe("Bearer [redacted]");
  });
});
