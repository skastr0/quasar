import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, test } from "bun:test";

import { grokAdapter, projectGrokLiveEpoch } from "../src/adapters/grok";
import { mergeGrokEpochMappedSessions } from "../src/adapters/grok-epoch-merge";
import {
  GROK_RECOVERY_ARCHIVE_INCOMPLETE,
  GROK_RECOVERY_COMPACTION_UNRESOLVED,
  classifyGrokEpochMessages,
  countExcessMessageOccurrences,
  planGrokEpochMerge,
  planGrokHistoryRecovery,
  planGrokLiveEpoch,
  verifyRecoveredTexts,
  verifyToolCallRetention,
  type GrokArchiveHistory,
  type GrokChatSource,
} from "../src/adapters/grok-recovery";
import { messageContentHash, NORMALIZED_SESSION_PROTOCOL_VERSION } from "@skastr0/quasar-protocol";
import {
  grokEntryStructuralKey,
  grokSyntheticInstructionKind,
} from "../src/adapters/grok-text";
import { mapSession } from "../src/map";

const MACHINE = {
  machineId: "machine:test",
  hostname: "test-host",
  platform: "darwin",
};
const NOW = "2026-06-01T00:00:00.000Z";

const testRoot = mkdtempSync(join(tmpdir(), "quasar-grok-recovery-"));
afterAll(() => {
  rmSync(testRoot, { recursive: true, force: true });
});

const writeJsonLines = (path: string, records: unknown[]) =>
  writeFileSync(path, records.map((record) => JSON.stringify(record)).join("\n") + "\n", "utf8");

const writeJson = (path: string, value: unknown) =>
  writeFileSync(path, JSON.stringify(value, null, 2), "utf8");

// ---------------------------------------------------------------------------
// Fixture shapes: the same per-record shapes grok writes to chat_history.jsonl,
// chat_history snapshots, and compacted_history snapshots.
// ---------------------------------------------------------------------------

const system = { type: "system", content: "SYSTEM PROMPT" };
const userInfo = (date: string) => ({
  type: "user",
  content: [{ type: "text", text: `<user_info>\nOS Version: macos\nToday's date: ${date}\n</user_info>` }],
});
const contextReminder = (label: string) => ({
  type: "user",
  content: [{ type: "text", text: `<system-reminder>\ncontext ${label}\n</system-reminder>` }],
});
const skillsReminder = {
  type: "user",
  content: [{ type: "text", text: "<system-reminder>\n## Available Skills\nThe following skills are available for use:\n- signal-20\n</system-reminder>" }],
};
const continuation = (summary: string) => ({
  type: "user",
  content: [{ type: "text", text: `This session is being continued from a previous conversation that ran out of context. ${summary}` }],
});
const userTurn = (text: string) => ({ type: "user", content: [{ type: "text", text }] });
const assistantTurn = (text: string) => ({ type: "assistant", content: text });
const syntheticCompactionInstruction = {
  type: "user",
  content: [{ type: "text", text: "Your task is to produce a faithful, concise summary of the conversation so far so that a successor assistant can continue the work seamlessly." }],
};

type Fixture = {
  readonly root: string;
  readonly sessionDir: string;
  readonly chatPath: string;
};

const buildFixture = (
  name: string,
  options: {
    readonly chat: unknown[];
    readonly requests?: Array<{ name: string; chat_history: unknown[] }>;
    readonly checkpoints?: Array<{ name: string; prompt_index_at_compaction: number; compacted_history: unknown[] }>;
    readonly updates?: unknown[];
  },
): Fixture => {
  const root = join(testRoot, name);
  const projectKey = encodeURIComponent("/repo/vouch");
  const sessionDir = join(root, "sessions", projectKey, "019ff6cb-53ba-71d0-bfdb-7aad1085b461");
  mkdirSync(sessionDir, { recursive: true });
  const chatPath = join(sessionDir, "chat_history.jsonl");
  writeJsonLines(chatPath, options.chat);
  if (options.requests !== undefined) {
    mkdirSync(join(sessionDir, "compaction_requests"), { recursive: true });
    for (const request of options.requests) {
      writeJson(join(sessionDir, "compaction_requests", request.name), {
        request_id: request.name.replace(/\.json$/, ""),
        created_at: "2026-08-14T11:06:29.879824+00:00",
        trigger: "auto",
        prompt_variant: "detailed",
        model: "grok-4.5",
        schema_version: 2,
        chat_history: request.chat_history,
      });
    }
  }
  if (options.checkpoints !== undefined) {
    mkdirSync(join(sessionDir, "compaction_checkpoints"), { recursive: true });
    for (const checkpoint of options.checkpoints) {
      writeJson(join(sessionDir, "compaction_checkpoints", checkpoint.name), {
        checkpoint_id: checkpoint.name.replace(/\.json$/, ""),
        created_at: "2026-08-14T11:07:22.085828+00:00",
        prompt_index_at_compaction: checkpoint.prompt_index_at_compaction,
        schema_version: 1,
        compacted_history: checkpoint.compacted_history,
        original_user_info: "OS Version: macos",
      });
    }
  }
  if (options.updates !== undefined) {
    writeJsonLines(join(sessionDir, "updates.jsonl"), options.updates);
  }
  return { root, sessionDir, chatPath };
};

const checkpointUpdate = (id: string) => ({
  method: "_x.ai/session/update",
  params: { update: { sessionUpdate: "compaction_checkpoint", checkpoint_id: id } },
});
const recapUpdate = (summary: string) => ({
  method: "session/update",
  params: { update: { sessionUpdate: "session_recap", summary, auto: true } },
});

const sessionTexts = (fixture: Fixture, result: { sessions: Parameters<typeof mapSession>[0][] }) => {
  const session = result.sessions.find((candidate) => candidate.id.startsWith("grok:"));
  if (session === undefined) return undefined;
  const mapped = mapSession(session, "test-fingerprint");
  return {
    session,
    texts: mapped.messages.map((message) => message.text),
    messages: mapped.messages,
  };
};

// ---------------------------------------------------------------------------
// Pure plan tests
// ---------------------------------------------------------------------------

const source = (value: unknown, line = 1): GrokChatSource => ({
  value,
  sourcePath: "/archive/request.json",
  line,
  nativeType: "compaction_request",
  createdAt: "2026-08-14T11:06:29+00:00",
  archive: true,
});
const history = (
  entries: readonly GrokChatSource[],
  kind: GrokArchiveHistory["kind"] = "compaction_request",
): GrokArchiveHistory => ({
  kind,
  sourcePath: "/archive/request.json",
  createdAt: "2026-08-14T11:06:29+00:00",
  entries,
  syntheticTailExcluded: kind !== "compaction_checkpoint",
});

describe("grok synthetic instruction validation", () => {
  test("documented compaction and recap markers are recognized", () => {
    expect(grokSyntheticInstructionKind(syntheticCompactionInstruction)).toBe("compaction");
    expect(
      grokSyntheticInstructionKind(
        userTurn("<system-reminder>Write ONE sentence recap body for a user returning from idle."),
      ),
    ).toBe("recap");
  });

  test("a non-marker final user line stays authored — never blindly dropped", () => {
    expect(grokSyntheticInstructionKind(userTurn("please continue"))).toBeUndefined();
    expect(grokSyntheticInstructionKind(assistantTurn("done"))).toBeUndefined();
  });
});

describe("planGrokHistoryRecovery", () => {
  const liveChat = [
    system,
    userInfo("2026-08-14"),
    contextReminder("live"),
    userTurn("final ask"),
    continuation("LIVE SUMMARY"),
    skillsReminder,
    assistantTurn("new answer"),
  ];
  const liveSources = liveChat.map((value, index) => ({
    value,
    sourcePath: "/live/chat_history.jsonl",
    line: index + 1,
    nativeType: "chat_history",
    createdAt: "",
    archive: false,
  }));

  test("anchored pre-compaction history is recovered once and the new epoch tail is kept", () => {
    const requestBody = [
      system,
      userInfo("2026-08-14"),
      contextReminder("live"),
      userTurn("first ask"),
      continuation("SESSION START SUMMARY"),
      skillsReminder,
      assistantTurn("old answer"),
      userTurn("final ask"),
    ];
    const request = history(requestBody.map((value, index) => source(value, index + 1)));
    const plan = planGrokHistoryRecovery(liveSources, [request], { compactionCheckpointUpdates: 0 });
    expect(plan.block).toBeUndefined();
    expect(plan.recovered).toBe(true);
    expect(plan.anchorIndex).toBe(3);
    const texts = plan.sources.map((entry) => grokEntryStructuralKey(entry.value));
    // Recovered history first, then only the new epoch tail (bootstrap stripped).
    expect(texts.slice(0, requestBody.length)).toEqual(
      requestBody.map((value) => grokEntryStructuralKey(value)),
    );
    expect(plan.sources.slice(requestBody.length)).toHaveLength(1);
    expect(grokEntryStructuralKey(plan.sources.at(-1)!.value)).toBe(
      grokEntryStructuralKey(assistantTurn("new answer")),
    );
    // "final ask" is kept exactly once — no duplicate authored turn.
    const finalAskKey = grokEntryStructuralKey(userTurn("final ask"));
    expect(texts.filter((key) => key === finalAskKey)).toHaveLength(1);
    // Live bootstrap machinery is preserved as context, not as turns.
    expect(
      plan.contextSources.map((entry) => grokEntryStructuralKey(entry.value)),
    ).toContain(grokEntryStructuralKey(continuation("LIVE SUMMARY")));
  });

  test("live-epoch planning ignores incomplete archives and never blocks", () => {
    const plan = planGrokLiveEpoch(liveSources);
    expect(plan.block).toBeUndefined();
    expect(plan.recovered).toBe(false);
    expect(plan.sources).toBe(liveSources);
    expect(plan.diagnostics).toEqual([]);
  });

  test("missing checkpoint archives block replacement on decoded update metadata", () => {
    const checkpoint = history(
      [system, userInfo("2026-08-14"), contextReminder("live"), userTurn("final ask")].map(
        (value, index) => source(value, index + 1),
      ),
      "compaction_checkpoint",
    );
    const plan = planGrokHistoryRecovery(liveSources, [checkpoint], {
      compactionCheckpointUpdates: 9,
    });
    expect(plan.block?.code).toBe(GROK_RECOVERY_ARCHIVE_INCOMPLETE);
    expect(plan.sources).toBe(liveSources);
    expect(plan.diagnostics[0]?.name).toBe(GROK_RECOVERY_ARCHIVE_INCOMPLETE);
  });

  test("compaction evidence without an anchor blocks replacement", () => {
    const request = history(
      [userTurn("unrelated old turn"), assistantTurn("unrelated old answer")].map((value) => source(value)),
    );
    const plan = planGrokHistoryRecovery(liveSources, [request], { compactionCheckpointUpdates: 0 });
    expect(plan.block?.code).toBe(GROK_RECOVERY_COMPACTION_UNRESOLVED);
    expect(plan.sources).toBe(liveSources);
  });

  test("recap-only archives never block — the live chat is retained unchanged", () => {
    const recap = history(
      [userTurn("some turn"), assistantTurn("some answer")].map((value) => source(value)),
      "recap_request",
    );
    const plan = planGrokHistoryRecovery(liveSources, [recap], { compactionCheckpointUpdates: 0 });
    expect(plan.block).toBeUndefined();
    expect(plan.recovered).toBe(false);
    expect(plan.sources).toBe(liveSources);
  });

  test("a complete-prefix chain keeps only the maximal history", () => {
    const shorter = history(
      [system, userInfo("2026-08-14"), contextReminder("live"), userTurn("first ask")].map((value, index) => source(value, index + 1)),
    );
    const longer = history(
      [
        system,
        userInfo("2026-08-14"),
        contextReminder("live"),
        userTurn("first ask"),
        continuation("SESSION START SUMMARY"),
        skillsReminder,
        assistantTurn("old answer"),
        userTurn("final ask"),
      ].map((value, index) => source(value, index + 1)),
    );
    const plan = planGrokHistoryRecovery(liveSources, [shorter, longer], {
      compactionCheckpointUpdates: 0,
    });
    expect(plan.recovered).toBe(true);
    expect(plan.selectedSourcePath).toBe(longer.sourcePath);
    expect(plan.sources).toHaveLength(longer.entries.length + 1);
  });
});

describe("verifyRecoveredTexts", () => {
  test("ordered injective matching with whitespace normalization", () => {
    const result = verifyRecoveredTexts(
      ["alpha  beta", "gamma", "alpha beta"],
      ["alpha beta", "gamma"],
    );
    expect(result.resolved).toBe(2);
    expect(result.unresolved).toEqual(["alpha beta"]);
  });

  test("all resolved when every occurrence has a distinct later match", () => {
    const result = verifyRecoveredTexts(["a", "b"], ["x", "a", "b", "y"]);
    expect(result).toEqual({ total: 2, resolved: 2, unresolved: [] });
  });
});

describe("duplicate and tool-call retention checks", () => {
  test("excess message occurrences are counted only beyond the canonical count", () => {
    expect(countExcessMessageOccurrences(["a", "b", "a"], ["a", "b", "a", "c"])).toBe(0);
    expect(countExcessMessageOccurrences(["a", "b"], ["a", "a", "b"])).toBe(1);
    expect(countExcessMessageOccurrences(["a"], ["a  ", "a"])).toBe(1);
  });

  test("tool retention proves identity, bytes and cross-event chronology", () => {
    const stored = [
      { toolCallId: "t2", sequence: 7, toolName: "read", status: "completed", inputBytes: 1, outputBytes: 1 },
      { toolCallId: "t1", sequence: 7, toolName: "grep", status: "completed", inputBytes: 2, outputBytes: 2 },
      { toolCallId: "t3", sequence: 13, toolName: "grep", status: "completed", inputBytes: 1, outputBytes: 1 },
    ];
    const recovered = [
      // Within one stored sequence, id sort vs array order is NOT chronology.
      { id: "t2", toolName: "read", status: "completed", inputText: "x", outputText: "y" },
      { id: "t1", toolName: "grep", status: "completed", inputText: "ab", outputText: "cd" },
      { id: "t3", toolName: "grep", status: "completed", inputText: "z", outputText: "w" },
    ];
    const result = verifyToolCallRetention(stored, recovered);
    expect(result.retained).toBe(3);
    expect(result.missing).toEqual([]);
    expect(result.byteMismatches).toEqual([]);
    expect(result.duplicateRecoveredIds).toEqual([]);
    expect(result.chronologyViolations).toBe(0);

    const lossy = verifyToolCallRetention(stored, [
      recovered[0]!,
      recovered[1]!,
      { id: "t3", toolName: "grep", status: "completed", inputText: "z", outputText: "" },
    ]);
    expect(lossy.missing).toEqual([]);
    expect(lossy.byteMismatches).toEqual([
      { toolCallId: "t3", field: "output", storedBytes: 1, recoveredBytes: 0 },
    ]);

    const truncated = verifyToolCallRetention(stored, recovered.slice(0, 2));
    expect(truncated.retained).toBe(2);
    expect(truncated.missing).toEqual(["t3"]);

    const duplicated = verifyToolCallRetention(
      [stored[0]!],
      [recovered[0]!, recovered[0]!],
    );
    expect(duplicated.duplicateRecoveredIds).toEqual(["t2"]);

    const hash = createHash("sha256").update("x").digest("hex");
    const hashed = verifyToolCallRetention(
      [{ ...stored[0]!, inputHash: hash, outputHash: "deadbeef" }],
      [recovered[0]!],
    );
    expect(hashed.hashMismatches).toEqual([
      { toolCallId: "t2", field: "output", storedHash: "deadbeef", recoveredHash: createHash("sha256").update("y").digest("hex") },
    ]);
  });
});

describe("planGrokEpochMerge", () => {
  test("keeps the stored prefix and appends the current suffix at a monotone junction", () => {
    const storedMessages = [
      { eventId: "old-a", seq: 1, text: "old only" },
      { eventId: "shared-1", seq: 2, text: "shared turn" },
    ];
    const currentMessages = [
      { eventId: "live-shared", seq: 0, text: "shared turn" },
      { eventId: "live-new", seq: 1, text: "new only" },
    ];
    const classification = classifyGrokEpochMessages(
      storedMessages.map((row) => row.text),
      currentMessages.map((row) => row.text),
    );
    expect(classification.oldOnlyIndexes).toEqual([0]);
    expect(classification.sharedStoredIndexes).toEqual([1]);
    expect(classification.newOnlyIndexes).toEqual([1]);
    expect(classification.sharedIsStoredSuffix).toBe(true);
    expect(classification.sharedIsCurrentPrefix).toBe(true);
    const plan = planGrokEpochMerge({
      storedMessages,
      storedTools: [{ id: "tool-old", eventId: "old-a", seq: 1, toolName: "read", inputText: "a", outputText: "b" }],
      currentMessages,
      currentTools: [
        { id: "tool-old", eventId: "live-shared", seq: 0, toolName: "read", inputText: "a", outputText: "b" },
        { id: "tool-new", eventId: "live-new", seq: 1, toolName: "grep", inputText: "q", outputText: "r" },
      ],
    });
    expect(plan.safe).toBe(true);
    expect(plan.oldOnly).toBe(1);
    expect(plan.shared).toBe(1);
    expect(plan.newOnly).toBe(1);
    expect(plan.unionMessages).toBe(3);
    expect(plan.appendCurrentMessageIndexes).toEqual([1]);
    expect(plan.appendCurrentToolIds).toEqual(["tool-new"]);
    expect(plan.currentToolIdsAlreadyStored).toBe(1);
  });

  test("a shared bootstrap hole is still a safe monotone merge", () => {
    const plan = planGrokEpochMerge({
      storedMessages: [
        { eventId: "old-0", seq: 0, text: "old header" },
        { eventId: "old-1", seq: 1, text: "shared bootstrap" },
        { eventId: "old-2", seq: 2, text: "old tail" },
      ],
      storedTools: [],
      currentMessages: [
        { eventId: "new-0", seq: 0, text: "continuation header" },
        { eventId: "new-1", seq: 1, text: "shared bootstrap" },
        { eventId: "new-2", seq: 2, text: "new work" },
      ],
      currentTools: [],
    });
    expect(plan.safe).toBe(true);
    expect(plan.shared).toBe(1);
    expect(plan.newOnly).toBe(2);
    expect(plan.classification.sharedStoredIndexes).toEqual([1]);
    expect(plan.classification.sharedCurrentIndexes).toEqual([1]);
    expect(plan.classification.sharedIsCurrentPrefix).toBe(false);
    expect(plan.appendCurrentMessageIndexes).toEqual([0, 2]);
  });

  test("blocks a same-id tool whose payload changed", () => {
    const plan = planGrokEpochMerge({
      storedMessages: [{ eventId: "s", seq: 1, text: "shared" }],
      storedTools: [{ id: "tool-old", eventId: "s", seq: 1, toolName: "read", inputText: "a", outputText: "b" }],
      currentMessages: [
        { eventId: "c0", seq: 0, text: "shared" },
        { eventId: "c1", seq: 1, text: "newer" },
      ],
      currentTools: [{ id: "tool-old", eventId: "c0", seq: 0, toolName: "read", inputText: "CHANGED", outputText: "b" }],
    });
    expect(plan.safe).toBe(false);
    expect(plan.blockers.some((blocker) => blocker.startsWith("tool_payload_conflict:"))).toBe(true);
  });

  test("merged mapped session preserves stored identities and appends the new turn", () => {
    const hashOf = (eventId: string, seq: number, role: "user" | "assistant", text: string) =>
      messageContentHash({ sessionId: "grok:merge", eventId, seq, role, text });
    const event = (
      id: string,
      seq: number,
      role: "user" | "assistant",
      text: string,
    ) => ({
      id,
      sessionId: "grok:merge",
      sequence: seq,
      timestamp: "2026-08-14T00:00:00.000Z",
      machineId: "machine:test",
      provider: "grok" as const,
      agentName: "grok-build",
      projectIdentityKey: "proj",
      role,
      kind: "message" as const,
      contentText: text,
      contentBlocks: [],
      rawReference: { sourcePath: "/tmp/chat_history.jsonl", line: seq + 1 },
    });
    const message = (
      eventId: string,
      seq: number,
      role: "user" | "assistant",
      text: string,
    ) => ({
      sessionId: "grok:merge",
      eventId,
      seq,
      role,
      text,
      projectKey: "proj",
      contentHash: hashOf(eventId, seq, role, text),
    });
    const stored = {
      protocolVersion: NORMALIZED_SESSION_PROTOCOL_VERSION,
      project: { projectKey: "proj", displayName: "proj" },
      session: {
        sessionId: "grok:merge",
        projectKey: "proj",
        provider: "grok",
        agentName: "grok-build",
        sourcePath: "/tmp/old",
        sourceFingerprint: "stored",
        host: "test",
        identitySchemeVersion: 1,
        normalizationVersion: 12,
        messageCount: 2,
        toolCallCount: 0,
      },
      messages: [message("old-only", 0, "user", "old only"), message("shared-old", 1, "assistant", "shared turn")],
      toolCalls: [],
      events: [event("old-only", 0, "user", "old only"), event("shared-old", 1, "assistant", "shared turn")],
      usageRecords: [],
      sessionEdges: [],
      artifacts: [],
      executionContexts: [],
    };
    const current = {
      protocolVersion: NORMALIZED_SESSION_PROTOCOL_VERSION,
      project: { projectKey: "proj", displayName: "proj" },
      session: {
        sessionId: "grok:merge",
        projectKey: "proj",
        provider: "grok",
        agentName: "grok-build",
        sourcePath: "/tmp/live",
        sourceFingerprint: "live",
        host: "test",
        identitySchemeVersion: 1,
        normalizationVersion: 12,
        messageCount: 2,
        toolCallCount: 0,
      },
      messages: [message("shared-live", 0, "assistant", "shared turn"), message("new-only", 1, "user", "new only")],
      toolCalls: [],
      events: [event("shared-live", 0, "assistant", "shared turn"), event("new-only", 1, "user", "new only")],
      usageRecords: [],
      sessionEdges: [],
      artifacts: [],
      executionContexts: [],
    };
    const merged = mergeGrokEpochMappedSessions(stored as never, current as never);
    expect(merged.plan.safe).toBe(true);
    expect(merged.session?.messages.map((row) => row.text)).toEqual(["old only", "shared turn", "new only"]);
    expect(merged.session?.messages[0]?.eventId).toBe("old-only");
    expect(merged.session?.messages[0]?.contentHash).toBe(stored.messages[0]!.contentHash);
    expect(merged.session?.messages[1]?.eventId).toBe("shared-old");
    expect(merged.session?.messages[2]?.eventId).toBe("new-only");
    expect(merged.session?.messages[2]?.seq).toBeGreaterThan(1);
  });
});

// ---------------------------------------------------------------------------
// Adapter integration: recovery, provenance, fingerprint, fail-closed hold
// ---------------------------------------------------------------------------

describe("grok adapter archive recovery", () => {
  test("replays the anchored pre-compaction history with archive provenance", async () => {
    const fixture = buildFixture("recovered", {
      chat: [system, userInfo("2026-08-14"), contextReminder("live"), userTurn("final ask"), continuation("LIVE SUMMARY"), skillsReminder, assistantTurn("new answer")],
      requests: [
        {
          name: "req-1.json",
          chat_history: [
            system,
            userInfo("2026-08-14"),
            contextReminder("live"),
            userTurn("first ask"),
            continuation("SESSION START SUMMARY"),
            skillsReminder,
            assistantTurn("old answer"),
            userTurn("final ask"),
            syntheticCompactionInstruction,
          ],
        },
      ],
      checkpoints: [
        {
          name: "cp-1.json",
          prompt_index_at_compaction: 1,
          compacted_history: [system, userInfo("2026-08-14"), contextReminder("live"), userTurn("final ask"), continuation("CHECKPOINT SUMMARY"), skillsReminder],
        },
      ],
      updates: [checkpointUpdate("cp-1"), recapUpdate("recap prose")],
    });

    const result = await grokAdapter.read({ machine: MACHINE, now: NOW, roots: { grok: fixture.root } });
    const projected = sessionTexts(fixture, result)!;
    expect(projected.texts).toContain("first ask");
    expect(projected.texts).toContain("old answer");
    expect(projected.texts).toContain("final ask");
    expect(projected.texts).toContain("new answer");
    expect(projected.texts.filter((text) => text === "final ask")).toHaveLength(1);
    // Synthetic summarization instruction is excluded, not projected.
    expect(projected.texts.some((text) => text.includes("produce a faithful, concise summary"))).toBe(false);
    // Recovered authored turn carries the archive path as provenance.
    const firstAsk = projected.messages.find((message) => message.text === "first ask")!;
    const firstAskEvent = projected.session.events.find((event) => event.id === firstAsk.eventId)!;
    expect(firstAskEvent.rawReference.sourcePath).toBe(join(fixture.sessionDir, "compaction_requests", "req-1.json"));
    expect(firstAskEvent.rawReference.nativeType).toBe("user");
    // Checkpoint bootstrap summary is preserved as provider context with provenance.
    const context = projected.session.events.find(
      (event) => event.rawReference.nativeType === "compaction_bootstrap",
    )!;
    expect(context.kind).toBe("summary");
    expect(context.role).toBe("system");
    expect(context.contentText).toContain("CHECKPOINT SUMMARY");
    expect(context.rawReference.sourcePath).toBe(
      join(fixture.sessionDir, "compaction_checkpoints", "cp-1.json"),
    );
  });

  test("incomplete compaction archives fail the session closed with an attributable error", async () => {
    const fixture = buildFixture("blocked", {
      chat: [system, userInfo("2026-08-14"), contextReminder("live"), userTurn("final ask"), continuation("LIVE SUMMARY"), skillsReminder, assistantTurn("new answer")],
      checkpoints: [
        {
          name: "cp-1.json",
          prompt_index_at_compaction: 1,
          compacted_history: [system, userInfo("2026-08-14"), contextReminder("live"), userTurn("final ask"), continuation("CHECKPOINT SUMMARY"), skillsReminder],
        },
      ],
      updates: [checkpointUpdate("cp-1"), checkpointUpdate("cp-2"), checkpointUpdate("cp-3")],
    });

    const result = await grokAdapter.read({ machine: MACHINE, now: NOW, roots: { grok: fixture.root } });
    expect(result.sessions).toHaveLength(0);
    const detailsOf = (diagnostic: { readonly details?: unknown }) =>
      (diagnostic.details ?? {}) as { readonly diagnostic?: string; readonly physicalPath?: string };
    const failure = result.diagnostics.find(
      (diagnostic) => detailsOf(diagnostic).diagnostic === GROK_RECOVERY_ARCHIVE_INCOMPLETE,
    )!;
    expect(failure.severity).toBe("error");
    expect(detailsOf(failure).physicalPath).toBe(fixture.chatPath);
    expect(failure.message).toContain("left unchanged");

    const live = projectGrokLiveEpoch(fixture.sessionDir, { machine: MACHINE, now: NOW });
    expect(live.session).toBeDefined();
    expect(live.recoveryBlock).toBeUndefined();
    const liveMapped = mapSession(live.session!, "live-epoch");
    expect(liveMapped.messages.some((message) => message.text.includes("new answer"))).toBe(true);
    expect(liveMapped.messages.some((message) => message.text.includes("first ask"))).toBe(false);
  });

  test("archive inputs join the fingerprint and the stat read gate", async () => {
    const fixture = buildFixture("fingerprint", {
      chat: [system, userTurn("hello"), assistantTurn("hi")],
      requests: [
        {
          name: "req-1.json",
          chat_history: [system, userTurn("hello"), assistantTurn("hi"), userTurn("again"), syntheticCompactionInstruction],
        },
      ],
      updates: [checkpointUpdate("cp-1")],
    });
    const archivePath = join(fixture.sessionDir, "compaction_requests", "req-1.json");

    const probes: string[] = [];
    const readPaths: string[] = [];
    for await (const item of grokAdapter.stream!({
      machine: MACHINE,
      now: NOW,
      roots: { grok: fixture.root },
      shouldReadFile: (path) => {
        readPaths.push(path);
        return true;
      },
      shouldParseSession: (probe) => {
        probes.push(probe.sourceFingerprint);
        return true;
      },
    })) {
      void item;
    }
    expect(readPaths).toContain(archivePath);
    expect(probes).toHaveLength(1);

    // A new archive file must change the fingerprint even when the chat file is
    // untouched.
    writeJson(join(fixture.sessionDir, "compaction_requests", "req-2.json"), {
      request_id: "req-2",
      created_at: "2026-08-14T12:00:00.000000+00:00",
      schema_version: 2,
      chat_history: [system, userTurn("hello"), assistantTurn("hi")],
    });
    const probesAfter: string[] = [];
    for await (const item of grokAdapter.stream!({
      machine: MACHINE,
      now: NOW,
      roots: { grok: fixture.root },
      shouldParseSession: (probe) => {
        probesAfter.push(probe.sourceFingerprint);
        return true;
      },
    })) {
      void item;
    }
    expect(probesAfter).toHaveLength(1);
    expect(probesAfter[0]).not.toBe(probes[0]);
  });

  test("read gate skips a session when no input changed", async () => {
    const fixture = buildFixture("read-gate", {
      chat: [system, userTurn("hello"), assistantTurn("hi")],
      requests: [
        {
          name: "req-1.json",
          chat_history: [system, userTurn("hello"), assistantTurn("hi"), syntheticCompactionInstruction],
        },
      ],
    });
    let probes = 0;
    for await (const item of grokAdapter.stream!({
      machine: MACHINE,
      now: NOW,
      roots: { grok: fixture.root },
      shouldReadFile: () => false,
      shouldParseSession: () => {
        probes += 1;
        return true;
      },
    })) {
      void item;
    }
    expect(probes).toBe(0);
  });
});
