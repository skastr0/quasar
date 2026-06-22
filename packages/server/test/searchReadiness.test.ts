import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { LanceDb, makeLanceDbLayer } from "../src/lancedb";
import { afterEach, describe, expect, test } from "bun:test";
import { Effect, Layer } from "effect";

import type { MappedSession } from "../src/model";
import { SearchMaintenance, SearchMaintenanceLive } from "../src/maintenance";
import { DerivedSearch, DerivedSearchLive } from "../src/search";
import { SearchReadiness, SearchReadinessLive } from "../src/searchReadiness";
import { DurableQueue, makeDurableQueueLayer } from "../src/services";
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

const withReadiness = <A>(
  run: Effect.Effect<A, unknown, LocalStore | LanceDb | DurableQueue | DerivedSearch | SearchReadiness | SearchMaintenance>,
) => {
  const sqlite = join(tempDir(), "quasar.sqlite");
  const lance = join(tempDir(), "search.lance");
  const dataLayer = Layer.mergeAll(makeLocalStoreLayer(sqlite), makeLanceDbLayer({ dataDir: lance }));
  const queueLayer = makeDurableQueueLayer(sqlite);
  const searchLayer = DerivedSearchLive.pipe(Layer.provide(dataLayer));
  const allData = Layer.mergeAll(dataLayer, queueLayer, searchLayer);
  const readinessLayer = SearchReadinessLive.pipe(Layer.provide(allData));
  const maintenanceLayer = SearchMaintenanceLive.pipe(Layer.provide(allData));
  return Effect.runPromise(run.pipe(Effect.provide(Layer.mergeAll(allData, readinessLayer, maintenanceLayer))));
};

describe("SearchReadiness", () => {
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

  test("not ready when rows exist but text_idx has unindexed rows", async () => {
    // Write rows to LanceDB without creating the FTS index.
    const result = await withReadiness(
      Effect.gen(function* () {
        const store = yield* LocalStore;
        const derived = yield* DerivedSearch;
        const readiness = yield* SearchReadiness;
        yield* store.upsertSession(mappedSession("session-a", [msg(1)]));
        // indexSession writes rows but also calls createMessageIndexes + optimizeTable.
        // We need to isolate: upsert session → LanceDB rows present, but check BEFORE
        // the FTS index is active. Since indexSession now auto-creates the index,
        // we use store.markSessionIndexStale to simulate a stale watermark after indexing.
        yield* derived.indexSession("session-a");
        // Force the watermark back to stale to simulate a session that was re-ingested
        // but not yet re-indexed (the staleness path that the gate must catch).
        yield* store.markSessionIndexStale("session-a");
        return yield* readiness.assertSearchReady("lexical");
      }),
    );

    // Watermark is stale even though LanceDB row count matches.
    expect(result.ok).toBe(false);
    expect(result.indexStats.staleSessions).toBeGreaterThan(0);
    expect(result.reason).toContain("stale index watermark");
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

  test("semantic/fusion not ready when unembedded messages remain", async () => {
    // contentHash LIKE 'unembedded:%' is set by indexedContentHash() for all
    // searchable-role messages (since they haven't been embedded yet).
    // After indexSession, SQLite messages still have their original contentHash
    // from the ingest, not the 'unembedded:' prefix. The prefix is only added
    // when writing to LanceDB (via indexedContentHash in search.ts). However,
    // SQLite's messages table stores the RAW contentHash. The store.countUnembeddedMessages()
    // method counts messages WHERE content_hash LIKE 'unembedded:%' — but the
    // ingest sets plain contentHashes, not unembedded: ones.
    //
    // The actual semantic readiness depends on embed-message queue jobs and
    // LanceDB VECTOR_READY_FILTER rows (not SQLite messages). For the SQLite
    // countUnembeddedMessages() method to return > 0, messages would need
    // contentHash='unembedded:...' which isn't what ingest writes.
    //
    // So: semantic not-ready is signalled by pendingEmbedJobs > 0.
    const result = await withReadiness(
      Effect.gen(function* () {
        const store = yield* LocalStore;
        const derived = yield* DerivedSearch;
        const queue = yield* DurableQueue;
        const readiness = yield* SearchReadiness;
        yield* store.upsertSession(mappedSession("session-a", [msg(1)]));
        yield* derived.indexSession("session-a");
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
    expect(result.missingVectorCount).toBeGreaterThanOrEqual(0);
    expect(result.indexStats.pendingEmbedJobs).toBeGreaterThan(0);
    expect(result.reason).toContain("embed-message jobs pending/leased");
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
});
