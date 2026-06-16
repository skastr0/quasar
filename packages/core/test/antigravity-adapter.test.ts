import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, test } from "vitest";

import { antigravityAdapter } from "../src/adapters/antigravity";

const MACHINE = {
  machineId: "machine:test",
  hostname: "test-host",
  platform: "darwin",
};

const NOW = "2026-06-01T00:00:00.000Z";

// Root for all tests — cleaned up once at the end.
const testRoot = mkdtempSync(join(tmpdir(), "quasar-antigravity-test-"));

afterAll(() => {
  rmSync(testRoot, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

/** Write a JSONL file where each line is a JSON-serialised object. */
const writeJsonLines = (path: string, records: unknown[]) =>
  writeFileSync(path, records.map((r) => JSON.stringify(r)).join("\n") + "\n", "utf8");

// ---------------------------------------------------------------------------
// T1: real session (has transcript) + stub session (no transcript)
//     → only the real one ingests (1 session not 2)
// ---------------------------------------------------------------------------
describe("T1: real session vs stub — only real ingests", () => {
  const root = join(testRoot, "t1");
  const brainRoot = join(root, "brain");

  // Real session: brain/<uuid>/.system_generated/logs/transcript_full.jsonl exists
  const realUuid = "aaaaaaaa-0001-0001-0001-000000000001";
  const realTranscriptDir = join(brainRoot, realUuid, ".system_generated", "logs");
  mkdirSync(realTranscriptDir, { recursive: true });

  writeJsonLines(join(realTranscriptDir, "transcript_full.jsonl"), [
    // USER_INPUT: user message
    {
      step_index: 0,
      source: "USER_EXPLICIT",
      type: "USER_INPUT",
      status: "DONE",
      created_at: "2026-05-01T10:00:00Z",
      content: "List all the files in the project.",
    },
    // CONVERSATION_HISTORY: should be SKIPPED (content null)
    {
      step_index: 1,
      source: "SYSTEM",
      type: "CONVERSATION_HISTORY",
      status: "DONE",
      created_at: "2026-05-01T10:00:01Z",
    },
    // PLANNER_RESPONSE with tool_calls (kind = tool_call)
    {
      step_index: 2,
      source: "MODEL",
      type: "PLANNER_RESPONSE",
      status: "DONE",
      created_at: "2026-05-01T10:00:02Z",
      content: "I will list the directory.",
      tool_calls: [
        {
          name: "list_dir",
          args: { DirectoryPath: "/Users/user/project" },
        },
      ],
    },
    // VIEW_FILE execution result (kind = tool_call, role = assistant)
    {
      step_index: 3,
      source: "MODEL",
      type: "VIEW_FILE",
      status: "DONE",
      created_at: "2026-05-01T10:00:03Z",
      content: "file1.ts\nfile2.ts\npackage.json",
    },
    // PLANNER_RESPONSE without tool_calls (kind = message, final answer)
    {
      step_index: 4,
      source: "MODEL",
      type: "PLANNER_RESPONSE",
      status: "DONE",
      created_at: "2026-05-01T10:00:04Z",
      content: "The project contains file1.ts, file2.ts, and package.json.",
    },
  ]);

  // Stub session: brain dir exists but NO transcript_full.jsonl
  const stubUuid = "bbbbbbbb-0002-0002-0002-000000000002";
  mkdirSync(join(brainRoot, stubUuid), { recursive: true });

  test("discovers exactly 1 session (real session only, stub filtered out)", async () => {
    const result = await antigravityAdapter.read({
      machine: MACHINE,
      now: NOW,
      roots: { antigravity: root },
    });
    expect(result.sessions).toHaveLength(1);
  });

  test("session has correct provider and agentName", async () => {
    const result = await antigravityAdapter.read({
      machine: MACHINE,
      now: NOW,
      roots: { antigravity: root },
    });
    const session = result.sessions[0]!;
    expect(session.provider).toBe("antigravity");
    expect(session.agentName).toBe("antigravity-cli");
  });

  test("user message event present with correct role and kind", async () => {
    const result = await antigravityAdapter.read({
      machine: MACHINE,
      now: NOW,
      roots: { antigravity: root },
    });
    const session = result.sessions[0]!;
    const userEvents = session.events.filter((e) => e.role === "user" && e.kind === "message");
    expect(userEvents).toHaveLength(1);
    expect(userEvents[0]!.contentText).toContain("List all the files");
  });

  test("CONVERSATION_HISTORY record is skipped (not in events)", async () => {
    const result = await antigravityAdapter.read({
      machine: MACHINE,
      now: NOW,
      roots: { antigravity: root },
    });
    const session = result.sessions[0]!;
    // step_index 1 was CONVERSATION_HISTORY and must not appear
    const systemEvents = session.events.filter((e) => e.kind === "system");
    // None should come from CONVERSATION_HISTORY (it's skipped)
    // There could be zero system events (CONVERSATION_HISTORY is the only SYSTEM record)
    expect(session.events.length).toBeLessThan(5); // 5 total minus 1 SKIP = 4 max
  });

  test("PLANNER_RESPONSE with tool_calls emits a tool_call event with a ToolCall record", async () => {
    const result = await antigravityAdapter.read({
      machine: MACHINE,
      now: NOW,
      roots: { antigravity: root },
    });
    const session = result.sessions[0]!;
    const toolCallEvents = session.events.filter((e) => e.kind === "tool_call");
    expect(toolCallEvents.length).toBeGreaterThanOrEqual(1);

    // At least one event has a toolCallId pointing to a ToolCall record
    const withId = toolCallEvents.filter((e) => e.toolCallId !== undefined);
    expect(withId.length).toBeGreaterThanOrEqual(1);

    const toolCallId = withId[0]!.toolCallId!;
    const toolCall = session.toolCalls.find((tc) => tc.id === toolCallId);
    expect(toolCall).toBeDefined();
    expect(toolCall!.toolName).toBe("list_dir");
  });

  test("final PLANNER_RESPONSE without tool_calls is a message event from assistant", async () => {
    const result = await antigravityAdapter.read({
      machine: MACHINE,
      now: NOW,
      roots: { antigravity: root },
    });
    const session = result.sessions[0]!;
    const assistantMessages = session.events.filter(
      (e) => e.role === "assistant" && e.kind === "message",
    );
    expect(assistantMessages.length).toBeGreaterThanOrEqual(1);
    const last = assistantMessages[assistantMessages.length - 1]!;
    expect(last.contentText).toContain("file1.ts");
  });
});

// ---------------------------------------------------------------------------
// T2: missing root → no sessions + no_data_found diagnostic
// ---------------------------------------------------------------------------
describe("T2: missing root", () => {
  test("yields no sessions and emits a no_data_found diagnostic", async () => {
    const result = await antigravityAdapter.read({
      machine: MACHINE,
      now: NOW,
      roots: { antigravity: join(testRoot, "nonexistent") },
    });
    expect(result.sessions).toHaveLength(0);
    const noData = result.diagnostics.filter((d) => d.status === "no_data_found");
    expect(noData).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// T3: shouldParseSession gate skips already-seen sessions
// ---------------------------------------------------------------------------
describe("T3: shouldParseSession gate", () => {
  const root = join(testRoot, "t3");
  const brainRoot = join(root, "brain");
  const uuid = "cccccccc-0003-0003-0003-000000000003";
  const transcriptDir = join(brainRoot, uuid, ".system_generated", "logs");
  mkdirSync(transcriptDir, { recursive: true });

  writeJsonLines(join(transcriptDir, "transcript_full.jsonl"), [
    {
      step_index: 0,
      source: "USER_EXPLICIT",
      type: "USER_INPUT",
      status: "DONE",
      created_at: "2026-05-02T09:00:00Z",
      content: "Hello gate test.",
    },
  ]);

  test("when shouldParseSession returns false, session is skipped", async () => {
    const result = await antigravityAdapter.read({
      machine: MACHINE,
      now: NOW,
      roots: { antigravity: root },
      shouldParseSession: () => false,
    });
    expect(result.sessions).toHaveLength(0);
  });

  test("when shouldParseSession returns true, session is parsed", async () => {
    const result = await antigravityAdapter.read({
      machine: MACHINE,
      now: NOW,
      roots: { antigravity: root },
      shouldParseSession: () => true,
    });
    expect(result.sessions).toHaveLength(1);
  });
});
