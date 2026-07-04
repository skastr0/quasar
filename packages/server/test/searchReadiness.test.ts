import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DEFAULT_SEARCH_TABLE, LanceDb, LanceDbOperationFailed, MESSAGE_TEXT_INDEX_NAME, WriteReceipt, makeLanceDbLayer } from "../src/lancedb";
import { afterEach, describe, expect, test } from "bun:test";
import { Effect, Layer } from "effect";

import { makeEmbeddingProfile } from "../src/embeddingProfiles";
import type { MappedSession } from "../src/model";
import { SearchMaintenance, SearchMaintenanceLive } from "../src/maintenance";
import { DerivedSearch, DerivedSearchLive } from "../src/search";
import { SearchReadiness, SearchReadinessLive } from "../src/searchReadiness";
import { DurableQueue, Embeddings, makeDurableQueueLayer } from "../src/services";
import { LocalStore, makeLocalStoreLayer } from "../src/store";

const tempDirs: string[] = [];

const tempDir = () => {
  const dir = mkdtempSync(join(tmpdir(), "quasar-readiness-"));
  tempDirs.push(dir);
  return dir;
};

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

const mappedSession = (sessionId = "session-a", messages: MappedSession["messages"] = []): MappedSession => ({
  project: { projectKey: "project-a", displayName: "Project A", rawPath: "/tmp/project-a" },
  session: {
    sessionId,
    projectKey: "project-a",
    provider: "codex",
    agentName: "codex",
    sourcePath: `/history/${sessionId}.jsonl`,
    sourceFingerprint: `fp-${sessionId}-${messages.length}`,
    host: "host-a",
    identitySchemeVersion: 1,
    messageCount: messages.length,
    toolCallCount: 0,
  },
  messages,
  toolCalls: [],
});

const msg = (seq: number, role: "user" | "assistant" = "user"): MappedSession["messages"][number] => ({
  sessionId: "session-a",
  seq,
  role,
  text: `message text ${seq}`,
  projectKey: "project-a",
  contentHash: `hash-${seq}`,
});

const readinessProfile = makeEmbeddingProfile({
  model: "test-embedding",
  dimensions: 1536,
  task: "search_document",
});

const makeEmbeddingService = (ok: boolean, reason?: string) =>
  Embeddings.of({
    model: readinessProfile.model,
    profile: readinessProfile,
    embedText: () => Effect.die("embedText not used by readiness"),
    getCached: () => Effect.succeed(undefined),
    putCached: () => Effect.die("putCached not used by readiness"),
    processBatch: () => Effect.die("processBatch not used by readiness"),
    status: Effect.succeed({ cached: 0, pending: 0, profile: readinessProfile }),
    readiness: Effect.succeed({
      ok,
      checkedAt: "2026-06-18T10:00:00.000Z",
      reason,
    }),
  });

const withReadiness = <A>(
  run: Effect.Effect<A, unknown, LocalStore | LanceDb | DurableQueue | DerivedSearch | SearchReadiness | SearchMaintenance | Embeddings>,
  embeddings = makeEmbeddingService(true),
) => {
  const sqlite = join(tempDir(), "quasar.sqlite");
  const lance = join(tempDir(), "search.lance");
  const dataLayer = Layer.mergeAll(makeLocalStoreLayer(sqlite), makeLanceDbLayer({ dataDir: lance }));
  const queueLayer = makeDurableQueueLayer(sqlite);
  const embeddingsLayer = Layer.succeed(Embeddings, embeddings);
  const searchLayer = DerivedSearchLive.pipe(Layer.provide(dataLayer));
  const allData = Layer.mergeAll(dataLayer, queueLayer, embeddingsLayer, searchLayer);
  const readinessLayer = SearchReadinessLive.pipe(Layer.provide(allData));
  const maintenanceLayer = SearchMaintenanceLive.pipe(Layer.provide(allData));
  return Effect.runPromise(run.pipe(Effect.provide(Layer.mergeAll(allData, readinessLayer, maintenanceLayer))));
};

describe("SearchReadiness", () => {
  test("request-time readiness does not call heavy tableStats", async () => {
    let tableStatsCalls = 0;
    let storeStatsCalls = 0;
    const fakeStore = LocalStore.of({
      dbPath: "/tmp/quasar.sqlite",
      listProjects: () => Effect.succeed([]),
      upsertSession: () => Effect.void,
      hasSessionFingerprint: () => Effect.succeed(false),
      listSessions: () => Effect.succeed([]),
      getMessage: () => Effect.succeed(undefined),
      readMessages: () => Effect.succeed([]),
      listToolCalls: () => Effect.succeed([]),
      getToolCall: () => Effect.succeed(undefined),
      recordIngestRun: () => Effect.void,
      getIngestRun: () => Effect.succeed(undefined),
      listIngestRuns: () => Effect.succeed([]),
      stats: Effect.sync(() => {
        storeStatsCalls += 1;
        return { projects: 0, sessions: 0, messages: 99, toolCalls: 0, ingestRuns: 0 };
      }),
      markSessionIndexStale: () => Effect.void,
      markSessionIndexed: () => Effect.void,
      intendedPairs: () => Effect.succeed(new Map<string, string>()),
      sessionVersion: () => Effect.succeed({ updatedAt: null, messageCount: 0 }),
      putDivergence: () => Effect.void,
      clearDivergence: () => Effect.void,
      divergenceAggregate: Effect.succeed({ sessions: 0, missing: 0, stale: 0, extra: 0 }),
      divergentSessions: () => Effect.succeed([]),
      countStaleIndexSessions: () => Effect.succeed(0),
      countUnembeddedMessages: () => Effect.succeed(0),
      countSearchableMessages: () => Effect.succeed(1),
      close: Effect.void,
    });
    const fakeQueue = DurableQueue.of({
      enqueue: () => Effect.die("enqueue not used"),
      leaseBatch: () => Effect.succeed([]),
      ack: () => Effect.void,
      retry: () => Effect.void,
      fail: () => Effect.void,
      recoverStaleLeases: () => Effect.succeed(0),
      stats: Effect.succeed({ pending: 0, leased: 0, failed: 0 }),
      statsByKind: Effect.succeed([]),
      embedMessageStatsByProfile: () => Effect.succeed({ kind: "embed-message", pending: 0, leased: 0, failed: 0 }),
    });
    const fakeLance = LanceDb.make({
      dataDir: "/tmp/search.lance",
      connect: Effect.die("connect not used"),
      openTable: () => Effect.die("openTable not used"),
      ensureMessageTable: () => Effect.die("ensureMessageTable not used"),
      createMessageIndexes: () => Effect.void,
      countRows: ({ tableName }) => {
        expect(tableName).toBe(DEFAULT_SEARCH_TABLE);
        return Effect.succeed(1);
      },
      tableIndexStats: () =>
        Effect.succeed([
          {
            name: MESSAGE_TEXT_INDEX_NAME,
            indexType: "FTS",
            columns: ["text"],
            numIndexedRows: 1,
            numUnindexedRows: 0,
          },
        ]),
      tableStats: () => {
        tableStatsCalls += 1;
        return Effect.die("tableStats should not be called by readiness");
      },
      ensureTable: () => Effect.die("ensureTable not used"),
      upsertMessageRows: () => Effect.succeed(new WriteReceipt({ table: DEFAULT_SEARCH_TABLE, requested: 0, inserted: 0, updated: 0, deleted: 0 })),
      upsertRows: () => Effect.void,
      deleteByKeys: () => Effect.succeed(0),
      readRows: () => Effect.succeed([]),
      readMessageRowsBySession: () => Effect.succeed([]),
      readMessageRowsBySessions: () => Effect.succeed([]),
      vectorSearch: () => Effect.succeed([]),
      ftsSearch: () => Effect.succeed([]),
      hybridSearch: () => Effect.succeed([]),
      listIndexDirNames: () => Effect.succeed([]),
      deleteIndexDirsByName: () => Effect.succeed(0),
    });
    const layer = SearchReadinessLive.pipe(
      Layer.provide(Layer.mergeAll(
        Layer.succeed(LocalStore, fakeStore),
        Layer.succeed(DurableQueue, fakeQueue),
        Layer.succeed(LanceDb, fakeLance),
        Layer.succeed(Embeddings, makeEmbeddingService(true)),
      )),
    );

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const readiness = yield* SearchReadiness;
        return yield* readiness.assertSearchReady("lexical");
      }).pipe(Effect.provide(layer)),
    );

    expect(result.ok).toBe(true);
    expect(tableStatsCalls).toBe(0);
    expect(storeStatsCalls).toBe(0);
    expect(result.indexStats.sqliteSearchableCount).toBe(1);
    expect(result.indexStats.sqliteSearchableCount).not.toBe(99);
  });

  test("table-missing readiness uses cheap SQLite stats only on the missing-table branch", async () => {
    let tableStatsCalls = 0;
    let storeStatsCalls = 0;
    const unused = (name: string) => () => Effect.die(`${name} not used`);
    const fakeStore = LocalStore.of({
      dbPath: "/tmp/quasar.sqlite",
      listProjects: () => Effect.succeed([]),
      upsertSession: () => Effect.void,
      hasSessionFingerprint: () => Effect.succeed(false),
      listSessions: () => Effect.succeed([]),
      getMessage: () => Effect.succeed(undefined),
      readMessages: () => Effect.succeed([]),
      listToolCalls: () => Effect.succeed([]),
      getToolCall: () => Effect.succeed(undefined),
      recordIngestRun: () => Effect.void,
      getIngestRun: () => Effect.succeed(undefined),
      listIngestRuns: () => Effect.succeed([]),
      stats: Effect.sync(() => {
        storeStatsCalls += 1;
        return { projects: 0, sessions: 1, messages: 99, toolCalls: 0, ingestRuns: 0 };
      }),
      markSessionIndexStale: () => Effect.void,
      markSessionIndexed: () => Effect.void,
      intendedPairs: () => Effect.succeed(new Map<string, string>()),
      sessionVersion: () => Effect.succeed({ updatedAt: null, messageCount: 0 }),
      putDivergence: () => Effect.void,
      clearDivergence: () => Effect.void,
      divergenceAggregate: Effect.succeed({ sessions: 0, missing: 0, stale: 0, extra: 0 }),
      divergentSessions: () => Effect.succeed([]),
      countStaleIndexSessions: () => Effect.succeed(1),
      countUnembeddedMessages: () => Effect.succeed(0),
      countSearchableMessages: () => Effect.succeed(2),
      close: Effect.void,
    });
    const fakeQueue = DurableQueue.of({
      enqueue: unused("enqueue"),
      leaseBatch: () => Effect.succeed([]),
      ack: () => Effect.void,
      retry: () => Effect.void,
      fail: () => Effect.void,
      recoverStaleLeases: () => Effect.succeed(0),
      stats: Effect.succeed({ pending: 0, leased: 0, failed: 0 }),
      statsByKind: Effect.succeed([]),
      embedMessageStatsByProfile: () => Effect.succeed({ kind: "embed-message", pending: 0, leased: 0, failed: 0 }),
    });
    const fakeLance = LanceDb.make({
      dataDir: "/tmp/search.lance",
      connect: Effect.die("connect not used"),
      openTable: unused("openTable"),
      ensureMessageTable: unused("ensureMessageTable"),
      createMessageIndexes: () => Effect.void,
      countRows: () =>
        Effect.fail(new LanceDbOperationFailed({
          tableName: DEFAULT_SEARCH_TABLE,
          operation: "countRows",
          message: "Table not found: messages",
        })),
      tableIndexStats: unused("tableIndexStats"),
      tableStats: () => {
        tableStatsCalls += 1;
        return Effect.die("tableStats should not be called by readiness");
      },
      ensureTable: unused("ensureTable"),
      upsertMessageRows: () => Effect.succeed(new WriteReceipt({ table: DEFAULT_SEARCH_TABLE, requested: 0, inserted: 0, updated: 0, deleted: 0 })),
      upsertRows: () => Effect.void,
      deleteByKeys: () => Effect.succeed(0),
      readRows: () => Effect.succeed([]),
      readMessageRowsBySession: () => Effect.succeed([]),
      readMessageRowsBySessions: () => Effect.succeed([]),
      vectorSearch: () => Effect.succeed([]),
      ftsSearch: () => Effect.succeed([]),
      hybridSearch: () => Effect.succeed([]),
      listIndexDirNames: () => Effect.succeed([]),
      deleteIndexDirsByName: () => Effect.succeed(0),
    });
    const layer = SearchReadinessLive.pipe(
      Layer.provide(Layer.mergeAll(
        Layer.succeed(LocalStore, fakeStore),
        Layer.succeed(DurableQueue, fakeQueue),
        Layer.succeed(LanceDb, fakeLance),
        Layer.succeed(Embeddings, makeEmbeddingService(true)),
      )),
    );

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const readiness = yield* SearchReadiness;
        return yield* readiness.assertSearchReady("lexical");
      }).pipe(Effect.provide(layer)),
    );

    expect(result.ok).toBe(false);
    expect(result.reason).toContain("LanceDB table not found");
    expect(result.indexStats.sqliteSearchableCount).toBe(2);
    expect(storeStatsCalls).toBe(0);
    expect(tableStatsCalls).toBe(0);
  });

  test("empty corpus stays ready even with a stale session watermark", async () => {
    let tableStatsCalls = 0;
    const fakeStore = LocalStore.of({
      dbPath: "/tmp/quasar.sqlite",
      listProjects: () => Effect.succeed([]),
      upsertSession: () => Effect.void,
      hasSessionFingerprint: () => Effect.succeed(false),
      listSessions: () => Effect.succeed([]),
      getMessage: () => Effect.succeed(undefined),
      readMessages: () => Effect.succeed([]),
      listToolCalls: () => Effect.succeed([]),
      getToolCall: () => Effect.succeed(undefined),
      recordIngestRun: () => Effect.void,
      getIngestRun: () => Effect.succeed(undefined),
      listIngestRuns: () => Effect.succeed([]),
      stats: Effect.succeed({ projects: 0, sessions: 0, messages: 0, toolCalls: 0, ingestRuns: 0 }),
      markSessionIndexStale: () => Effect.void,
      markSessionIndexed: () => Effect.void,
      intendedPairs: () => Effect.succeed(new Map<string, string>()),
      sessionVersion: () => Effect.succeed({ updatedAt: null, messageCount: 0 }),
      putDivergence: () => Effect.void,
      clearDivergence: () => Effect.void,
      divergenceAggregate: Effect.succeed({ sessions: 0, missing: 0, stale: 0, extra: 0 }),
      divergentSessions: () => Effect.succeed([]),
      countStaleIndexSessions: () => Effect.succeed(1),
      countUnembeddedMessages: () => Effect.succeed(0),
      countSearchableMessages: () => Effect.succeed(0),
      close: Effect.void,
    });
    const fakeQueue = DurableQueue.of({
      enqueue: () => Effect.die("enqueue not used"),
      leaseBatch: () => Effect.succeed([]),
      ack: () => Effect.void,
      retry: () => Effect.void,
      fail: () => Effect.void,
      recoverStaleLeases: () => Effect.succeed(0),
      stats: Effect.succeed({ pending: 0, leased: 0, failed: 0 }),
      statsByKind: Effect.succeed([]),
      embedMessageStatsByProfile: () => Effect.succeed({ kind: "embed-message", pending: 0, leased: 0, failed: 0 }),
    });
    const fakeLance = LanceDb.make({
      dataDir: "/tmp/search.lance",
      connect: Effect.die("connect not used"),
      openTable: () => Effect.die("openTable not used"),
      ensureMessageTable: () => Effect.die("ensureMessageTable not used"),
      createMessageIndexes: () => Effect.void,
      countRows: () => Effect.fail(new LanceDbOperationFailed({
        tableName: DEFAULT_SEARCH_TABLE,
        operation: "countRows",
        message: "Table not found: messages",
      })),
      tableIndexStats: () => Effect.succeed([]),
      tableStats: () => {
        tableStatsCalls += 1;
        return Effect.die("tableStats should not be called by readiness");
      },
      ensureTable: () => Effect.die("ensureTable not used"),
      upsertMessageRows: () => Effect.succeed(new WriteReceipt({ table: DEFAULT_SEARCH_TABLE, requested: 0, inserted: 0, updated: 0, deleted: 0 })),
      upsertRows: () => Effect.void,
      deleteByKeys: () => Effect.succeed(0),
      readRows: () => Effect.succeed([]),
      readMessageRowsBySession: () => Effect.succeed([]),
      readMessageRowsBySessions: () => Effect.succeed([]),
      vectorSearch: () => Effect.succeed([]),
      ftsSearch: () => Effect.succeed([]),
      hybridSearch: () => Effect.succeed([]),
      listIndexDirNames: () => Effect.succeed([]),
      deleteIndexDirsByName: () => Effect.succeed(0),
    });
    const layer = SearchReadinessLive.pipe(
      Layer.provide(Layer.mergeAll(
        Layer.succeed(LocalStore, fakeStore),
        Layer.succeed(DurableQueue, fakeQueue),
        Layer.succeed(LanceDb, fakeLance),
        Layer.succeed(Embeddings, makeEmbeddingService(true)),
      )),
    );

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const readiness = yield* SearchReadiness;
        return yield* readiness.assertSearchReady("lexical");
      }).pipe(Effect.provide(layer)),
    );

    expect(result.ok).toBe(true);
    expect(result.indexStats.staleSessions).toBe(1);
    expect(tableStatsCalls).toBe(0);
  });

  test("lexical stays ready while semantic and fusion fail closed when synthetic embeddings are unavailable", async () => {
    const [lexical, semantic, fusion] = await withReadiness(
      Effect.gen(function* () {
        const readiness = yield* SearchReadiness;
        return yield* Effect.all([
          readiness.assertSearchReady("lexical"),
          readiness.assertSearchReady("semantic"),
          readiness.assertSearchReady("fusion"),
        ]);
      }),
      makeEmbeddingService(false, "Synthetic embeddings are unavailable"),
    );

    expect(lexical.ok).toBe(true);
    expect(semantic.ok).toBe(false);
    expect(fusion.ok).toBe(false);
    expect(lexical.syntheticEmbeddingReady).toBeUndefined();
    expect(semantic.syntheticEmbeddingReady).toBe(false);
    expect(fusion.syntheticEmbeddingReady).toBe(false);
    expect(semantic.syntheticEmbeddingReason).toContain("Synthetic embeddings are unavailable");
    expect(fusion.syntheticEmbeddingReason).toContain("Synthetic embeddings are unavailable");
  });

  test("populated fully indexed corpus keeps lexical ready but fails semantic and fusion closed without Synthetic", async () => {
    const [lexical, semantic, fusion] = await withReadiness(
      Effect.gen(function* () {
        const store = yield* LocalStore;
        const derived = yield* DerivedSearch;
        const maintenance = yield* SearchMaintenance;
        const readiness = yield* SearchReadiness;
        yield* store.upsertSession(mappedSession("session-a", [msg(1), msg(2, "assistant")]));
        yield* derived.indexSession("session-a");
        yield* maintenance.maintain();
        return yield* Effect.all([
          readiness.assertSearchReady("lexical"),
          readiness.assertSearchReady("semantic"),
          readiness.assertSearchReady("fusion"),
        ]);
      }),
      makeEmbeddingService(false, "Synthetic embeddings are unavailable"),
    );

    expect(lexical.ok).toBe(true);
    expect(semantic.ok).toBe(false);
    expect(fusion.ok).toBe(false);
    expect(lexical.syntheticEmbeddingReady).toBeUndefined();
    expect(semantic.syntheticEmbeddingReady).toBe(false);
    expect(fusion.syntheticEmbeddingReady).toBe(false);
    expect(semantic.indexStats.sqliteSearchableCount).toBe(2);
    expect(semantic.indexStats.pendingEmbedJobs).toBe(0);
  });

  test("stays not ready when LanceDB rows are deleted after indexing", async () => {
    const result = await withReadiness(
      Effect.gen(function* () {
        const store = yield* LocalStore;
        const search = yield* LanceDb;
        const readiness = yield* SearchReadiness;
        yield* store.upsertSession(mappedSession("session-a", [msg(1), msg(2, "assistant")]));
        yield* search.upsertMessageRows({
          tableName: DEFAULT_SEARCH_TABLE,
          rows: [
            {
              sessionId: "session-a",
              seq: 1,
              role: "user",
              projectKey: "project-a",
              provider: "codex",
              text: "message text 1",
              contentHash: "hash-1",
              vector: Array.from({ length: 1536 }, () => 0),
            },
            {
              sessionId: "session-a",
              seq: 2,
              role: "assistant",
              projectKey: "project-a",
              provider: "codex",
              text: "message text 2",
              contentHash: "hash-2",
              vector: Array.from({ length: 1536 }, () => 0),
            },
          ],
        });
        yield* search.deleteByKeys({
          tableName: DEFAULT_SEARCH_TABLE,
          keys: ["session-a:1:user", "session-a:2:assistant"],
        });
        return yield* readiness.assertSearchReady("lexical");
      }),
    );

    expect(result.ok).toBe(false);
    expect(result.indexStats.sqliteSearchableCount).toBe(2);
    expect(result.indexStats.lanceRowCount).toBe(0);
    // 2 of 2 missing = ratio 1.0, far above tolerance → fails closed on divergence.
    expect(result.reason).toMatch(/divergence|shortfall|does not match|table not found/i);
  });

  test("empty corpus returns ready for all modes", async () => {
    const [lexical, semantic, fusion] = await withReadiness(
      Effect.gen(function* () {
        const readiness = yield* SearchReadiness;
        return yield* Effect.all([
          readiness.assertSearchReady("lexical"),
          readiness.assertSearchReady("semantic"),
          readiness.assertSearchReady("fusion"),
        ]);
      }),
    );

    expect(lexical.ok).toBe(true);
    expect(semantic.ok).toBe(true);
    expect(fusion.ok).toBe(true);
    expect(lexical.staleCount).toBe(0);
    expect(lexical.missingVectorCount).toBe(0);
  });

  test("not ready when session upserted but not indexed — LanceDB has no rows yet", async () => {
    const result = await withReadiness(
      Effect.gen(function* () {
        const store = yield* LocalStore;
        const readiness = yield* SearchReadiness;
        yield* store.upsertSession(mappedSession("session-a", [msg(1), msg(2, "assistant")]));
        return yield* readiness.assertSearchReady("lexical");
      }),
    );

    // SQLite has 2 searchable messages; LanceDB table doesn't exist yet → not ready
    expect(result.ok).toBe(false);
    expect(result.indexStats.sqliteSearchableCount).toBe(2);
    expect(result.indexStats.lanceRowCount).toBe(0);
    expect(result.reason).toBeDefined();
    // Either "row count mismatch" (after table is created) or "table not found" (before first indexSession).
    expect(result.reason).toMatch(/row count mismatch|table not found|searchable messages/i);
  });

  test("serves despite a stale index watermark — a catching-up tail is not degraded (C1)", async () => {
    // E3 + docs.lancedb.com/indexing/fts-index: LanceDB serves rows regardless of
    // whether the FTS index has caught up; an unindexed/stale tail yields
    // complete-or-current results, never wrong ones. Staleness is DISCLOSED, not a 503.
    const result = await withReadiness(
      Effect.gen(function* () {
        const store = yield* LocalStore;
        const derived = yield* DerivedSearch;
        const readiness = yield* SearchReadiness;
        yield* store.upsertSession(mappedSession("session-a", [msg(1)]));
        yield* derived.indexSession("session-a"); // LanceDB table now exists with the row
        // Re-mark the watermark stale (re-ingested-but-not-yet-reindexed).
        yield* store.markSessionIndexStale("session-a");
        return yield* readiness.assertSearchReady("lexical");
      }),
    );

    // Table exists → serve. Watermark staleness is disclosed but never blocks.
    expect(result.ok).toBe(true);
    expect(result.indexStats.staleSessions).toBeGreaterThan(0);
  });

  test("ready after full index cycle: upsert → indexSession → maintain → watermark set", async () => {
    const result = await withReadiness(
      Effect.gen(function* () {
        const store = yield* LocalStore;
        const derived = yield* DerivedSearch;
        const maintenance = yield* SearchMaintenance;
        const readiness = yield* SearchReadiness;
        yield* store.upsertSession(mappedSession("session-a", [msg(1), msg(2, "assistant")]));
        yield* derived.indexSession("session-a");
        // The always-on maintenance worker folds newly-written rows into the FTS index.
        // Call maintain() directly here to simulate one worker tick.
        yield* maintenance.maintain();
        return yield* readiness.assertSearchReady("lexical");
      }),
    );

    expect(result.ok).toBe(true);
    expect(result.staleCount).toBe(0);
    expect(result.indexStats.staleSessions).toBe(0);
    expect(result.indexStats.numUnindexedTextRows).toBe(0);
  });

  test("blocks semantic while embeds are pending", async () => {
    const result = await withReadiness(
      Effect.gen(function* () {
        const store = yield* LocalStore;
        const derived = yield* DerivedSearch;
        const queue = yield* DurableQueue;
        const readiness = yield* SearchReadiness;
        yield* store.upsertSession(mappedSession("session-a", [msg(1)]));
        yield* derived.indexSession("session-a"); // table exists
        // Enqueue an embed-message job to simulate pending embedding work.
        yield* queue.enqueue({
          kind: "embed-message",
          payload: { sessionId: "session-a", seq: 1, contentHash: "hash-1", embeddingProfile: "test" },
          idempotencyKey: "embed-message:test:session-a:1:hash-1",
        });
        return yield* readiness.assertSearchReady("semantic");
      }),
    );

    expect(result.ok).toBe(false);
    expect(result.indexStats.pendingEmbedJobs).toBeGreaterThan(0);
    expect(result.missingVectorCount).toBeGreaterThan(0);
  });

  test("blocks semantic when SQLite still has unembedded searchable rows but the queue is empty", async () => {
    const result = await withReadiness(
      Effect.gen(function* () {
        const store = yield* LocalStore;
        const search = yield* LanceDb;
        const readiness = yield* SearchReadiness;
        yield* store.upsertSession(mappedSession("session-a", [{ ...msg(1), contentHash: "unembedded:hash-1" }]));
        yield* search.upsertMessageRows({
          tableName: DEFAULT_SEARCH_TABLE,
          rows: [
            {
              sessionId: "session-a",
              seq: 1,
              role: "user",
              projectKey: "project-a",
              provider: "codex",
              text: "message text 1",
              contentHash: "unembedded:hash-1",
              vector: Array.from({ length: 1536 }, () => 0),
            },
          ],
        });
        return yield* readiness.assertSearchReady("semantic");
      }),
    );

    expect(result.ok).toBe(false);
    expect(result.indexStats.unembeddedVectorRows).toBe(1);
    expect(result.indexStats.pendingEmbedJobs).toBe(0);
    expect(result.missingVectorCount).toBe(1);
  });

  test("semantic ready after all embed jobs complete", async () => {
    // With no embed jobs queued and all messages indexed, semantic should be ready.
    const result = await withReadiness(
      Effect.gen(function* () {
        const store = yield* LocalStore;
        const derived = yield* DerivedSearch;
        const maintenance = yield* SearchMaintenance;
        const readiness = yield* SearchReadiness;
        yield* store.upsertSession(mappedSession("session-a", [msg(1)]));
        yield* derived.indexSession("session-a");
        // The maintenance worker folds rows into the FTS index; simulate one tick.
        yield* maintenance.maintain();
        // No embed jobs → pendingEmbedJobs=0; no unembedded SQLite messages.
        return yield* readiness.assertSearchReady("semantic");
      }),
    );

    // lexical checks pass; semantic adds vector checks — both clear.
    expect(result.ok).toBe(true);
    expect(result.indexStats.pendingEmbedJobs).toBe(0);
  });

  test("discriminates building-vs-empty: rowCount>0 sqliteCount>0 with stale index returns not-ready, not empty-ready", async () => {
    // "Building" state: LanceDB has rows, FTS index not yet built.
    // vs "empty" state: both sides 0 → ready.
    // The row-count-parity check ensures building !== empty.
    const [empty, building] = await withReadiness(
      Effect.gen(function* () {
        const store = yield* LocalStore;
        const lance = yield* LanceDb;
        const readiness = yield* SearchReadiness;

        const emptyResult = yield* readiness.assertSearchReady("lexical");

        // Now write a session to SQLite but don't index to LanceDB.
        yield* store.upsertSession(mappedSession("session-a", [msg(1)]));
        const buildingResult = yield* readiness.assertSearchReady("lexical");

        return [emptyResult, buildingResult] as const;
      }),
    );

    // Empty corpus: ready.
    expect(empty.ok).toBe(true);
    expect(empty.indexStats.lanceRowCount).toBe(0);
    expect(empty.indexStats.sqliteSearchableCount).toBe(0);

    // Building: not ready (SQLite has 1, LanceDB table absent or row count mismatch).
    expect(building.ok).toBe(false);
    expect(building.indexStats.sqliteSearchableCount).toBe(1);
    expect(building.indexStats.lanceRowCount).toBe(0);
    expect(building.reason).toMatch(/row count mismatch|table not found|searchable messages/i);
  });

  test("maintenance worker makes a freshly-indexed session searchable", async () => {
    // indexSession writes rows to LanceDB but does not optimize inline.
    // The always-on maintenance worker folds rows into the FTS index per table
    // once writers are idle. Call maintain() directly to simulate one worker tick.
    const [readiness, hits] = await withReadiness(
      Effect.gen(function* () {
        const store = yield* LocalStore;
        const derived = yield* DerivedSearch;
        const maintenance = yield* SearchMaintenance;
        const readiness = yield* SearchReadiness;
        yield* store.upsertSession(mappedSession("session-a", [msg(1)]));
        yield* derived.indexSession("session-a");
        yield* maintenance.maintain();
        const result = yield* readiness.assertSearchReady("lexical");
        const hits = yield* derived.lexicalSearch({ query: "message text", limit: 10 });
        return [result, hits] as const;
      }),
    );

    expect(readiness.ok).toBe(true);
    expect(readiness.indexStats.numUnindexedTextRows).toBe(0);
    // lexicalSearch finds the message after the maintenance worker runs.
    expect(hits.length).toBeGreaterThan(0);
  });

  test("upsertSession marks index stale; indexSession clears it", async () => {
    const [afterUpsert, afterIndex] = await withReadiness(
      Effect.gen(function* () {
        const store = yield* LocalStore;
        const derived = yield* DerivedSearch;
        yield* store.upsertSession(mappedSession("session-a", [msg(1)]));
        const afterUpsert = yield* store.countStaleIndexSessions();
        yield* derived.indexSession("session-a");
        const afterIndex = yield* store.countStaleIndexSessions();
        return [afterUpsert, afterIndex] as const;
      }),
    );

    expect(afterUpsert).toBe(1);
    expect(afterIndex).toBe(0);
  });

  test("/search 503 (not 200) via assertSearchReady when stale", async () => {
    // This tests the service contract: assertSearchReady returns ok:false when stale.
    // The HTTP gate converts this to 503. We verify the service layer here;
    // the HTTP integration is covered by server.test.ts.
    const result = await withReadiness(
      Effect.gen(function* () {
        const store = yield* LocalStore;
        const readiness = yield* SearchReadiness;
        // Upsert session but do NOT call indexSession → stale.
        yield* store.upsertSession(mappedSession("session-a", [msg(1)]));
        return yield* readiness.assertSearchReady("lexical");
      }),
    );

    // assertSearchReady returns ok:false with code-level info for 503 response body.
    expect(result.ok).toBe(false);
    expect(result.staleCount).toBeGreaterThan(0);
    expect(result.missingVectorCount).toBe(0);
    expect(result.indexStats).toBeDefined();
    expect(typeof result.reason).toBe("string");
  });

  // ── classify-then-gate: degraded serve vs structural close (kills the exact cliff) ──
  const classifyLayer = (opts: {
    searchable: number;
    lanceRows: number;
    divergence?: { sessions: number; missing: number; stale: number; extra: number };
  }) => {
    const fakeStore = LocalStore.of({
      dbPath: "/tmp/q.sqlite",
      listProjects: () => Effect.succeed([]),
      upsertSession: () => Effect.void,
      hasSessionFingerprint: () => Effect.succeed(false),
      listSessions: () => Effect.succeed([]),
      getMessage: () => Effect.succeed(undefined),
      readMessages: () => Effect.succeed([]),
      listToolCalls: () => Effect.succeed([]),
      getToolCall: () => Effect.succeed(undefined),
      recordIngestRun: () => Effect.void,
      getIngestRun: () => Effect.succeed(undefined),
      listIngestRuns: () => Effect.succeed([]),
      stats: Effect.succeed({ projects: 0, sessions: 1, messages: opts.searchable, toolCalls: 0, ingestRuns: 0 }),
      markSessionIndexStale: () => Effect.void,
      markSessionIndexed: () => Effect.void,
      intendedPairs: () => Effect.succeed(new Map<string, string>()),
      sessionVersion: () => Effect.succeed({ updatedAt: null, messageCount: 0 }),
      putDivergence: () => Effect.void,
      clearDivergence: () => Effect.void,
      divergenceAggregate: Effect.succeed(opts.divergence ?? { sessions: 0, missing: 0, stale: 0, extra: 0 }),
      divergentSessions: () => Effect.succeed([]),
      countStaleIndexSessions: () => Effect.succeed(0),
      countUnembeddedMessages: () => Effect.succeed(0),
      countSearchableMessages: () => Effect.succeed(opts.searchable),
      close: Effect.void,
    });
    const fakeQueue = DurableQueue.of({
      enqueue: () => Effect.void,
      leaseBatch: () => Effect.succeed([]),
      ack: () => Effect.void,
      retry: () => Effect.void,
      fail: () => Effect.void,
      recoverStaleLeases: () => Effect.succeed(0),
      stats: Effect.succeed({ pending: 0, leased: 0, failed: 0 }),
      statsByKind: Effect.succeed([]),
      embedMessageStatsByProfile: () => Effect.succeed({ kind: "embed-message", pending: 0, leased: 0, failed: 0 }),
    });
    const fakeLance = LanceDb.make({
      dataDir: "/tmp/s.lance",
      connect: Effect.die("connect not used"),
      openTable: () => Effect.die("openTable not used"),
      ensureMessageTable: () => Effect.die("ensureMessageTable not used"),
      createMessageIndexes: () => Effect.void,
      countRows: () => Effect.succeed(opts.lanceRows),
      tableIndexStats: () =>
        Effect.succeed([
          { name: MESSAGE_TEXT_INDEX_NAME, indexType: "FTS", columns: ["text"], numIndexedRows: opts.lanceRows, numUnindexedRows: 0 },
        ]),
      tableStats: () => Effect.die("tableStats not used"),
      ensureTable: () => Effect.die("ensureTable not used"),
      upsertMessageRows: () => Effect.succeed(new WriteReceipt({ table: DEFAULT_SEARCH_TABLE, requested: 0, inserted: 0, updated: 0, deleted: 0 })),
      upsertRows: () => Effect.void,
      deleteByKeys: () => Effect.succeed(0),
      readRows: () => Effect.succeed([]),
      readMessageRowsBySession: () => Effect.succeed([]),
      readMessageRowsBySessions: () => Effect.succeed([]),
      vectorSearch: () => Effect.succeed([]),
      ftsSearch: () => Effect.succeed([]),
      hybridSearch: () => Effect.succeed([]),
      listIndexDirNames: () => Effect.succeed([]),
      deleteIndexDirsByName: () => Effect.succeed(0),
    });
    return SearchReadinessLive.pipe(
      Layer.provide(Layer.mergeAll(
        Layer.succeed(LocalStore, fakeStore),
        Layer.succeed(DurableQueue, fakeQueue),
        Layer.succeed(LanceDb, fakeLance),
        Layer.succeed(Embeddings, makeEmbeddingService(true)),
      )),
    );
  };
  const assertLexical = (layer: Layer.Layer<SearchReadiness>) =>
    Effect.runPromise(Effect.flatMap(SearchReadiness, (r) => r.assertSearchReady("lexical")).pipe(Effect.provide(layer)));

  test("a sub-tolerance missing shortfall serves DEGRADED with disclosed completeness — no 503 cliff", async () => {
    const result = await assertLexical(classifyLayer({ searchable: 100_000, lanceRows: 99_998 }));
    expect(result.ok).toBe(true); // 2 of 100k missing was a total outage before; now it serves
    expect(result.completeness).toBeGreaterThan(0.9999);
    expect(result.completeness).toBeLessThan(1);
  });

  test("a missing shortfall ABOVE tolerance fails closed", async () => {
    const result = await assertLexical(classifyLayer({ searchable: 100, lanceRows: 50 }));
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/divergence|shortfall/i);
  });

  test("a small structural divergence (orphan tail) serves DEGRADED — not a 100% outage", async () => {
    // 2 orphan rows of 100k = 0.002%: a normal ingest tail, not corruption. Before, ANY
    // extra row failed ALL search closed; a measured 0.25% tail was a total outage.
    const result = await assertLexical(classifyLayer({ searchable: 100_000, lanceRows: 100_002 }));
    expect(result.ok).toBe(true);
    expect(result.completeness).toBeGreaterThan(0.999);
    expect(result.completeness).toBeLessThan(1);
  });

  test("a large structural divergence (gross corruption) fails closed", async () => {
    const result = await assertLexical(classifyLayer({ searchable: 100, lanceRows: 200 }));
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/divergence|tolerance/i);
  });

  test("a small ledger-reported stale tail serves degraded; a large one fails closed", async () => {
    const small = await assertLexical(
      classifyLayer({ searchable: 100_000, lanceRows: 100_000, divergence: { sessions: 1, missing: 0, stale: 3, extra: 0 } }),
    );
    expect(small.ok).toBe(true);
    const large = await assertLexical(
      classifyLayer({ searchable: 100, lanceRows: 100, divergence: { sessions: 1, missing: 0, stale: 10, extra: 0 } }),
    );
    expect(large.ok).toBe(false);
    expect(large.reason).toMatch(/divergence|tolerance/i);
  });
});
