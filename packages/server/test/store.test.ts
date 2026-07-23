import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { Effect } from "effect";

import { fts5QueryForText, ftsProjectScopeToken, ftsProviderScopeToken, ftsRoleScopeToken } from "../src/fts5";
import type { IngestRunRow, MappedSession } from "../src/model";
import { LocalStore, makeLocalStoreLayer } from "../src/store";
import type { LocalStoreService } from "../src/store";

const tempDirs: string[] = [];

const sqlitePath = () => {
  const dir = mkdtempSync(join(tmpdir(), "quasar-local-store-"));
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

const mappedSession = (overrides: Partial<MappedSession["session"]> = {}): MappedSession => ({
  project: {
    projectKey: overrides.projectKey ?? "project-a",
    displayName: "Project A",
    rawPath: "/tmp/project-a",
  },
  session: {
    sessionId: overrides.sessionId ?? "session-a",
    projectKey: overrides.projectKey ?? "project-a",
    provider: overrides.provider ?? "codex",
    agentName: overrides.agentName ?? "codex",
    title: overrides.title ?? "Session A",
    startedAt: overrides.startedAt ?? "2026-06-18T10:00:00.000Z",
    updatedAt: overrides.updatedAt ?? "2026-06-18T10:05:00.000Z",
    sourcePath: overrides.sourcePath ?? "/hist/session-a.jsonl",
    sourceFingerprint: overrides.sourceFingerprint ?? "fingerprint-a",
    host: overrides.host ?? "host-a",
    identitySchemeVersion: overrides.identitySchemeVersion ?? 1,
    normalizationVersion: overrides.normalizationVersion ?? 2,
    ...(overrides.parentSessionId !== undefined
      ? { parentSessionId: overrides.parentSessionId }
      : {}),
    messageCount: overrides.messageCount ?? 2,
    toolCallCount: overrides.toolCallCount ?? 2,
  },
  messages: [
    {
      sessionId: overrides.sessionId ?? "session-a",
      seq: 2,
      role: "assistant",
      text: "Second message",
      ts: "2026-06-18T10:02:00.000Z",
      projectKey: overrides.projectKey ?? "project-a",
      contentHash: "hash-2",
    },
    {
      sessionId: overrides.sessionId ?? "session-a",
      seq: 1,
      role: "user",
      text: "First message",
      ts: "2026-06-18T10:01:00.000Z",
      projectKey: overrides.projectKey ?? "project-a",
      contentHash: "hash-1",
    },
  ],
  toolCalls: [
    {
      id: `${overrides.sessionId ?? "session-a"}:tool-2`,
      sessionId: overrides.sessionId ?? "session-a",
      seq: 4,
      toolName: "shell_command",
      status: "ok",
      inputText: "echo second",
      outputText: "second",
      startedAt: "2026-06-18T10:04:00.000Z",
      completedAt: "2026-06-18T10:04:01.000Z",
      projectKey: overrides.projectKey ?? "project-a",
      provider: overrides.provider ?? "codex",
    },
    {
      id: `${overrides.sessionId ?? "session-a"}:tool-1`,
      sessionId: overrides.sessionId ?? "session-a",
      seq: 3,
      toolName: "read_file",
      status: "ok",
      inputText: "model.ts",
      outputText: "contents",
      startedAt: "2026-06-18T10:03:00.000Z",
      completedAt: "2026-06-18T10:03:01.000Z",
      projectKey: overrides.projectKey ?? "project-a",
      provider: overrides.provider ?? "codex",
    },
  ],
  events: [],
  usageRecords: [],
  sessionEdges: [],
  artifacts: [],
  executionContexts: [],
});

describe("LocalStore", () => {
  test("bootstraps the SQLite schema idempotently", async () => {
    const path = sqlitePath();

    await withStore(path, (store) => store.stats);
    const stats = await withStore(path, (store) => store.stats);

    expect(stats).toEqual({ projects: 0, sessions: 0, messages: 0, toolCalls: 0, ingestRuns: 0 });
  });

  test("upserts a session without duplicating child rows", async () => {
    const path = sqlitePath();
    const session = mappedSession();

    const stats = await withStore(
      path,
      (store) =>
        Effect.gen(function* () {
          yield* store.upsertSession(session);
          yield* store.upsertSession({
            ...session,
            session: { ...session.session, title: "Updated session" },
          });
          return yield* store.stats;
        }),
    );

    expect(stats).toEqual({ projects: 1, sessions: 1, messages: 2, toolCalls: 2, ingestRuns: 0 });
  });

  test("keeps message vectors scoped by embedding profile", async () => {
    const path = sqlitePath();

    const rows = await withStore(
      path,
      (store) =>
        Effect.gen(function* () {
          yield* store.upsertSession(mappedSession());
          for (const [model, vector] of [
            ["profile-a", [1, 0, 0]],
            ["profile-b", [0, 1, 0]],
          ] as const) {
            yield* store.upsertMessageVectors([{
              model,
              modality: "text",
              sessionId: "session-a",
              seq: 1,
              role: "user",
              projectKey: "project-a",
              provider: "codex",
              contentHash: "hash-1",
              documentHash: `${model}:hash-1`,
              vector,
            }]);
          }
          return yield* store.listMessageVectorsBySession({ sessionId: "session-a" });
        }),
    );

    expect(rows.map((row) => row.model)).toEqual(["profile-a", "profile-b"]);
    expect(rows.map((row) => row.contentHash)).toEqual(["hash-1", "hash-1"]);
  });

  test("builds hostile-input-safe SQLite FTS5 query strings", () => {
    expect(fts5QueryForText("sqlite: proof - vector")).toBe('"sqlite" AND "proof" AND "vector"');
    expect(fts5QueryForText('" OR foo:bar - ()')).toBe('"OR" AND "foo" AND "bar"');
    expect(fts5QueryForText(" ::: ")).toBeUndefined();
  });

  test("keeps SQLite FTS lexical rows coherent across insert, update, and delete triggers", async () => {
    const path = sqlitePath();
    // A colon-bearing session id — the real shape every provider adapter
    // produces via sessionIdFor(provider, native) — so the provider scope
    // token derives deterministically via the trigger's substr/instr formula.
    const sessionId = "codex:session-a";
    await withStore(path, (store) => store.upsertSession(mappedSession({ sessionId })));

    const projectToken = ftsProjectScopeToken("project-a");
    const userToken = ftsRoleScopeToken("user");
    const providerToken = ftsProviderScopeToken("codex");

    // The serving path returns the TRUTH TABLE's plain text/contentHash — the
    // token-prefixed FTS text must never leave the store layer.
    const inserted = await withStore(path, (store) => store.lexicalSearch({ query: "First", limit: 10 }));
    expect(inserted.map((hit) => hit.row.text)).toEqual(["First message"]);
    expect(inserted.map((hit) => hit.row.contentHash)).toEqual(["hash-1"]);

    // The trigger still writes scope-token-prefixed text into the raw FTS
    // column — that's what makes the scoped MATCH above possible.
    const rawFtsRow = new Database(path);
    try {
      const row = rawFtsRow.query("SELECT text FROM messages_fts WHERE key = ?").get(`${sessionId}:1:user`) as
        | { text: string }
        | null;
      expect(row?.text).toBe(`${projectToken} ${userToken} ${providerToken} First message`);
    } finally {
      rawFtsRow.close();
    }

    const hostile = await withStore(path, (store) =>
      store.lexicalSearch({ query: '" OR First:message - ()', limit: 10 }),
    );
    expect(hostile).toEqual([]);

    const rowidSkewDb = new Database(path);
    try {
      rowidSkewDb.prepare("UPDATE messages_fts SET rowid = rowid + 1000 WHERE key = ?").run(`${sessionId}:1:user`);
    } finally {
      rowidSkewDb.close();
    }

    const db = new Database(path);
    try {
      db.prepare("UPDATE messages SET text = ?, content_hash = ? WHERE session_id = ? AND seq = ?").run(
        "Updated trigger keyword",
        "hash-updated",
        sessionId,
        1,
      );
    } finally {
      db.close();
    }

    const [afterUpdate, oldText] = await withStore(
      path,
      (store) =>
        Effect.all([
          store.lexicalSearch({ query: "Updated", limit: 10 }),
          store.lexicalSearch({ query: "First", limit: 10 }),
        ]),
    );
    expect(afterUpdate.map((hit) => hit.row.text)).toEqual(["Updated trigger keyword"]);
    expect(afterUpdate.map((hit) => hit.row.contentHash)).toEqual(["hash-updated"]);
    expect(oldText).toEqual([]);

    const deleteDb = new Database(path);
    try {
      deleteDb.prepare("DELETE FROM messages WHERE session_id = ? AND seq = ?").run(sessionId, 1);
    } finally {
      deleteDb.close();
    }

    const afterDelete = await withStore(path, (store) => store.lexicalSearch({ query: "Updated", limit: 10 }));
    expect(afterDelete).toEqual([]);
  });

  test("QSR: fresh DB migration lands PRAGMA user_version 1 with scope-token-prefixed FTS text", async () => {
    const path = sqlitePath();
    const sessionId = "codex:session-scope";

    await withStore(path, (store) =>
      store.upsertSession(mappedSession({ sessionId, projectKey: "project-scope" })),
    );

    const db = new Database(path);
    try {
      const { user_version: userVersion } = db.query("PRAGMA user_version").get() as { user_version: number };
      expect(userVersion).toBe(1);

      const messageRow = db
        .query("SELECT project_scope_token AS token FROM messages WHERE session_id = ? AND seq = 1")
        .get(sessionId) as { token: string } | null;
      expect(messageRow?.token).toBe(ftsProjectScopeToken("project-scope"));

      const ftsRow = db
        .query("SELECT text FROM messages_fts WHERE key = ?")
        .get(`${sessionId}:1:user`) as { text: string } | null;
      expect(ftsRow?.text).toBe(
        `${ftsProjectScopeToken("project-scope")} ${ftsRoleScopeToken("user")} ${ftsProviderScopeToken("codex")} First message`,
      );
    } finally {
      db.close();
    }
  });

  test("QSR: migrates an old-shape (pre-scope-token) DB — backfills every row and rebuilds FTS with row-count parity", async () => {
    const path = sqlitePath();
    const sessionId = "codex:session-old";

    // Reproduce the pre-migration on-disk shape directly: base tables as
    // before, messages_fts seeded with OLD-style (un-tokenized) content, and
    // no project_scope_token column — i.e. PRAGMA user_version defaults to 0.
    const seedDb = new Database(path, { create: true });
    try {
      seedDb.exec(`
        PRAGMA journal_mode = WAL;
        CREATE TABLE projects (project_key TEXT PRIMARY KEY, display_name TEXT NOT NULL, raw_path TEXT);
        CREATE TABLE sessions (
          session_id TEXT PRIMARY KEY, project_key TEXT NOT NULL, provider TEXT NOT NULL, agent_name TEXT NOT NULL,
          title TEXT, started_at TEXT, updated_at TEXT, source_path TEXT NOT NULL, source_fingerprint TEXT NOT NULL,
          host TEXT NOT NULL DEFAULT '', identity_scheme_version INTEGER NOT NULL DEFAULT 0, parent_session_id TEXT,
          message_count INTEGER NOT NULL, tool_call_count INTEGER NOT NULL
        );
        CREATE TABLE messages (
          session_id TEXT NOT NULL, seq INTEGER NOT NULL, role TEXT NOT NULL, text TEXT NOT NULL, ts TEXT,
          project_key TEXT NOT NULL, content_hash TEXT NOT NULL, PRIMARY KEY (session_id, seq)
        );
        CREATE VIRTUAL TABLE messages_fts USING fts5(
          text, key UNINDEXED, session_id UNINDEXED, seq UNINDEXED, role UNINDEXED,
          project_key UNINDEXED, provider UNINDEXED, content_hash UNINDEXED, tokenize = 'unicode61'
        );
      `);
      seedDb.prepare("INSERT INTO projects(project_key, display_name, raw_path) VALUES (?, ?, ?)").run(
        "project-old",
        "Project Old",
        null,
      );
      seedDb
        .prepare(
          `INSERT INTO sessions(session_id, project_key, provider, agent_name, title, started_at, updated_at, source_path, source_fingerprint, message_count, tool_call_count)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          sessionId,
          "project-old",
          "codex",
          "codex",
          "Old session",
          "2026-01-01T00:00:00.000Z",
          "2026-01-01T00:01:00.000Z",
          "/hist/old.jsonl",
          "fp-old",
          2,
          0,
        );
      const insertOldMessage = seedDb.prepare(
        "INSERT INTO messages(session_id, seq, role, text, ts, project_key, content_hash) VALUES (?, ?, ?, ?, ?, ?, ?)",
      );
      insertOldMessage.run(sessionId, 1, "user", "Old first message", "2026-01-01T00:00:30.000Z", "project-old", "hash-old-1");
      insertOldMessage.run(sessionId, 2, "assistant", "Old second message", "2026-01-01T00:00:45.000Z", "project-old", "hash-old-2");
      const insertOldFts = seedDb.prepare(
        "INSERT INTO messages_fts(text, key, session_id, seq, role, project_key, provider, content_hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      );
      insertOldFts.run("Old first message", `${sessionId}:1:user`, sessionId, 1, "user", "project-old", "codex", "unembedded:hash-old-1");
      insertOldFts.run("Old second message", `${sessionId}:2:assistant`, sessionId, 2, "assistant", "project-old", "codex", "unembedded:hash-old-2");
    } finally {
      seedDb.close();
    }

    // Opening the store runs migrate(), which must carry the old-shape DB
    // through the full one-time migration.
    await withStore(path, (store) => store.stats);

    const db = new Database(path);
    try {
      const { user_version: userVersion } = db.query("PRAGMA user_version").get() as { user_version: number };
      expect(userVersion).toBe(1);

      const messageTokens = db
        .query("SELECT project_scope_token AS token FROM messages ORDER BY seq ASC")
        .all() as Array<{ token: string | null }>;
      expect(messageTokens).toHaveLength(2);
      expect(messageTokens.every((row) => row.token === ftsProjectScopeToken("project-old"))).toBe(true);

      const searchableMessageCount = (
        db
          .query("SELECT COUNT(*) AS count FROM messages WHERE role IN ('user', 'assistant', 'reasoning')")
          .get() as { count: number }
      ).count;
      const ftsRowCount = (db.query("SELECT COUNT(*) AS count FROM messages_fts").get() as { count: number }).count;
      expect(ftsRowCount).toBe(searchableMessageCount);

      const ftsRows = db.query("SELECT text FROM messages_fts ORDER BY seq ASC").all() as Array<{ text: string }>;
      const projectToken = ftsProjectScopeToken("project-old");
      const providerToken = ftsProviderScopeToken("codex");
      expect(ftsRows.map((row) => row.text)).toEqual([
        `${projectToken} ${ftsRoleScopeToken("user")} ${providerToken} Old first message`,
        `${projectToken} ${ftsRoleScopeToken("assistant")} ${providerToken} Old second message`,
      ]);
    } finally {
      db.close();
    }
  });

  test("QSR: a hostile projectKey round-trips into a clean scope token without corrupting FTS text", async () => {
    const path = sqlitePath();
    const hostileProjectKey = `weird "project"; DROP TABLE messages;-- éè 'quote'`;
    const sessionId = "codex:session-hostile";

    await withStore(path, (store) =>
      store.upsertSession(mappedSession({ sessionId, projectKey: hostileProjectKey })),
    );

    const expectedToken = ftsProjectScopeToken(hostileProjectKey);
    expect(expectedToken).toMatch(/^p[0-9a-f]{40}$/);

    const db = new Database(path);
    try {
      const messageRows = db
        .query("SELECT project_scope_token AS token FROM messages WHERE session_id = ?")
        .all(sessionId) as Array<{ token: string }>;
      expect(messageRows.length).toBeGreaterThan(0);
      expect(messageRows.every((row) => row.token === expectedToken)).toBe(true);

      const ftsRow = db
        .query("SELECT text FROM messages_fts WHERE key = ?")
        .get(`${sessionId}:1:user`) as { text: string } | null;
      expect(ftsRow?.text).toBe(`${expectedToken} ${ftsRoleScopeToken("user")} ${ftsProviderScopeToken("codex")} First message`);
    } finally {
      db.close();
    }

    const hits = await withStore(path, (store) =>
      store.lexicalSearch({ query: "First", limit: 10, projectKey: hostileProjectKey }),
    );
    expect(hits.map((hit) => hit.row.text)).toEqual(["First message"]);
  });

  test("QSR-D5: filtered lexical search (projectKey+role, single- and multi-provider) returns rows whose text is exactly the original message text, on a real migrated DB", async () => {
    const path = sqlitePath();

    // Two sessions across two projects and two providers, each with the same
    // two fixed messages ("First message" / "Second message") — so every
    // filter variant below must narrow to exactly the right rows, and every
    // returned row's text must be the untouched original, never the
    // scope-token-prefixed FTS text.
    await withStore(path, (store) =>
      Effect.all([
        store.upsertSession(
          mappedSession({ sessionId: "codex:project-alpha-session", projectKey: "project-alpha", provider: "codex" }),
        ),
        store.upsertSession(
          mappedSession({
            sessionId: "opencode:project-beta-session",
            projectKey: "project-beta",
            provider: "opencode",
          }),
        ),
      ]),
    );

    // projectKey + role narrows via BOTH the scoped MATCH and the backstop
    // predicate to the single matching row across both sessions.
    const scoped = await withStore(path, (store) =>
      store.lexicalSearch({ query: "message", projectKey: "project-alpha", role: "user", limit: 10 }),
    );
    expect(scoped.map((hit) => hit.row.text)).toEqual(["First message"]);
    expect(scoped.map((hit) => hit.row.projectKey)).toEqual(["project-alpha"]);
    expect(scoped.map((hit) => hit.row.role)).toEqual(["user"]);

    // Single-provider allow-list narrows the MATCH itself via the provider
    // scope token — still returns exact, untouched text.
    const singleProvider = await withStore(path, (store) =>
      store.lexicalSearch({ query: "message", providers: ["opencode"], limit: 10 }),
    );
    expect(singleProvider.map((hit) => hit.row.text).sort()).toEqual(["First message", "Second message"]);
    expect(singleProvider.every((hit) => hit.row.provider === "opencode")).toBe(true);

    // Multi-provider allow-list can't be a single AND-ed scope token, so it
    // falls through to the provider IN (...) backstop — text integrity holds.
    const multiProvider = await withStore(path, (store) =>
      store.lexicalSearch({ query: "message", providers: ["codex", "opencode"], limit: 10 }),
    );
    expect(multiProvider.map((hit) => hit.row.text).sort()).toEqual([
      "First message",
      "First message",
      "Second message",
      "Second message",
    ]);
  });

  test("round-trips host and identity scheme version provenance on read", async () => {
    const path = sqlitePath();
    const sessions = await withStore(
      path,
      (store) =>
        Effect.gen(function* () {
          yield* store.upsertSession(
            mappedSession({ host: "lighthouse", identitySchemeVersion: 1 }),
          );
          return yield* store.listSessions({ limit: 10 });
        }),
    );

    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.host).toBe("lighthouse");
    expect(sessions[0]?.identitySchemeVersion).toBe(1);
  });

  test("QSR-220: child session round-trips parentSessionId through store + read", async () => {
    const path = sqlitePath();
    const sessions = await withStore(
      path,
      (store) =>
        Effect.gen(function* () {
          yield* store.upsertSession(
            mappedSession({ sessionId: "parent-session" }),
          );
          yield* store.upsertSession(
            mappedSession({
              sessionId: "child-session",
              parentSessionId: "parent-session",
            }),
          );
          return yield* store.listSessions({ limit: 10 });
        }),
    );

    const child = sessions.find((row) => row.sessionId === "child-session");
    const parent = sessions.find((row) => row.sessionId === "parent-session");
    expect(child?.parentSessionId).toBe("parent-session");
    // Root sessions report no parent (NULL column reads back as null/undefined).
    expect(parent?.parentSessionId ?? undefined).toBeUndefined();
  });

  test("lists projects for the HTTP and CLI read surfaces", async () => {
    const path = sqlitePath();
    const projects = await withStore(
      path,
      (store) =>
        Effect.gen(function* () {
          yield* store.upsertSession(mappedSession({ projectKey: "project-b", sessionId: "session-b" }));
          yield* store.upsertSession(mappedSession({ projectKey: "project-a", sessionId: "session-a" }));
          return yield* store.listProjects({ limit: 10 });
        }),
    );

    expect(projects.map((project) => project.projectKey)).toEqual(["project-a", "project-b"]);
  });

  test("reads messages in turn sequence order", async () => {
    const path = sqlitePath();
    const messages = await withStore(
      path,
      (store) =>
        Effect.gen(function* () {
          yield* store.upsertSession(mappedSession());
          return yield* store.readMessages("session-a", 10);
        }),
    );

    expect(messages.map((message) => message.seq)).toEqual([1, 2]);
  });

  test("gets one message by session, sequence, and content hash", async () => {
    const path = sqlitePath();
    const row = await withStore(
      path,
      (store) =>
        Effect.gen(function* () {
          yield* store.upsertSession(mappedSession());
          return yield* store.getMessage({ sessionId: "session-a", seq: 1, contentHash: "hash-1" });
        }),
    );

    expect(row?.text).toBe("First message");
  });

  test("looks up tool calls by session, provider, and project/tool", async () => {
    const path = sqlitePath();
    const [bySession, byProvider, byWrongProvider, byProjectTool] = await withStore(
      path,
      (store) =>
        Effect.gen(function* () {
          yield* store.upsertSession(mappedSession());
          yield* store.upsertSession(mappedSession({ sessionId: "session-b", projectKey: "project-b", provider: "grok" }));
          const bySession = yield* store.listToolCalls({ sessionId: "session-a", limit: 10 });
          const byProvider = yield* store.listToolCalls({ provider: "codex", limit: 10 });
          const byWrongProvider = yield* store.listToolCalls({ provider: "claude", limit: 10 });
          const byProjectTool = yield* store.listToolCalls({ projectKey: "project-a", toolName: "shell_command", limit: 10 });
          return [bySession, byProvider, byWrongProvider, byProjectTool] as const;
        }),
    );

    expect(bySession.map((toolCall) => toolCall.seq)).toEqual([3, 4]);
    expect(byProvider.map((toolCall) => toolCall.provider)).toEqual(["codex", "codex"]);
    expect(byWrongProvider).toEqual([]);
    expect(byProjectTool).toHaveLength(1);
    expect(byProjectTool[0]?.sessionId).toBe("session-a");
    expect(byProjectTool[0]?.toolName).toBe("shell_command");
  });

  test("reads a single tool call by id", async () => {
    const path = sqlitePath();
    const toolCall = await withStore(
      path,
      (store) =>
        Effect.gen(function* () {
          yield* store.upsertSession(mappedSession());
          return yield* store.getToolCall("session-a:tool-1");
        }),
    );

    expect(toolCall?.toolName).toBe("read_file");
    expect(toolCall?.inputText).toBe("model.ts");
  });

  // ---------------------------------------------------------------------------
  // AC#6 — upsert / no-parallel-rows
  //
  // Upserting the SAME sessionId multiple times (including with a different
  // sourcePath to simulate a host→Docker path change) must never accrue more
  // than ONE row in the sessions table for that id.  The last writer's
  // sourcePath wins; earlier writes are replaced, not duplicated.
  // ---------------------------------------------------------------------------
  test("AC#6: three upserts with same sessionId produce exactly one sessions row; last sourcePath wins", async () => {
    const path = sqlitePath();
    const CANONICAL_SESSION_ID = "upsert-idem-session-001";

    const firstWrite = mappedSession({
      sessionId: CANONICAL_SESSION_ID,
      sourcePath: "/Users/alice/Library/codex/sessions/2026/rollout-idem.jsonl",
      title: "First write — host path",
    });
    const secondWrite = mappedSession({
      sessionId: CANONICAL_SESSION_ID,
      sourcePath: "/Users/alice/Library/codex/sessions/2026/rollout-idem.jsonl",
      title: "Second write — same path, updated title",
    });
    // Third write simulates the Docker /history mount: different sourcePath,
    // same canonical sessionId — must still converge to one row.
    const thirdWrite = mappedSession({
      sessionId: CANONICAL_SESSION_ID,
      sourcePath: "/history/codex/sessions/2026/rollout-idem.jsonl",
      title: "Third write — docker path",
    });

    const [rowCount, lastSourcePath] = await withStore(
      path,
      (store) =>
        Effect.gen(function* () {
          yield* store.upsertSession(firstWrite);
          yield* store.upsertSession(secondWrite);
          yield* store.upsertSession(thirdWrite);
          const sessions = yield* store.listSessions({ limit: 100 });
          // Filter to just the sessions with our canonical id.
          const matching = sessions.filter((s) => s.sessionId === CANONICAL_SESSION_ID);
          return [matching.length, matching[0]?.sourcePath] as const;
        }),
    );

    // Exactly ONE row — no parallel rows for one canonical identity.
    expect(rowCount).toBe(1);
    // The last writer's sourcePath is reflected.
    expect(lastSourcePath).toBe("/history/codex/sessions/2026/rollout-idem.jsonl");
  });

  test("records ingest runs idempotently", async () => {
    const path = sqlitePath();
    const run: IngestRunRow = {
      runId: "run-a",
      provider: "codex",
      status: "running",
      startedAt: "2026-06-18T10:00:00.000Z",
      sessionsSeen: 10,
      sessionsWritten: 0,
      sessionsSkipped: 0,
      sessionsFailed: 0,
    };

    const [stored, completed] = await withStore(
      path,
      (store) =>
        Effect.gen(function* () {
          yield* store.recordIngestRun(run);
          yield* store.recordIngestRun({
            ...run,
            status: "completed",
            completedAt: "2026-06-18T10:01:00.000Z",
            sessionsWritten: 9,
            sessionsSkipped: 1,
          });
          const stored = yield* store.getIngestRun("run-a");
          const completed = yield* store.listIngestRuns({ status: "completed" });
          return [stored, completed] as const;
        }),
    );

    expect(stored?.status).toBe("completed");
    expect(stored?.sessionsWritten).toBe(9);
    expect(completed.map((item) => item.runId)).toEqual(["run-a"]);
  });
});
