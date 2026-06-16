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
// T1: the terminal-response rule.
//
// A turn runs from a USER_INPUT up to the next USER_INPUT. Inside each turn the
// model loops — narrating tool calls, ticking through bare planner responses,
// thinking — and only the LAST PLANNER_RESPONSE before the next USER_INPUT is
// the assistant's real answer. The fixture below is N=3 user turns, each with
// several mid-loop responses (some with tool_calls, some bare, some thinking)
// followed by a single terminal answer. We assert exactly N user + N assistant
// MESSAGE events, that mid-loop ticks are NOT messages, that tool_calls became
// session.toolCalls, and that thinking became role:"reasoning".
// ---------------------------------------------------------------------------
describe("T1: terminal-response rule — one assistant message per turn", () => {
  const root = join(testRoot, "t1");
  const brainRoot = join(root, "brain");
  const TURNS = 3;

  // Build one turn: a USER_INPUT, then mid-loop responses (a tool_call
  // narration, a tool execution result, a bare tick, a thinking response),
  // then the turn-terminal answer.
  const buildTurn = (n: number) => {
    const t = `2026-05-01T10:0${n}`;
    return [
      {
        type: "USER_INPUT",
        source: "USER_EXPLICIT",
        status: "DONE",
        created_at: `${t}:00Z`,
        content: `Turn ${n}: please investigate the repository.`,
      },
      // CONVERSATION_HISTORY: null content, must be SKIPPED entirely.
      {
        type: "CONVERSATION_HISTORY",
        source: "SYSTEM",
        status: "DONE",
        created_at: `${t}:01Z`,
      },
      // Mid-loop PLANNER_RESPONSE WITH tool_calls: narration is the call's
      // context, NOT a standalone message. Structural only.
      {
        type: "PLANNER_RESPONSE",
        source: "MODEL",
        status: "DONE",
        created_at: `${t}:02Z`,
        content: `I will list the directory for turn ${n}.`,
        tool_calls: [{ name: "list_dir", args: { DirectoryPath: "/repo" } }],
      },
      // Tool execution result: structural, never a message.
      {
        type: "LIST_DIRECTORY",
        source: "MODEL",
        status: "DONE",
        created_at: `${t}:03Z`,
        content: "file1.ts\nfile2.ts\npackage.json",
      },
      // Mid-loop BARE PLANNER_RESPONSE: a lifecycle tick, NOT a message.
      {
        type: "PLANNER_RESPONSE",
        source: "MODEL",
        status: "DONE",
        created_at: `${t}:04Z`,
        content: `Still working on turn ${n}, no tool needed here.`,
      },
      // Mid-loop PLANNER_RESPONSE with thinking (no tool_calls): reasoning,
      // off the embedding surface.
      {
        type: "PLANNER_RESPONSE",
        source: "MODEL",
        status: "DONE",
        created_at: `${t}:05Z`,
        thinking: `Reasoning trace for turn ${n}: the answer is shaping up.`,
        content: `Internal narration for turn ${n}.`,
      },
      // TERMINAL PLANNER_RESPONSE: the assistant's real answer for this turn.
      {
        type: "PLANNER_RESPONSE",
        source: "MODEL",
        status: "DONE",
        created_at: `${t}:06Z`,
        content: `Final answer for turn ${n}: the repository looks healthy.`,
      },
    ];
  };

  const records = Array.from({ length: TURNS }, (_unused, i) => buildTurn(i + 1)).flat();

  const realUuid = "aaaaaaaa-0001-0001-0001-000000000001";
  const realTranscriptDir = join(brainRoot, realUuid, ".system_generated", "logs");
  mkdirSync(realTranscriptDir, { recursive: true });
  writeJsonLines(join(realTranscriptDir, "transcript_full.jsonl"), records);

  // Stub session: brain dir exists but NO transcript_full.jsonl → filtered out.
  const stubUuid = "bbbbbbbb-0002-0002-0002-000000000002";
  mkdirSync(join(brainRoot, stubUuid), { recursive: true });

  const readSession = async () => {
    const result = await antigravityAdapter.read({
      machine: MACHINE,
      now: NOW,
      roots: { antigravity: root },
    });
    return result;
  };

  test("discovers exactly 1 session (stub without transcript filtered out)", async () => {
    const result = await readSession();
    expect(result.sessions).toHaveLength(1);
    expect(result.sessions[0]!.provider).toBe("antigravity");
    expect(result.sessions[0]!.agentName).toBe("antigravity-cli");
  });

  test("emits exactly N user MESSAGE events, one per turn", async () => {
    const session = (await readSession()).sessions[0]!;
    const userMessages = session.events.filter((e) => e.role === "user" && e.kind === "message");
    expect(userMessages).toHaveLength(TURNS);
    for (let i = 0; i < TURNS; i++) {
      expect(userMessages[i]!.contentText).toContain(`Turn ${i + 1}`);
    }
  });

  test("emits exactly N assistant MESSAGE events — only the turn-terminal answers", async () => {
    const session = (await readSession()).sessions[0]!;
    const assistantMessages = session.events.filter(
      (e) => e.role === "assistant" && e.kind === "message",
    );
    expect(assistantMessages).toHaveLength(TURNS);
    // Each is the terminal "Final answer", never the mid-loop narration.
    for (let i = 0; i < TURNS; i++) {
      expect(assistantMessages[i]!.contentText).toContain(`Final answer for turn ${i + 1}`);
    }
    for (const m of assistantMessages) {
      expect(m.contentText).not.toContain("I will list the directory");
      expect(m.contentText).not.toContain("Still working");
      expect(m.contentText).not.toContain("Internal narration");
    }
  });

  test("mid-loop bare planner responses are lifecycle ticks, NOT messages", async () => {
    const session = (await readSession()).sessions[0]!;
    const lifecycle = session.events.filter((e) => e.kind === "lifecycle");
    // One bare mid-loop PLANNER_RESPONSE per turn.
    expect(lifecycle).toHaveLength(TURNS);
    for (const e of lifecycle) {
      expect(e.role).toBe("unknown");
      // A lifecycle tick carries no searchable content.
      expect(e.contentText).toBeUndefined();
    }
    // And the bare narration never leaked onto the message surface.
    const allMessages = session.events.filter((e) => e.kind === "message");
    for (const m of allMessages) {
      expect(m.contentText).not.toContain("Still working");
    }
  });

  test("mid-loop tool_calls become session.toolCalls, narration is not a message", async () => {
    const session = (await readSession()).sessions[0]!;
    // The mid-loop PLANNER_RESPONSE that carries the tool_calls array — one per
    // turn. It is classified tool_call (structural), never a message.
    const plannerToolEvents = session.events.filter(
      (e) => e.kind === "tool_call" && e.rawReference.nativeType === "PLANNER_RESPONSE",
    );
    expect(plannerToolEvents).toHaveLength(TURNS);
    // The narration text never reaches contentText.
    for (const e of plannerToolEvents) {
      expect(e.role).toBe("assistant");
      expect(e.contentText).toBeUndefined();
    }
    // Each emitted exactly one list_dir ToolCall record on the structural surface.
    const listDirCalls = session.toolCalls.filter((tc) => tc.toolName === "list_dir");
    expect(listDirCalls).toHaveLength(TURNS);
  });

  test("thinking becomes role:thinking / kind:reasoning carrying the thinking text", async () => {
    const session = (await readSession()).sessions[0]!;
    const reasoning = session.events.filter((e) => e.kind === "reasoning");
    expect(reasoning).toHaveLength(TURNS);
    for (let i = 0; i < TURNS; i++) {
      const e = reasoning[i]!;
      expect(e.role).toBe("thinking");
      // The thinking trace is carried (so ingest promotes it to a reasoning
      // row), NOT the bare planner narration.
      expect(e.contentText).toContain(`Reasoning trace for turn ${i + 1}`);
      expect(e.contentText).not.toContain("Internal narration");
    }
  });

  test("CONVERSATION_HISTORY records are skipped entirely", async () => {
    const session = (await readSession()).sessions[0]!;
    const fromHistory = session.events.filter(
      (e) => e.rawReference.nativeType === "CONVERSATION_HISTORY",
    );
    expect(fromHistory).toHaveLength(0);
  });

  test("user message count tracks assistant message count (the collapse invariant)", async () => {
    const session = (await readSession()).sessions[0]!;
    const userMessages = session.events.filter((e) => e.role === "user" && e.kind === "message");
    const assistantMessages = session.events.filter(
      (e) => e.role === "assistant" && e.kind === "message",
    );
    // Each fully-closed turn yields exactly one user and one assistant message.
    expect(userMessages.length).toBe(assistantMessages.length);
    // The searchable surface is N+N, not the 7*N raw planner-response flood.
    const searchableMessages = session.events.filter((e) => e.kind === "message");
    expect(searchableMessages).toHaveLength(TURNS * 2);
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
