import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "bun:test";
import { Effect } from "effect";

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
