import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { Effect } from "effect";

import type { MappedSession, MessageRow, ToolCallRow } from "../src/model";
import { LocalStore, makeLocalStoreLayer } from "../src/store";
import type { LocalStoreService, SessionDiffOutcome } from "../src/store";

const tempDirs: string[] = [];

const sqlitePath = () => {
  const dir = mkdtempSync(join(tmpdir(), "quasar-store-diff-"));
  tempDirs.push(dir);
  return join(dir, "quasar.sqlite");
};

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

const withStore = <A>(path: string, run: (store: LocalStoreService) => Effect.Effect<A, unknown, never>) =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const store = yield* LocalStore;
        return yield* run(store);
      }).pipe(Effect.provide(makeLocalStoreLayer(path))),
    ),
  );

const SESSION_ID = "codex:diff-session";
const PROJECT_KEY = "project-diff";

const message = (seq: number, text: string, overrides: Partial<MessageRow> = {}): MessageRow => ({
  sessionId: SESSION_ID,
  seq,
  role: overrides.role ?? (seq % 2 === 0 ? "assistant" : "user"),
  text,
  ts: overrides.ts ?? `2026-07-07T10:00:${String(seq % 60).padStart(2, "0")}.000Z`,
  projectKey: overrides.projectKey ?? PROJECT_KEY,
  contentHash: overrides.contentHash ?? `hash-${seq}-${text.length}`,
});

const toolCall = (id: string, seq: number, overrides: Partial<ToolCallRow> = {}): ToolCallRow => ({
  id,
  sessionId: SESSION_ID,
  seq,
  toolName: overrides.toolName ?? "bash",
  status: overrides.status ?? "completed",
  inputText: overrides.inputText ?? `input for ${id}`,
  outputText: overrides.outputText ?? `output for ${id}`,
  startedAt: overrides.startedAt ?? "2026-07-07T10:00:00.000Z",
  completedAt: overrides.completedAt ?? "2026-07-07T10:00:01.000Z",
  projectKey: overrides.projectKey ?? PROJECT_KEY,
  provider: overrides.provider ?? "codex",
});

const session = (
  messages: readonly MessageRow[],
  toolCalls: readonly ToolCallRow[] = [],
  overrides: Partial<MappedSession["session"]> = {},
): MappedSession => ({
  project: {
    projectKey: overrides.projectKey ?? PROJECT_KEY,
    displayName: "Diff Project",
    rawPath: "/tmp/diff-project",
  },
  session: {
    sessionId: SESSION_ID,
    projectKey: overrides.projectKey ?? PROJECT_KEY,
    provider: "codex",
    agentName: "codex",
    title: "Diff Session",
    startedAt: "2026-07-07T10:00:00.000Z",
    updatedAt: overrides.updatedAt ?? "2026-07-07T10:05:00.000Z",
    sourcePath: "/hist/diff-session.jsonl",
    sourceFingerprint: overrides.sourceFingerprint ?? "fp-1",
    host: "host-diff",
    identitySchemeVersion: 1,
    normalizationVersion: overrides.normalizationVersion ?? 2,
    messageCount: messages.length,
    toolCallCount: toolCalls.length,
  },
  messages: messages.map((row) => ({ ...row, projectKey: overrides.projectKey ?? row.projectKey })),
  toolCalls: toolCalls.map((row) => ({ ...row, projectKey: overrides.projectKey ?? row.projectKey })),
});

const initialMessages = (count: number): MessageRow[] =>
  Array.from({ length: count }, (_, index) => message(index + 1, `message body ${index + 1}`));

const ftsCount = (path: string): number => {
  const db = new Database(path, { readonly: true });
  try {
    return (db.query("SELECT COUNT(*) AS count FROM messages_fts").get() as { count: number }).count;
  } finally {
    db.close();
  }
};

const messagesCount = (path: string): number => {
  const db = new Database(path, { readonly: true });
  try {
    return (db.query("SELECT COUNT(*) AS count FROM messages WHERE session_id = ?").get(SESSION_ID) as { count: number }).count;
  } finally {
    db.close();
  }
};

const storedFingerprint = (path: string): string | undefined => {
  const db = new Database(path, { readonly: true });
  try {
    const row = db.query("SELECT source_fingerprint AS fp FROM sessions WHERE session_id = ?").get(SESSION_ID) as { fp: string } | null;
    return row?.fp;
  } finally {
    db.close();
  }
};

const vectorRow = (row: MessageRow) => ({
  model: "test-model",
  modality: "text" as const,
  sessionId: row.sessionId,
  seq: row.seq,
  role: row.role,
  projectKey: row.projectKey,
  provider: "codex",
  contentHash: row.contentHash,
  documentHash: `doc-${row.seq}`,
  vector: [0.1, 0.2, 0.3],
});

describe("upsertSession row-level diff", () => {
  test("fresh session inserts every row and stamps the real fingerprint", async () => {
    const path = sqlitePath();
    const rows = initialMessages(5);
    const outcome = await withStore(path, (store) => store.upsertSession(session(rows, [toolCall("tc-1", 1)])) as Effect.Effect<SessionDiffOutcome, unknown, never>);
    expect(outcome.messagesInserted).toBe(5);
    expect(outcome.messagesUpdated).toBe(0);
    expect(outcome.messagesDeleted).toBe(0);
    expect(outcome.messagesUnchanged).toBe(0);
    expect(outcome.toolCallsInserted).toBe(1);
    expect(outcome.changedMessages.length).toBe(5);
    expect(ftsCount(path)).toBe(5);
    expect(storedFingerprint(path)).toBe("fp-1");
  });

  test("normalization upgrades invalidate only the fingerprint gate", async () => {
    const path = sqlitePath();
    const rows = initialMessages(2);
    const result = await withStore(path, (store) =>
      Effect.gen(function* () {
        yield* store.upsertSession(session(rows));
        const current = yield* store.hasSessionFingerprint(SESSION_ID, "fp-1", 2);
        const staleProjection = yield* store.hasSessionFingerprint(SESSION_ID, "fp-1", 3);
        const replay = yield* store.upsertSession(session(rows, [], { normalizationVersion: 3 }));
        const upgraded = yield* store.hasSessionFingerprint(SESSION_ID, "fp-1", 3);
        return { current, staleProjection, replay, upgraded };
      }));

    expect(result.current).toBe(true);
    expect(result.staleProjection).toBe(false);
    expect(result.replay.messagesUnchanged).toBe(2);
    expect(result.upgraded).toBe(true);
  });

  test("append touches only the new rows and preserves existing vectors", async () => {
    const path = sqlitePath();
    const rows = initialMessages(50);
    const grown = [...rows, message(51, "the fresh appended tail row"), message(52, "another fresh tail row")];
    const { second, vectors } = await withStore(path, (store) =>
      Effect.gen(function* () {
        yield* store.upsertSession(session(rows));
        yield* store.upsertMessageVectors(rows.map(vectorRow));
        const second = yield* store.upsertSession(session(grown, [], { sourceFingerprint: "fp-2" }));
        const vectors = yield* store.listMessageVectorsBySession({ sessionId: SESSION_ID, model: "test-model" });
        return { second, vectors };
      }));
    expect(second.messagesInserted).toBe(2);
    expect(second.messagesUpdated).toBe(0);
    expect(second.messagesDeleted).toBe(0);
    expect(second.messagesUnchanged).toBe(50);
    expect(second.changedMessages.map((row) => row.seq)).toEqual([51, 52]);
    // vectors for the 50 untouched rows survive the re-apply
    expect(vectors.length).toBe(50);
    expect(ftsCount(path)).toBe(52);
    expect(storedFingerprint(path)).toBe("fp-2");
  });

  test("editing one message updates exactly that row, drops its vector, and reindexes FTS", async () => {
    const path = sqlitePath();
    const rows = initialMessages(20);
    const edited = rows.map((row) =>
      row.seq === 10 ? { ...row, text: "completely rewritten zanzibar content", contentHash: "hash-10-edited" } : row);
    const { second, vectors, hits } = await withStore(path, (store) =>
      Effect.gen(function* () {
        yield* store.upsertSession(session(rows));
        yield* store.upsertMessageVectors(rows.map(vectorRow));
        const second = yield* store.upsertSession(session(edited, [], { sourceFingerprint: "fp-2" }));
        const vectors = yield* store.listMessageVectorsBySession({ sessionId: SESSION_ID, model: "test-model" });
        const hits = yield* store.lexicalSearch({ query: "zanzibar", limit: 5 });
        return { second, vectors, hits };
      }));
    expect(second.messagesUpdated).toBe(1);
    expect(second.messagesInserted).toBe(0);
    expect(second.messagesUnchanged).toBe(19);
    // the AD trigger dropped the edited row's vector; the other 19 survive
    expect(vectors.length).toBe(19);
    expect(vectors.some((row) => row.seq === 10)).toBe(false);
    expect(hits.length).toBe(1);
    expect(ftsCount(path)).toBe(20);
  });

  test("truncation deletes vanished rows from messages, FTS, and vectors", async () => {
    const path = sqlitePath();
    const rows = initialMessages(30);
    const truncated = rows.slice(0, 18);
    const { second, vectors } = await withStore(path, (store) =>
      Effect.gen(function* () {
        yield* store.upsertSession(session(rows));
        yield* store.upsertMessageVectors(rows.map(vectorRow));
        const second = yield* store.upsertSession(session(truncated, [], { sourceFingerprint: "fp-2" }));
        const vectors = yield* store.listMessageVectorsBySession({ sessionId: SESSION_ID, model: "test-model" });
        return { second, vectors };
      }));
    expect(second.messagesDeleted).toBe(12);
    expect(second.messagesUnchanged).toBe(18);
    expect(messagesCount(path)).toBe(18);
    expect(ftsCount(path)).toBe(18);
    expect(vectors.length).toBe(18);
  });

  test("a project move rewrites every row with the new scope token", async () => {
    const path = sqlitePath();
    const rows = initialMessages(8);
    const { second, scoped } = await withStore(path, (store) =>
      Effect.gen(function* () {
        yield* store.upsertSession(session(rows));
        const second = yield* store.upsertSession(session(rows, [], { projectKey: "project-moved", sourceFingerprint: "fp-2" }));
        const scoped = yield* store.lexicalSearch({ query: "message body", projectKey: "project-moved", limit: 20 });
        return { second, scoped };
      }));
    expect(second.messagesUpdated).toBe(8);
    expect(second.messagesUnchanged).toBe(0);
    expect(scoped.length).toBe(8);
  });

  test("re-applying identical content writes nothing", async () => {
    const path = sqlitePath();
    const rows = initialMessages(25);
    const calls = [toolCall("tc-1", 1), toolCall("tc-2", 2)];
    const second = await withStore(path, (store) =>
      Effect.gen(function* () {
        yield* store.upsertSession(session(rows, calls));
        return yield* store.upsertSession(session(rows, calls, { sourceFingerprint: "fp-2" }));
      }));
    expect(second.messagesInserted + second.messagesUpdated + second.messagesDeleted).toBe(0);
    expect(second.messagesUnchanged).toBe(25);
    expect(second.toolCallsInserted + second.toolCallsUpdated + second.toolCallsDeleted).toBe(0);
    expect(second.toolCallsUnchanged).toBe(2);
    expect(second.changedMessages.length).toBe(0);
    expect(storedFingerprint(path)).toBe("fp-2");
  });

  test("a crashed partial apply leaves a fingerprint mismatch and the re-send converges", async () => {
    const path = sqlitePath();
    const rows = initialMessages(12);
    await withStore(path, (store) => store.upsertSession(session(rows)));
    // simulate a crash mid-apply: tail row missing, sentinel fingerprint stored
    const db = new Database(path);
    db.query("DELETE FROM messages WHERE session_id = ? AND seq = 12").run(SESSION_ID);
    db.query("UPDATE sessions SET source_fingerprint = ? WHERE session_id = ?").run("applying:fp-2", SESSION_ID);
    db.close();
    const { unchangedBefore, second, fingerprintMatches } = await withStore(path, (store) =>
      Effect.gen(function* () {
        const unchangedBefore = yield* store.hasSessionFingerprint(SESSION_ID, "fp-2", 2);
        const second = yield* store.upsertSession(session(rows, [], { sourceFingerprint: "fp-2" }));
        const fingerprintMatches = yield* store.hasSessionFingerprint(SESSION_ID, "fp-2", 2);
        return { unchangedBefore, second, fingerprintMatches };
      }));
    // the sentinel never satisfies the fingerprint probe, so the daemon re-sends
    expect(unchangedBefore).toBe(false);
    expect(second.messagesInserted).toBe(1);
    expect(second.messagesUnchanged).toBe(11);
    expect(fingerprintMatches).toBe(true);
    expect(messagesCount(path)).toBe(12);
    expect(ftsCount(path)).toBe(12);
  });

  test("tool calls diff by id: append, grow output, and delete", async () => {
    const path = sqlitePath();
    const rows = initialMessages(3);
    const initial = [toolCall("tc-1", 1), toolCall("tc-2", 2), toolCall("tc-3", 3)];
    const next = [
      initial[0]!,
      { ...initial[1]!, outputText: `${initial[1]!.outputText} plus streamed continuation bytes` },
      toolCall("tc-4", 4),
    ];
    const second = await withStore(path, (store) =>
      Effect.gen(function* () {
        yield* store.upsertSession(session(rows, initial));
        return yield* store.upsertSession(session(rows, next, { sourceFingerprint: "fp-2" }));
      }));
    expect(second.toolCallsInserted).toBe(1);
    expect(second.toolCallsUpdated).toBe(1);
    expect(second.toolCallsDeleted).toBe(1);
    expect(second.toolCallsUnchanged).toBe(1);
    const db = new Database(path, { readonly: true });
    const stored = db.query("SELECT output_text AS output FROM tool_calls WHERE id = ?").get("tc-2") as { output: string };
    db.close();
    expect(stored.output).toContain("streamed continuation bytes");
  });

  test("a role change on an existing seq rewrites the row", async () => {
    const path = sqlitePath();
    const rows = initialMessages(4);
    const flipped = rows.map((row) =>
      row.seq === 2 ? { ...row, role: "user" as const } : row);
    const second = await withStore(path, (store) =>
      Effect.gen(function* () {
        yield* store.upsertSession(session(rows));
        return yield* store.upsertSession(session(flipped, [], { sourceFingerprint: "fp-2" }));
      }));
    expect(second.messagesUpdated).toBe(1);
    expect(second.messagesUnchanged).toBe(3);
  });
});
