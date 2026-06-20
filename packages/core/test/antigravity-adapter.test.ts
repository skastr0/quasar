import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
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

/** Collapse invariant: searchable surface is one user + one assistant per turn. */
const assertCollapseInvariant = (
  events: Awaited<ReturnType<typeof antigravityAdapter.read>>["sessions"][number]["events"],
) => {
  const userMessages = events.filter((e) => e.role === "user" && e.kind === "message");
  const assistantMessages = events.filter((e) => e.role === "assistant" && e.kind === "message");
  expect(userMessages.length).toBeGreaterThan(0);
  expect(assistantMessages.length).toBeLessThanOrEqual(userMessages.length + 1);
  expect(assistantMessages.length).toBeGreaterThanOrEqual(userMessages.length - 1);
  // Mid-loop planner ticks must never masquerade as assistant messages.
  const leakedMidLoop = assistantMessages.filter(
    (e) =>
      e.contentText?.includes("I will list the directory") === true ||
      e.contentText?.includes("Still working") === true ||
      e.contentText === "Done." ||
      e.contentText?.startsWith("Reading") === true,
  );
  expect(leakedMidLoop).toHaveLength(0);
};

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
// Pre-user planner records are provider preamble, not assistant answers.
// ---------------------------------------------------------------------------
describe("pre-user planner preamble", () => {
  const root = join(testRoot, "pre-user-preamble");
  const brainRoot = join(root, "brain");
  const uuid = "ffffffff-0006-0006-0006-000000000006";
  const transcriptDir = join(brainRoot, uuid, ".system_generated", "logs");
  mkdirSync(transcriptDir, { recursive: true });

  writeJsonLines(join(transcriptDir, "transcript_full.jsonl"), [
    {
      type: "PLANNER_RESPONSE",
      source: "MODEL",
      status: "DONE",
      created_at: "2026-05-02T09:00:00Z",
      content: "Planner preamble before the first user turn.",
    },
    {
      type: "USER_INPUT",
      source: "USER_EXPLICIT",
      status: "DONE",
      created_at: "2026-05-02T09:00:01Z",
      content: "Now start the real turn.",
    },
    {
      type: "PLANNER_RESPONSE",
      source: "MODEL",
      status: "DONE",
      created_at: "2026-05-02T09:00:02Z",
      content: "Real answer to the user turn.",
    },
  ]);

  test("does not emit an assistant message before the first user turn", async () => {
    const result = await antigravityAdapter.read({
      machine: MACHINE,
      now: NOW,
      roots: { antigravity: root },
    });

    expect(result.sessions).toHaveLength(1);
    const session = result.sessions[0]!;
    const userMessages = session.events.filter((e) => e.role === "user" && e.kind === "message");
    const assistantMessages = session.events.filter(
      (e) => e.role === "assistant" && e.kind === "message",
    );
    expect(userMessages).toHaveLength(1);
    expect(assistantMessages).toHaveLength(1);
    expect(assistantMessages[0]!.contentText).toBe("Real answer to the user turn.");
    expect(session.events.some((e) => e.contentText === "Planner preamble before the first user turn.")).toBe(
      false,
    );
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
// T3: malformed transcript with no user turn → named diagnostic, zero session
// ---------------------------------------------------------------------------
describe("T3: no-user transcript", () => {
  const root = join(testRoot, "t3-no-user");
  const brainRoot = join(root, "brain");
  const uuid = "eeeeeeee-0003-0003-0003-000000000003";
  const transcriptDir = join(brainRoot, uuid, ".system_generated", "logs");
  mkdirSync(transcriptDir, { recursive: true });

  writeJsonLines(join(transcriptDir, "transcript_full.jsonl"), [
    {
      type: "GENERIC",
      source: "MODEL",
      status: "DONE",
      created_at: "2026-05-02T09:00:00Z",
      content: "Tool output without a user turn.",
    },
    {
      type: "PLANNER_RESPONSE",
      source: "MODEL",
      status: "DONE",
      created_at: "2026-05-02T09:00:01Z",
      content: "Assistant response without a user turn.",
    },
  ]);

  test("skips the session instead of yielding assistant-only message rows", async () => {
    const result = await antigravityAdapter.read({
      machine: MACHINE,
      now: NOW,
      roots: { antigravity: root },
    });

    expect(result.sessions).toHaveLength(0);
    const unsupported = result.diagnostics.filter((d) => d.status === "unsupported");
    expect(unsupported).toHaveLength(1);
    expect(unsupported[0]!.message).toBe("Skipped Antigravity transcript with no user message events.");
    expect(unsupported[0]!.details).toMatchObject({
      nativeSessionId: uuid,
      userMessages: 0,
      assistantMessages: 0,
    });
  });
});

// ---------------------------------------------------------------------------
// T4: shouldParseSession gate skips already-seen sessions
// ---------------------------------------------------------------------------
describe("T4: shouldParseSession gate", () => {
  const root = join(testRoot, "t4-gate");
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

// ---------------------------------------------------------------------------
// T5: scaled cumulative-replay fixture + optional on-disk estate scan.
//
// Real Antigravity transcripts replay the entire prior trajectory on every
// USER_INPUT (step_index resets to 0). A session with N user turns can carry
// tens of thousands of raw PLANNER_RESPONSE lines; only N terminal answers may
// surface as assistant messages. This fixture replays turn blocks the way the
// on-disk estate does, without checking in a multi-megabyte JSONL file.
// ---------------------------------------------------------------------------
describe("T5: cumulative replay collapse — estate validation", () => {
  const root = join(testRoot, "t5");
  const brainRoot = join(root, "brain");
  const TURNS = 8;
  const REPLAYS_PER_TURN = 3;

  const midLoopNoise = (turn: number) =>
    Array.from({ length: REPLAYS_PER_TURN }, (_unused, replay) => {
      const r = replay + 1;
      const t = `2026-06-12T08:4${turn}`;
      return [
        {
          type: "PLANNER_RESPONSE",
          source: "MODEL",
          status: "DONE",
          created_at: `${t}:${String(10 + replay).padStart(2, "0")}Z`,
          content: `Turn ${turn} replay ${r}: I will list the directory.`,
          tool_calls: [{ name: "list_dir", args: { DirectoryPath: "/repo" } }],
        },
        {
          type: "LIST_DIRECTORY",
          source: "MODEL",
          status: "DONE",
          created_at: `${t}:${String(11 + replay).padStart(2, "0")}Z`,
          content: "Done.",
        },
        {
          type: "PLANNER_RESPONSE",
          source: "MODEL",
          status: "DONE",
          created_at: `${t}:${String(12 + replay).padStart(2, "0")}Z`,
          content: `Turn ${turn} replay ${r}: Still working.`,
        },
        {
          type: "SYSTEM_MESSAGE",
          source: "SYSTEM",
          status: "DONE",
          created_at: `${t}:${String(13 + replay).padStart(2, "0")}Z`,
          content: "<SYSTEM_MESSAGE>stop hook blocked termination</SYSTEM_MESSAGE>",
        },
        {
          type: "PLANNER_RESPONSE",
          source: "MODEL",
          status: "DONE",
          created_at: `${t}:${String(14 + replay).padStart(2, "0")}Z`,
          thinking: `Turn ${turn} replay ${r} reasoning trace.`,
          content: `Turn ${turn} replay ${r}: Internal narration.`,
        },
      ];
    }).flat();

  const turnTrajectory = (turn: number) => {
    const t = `2026-06-12T08:4${turn}`;
    return [
      { type: "CONVERSATION_HISTORY", source: "SYSTEM", status: "DONE", created_at: `${t}:01Z` },
      ...midLoopNoise(turn),
      {
        type: "PLANNER_RESPONSE",
        source: "MODEL",
        status: "DONE",
        created_at: `${t}:99Z`,
        content: `Turn ${turn}: terminal answer after ${REPLAYS_PER_TURN} replay blocks.`,
      },
    ];
  };

  // Cumulative replay: each USER_INPUT is followed by the full trajectories of
  // every turn so far (the on-disk estate shape that used to flood ingest).
  const records: unknown[] = [];
  for (let turn = 1; turn <= TURNS; turn++) {
    const t = `2026-06-12T08:4${turn}`;
    records.push({
      type: "USER_INPUT",
      source: "USER_EXPLICIT",
      status: "DONE",
      created_at: `${t}:00Z`,
      content: `Turn ${turn}: investigate the repository.`,
    });
    for (let prior = 1; prior <= turn; prior++) {
      records.push(...turnTrajectory(prior));
    }
  }

  const uuid = "dddddddd-0004-0004-0004-000000000004";
  const transcriptDir = join(brainRoot, uuid, ".system_generated", "logs");
  mkdirSync(transcriptDir, { recursive: true });
  writeJsonLines(join(transcriptDir, "transcript_full.jsonl"), records);

  test("scaled replay fixture collapses to N user + N assistant messages", async () => {
    const result = await antigravityAdapter.read({
      machine: MACHINE,
      now: NOW,
      roots: { antigravity: root },
    });
    expect(result.sessions).toHaveLength(1);
    const session = result.sessions[0]!;
    const userMessages = session.events.filter((e) => e.role === "user" && e.kind === "message");
    const assistantMessages = session.events.filter(
      (e) => e.role === "assistant" && e.kind === "message",
    );
    expect(userMessages).toHaveLength(TURNS);
    expect(assistantMessages).toHaveLength(TURNS);
    assertCollapseInvariant(session.events);
    // Raw record count is far larger than the searchable surface.
    expect(records.length).toBeGreaterThan(TURNS * 20);
    expect(session.events.filter((e) => e.kind === "message")).toHaveLength(TURNS * 2);
  });

  const estateRoot = process.env.ANTIGRAVITY_ESTATE_ROOT ?? join(homedir(), ".gemini/antigravity-cli");
  const estateBrain = join(estateRoot, "brain");

  test.runIf(existsSync(estateBrain))(
    "on-disk estate: every real session satisfies collapse invariant",
    async () => {
      const result = await antigravityAdapter.read({
        machine: MACHINE,
        now: NOW,
        roots: { antigravity: estateRoot },
      });
      expect(result.sessions.length).toBeGreaterThan(0);
      for (const session of result.sessions) {
        assertCollapseInvariant(session.events);
        const users = session.events.filter((e) => e.role === "user" && e.kind === "message");
        const assistants = session.events.filter(
          (e) => e.role === "assistant" && e.kind === "message",
        );
        expect(assistants.length).toBe(users.length);
      }
    },
    30_000,
  );
});
