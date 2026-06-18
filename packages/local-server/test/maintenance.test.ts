import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { LanceDb, makeLanceDbLayer } from "@skastr0/quasar-search";
import { afterEach, describe, expect, test } from "bun:test";
import { Effect, Layer } from "effect";

import { embeddingProfileFromEnv, embeddingProfileSearchTable, makeGeminiEmbeddingProfile } from "../src/embeddingProfiles";
import { SearchMaintenance, SearchMaintenanceLive } from "../src/maintenance";
import { makeEmbeddingsLayer, type Embedder } from "../src/embeddings";
import type { MappedSession } from "../src/model";
import { DerivedSearch, DerivedSearchLive } from "../src/search";
import { DurableQueue, Embeddings, makeDurableQueueLayer } from "../src/services";
import { LocalStore, makeLocalStoreLayer } from "../src/store";

const tempDirs: string[] = [];

const tempDir = () => {
  const dir = mkdtempSync(join(tmpdir(), "quasar-local-maintenance-"));
  tempDirs.push(dir);
  return dir;
};

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

const mappedSession = (sessionId = "session-a", text = "alpha terminal"): MappedSession => ({
  project: { projectKey: "project-a", displayName: "Project A", rawPath: "/tmp/project-a" },
  session: {
    sessionId,
    projectKey: "project-a",
    provider: "codex",
    agentName: "codex",
    sourcePath: `/history/${sessionId}.jsonl`,
    sourceFingerprint: `fingerprint-${sessionId}`,
    messageCount: 1,
    toolCallCount: 0,
  },
  messages: [
    {
      sessionId,
      seq: 1,
      role: "user",
      text,
      projectKey: "project-a",
      contentHash: `hash-${sessionId}`,
    },
  ],
  toolCalls: [],
});

const embeddingEnvKeys = [
  "QUASAR_EMBEDDING_PROVIDER",
  "QUASAR_EMBEDDING_MODEL",
  "QUASAR_EMBEDDING_DIMENSIONS",
  "QUASAR_EMBEDDING_TASK",
  "QUASAR_EMBEDDING_CACHE_NAMESPACE",
  "QUASAR_EMBEDDING_DOCUMENT_PREFIX",
  "QUASAR_EMBEDDING_QUERY_PREFIX",
] as const;

const withEmbeddingEnv = <A>(
  embeddingEnv: Partial<Record<(typeof embeddingEnvKeys)[number], string>>,
  run: () => Promise<A>,
) => {
  const previousEnv = Object.fromEntries(
    embeddingEnvKeys.map((key) => [key, process.env[key]] as const),
  );
  for (const key of embeddingEnvKeys) {
    const value = embeddingEnv[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  return run().finally(() => {
    for (const key of embeddingEnvKeys) {
      const value = previousEnv[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
};

const withMaintenance = <A>(
  run: Effect.Effect<A, unknown, LocalStore | LanceDb | DurableQueue | DerivedSearch | SearchMaintenance>,
  embeddingEnv: Partial<Record<(typeof embeddingEnvKeys)[number], string>> = {},
) => withEmbeddingEnv(embeddingEnv, () => {
  const sqlite = join(tempDir(), "quasar.sqlite");
  const lance = join(tempDir(), "search.lance");
  const dataLayer = Layer.mergeAll(makeLocalStoreLayer(sqlite), makeLanceDbLayer({ dataDir: lance }));
  const queueLayer = makeDurableQueueLayer(sqlite);
  const searchLayer = DerivedSearchLive.pipe(Layer.provide(dataLayer));
  const maintenanceLayer = SearchMaintenanceLive.pipe(Layer.provide(Layer.mergeAll(dataLayer, queueLayer, searchLayer)));
  return Effect.runPromise(run.pipe(Effect.provide(Layer.mergeAll(dataLayer, queueLayer, searchLayer, maintenanceLayer))));
});

const withMaintenanceAndEmbeddings = <A>(run: Effect.Effect<A, unknown, LocalStore | LanceDb | DurableQueue | DerivedSearch | SearchMaintenance | Embeddings>) => withEmbeddingEnv({}, () => {
  const sqlite = join(tempDir(), "quasar.sqlite");
  const lance = join(tempDir(), "search.lance");
  const embedder: Embedder = {
    embedMany: async (values) => values.map(() => Array.from({ length: 1536 }, (_, index) => index === 0 ? 1 : 0)),
  };
  const dataLayer = Layer.mergeAll(makeLocalStoreLayer(sqlite), makeLanceDbLayer({ dataDir: lance }));
  const queueLayer = makeDurableQueueLayer(sqlite);
  const searchLayer = DerivedSearchLive.pipe(Layer.provide(dataLayer));
  const embeddingsLayer = makeEmbeddingsLayer({ sqlite, profile: makeGeminiEmbeddingProfile({ model: "test-maintenance" }), embedder }).pipe(Layer.provide(Layer.merge(dataLayer, queueLayer)));
  const maintenanceLayer = SearchMaintenanceLive.pipe(Layer.provide(Layer.mergeAll(dataLayer, queueLayer, searchLayer)));
  return Effect.runPromise(run.pipe(Effect.provide(Layer.mergeAll(dataLayer, queueLayer, searchLayer, embeddingsLayer, maintenanceLayer))));
});

describe("SearchMaintenance", () => {
  test("reconciles missing LanceDB rows into idempotent repair jobs", async () => {
    const [report, queueStats] = await withMaintenance(
      Effect.gen(function* () {
        const store = yield* LocalStore;
        const maintenance = yield* SearchMaintenance;
        const queue = yield* DurableQueue;
        yield* store.upsertSession(mappedSession());
        const report = yield* maintenance.reconcileFreshness({ limit: 10, now: "2026-06-18T10:00:00.000Z" });
        yield* maintenance.reconcileFreshness({ limit: 10, now: "2026-06-18T10:00:01.000Z" });
        const queueStats = yield* queue.stats;
        return [report, queueStats] as const;
      }),
    );

    expect(report).toEqual({ sessionsChecked: 1, freshSessions: 0, repairsEnqueued: 1, staleSessions: ["session-a"] });
    expect(queueStats).toEqual({ pending: 1, leased: 0, failed: 0 });
  });

  test("repairOnce indexes stale sessions and freshness then passes", async () => {
    const [repair, fresh, stats] = await withMaintenance(
      Effect.gen(function* () {
        const store = yield* LocalStore;
        const maintenance = yield* SearchMaintenance;
        const search = yield* DerivedSearch;
        yield* store.upsertSession(mappedSession());
        yield* maintenance.reconcileFreshness({ limit: 10, now: "2026-06-18T10:00:00.000Z" });
        const repair = yield* maintenance.repairOnce({ workerId: "indexer", limit: 10, leaseMs: 60_000, now: "2026-06-18T10:00:01.000Z" });
        const fresh = yield* maintenance.reconcileFreshness({ limit: 10, now: "2026-06-18T10:00:02.000Z" });
        const stats = yield* search.stats;
        return [repair, fresh, stats] as const;
      }),
    );

    expect(repair).toEqual({ leased: 1, repaired: 1, failed: 0 });
    expect(fresh).toEqual({ sessionsChecked: 1, freshSessions: 1, repairsEnqueued: 0, staleSessions: [] });
    expect(stats.rowCount).toBe(1);
  });

  test("freshness accepts embedded rows with bare content hashes", async () => {
    const fresh = await withMaintenanceAndEmbeddings(
      Effect.gen(function* () {
        const store = yield* LocalStore;
        const queue = yield* DurableQueue;
        const search = yield* DerivedSearch;
        const embeddings = yield* Embeddings;
        const maintenance = yield* SearchMaintenance;
        yield* store.upsertSession(mappedSession());
        yield* search.indexSession("session-a");
        yield* queue.enqueue({
          kind: "embed-message",
          payload: { sessionId: "session-a", seq: 1, contentHash: "hash-session-a" },
          idempotencyKey: "embed-message:hash-session-a",
        });
        yield* embeddings.processBatch({ workerId: "embedder", limit: 10, leaseMs: 60_000, now: "2099-06-18T10:00:00.000Z" });
        return yield* maintenance.reconcileFreshness({ limit: 10, now: "2099-06-18T10:00:01.000Z" });
      }),
    );

    expect(fresh).toEqual({ sessionsChecked: 1, freshSessions: 1, repairsEnqueued: 0, staleSessions: [] });
  });

  test("maintain creates indexes, optimizes, and returns proof stats", async () => {
    const report = await withMaintenance(
      Effect.gen(function* () {
        const store = yield* LocalStore;
        const search = yield* DerivedSearch;
        const maintenance = yield* SearchMaintenance;
        yield* store.upsertSession(mappedSession());
        yield* search.indexSession("session-a");
        return yield* maintenance.maintain({ includeVector: false, optimize: true });
      }),
    );

    expect(report.indexesCreated).toEqual(["text_idx"]);
    expect(report.optimized).toBe(true);
    expect((report.stats as { rowCount: number }).rowCount).toBe(1);
  });

  test("freshness checks both lexical and active profile tables", async () => {
    const [profileTable, first, afterProfileRepair, afterLexicalDelete] = await withMaintenance(
      Effect.gen(function* () {
        const profileTable = embeddingProfileSearchTable(embeddingProfileFromEnv());
        const store = yield* LocalStore;
        const search = yield* LanceDb;
        const derived = yield* DerivedSearch;
        const maintenance = yield* SearchMaintenance;
        yield* store.upsertSession(mappedSession());
        const first = yield* maintenance.reconcileFreshness({ limit: 10, now: "2026-06-18T10:00:00.000Z" });
        yield* derived.indexSession("session-a");
        const afterProfileRepair = yield* maintenance.reconcileFreshness({ limit: 10, now: "2026-06-18T10:00:01.000Z" });
        yield* search.deleteByKeys({ tableName: "messages", keys: ["session-a:1:user"] });
        const afterLexicalDelete = yield* maintenance.reconcileFreshness({ limit: 10, now: "2026-06-18T10:00:02.000Z" });
        return [profileTable, first, afterProfileRepair, afterLexicalDelete] as const;
      }),
      {
        QUASAR_EMBEDDING_PROVIDER: "synthetic",
        QUASAR_EMBEDDING_MODEL: "hf:nomic-ai/nomic-embed-text-v1.5",
        QUASAR_EMBEDDING_DIMENSIONS: "768",
      },
    );

    expect(profileTable).not.toBe("messages");
    expect(first).toMatchObject({ sessionsChecked: 1, freshSessions: 0, staleSessions: ["session-a"] });
    expect(afterProfileRepair).toMatchObject({ sessionsChecked: 1, freshSessions: 1, staleSessions: [] });
    expect(afterLexicalDelete).toMatchObject({ sessionsChecked: 1, freshSessions: 0, staleSessions: ["session-a"] });
  });
});
