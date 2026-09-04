import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { Effect, Layer } from "effect";

import { sqliteBusyTimeoutMs } from "../src/config";
import type { MappedSession } from "../src/model";
import { DurableQueue, makeDurableQueueLayer } from "../src/services";
import { applyBusyTimeout, LocalStore, makeLocalStoreLayer } from "../src/store";

const tempDirs: string[] = [];

const sqlitePath = () => {
  const dir = mkdtempSync(join(tmpdir(), "quasar-sqlite-concurrency-"));
  tempDirs.push(dir);
  return join(dir, "quasar.sqlite");
};

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

const LOCK_HOLDER = new URL("./fixtures/sqliteWriteLockHolder.ts", import.meta.url);

const sessionFixture = (sessionId: string): MappedSession => ({
  protocolVersion: "quasar.normalized-session/v1",
  project: { projectKey: "project-busy", displayName: "project-busy", rawPath: "/tmp/project-busy" },
  session: {
    sessionId,
    projectKey: "project-busy",
    provider: "codex",
    agentName: "codex",
    title: sessionId,
    startedAt: "2026-07-01T10:00:00.000Z",
    updatedAt: "2026-07-01T10:05:00.000Z",
    sourcePath: `/tmp/${sessionId}.jsonl`,
    sourceFingerprint: `fp-${sessionId}`,
    normalizationVersion: 2,
    host: "test-host",
    identitySchemeVersion: 1,
    messageCount: 1,
    toolCallCount: 0,
  },
  messages: [{
    sessionId,
    eventId: `${sessionId}:event:0`,
    seq: 0,
    role: "user" as const,
    text: "concurrent write probe",
    ts: "2026-07-01T10:00:00.000Z",
    projectKey: "project-busy",
    contentHash: `hash-${sessionId}-0`,
  }],
  toolCalls: [],
  events: [],
  usageRecords: [],
  sessionEdges: [],
  artifacts: [],
  executionContexts: [],
});

/** Take the file's single WAL write lock on another thread and hold it. */
const holdWriteLock = (path: string, holdMs: number) => {
  const worker = new Worker(LOCK_HOLDER);
  const locked = new Promise<void>((resolve, reject) => {
    worker.onmessage = (event: MessageEvent) => {
      const message = event.data as { type: string; message?: string };
      if (message.type === "locked") resolve();
      if (message.type === "error") reject(new Error(message.message ?? "lock holder failed"));
    };
    worker.onerror = (event: ErrorEvent) => reject(new Error(event.message));
  });
  worker.postMessage({ type: "hold", path, holdMs });
  return { worker, locked };
};

describe("sqlite concurrent writers", () => {
  test("a store write waits out another connection's write lock instead of surfacing SQLITE_BUSY", async () => {
    const path = sqlitePath();
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const store = yield* LocalStore;
          const { worker, locked } = holdWriteLock(path, 600);
          try {
            yield* Effect.promise(() => locked);

            // Control: the same contention with the busy handler disarmed is
            // exactly the raw failure this pragma exists to remove. Without
            // this the test could pass on an uncontended file and prove
            // nothing.
            const control = new Database(path);
            control.exec("PRAGMA busy_timeout = 0");
            try {
              expect(() =>
                control.exec(
                  "INSERT OR REPLACE INTO projects(project_key, display_name, raw_path) VALUES ('control', 'control', NULL)",
                ),
              ).toThrow(/SQLITE_BUSY|database is locked/);
            } finally {
              control.close();
            }

            // Subject: the real store write blocks on the busy handler and
            // lands once the holder commits.
            const diff = yield* store.upsertSession(sessionFixture("codex:busy"));
            expect(diff.messagesInserted).toBe(1);
            const sessions = yield* store.listSessions({ projectKey: "project-busy" });
            expect(sessions.map((row) => row.sessionId)).toEqual(["codex:busy"]);
          } finally {
            worker.terminate();
          }
        }).pipe(Effect.provide(makeLocalStoreLayer(path))),
      ),
    );
  }, 20_000);

  test("the queue connection against the same file also waits instead of failing", async () => {
    const path = sqlitePath();
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          // Store first: it owns the schema the lock holder writes into.
          yield* LocalStore;
          const queue = yield* DurableQueue;
          const { worker, locked } = holdWriteLock(path, 600);
          try {
            yield* Effect.promise(() => locked);
            yield* queue.enqueueBatch([{
              kind: "embed-message",
              payload: { probe: true },
              idempotencyKey: "busy-timeout-probe",
              maxAttempts: 1,
            }]);
            const stats = yield* queue.stats;
            expect(stats.pending).toBe(1);
          } finally {
            worker.terminate();
          }
        }).pipe(
          Effect.provide(
            makeDurableQueueLayer(path).pipe(Layer.provideMerge(makeLocalStoreLayer(path))),
          ),
        ),
      ),
    );
  }, 20_000);

  test("every connection opens with the busy handler already armed", async () => {
    const path = sqlitePath();
    await Effect.runPromise(
      Effect.scoped(Effect.gen(function* () {
        yield* LocalStore;
      }).pipe(Effect.provide(makeLocalStoreLayer(path)))),
    );
    const probe = applyBusyTimeout(new Database(path));
    try {
      expect((probe.query("PRAGMA busy_timeout").get() as { timeout: number }).timeout).toBe(
        sqliteBusyTimeoutMs(),
      );
    } finally {
      probe.close();
    }
    expect(sqliteBusyTimeoutMs()).toBeGreaterThan(0);
  });
});
