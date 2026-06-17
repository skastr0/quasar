import { describe, expect, test } from "bun:test";

import type {
  ContentBlock,
  NormalizedSession,
  SessionEvent,
  ToolCall,
} from "@skastr0/quasar-core";

import { mapNormalizedSession, PROVIDER_INGEST_HOOKS } from "../src/commands/ingest";

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

describe("mapNormalizedSession", () => {
  test("maps plain user/assistant text turns with seq and ts", () => {
    const mapped = mapNormalizedSession(
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
    const mapped = mapNormalizedSession(
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
    const mapped = mapNormalizedSession(
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

  test("admits values below the Convex 1 MiB limit and rejects at the limit with a named diagnostic", () => {
    // The boundary is Convex's own 1 MiB value limit — no invented budget. A
    // value just under it is legitimate (if rare) data and must be admitted.
    const large = "y".repeat(1_048_575);
    const mappedLarge = mapNormalizedSession(
      session({
        events: [
          baseEvent({
            id: "e-large",
            sequence: 0,
            role: "user",
            kind: "message",
            contentText: large,
          }),
        ],
      }),
    );
    expect(mappedLarge.messages).toHaveLength(1);
    expect(mappedLarge.diagnostics).toHaveLength(0);

    const garbage = "x".repeat(1_048_576);
    const mapped = mapNormalizedSession(
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
        observedBytes: 1_048_576,
      },
      {
        provider: "claude",
        sessionId: SESSION_ID,
        field: "toolCalls.outputText",
        observedBytes: 1_048_576,
      },
    ]);
    expect(mapped.session.messageCount).toBe(1);
    expect(mapped.session.toolCallCount).toBe(0);
  });

  test("skips injected preamble/system/summary events even when they carry user or assistant roles", () => {
    const mapped = mapNormalizedSession(
      session({
        events: [
          baseEvent({
            id: "e-preamble",
            sequence: 0,
            role: "user",
            kind: "preamble",
            contentText: "<user_instructions>injected wrapper</user_instructions>",
          }),
          baseEvent({
            id: "e-system",
            sequence: 1,
            role: "user",
            kind: "system",
            contentText: "permission mode changed",
          }),
          baseEvent({
            id: "e-summary",
            sequence: 2,
            role: "assistant",
            kind: "summary",
            contentText: "compaction summary of prior turns",
          }),
          baseEvent({
            id: "e-real",
            sequence: 3,
            role: "user",
            kind: "message",
            contentText: "a human-authored turn",
          }),
        ],
      }),
    );
    expect(mapped.messages).toEqual([
      {
        sessionId: SESSION_ID,
        seq: 3,
        role: "user",
        text: "a human-authored turn",
        projectKey: PROJECT_KEY,
      },
    ]);
    expect(mapped.session.messageCount).toBe(1);
  });

  test("applies redactSensitive to every written text", () => {
    const mapped = mapNormalizedSession(
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

describe("mapNormalizedSession with codex hooks", () => {
  const codexHooks = PROVIDER_INGEST_HOOKS.get("codex")!;

  const codexEvent = (
    overrides: Partial<SessionEvent> &
      Pick<SessionEvent, "id" | "sequence" | "role" | "kind"> & {
        readonly nativeType: string;
      },
  ): SessionEvent => {
    const { nativeType, ...rest } = overrides;
    return baseEvent({
      provider: "codex",
      agentName: "codex",
      rawReference: { sourcePath: SOURCE_PATH, nativeType },
      ...rest,
    });
  };

  test("admits only response_item message events: event_msg duplicates never become rows", () => {
    const mapped = mapNormalizedSession(
      session({
        provider: "codex",
        agentName: "codex",
        events: [
          codexEvent({
            id: "e-canonical",
            sequence: 0,
            role: "user",
            kind: "message",
            nativeType: "response_item.message",
            contentBlocks: [block({ kind: "text", text: "please fix the bug" })],
          }),
          // event_msg duplicates the same content — never ingested.
          codexEvent({
            id: "e-dup",
            sequence: 1,
            role: "user",
            kind: "message",
            nativeType: "event_msg.user_message",
            contentText: "please fix the bug",
          }),
          codexEvent({
            id: "e-final-dup",
            sequence: 2,
            role: "assistant",
            kind: "message",
            nativeType: "event_msg.agent_message",
            contentText: "done, the bug is fixed",
          }),
          codexEvent({
            id: "e-reply",
            sequence: 3,
            role: "assistant",
            kind: "message",
            nativeType: "response_item.message",
            contentBlocks: [block({ kind: "text", text: "done, the bug is fixed" })],
          }),
        ],
      }),
      codexHooks,
    );
    expect(mapped.messages.map((row) => [row.seq, row.role, row.text])).toEqual([
      [0, "user", "please fix the bug"],
      [3, "assistant", "done, the bug is fixed"],
    ]);
  });

  test("keeps tool payloads out of messages: tool events map only via toolCalls", () => {
    const mapped = mapNormalizedSession(
      session({
        provider: "codex",
        agentName: "codex",
        events: [
          // codex function_call events render their JSON payload as fallback
          // text blocks; the hook must keep them off the search surface.
          codexEvent({
            id: "e-call",
            sequence: 0,
            role: "assistant",
            kind: "tool_call",
            nativeType: "response_item.function_call",
            toolCallId: "tc1",
            contentBlocks: [
              block({ kind: "text", text: '{"type":"function_call","name":"shell"}' }),
            ],
          }),
          codexEvent({
            id: "e-preamble",
            sequence: 1,
            role: "user",
            kind: "preamble",
            nativeType: "response_item.message",
            contentBlocks: [block({ kind: "text", text: "<environment_context>injected</environment_context>" })],
          }),
        ],
        toolCalls: [
          toolCall({
            id: "tc1",
            eventId: "e-call",
            toolName: "shell",
            status: "completed",
            input: { command: ["ls"] },
            output: "file.txt",
          }),
        ],
      }),
      codexHooks,
    );
    expect(mapped.messages).toHaveLength(0);
    expect(mapped.toolCalls).toHaveLength(1);
    expect(mapped.toolCalls[0]?.toolName).toBe("shell");
    expect(mapped.toolCalls[0]?.provider).toBe("codex");
  });
});

describe("mapNormalizedSession with opencode hooks", () => {
  const opencodeHooks = PROVIDER_INGEST_HOOKS.get("opencode")!;

  const opencodeEvent = (
    overrides: Partial<SessionEvent> &
      Pick<SessionEvent, "id" | "sequence" | "role" | "kind"> & {
        readonly rawBytes?: number;
      },
  ): SessionEvent => {
    const { rawBytes, ...rest } = overrides;
    return baseEvent({
      provider: "opencode",
      agentName: "opencode",
      rawReference: {
        sourcePath: SOURCE_PATH,
        table: "message",
        nativeType: "message",
        ...(rawBytes !== undefined ? { rawBytes } : {}),
      },
      ...rest,
    });
  };

  test("maps text parts to messages and thinking blocks to role reasoning", () => {
    const mapped = mapNormalizedSession(
      session({
        provider: "opencode",
        agentName: "opencode",
        events: [
          opencodeEvent({
            id: "e0",
            sequence: 0,
            role: "user",
            kind: "message",
            rawBytes: 240,
            contentBlocks: [block({ kind: "text", text: "please profile the ingest" })],
          }),
          opencodeEvent({
            id: "e1",
            sequence: 1,
            role: "assistant",
            kind: "tool_call",
            rawBytes: 512,
            contentBlocks: [
              block({
                kind: "thinking",
                thinking: "I should measure first",
                metadata: { nativeType: "reasoning" },
              }),
              block({
                kind: "text",
                text: "Measured; here is the plan.",
                sequence: 1,
                metadata: { nativeType: "text" },
              }),
              // Tool part rendering — tool payloads live in toolCalls only.
              block({
                kind: "text",
                text: '{"type":"tool","toolName":"bash","callID":"call1"}',
                sequence: 2,
                metadata: { nativeType: "tool_use", toolName: "bash", callId: "call1" },
              }),
            ],
          }),
        ],
        toolCalls: [
          toolCall({
            id: "tc1",
            eventId: "e1",
            toolName: "bash",
            status: "completed",
            input: { command: "ls" },
            output: "file.txt",
          }),
        ],
      }),
      opencodeHooks,
    );
    expect(mapped.messages.map((row) => [row.seq, row.role, row.text])).toEqual([
      [0, "user", "please profile the ingest"],
      [1, "reasoning", "I should measure first"],
      [1, "assistant", "Measured; here is the plan."],
    ]);
    expect(mapped.toolCalls).toHaveLength(1);
    expect(mapped.toolCalls[0]?.toolName).toBe("bash");
    expect(mapped.diagnostics).toHaveLength(0);
  });

  test("a source row at or beyond the Convex value limit is provider garbage: named diagnostic, zero rows", () => {
    // The 105 MB summary.diffs blob is pruned away inside SQLite, so the
    // post-prune value cannot witness the breach — the adapter's pre-prune
    // rawBytes measurement carries it to the boundary line instead.
    const mapped = mapNormalizedSession(
      session({
        provider: "opencode",
        agentName: "opencode",
        events: [
          opencodeEvent({
            id: "e-garbage",
            sequence: 0,
            role: "user",
            kind: "message",
            rawBytes: 105_806_336,
            // Pruning left a perfectly small projection — rejected anyway.
            contentBlocks: [block({ kind: "text", text: "Continue" })],
          }),
          opencodeEvent({
            id: "e-sound",
            sequence: 1,
            role: "assistant",
            kind: "message",
            rawBytes: 180,
            contentBlocks: [block({ kind: "text", text: "a sound turn" })],
          }),
        ],
        toolCalls: [
          // A tool call hanging off the rejected event writes zero rows too.
          toolCall({
            id: "tc-garbage",
            eventId: "e-garbage",
            toolName: "bash",
            input: { command: "ok" },
            output: "fine",
          }),
        ],
      }),
      opencodeHooks,
    );
    expect(mapped.messages).toEqual([
      {
        sessionId: SESSION_ID,
        seq: 1,
        role: "assistant",
        text: "a sound turn",
        projectKey: PROJECT_KEY,
      },
    ]);
    expect(mapped.toolCalls).toHaveLength(0);
    expect(mapped.diagnostics).toEqual([
      {
        provider: "opencode",
        sessionId: SESSION_ID,
        field: "message.data",
        observedBytes: 105_806_336,
      },
    ]);
    expect(mapped.session.messageCount).toBe(1);
    expect(mapped.session.toolCallCount).toBe(0);
  });
});

describe("mapNormalizedSession with hermes hooks", () => {
  const hermesHooks = PROVIDER_INGEST_HOOKS.get("hermes")!;

  test("hermes hooks are registered and admit all user/assistant turns", () => {
    const mapped = mapNormalizedSession(
      session({
        provider: "hermes",
        agentName: "hermes",
        events: [
          baseEvent({
            id: "e0",
            sequence: 0,
            role: "user",
            kind: "message",
            contentText: "describe the current architecture",
          }),
          baseEvent({
            id: "e1",
            sequence: 1,
            role: "assistant",
            kind: "message",
            contentBlocks: [
              block({ kind: "text", text: "The architecture uses Convex as its backend." }),
            ],
          }),
        ],
      }),
      hermesHooks,
    );
    expect(mapped.messages.map((r) => [r.seq, r.role, r.text])).toEqual([
      [0, "user", "describe the current architecture"],
      [1, "assistant", "The architecture uses Convex as its backend."],
    ]);
    expect(mapped.diagnostics).toHaveLength(0);
  });
});

describe("mapNormalizedSession with grok hooks", () => {
  const grokHooks = PROVIDER_INGEST_HOOKS.get("grok")!;

  test("grok hooks are registered and admit user/assistant turns", () => {
    const mapped = mapNormalizedSession(
      session({
        provider: "grok",
        agentName: "grok-build",
        events: [
          baseEvent({
            id: "e0",
            sequence: 0,
            role: "user",
            kind: "message",
            contentText: "add booth-* projects to system-config",
          }),
          baseEvent({
            id: "e1",
            sequence: 1,
            role: "assistant",
            kind: "message",
            contentBlocks: [
              block({ kind: "text", text: "Done, added three booth-* directories." }),
            ],
          }),
        ],
      }),
      grokHooks,
    );
    expect(mapped.messages.map((r) => [r.seq, r.role, r.text])).toEqual([
      [0, "user", "add booth-* projects to system-config"],
      [1, "assistant", "Done, added three booth-* directories."],
    ]);
    expect(mapped.diagnostics).toHaveLength(0);
  });

  test("grok thinking events become role:reasoning rows", () => {
    const mapped = mapNormalizedSession(
      session({
        provider: "grok",
        agentName: "grok-build",
        events: [
          // The grok adapter emits a dedicated reasoning event before the reply.
          baseEvent({
            id: "e0-r",
            sequence: 5,
            role: "thinking",
            kind: "reasoning",
            contentText: "Let me check the directory structure first",
          }),
          baseEvent({
            id: "e0",
            sequence: 5,
            role: "assistant",
            kind: "tool_call",
            contentText: "",
            toolCallId: "tc1",
          }),
        ],
        toolCalls: [
          toolCall({
            id: "tc1",
            eventId: "e0",
            toolName: "list_dir",
            status: "completed",
            input: { target_directory: "/Users/guilhermecastro/Projects" },
            output: "atlas/\nquasar/\nrig/",
          }),
        ],
      }),
      grokHooks,
    );
    expect(mapped.messages.map((r) => [r.seq, r.role, r.text])).toEqual([
      [5, "reasoning", "Let me check the directory structure first"],
    ]);
    expect(mapped.toolCalls).toHaveLength(1);
    expect(mapped.toolCalls[0]?.toolName).toBe("list_dir");
    expect(mapped.diagnostics).toHaveLength(0);
  });
});

describe("antigravity ingest hooks", () => {
  const antigravitySession = (events: SessionEvent[]): NormalizedSession =>
    session({
      provider: "antigravity",
      agentName: "antigravity-cli",
      events,
      toolCalls: [],
    });

  const antigravityEvent = (
    overrides: Partial<SessionEvent> & Pick<SessionEvent, "id" | "sequence" | "role" | "kind">,
  ): SessionEvent =>
    baseEvent({
      provider: "antigravity",
      agentName: "antigravity-cli",
      ...overrides,
    });

  test("only kind:message events become messages rows", () => {
    const hooks = PROVIDER_INGEST_HOOKS.get("antigravity");
    const mapped = mapNormalizedSession(
      antigravitySession([
        antigravityEvent({
          id: "u0",
          sequence: 0,
          role: "user",
          kind: "message",
          contentText: "Fix the adapter.",
        }),
        antigravityEvent({
          id: "a0",
          sequence: 1,
          role: "assistant",
          kind: "message",
          contentText: "Done — terminal answer only.",
        }),
        antigravityEvent({
          id: "tick",
          sequence: 2,
          role: "unknown",
          kind: "lifecycle",
          rawReference: { sourcePath: SOURCE_PATH, nativeType: "PLANNER_RESPONSE" },
        }),
        antigravityEvent({
          id: "tool",
          sequence: 3,
          role: "assistant",
          kind: "tool_call",
          rawReference: { sourcePath: SOURCE_PATH, nativeType: "PLANNER_RESPONSE" },
        }),
        antigravityEvent({
          id: "think",
          sequence: 4,
          role: "thinking",
          kind: "reasoning",
          contentText: "Mid-loop thinking must not become a row.",
        }),
        antigravityEvent({
          id: "sys",
          sequence: 5,
          role: "system",
          kind: "system",
          contentText: "SYSTEM_MESSAGE replay noise.",
        }),
      ]),
      hooks,
    );

    expect(mapped.messages.map((r) => [r.seq, r.role, r.text])).toEqual([
      [0, "user", "Fix the adapter."],
      [1, "assistant", "Done — terminal answer only."],
    ]);
  });
});
