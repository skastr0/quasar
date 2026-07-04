import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "bun:test";
import { Effect, Layer } from "effect";
import { createHash } from "node:crypto";

import { EmbeddingConfigurationError, embeddingProfileFromEnv, makeEmbeddingProfile, type EmbeddingProfile } from "../src/embeddingProfiles";
import { makeEmbeddingsLayer, type Embedder } from "../src/embeddings";
import type { MappedSession } from "../src/model";
import { Embeddings, DurableQueue, makeDurableQueueLayer } from "../src/services";
import type { DurableQueueService } from "../src/services";
import { LocalStore, makeLocalStoreLayer } from "../src/store";
import { makeSyntheticEmbedder, SyntheticEmbeddingError } from "../src/syntheticEmbeddings";

const tempDirs: string[] = [];

const tempDir = () => {
  const dir = mkdtempSync(join(tmpdir(), "quasar-local-embeddings-"));
  tempDirs.push(dir);
  return dir;
};

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

const vector = (seed: number) => Array.from({ length: 1536 }, (_, index) => (index === seed ? 1 : 0));
const hashText = (text: string) => createHash("sha256").update(text).digest("hex");

const mappedSession = (text = "alpha terminal"): MappedSession => ({
  project: { projectKey: "project-a", displayName: "Project A", rawPath: "/tmp/project-a" },
  session: {
    sessionId: "session-a",
    projectKey: "project-a",
    provider: "codex",
    agentName: "codex",
    sourcePath: "/history/session-a.jsonl",
    sourceFingerprint: "fingerprint-a",
    host: "host-a",
    identitySchemeVersion: 1,
    messageCount: 1,
    toolCallCount: 0,
  },
  messages: [
    {
      sessionId: "session-a",
      seq: 1,
      role: "user",
      text,
      projectKey: "project-a",
      contentHash: "hash-a",
    },
  ],
  toolCalls: [],
});

const defaultEmbeddingProfile = makeEmbeddingProfile({
  model: "test-embedding",
  dimensions: 1536,
  task: "search_document",
});

const enqueueEmbeddingJob = (queue: DurableQueueService, maxAttempts = 2, embeddingProfile = defaultEmbeddingProfile.cacheNamespace) =>
  queue.enqueue({
    kind: "embed-message",
    payload: { sessionId: "session-a", seq: 1, contentHash: "hash-a", embeddingProfile },
    idempotencyKey: `embed-message:hash-a:${crypto.randomUUID()}`,
    maxAttempts,
  });

const withEmbeddingsAt = <A>(
  sqlite: string,
  embedder: Embedder,
  profile: EmbeddingProfile,
  run: Effect.Effect<A, unknown, LocalStore | DurableQueue | Embeddings>,
) => {
  const dataLayer = makeLocalStoreLayer(sqlite);
  const queueLayer = makeDurableQueueLayer(sqlite);
  const embeddingsLayer = makeEmbeddingsLayer({ sqlite, profile, embedder }).pipe(
    Layer.provide(Layer.merge(dataLayer, queueLayer)),
  );
  return Effect.runPromise(run.pipe(Effect.provide(Layer.mergeAll(dataLayer, queueLayer, embeddingsLayer))));
};

const withEmbeddings = <A>(embedder: Embedder, run: Effect.Effect<A, unknown, LocalStore | DurableQueue | Embeddings>) =>
  withEmbeddingsAt(join(tempDir(), "quasar.sqlite"), embedder, defaultEmbeddingProfile, run);

describe("Embeddings", () => {
  test("embedText caches query vectors by content hash", async () => {
    let calls = 0;
    const embedder: Embedder = {
      embedMany: async (values) => {
        calls += 1;
        expect(values).toEqual(["query text"]);
        return [vector(4)];
      },
    };

    const [first, second, status] = await withEmbeddings(
      embedder,
      Effect.gen(function* () {
        const embeddings = yield* Embeddings;
        const first = yield* embeddings.embedText("query text");
        const second = yield* embeddings.embedText("query text");
        const status = yield* embeddings.status;
        return [first, second, status] as const;
      }),
    );

    expect(calls).toBe(1);
    expect(first).toEqual(second);
    expect(status.cached).toBe(1);
  });

  test("cache miss embeds, caches, writes SQLite message_vectors, and acks the job", async () => {
    let calls = 0;
    const embedder: Embedder = {
      embedMany: async (values) => {
        calls += 1;
        expect(values).toEqual(["alpha terminal"]);
        return [vector(0)];
      },
    };

    const [report, cached, sqliteRows, coverage, queueStats] = await withEmbeddings(
      embedder,
      Effect.gen(function* () {
        const store = yield* LocalStore;
        const queue = yield* DurableQueue;
        const embeddings = yield* Embeddings;
        yield* store.upsertSession(mappedSession());
        yield* enqueueEmbeddingJob(queue);
        const report = yield* embeddings.processBatch({ workerId: "worker-a", limit: 10, leaseMs: 60_000, now: "2099-06-18T10:00:00.000Z" });
        const cached = yield* embeddings.getCached("hash-a");
        const sqliteRows = yield* store.listMessageVectorsBySession({ sessionId: "session-a", model: defaultEmbeddingProfile.cacheNamespace });
        const coverage = yield* store.messageVectorCoverage(defaultEmbeddingProfile.cacheNamespace);
        const queueStats = yield* queue.stats;
        return [report, cached, sqliteRows, coverage, queueStats] as const;
      }),
    );

    expect(calls).toBe(1);
    expect(report).toMatchObject({ leased: 1, cacheHits: 0, cacheMisses: 1, embedded: 1, retried: 0, failed: 0, sqliteVectorsUpserted: 1 });
    expect(cached?.dimensions).toBe(1536);
    expect(sqliteRows).toHaveLength(1);
    expect(sqliteRows[0]?.contentHash).toBe("hash-a");
    expect(sqliteRows[0]?.encoding).toBe("f16le");
    expect(sqliteRows[0]?.vector[0]).toBe(1);
    expect(coverage).toMatchObject({ searchableMessages: 1, vectorRows: 1, vectorlessMessages: 0, staleVectorRows: 0 });
    expect(queueStats).toEqual({ pending: 0, leased: 0, failed: 0 });
  });

  test("cache hit avoids provider calls and still writes SQLite message_vectors", async () => {
    let calls = 0;
    const embedder: Embedder = {
      embedMany: async () => {
        calls += 1;
        return [vector(1)];
      },
    };

    const [report, sqliteRows, coverage] = await withEmbeddings(
      embedder,
      Effect.gen(function* () {
        const store = yield* LocalStore;
        const queue = yield* DurableQueue;
        const embeddings = yield* Embeddings;
        yield* store.upsertSession(mappedSession());
        yield* embeddings.putCached({ contentHash: "hash-a", text: "alpha terminal", vector: vector(0), now: "2026-06-18T09:00:00.000Z" });
        yield* enqueueEmbeddingJob(queue);
        const report = yield* embeddings.processBatch({ workerId: "worker-a", limit: 10, leaseMs: 60_000, now: "2099-06-18T10:00:00.000Z" });
        const sqliteRows = yield* store.listMessageVectorsBySession({ sessionId: "session-a", model: defaultEmbeddingProfile.cacheNamespace });
        const coverage = yield* store.messageVectorCoverage(defaultEmbeddingProfile.cacheNamespace);
        return [report, sqliteRows, coverage] as const;
      }),
    );

    expect(calls).toBe(0);
    expect(report).toMatchObject({ leased: 1, cacheHits: 1, cacheMisses: 0, embedded: 0, sqliteVectorsUpserted: 1 });
    expect(sqliteRows[0]?.contentHash).toBe("hash-a");
    expect(sqliteRows[0]?.vector[0]).toBe(1);
    expect(coverage).toMatchObject({ searchableMessages: 1, vectorRows: 1, vectorlessMessages: 0, staleVectorRows: 0 });
  });

  test("materializeCachedVectors replays the existing cache into SQLite without provider calls", async () => {
    let calls = 0;
    const embedder: Embedder = {
      embedMany: async () => {
        calls += 1;
        return [vector(1)];
      },
    };

    const [report, sqliteRows, coverage] = await withEmbeddings(
      embedder,
      Effect.gen(function* () {
        const store = yield* LocalStore;
        const embeddings = yield* Embeddings;
        yield* store.upsertSession({
          ...mappedSession(),
          messages: [
            { sessionId: "session-a", seq: 1, role: "user", text: "alpha terminal", projectKey: "project-a", contentHash: "hash-a" },
            { sessionId: "session-a", seq: 2, role: "assistant", text: "beta terminal", projectKey: "project-a", contentHash: "hash-b" },
          ],
        });
        yield* embeddings.putCached({ contentHash: "hash-a", text: "alpha terminal", vector: vector(0), now: "2026-06-18T09:00:00.000Z" });
        const report = yield* embeddings.materializeCachedVectors({ limit: 10, now: "2099-06-18T10:00:00.000Z" });
        const sqliteRows = yield* store.listMessageVectorsBySession({ sessionId: "session-a", model: defaultEmbeddingProfile.cacheNamespace });
        const coverage = yield* store.messageVectorCoverage(defaultEmbeddingProfile.cacheNamespace);
        return [report, sqliteRows, coverage] as const;
      }),
    );

    expect(calls).toBe(0);
    expect(report).toEqual({ scanned: 2, cacheHits: 1, missingCache: 1, sqliteVectorsUpserted: 1 });
    expect(sqliteRows.map((row) => row.seq)).toEqual([1]);
    expect(sqliteRows[0]?.vector[0]).toBe(1);
    expect(coverage).toMatchObject({ searchableMessages: 2, vectorRows: 1, vectorlessMessages: 1, staleVectorRows: 0 });
  });

  test("materializeMissingVectorsToSqlite replays cache and embeds misses into SQLite only", async () => {
    let providerCalls = 0;
    const embedder: Embedder = {
      embedMany: async (values) => {
        providerCalls += 1;
        expect(values).toEqual(["beta terminal"]);
        return [vector(2)];
      },
    };

    const [report, cached, sqliteRows, coverage] = await withEmbeddings(
      embedder,
      Effect.gen(function* () {
        const store = yield* LocalStore;
        const embeddings = yield* Embeddings;
        yield* store.upsertSession({
          ...mappedSession(),
          messages: [
            { sessionId: "session-a", seq: 1, role: "user", text: "alpha terminal", projectKey: "project-a", contentHash: "hash-a" },
            { sessionId: "session-a", seq: 2, role: "assistant", text: "beta terminal", projectKey: "project-a", contentHash: "hash-b" },
          ],
        });
        yield* embeddings.putCached({ contentHash: "hash-a", text: "alpha terminal", vector: vector(0), now: "2026-06-18T09:00:00.000Z" });
        const report = yield* embeddings.materializeMissingVectorsToSqlite({ limit: 10, now: "2099-06-18T10:00:00.000Z" });
        const cached = yield* embeddings.getCached("hash-b");
        const sqliteRows = yield* store.listMessageVectorsBySession({ sessionId: "session-a", model: defaultEmbeddingProfile.cacheNamespace });
        const coverage = yield* store.messageVectorCoverage(defaultEmbeddingProfile.cacheNamespace);
        return [report, cached, sqliteRows, coverage] as const;
      }),
    );

    expect(providerCalls).toBe(1);
    expect(report).toMatchObject({
      scanned: 2,
      cacheHits: 1,
      cacheMisses: 1,
      embedded: 1,
      skipped: 0,
      sqliteVectorsUpserted: 2,
      startedAt: "2099-06-18T10:00:00.000Z",
      finishedAt: "2099-06-18T10:00:00.000Z",
    });
    expect(typeof report.elapsedMs).toBe("number");
    expect("lanceRowsUpserted" in report).toBe(false);
    expect(cached?.contentHash).toBe("hash-b");
    expect(sqliteRows.map((row) => row.seq)).toEqual([1, 2]);
    expect(sqliteRows.map((row) => row.contentHash).sort()).toEqual(["hash-a", "hash-b"]);
    expect(coverage).toMatchObject({ searchableMessages: 2, vectorRows: 2, vectorlessMessages: 0, staleVectorRows: 0 });
  });

  test("message_vectors rows are deleted when the source message is replaced", async () => {
    const embedder: Embedder = { embedMany: async () => [vector(0)] };

    const [before, after] = await withEmbeddings(
      embedder,
      Effect.gen(function* () {
        const store = yield* LocalStore;
        const queue = yield* DurableQueue;
        const embeddings = yield* Embeddings;
        yield* store.upsertSession(mappedSession("alpha terminal"));
        yield* enqueueEmbeddingJob(queue);
        yield* embeddings.processBatch({ workerId: "worker-a", limit: 10, leaseMs: 60_000, now: "2099-06-18T10:00:00.000Z" });
        const before = yield* store.messageVectorCoverage(defaultEmbeddingProfile.cacheNamespace);
        yield* store.upsertSession({
          ...mappedSession("replacement terminal"),
          messages: [{
            sessionId: "session-a",
            seq: 1,
            role: "user",
            text: "replacement terminal",
            projectKey: "project-a",
            contentHash: "hash-b",
          }],
        });
        const after = yield* store.messageVectorCoverage(defaultEmbeddingProfile.cacheNamespace);
        return [before, after] as const;
      }),
    );

    expect(before).toMatchObject({ searchableMessages: 1, vectorRows: 1, vectorlessMessages: 0, staleVectorRows: 0 });
    expect(after).toMatchObject({ searchableMessages: 1, vectorRows: 0, vectorlessMessages: 1, staleVectorRows: 0 });
  });

  test("late message_vectors writes are rejected after the source message changes", async () => {
    const accepted = await withEmbeddings(
      { embedMany: async () => [vector(0)] },
      Effect.gen(function* () {
        const store = yield* LocalStore;
        yield* store.upsertSession(mappedSession("alpha terminal"));
        yield* store.upsertSession({
          ...mappedSession("replacement terminal"),
          messages: [{
            sessionId: "session-a",
            seq: 1,
            role: "user",
            text: "replacement terminal",
            projectKey: "project-a",
            contentHash: "hash-b",
          }],
        });
        return yield* store.upsertMessageVectors([{
          model: defaultEmbeddingProfile.cacheNamespace,
          modality: "text",
          sessionId: "session-a",
          seq: 1,
          role: "user",
          projectKey: "project-a",
          provider: "session-a",
          contentHash: "hash-a",
          documentHash: "hash-a",
          vector: vector(0),
        }]);
      }),
    );

    expect(accepted).toBe(0);
  });

  test("environment profile keeps synthetic cache compatible and fingerprints local vector settings", () => {
    const previous = {
      provider: process.env.QUASAR_EMBEDDING_PROVIDER,
      namespace: process.env.QUASAR_EMBEDDING_CACHE_NAMESPACE,
      dtype: process.env.QUASAR_EMBEDDING_ONNX_DTYPE,
      documentPrefix: process.env.QUASAR_EMBEDDING_DOCUMENT_PREFIX,
    };

    try {
      delete process.env.QUASAR_EMBEDDING_CACHE_NAMESPACE;
      process.env.QUASAR_EMBEDDING_PROVIDER = "local";
      process.env.QUASAR_EMBEDDING_ONNX_DTYPE = "q8";
      process.env.QUASAR_EMBEDDING_DOCUMENT_PREFIX = "search_document: ";
      const local = embeddingProfileFromEnv();
      process.env.QUASAR_EMBEDDING_PROVIDER = "synthetic";
      const synthetic = embeddingProfileFromEnv();
      process.env.QUASAR_EMBEDDING_PROVIDER = "local";
      process.env.QUASAR_EMBEDDING_DOCUMENT_PREFIX = "passage: ";
      const localWithDifferentPrefix = embeddingProfileFromEnv();
      process.env.QUASAR_EMBEDDING_CACHE_NAMESPACE = "operator-selected-cache";
      const explicit = embeddingProfileFromEnv();

      expect(local.cacheNamespace).toStartWith("local:hf:nomic-ai/nomic-embed-text-v1.5:768:search_document:");
      expect(synthetic.cacheNamespace).toBe("synthetic:hf:nomic-ai/nomic-embed-text-v1.5:768:search_document");
      expect(local.cacheNamespace).not.toBe(synthetic.cacheNamespace);
      expect(local.cacheNamespace).not.toBe(localWithDifferentPrefix.cacheNamespace);
      expect(explicit.cacheNamespace).toBe("operator-selected-cache");
    } finally {
      if (previous.provider === undefined) delete process.env.QUASAR_EMBEDDING_PROVIDER;
      else process.env.QUASAR_EMBEDDING_PROVIDER = previous.provider;
      if (previous.namespace === undefined) delete process.env.QUASAR_EMBEDDING_CACHE_NAMESPACE;
      else process.env.QUASAR_EMBEDDING_CACHE_NAMESPACE = previous.namespace;
      if (previous.dtype === undefined) delete process.env.QUASAR_EMBEDDING_ONNX_DTYPE;
      else process.env.QUASAR_EMBEDDING_ONNX_DTYPE = previous.dtype;
      if (previous.documentPrefix === undefined) delete process.env.QUASAR_EMBEDDING_DOCUMENT_PREFIX;
      else process.env.QUASAR_EMBEDDING_DOCUMENT_PREFIX = previous.documentPrefix;
    }
  });

  test("synthetic prefix overrides require an explicit cache namespace", () => {
    const previous = {
      provider: process.env.QUASAR_EMBEDDING_PROVIDER,
      namespace: process.env.QUASAR_EMBEDDING_CACHE_NAMESPACE,
      documentPrefix: process.env.QUASAR_EMBEDDING_DOCUMENT_PREFIX,
      queryPrefix: process.env.QUASAR_EMBEDDING_QUERY_PREFIX,
    };

    try {
      delete process.env.QUASAR_EMBEDDING_CACHE_NAMESPACE;
      process.env.QUASAR_EMBEDDING_PROVIDER = "synthetic";
      process.env.QUASAR_EMBEDDING_DOCUMENT_PREFIX = "passage: ";
      expect(() => embeddingProfileFromEnv()).toThrow("QUASAR_EMBEDDING_CACHE_NAMESPACE must be one of: set explicitly when overriding Synthetic embedding prefixes");

      process.env.QUASAR_EMBEDDING_CACHE_NAMESPACE = "synthetic-custom-prefix";
      expect(embeddingProfileFromEnv().cacheNamespace).toBe("synthetic-custom-prefix");
    } finally {
      if (previous.provider === undefined) delete process.env.QUASAR_EMBEDDING_PROVIDER;
      else process.env.QUASAR_EMBEDDING_PROVIDER = previous.provider;
      if (previous.namespace === undefined) delete process.env.QUASAR_EMBEDDING_CACHE_NAMESPACE;
      else process.env.QUASAR_EMBEDDING_CACHE_NAMESPACE = previous.namespace;
      if (previous.documentPrefix === undefined) delete process.env.QUASAR_EMBEDDING_DOCUMENT_PREFIX;
      else process.env.QUASAR_EMBEDDING_DOCUMENT_PREFIX = previous.documentPrefix;
      if (previous.queryPrefix === undefined) delete process.env.QUASAR_EMBEDDING_QUERY_PREFIX;
      else process.env.QUASAR_EMBEDDING_QUERY_PREFIX = previous.queryPrefix;
    }
  });

  test("environment profile rejects unknown embedding providers", () => {
    const previous = process.env.QUASAR_EMBEDDING_PROVIDER;
    try {
      process.env.QUASAR_EMBEDDING_PROVIDER = "locla";
      expect(() => embeddingProfileFromEnv()).toThrow("QUASAR_EMBEDDING_PROVIDER must be one of: local, synthetic; got locla");
      expect(() => embeddingProfileFromEnv()).toThrow(EmbeddingConfigurationError);
    } finally {
      if (previous === undefined) delete process.env.QUASAR_EMBEDDING_PROVIDER;
      else process.env.QUASAR_EMBEDDING_PROVIDER = previous;
    }
  });

  test("readiness is a non-blocking Ref read — never a per-call network probe", async () => {
    // The background fiber fires after readinessCacheTtlMs() (30s by default),
    // so within a short test the Ref holds the initial "pending" state.
    // Reading readiness must NEVER call the embedder synchronously.
    let calls = 0;
    const embedder: Embedder = {
      embedMany: async () => {
        calls += 1;
        return [vector(2)];
      },
    };

    const [first, second] = await withEmbeddings(
      embedder,
      Effect.gen(function* () {
        const embeddings = yield* Embeddings;
        const first = yield* embeddings.readiness;
        const second = yield* embeddings.readiness;
        return [first, second] as const;
      }),
    );

    // No embedder call from readiness reads — background fiber hasn't fired yet
    expect(calls).toBe(0);
    // Both reads return the same Ref snapshot (consistent, no race)
    expect(first).toEqual(second);
    // Initial state: probe pending (not yet had a chance to fire)
    expect(first.ok).toBe(false);
    expect(first.reason).toBeDefined();
  });

  test("readiness reports not-ok when SYNTHETIC_API_KEY is absent (pending or no-key after probe)", async () => {
    // Without an API key, the probe (when it eventually fires) returns not-ok.
    // Before the probe fires, the state is "pending" (also not-ok).
    // In both cases: ok === false and embedder is never called directly.
    const previousKey = process.env.SYNTHETIC_API_KEY;
    delete process.env.SYNTHETIC_API_KEY;
    let calls = 0;
    const embedder: Embedder = {
      embedMany: async () => {
        calls += 1;
        return [vector(2)];
      },
    };

    try {
      const result = await withEmbeddings(
        embedder,
        Effect.gen(function* () {
          const embeddings = yield* Embeddings;
          return yield* embeddings.readiness;
        }),
      );

      expect(calls).toBe(0);
      expect(result.ok).toBe(false);
      // Either "pending" (probe not yet fired) or the api-key reason — both are not-ok
      expect(result.reason).toBeDefined();
    } finally {
      if (previousKey === undefined) delete process.env.SYNTHETIC_API_KEY;
      else process.env.SYNTHETIC_API_KEY = previousKey;
    }
  });

  test("provider failures retry then fail after max attempts", async () => {
    const embedder: Embedder = { embedMany: async () => { throw new Error("embedding provider unavailable"); } };

    const [first, second, queueStats] = await withEmbeddings(
      embedder,
      Effect.gen(function* () {
        const store = yield* LocalStore;
        const queue = yield* DurableQueue;
        const embeddings = yield* Embeddings;
        yield* store.upsertSession(mappedSession());
        yield* enqueueEmbeddingJob(queue, 2);
        const first = yield* embeddings.processBatch({ workerId: "worker-a", limit: 10, leaseMs: 60_000, now: "2099-06-18T10:00:00.000Z" });
        const second = yield* embeddings.processBatch({ workerId: "worker-a", limit: 10, leaseMs: 60_000, now: "2099-06-18T10:01:00.000Z" });
        const queueStats = yield* queue.stats;
        return [first, second, queueStats] as const;
      }),
    );

    expect(first).toMatchObject({ retried: 1, failed: 0 });
    expect(second).toMatchObject({ retried: 0, failed: 1 });
    expect(queueStats).toEqual({ pending: 0, leased: 0, failed: 1 });
  });

  test("jobs for a different embedding profile fail closed without provider calls", async () => {
    let calls = 0;
    const embedder: Embedder = {
      embedMany: async () => {
        calls += 1;
        return [vector(0)];
      },
    };

    const [report, queueStats] = await withEmbeddings(
      embedder,
      Effect.gen(function* () {
        const store = yield* LocalStore;
        const queue = yield* DurableQueue;
        const embeddings = yield* Embeddings;
        yield* store.upsertSession(mappedSession());
        yield* enqueueEmbeddingJob(queue, 2, "other-profile");
        const report = yield* embeddings.processBatch({ workerId: "worker-a", limit: 10, leaseMs: 60_000, now: "2099-06-18T10:00:00.000Z" });
        const queueStats = yield* queue.stats;
        return [report, queueStats] as const;
      }),
    );

    expect(calls).toBe(0);
    expect(report).toMatchObject({ leased: 1, cacheHits: 0, cacheMisses: 0, embedded: 0, failed: 1 });
    expect(queueStats).toEqual({ pending: 0, leased: 0, failed: 1 });
  });

  test("stale jobs for superseded message hashes are acked as skipped", async () => {
    let calls = 0;
    const embedder: Embedder = {
      embedMany: async () => {
        calls += 1;
        return [vector(0)];
      },
    };

    const [report, queueStats] = await withEmbeddings(
      embedder,
      Effect.gen(function* () {
        const store = yield* LocalStore;
        const queue = yield* DurableQueue;
        const embeddings = yield* Embeddings;
        yield* store.upsertSession(mappedSession("old text"));
        yield* enqueueEmbeddingJob(queue, 2);
        yield* store.upsertSession({
          ...mappedSession("new text"),
          messages: [{
            sessionId: "session-a",
            seq: 1,
            role: "user",
            text: "new text",
            projectKey: "project-a",
            contentHash: "hash-b",
          }],
        });
        const report = yield* embeddings.processBatch({ workerId: "worker-a", limit: 10, leaseMs: 60_000, now: "2099-06-18T10:00:00.000Z" });
        const queueStats = yield* queue.stats;
        return [report, queueStats] as const;
      }),
    );

    expect(calls).toBe(0);
    expect(report).toMatchObject({ leased: 1, cacheHits: 0, cacheMisses: 0, embedded: 0, skipped: 1, failed: 0 });
    expect(queueStats).toEqual({ pending: 0, leased: 0, failed: 0 });
  });

  test("synthetic rate-limit status is treated as retryable", async () => {
    const embedder: Embedder = {
      embedMany: async () => {
        throw new SyntheticEmbeddingError({ operation: "synthetic.embeddings", message: "temporarily unavailable", status: 429 });
      },
    };

    const report = await withEmbeddings(
      embedder,
      Effect.gen(function* () {
        const store = yield* LocalStore;
        const queue = yield* DurableQueue;
        const embeddings = yield* Embeddings;
        yield* store.upsertSession(mappedSession());
        yield* enqueueEmbeddingJob(queue, 2);
        return yield* embeddings.processBatch({ workerId: "worker-a", limit: 10, leaseMs: 60_000, now: "2099-06-18T10:00:00.000Z" });
      }),
    );

    expect(report).toMatchObject({ retried: 1, failed: 0 });
  });

  test("retryable provider failures fail after max attempts", async () => {
    const embedder: Embedder = {
      embedMany: async () => {
        throw new SyntheticEmbeddingError({ operation: "synthetic.embeddings", message: "still overloaded", status: 500 });
      },
    };

    const [first, second, queueStats] = await withEmbeddings(
      embedder,
      Effect.gen(function* () {
        const store = yield* LocalStore;
        const queue = yield* DurableQueue;
        const embeddings = yield* Embeddings;
        yield* store.upsertSession(mappedSession());
        yield* enqueueEmbeddingJob(queue, 2);
        const first = yield* embeddings.processBatch({ workerId: "worker-a", limit: 10, leaseMs: 60_000, now: "2099-06-18T10:00:00.000Z" });
        const second = yield* embeddings.processBatch({ workerId: "worker-a", limit: 10, leaseMs: 60_000, now: "2099-06-18T10:01:00.000Z" });
        const queueStats = yield* queue.stats;
        return [first, second, queueStats] as const;
      }),
    );

    expect(first).toMatchObject({ retried: 1, failed: 0 });
    expect(second).toMatchObject({ retried: 0, failed: 1 });
    expect(queueStats).toEqual({ pending: 0, leased: 0, failed: 1 });
  });

  test("retryable batch failures are split before delaying jobs", async () => {
    const seen: string[][] = [];
    const embedder: Embedder = {
      embedMany: async (values) => {
        seen.push([...values]);
        if (values.length > 1) {
          throw new SyntheticEmbeddingError({ operation: "synthetic.embeddings", message: "batch overloaded", status: 500 });
        }
        return [vector(0)];
      },
    };

    const [report, queueStats] = await withEmbeddings(
      embedder,
      Effect.gen(function* () {
        const store = yield* LocalStore;
        const queue = yield* DurableQueue;
        const embeddings = yield* Embeddings;
        yield* store.upsertSession({
          ...mappedSession(),
          messages: [
            { sessionId: "session-a", seq: 1, role: "user", text: "alpha terminal", projectKey: "project-a", contentHash: "hash-a" },
            { sessionId: "session-a", seq: 2, role: "assistant", text: "beta terminal", projectKey: "project-a", contentHash: "hash-b" },
          ],
        });
        yield* queue.enqueue({
          kind: "embed-message",
          payload: { sessionId: "session-a", seq: 1, contentHash: "hash-a", embeddingProfile: defaultEmbeddingProfile.cacheNamespace },
          idempotencyKey: `embed-message:${defaultEmbeddingProfile.cacheNamespace}:hash-a`,
          maxAttempts: 2,
        });
        yield* queue.enqueue({
          kind: "embed-message",
          payload: { sessionId: "session-a", seq: 2, contentHash: "hash-b", embeddingProfile: defaultEmbeddingProfile.cacheNamespace },
          idempotencyKey: `embed-message:${defaultEmbeddingProfile.cacheNamespace}:hash-b`,
          maxAttempts: 2,
        });
        const report = yield* embeddings.processBatch({ workerId: "worker-a", limit: 10, leaseMs: 60_000, now: "2099-06-18T10:00:00.000Z" });
        const queueStats = yield* queue.stats;
        return [report, queueStats] as const;
      }),
    );

    expect(seen).toEqual([["alpha terminal", "beta terminal"], ["alpha terminal"], ["beta terminal"]]);
    expect(report).toMatchObject({ leased: 2, cacheMisses: 2, embedded: 2, retried: 0, failed: 0 });
    expect(queueStats).toEqual({ pending: 0, leased: 0, failed: 0 });
  });

  test("large messages are chunked and averaged into one cached message vector", async () => {
    const previousChunkSize = process.env.QUASAR_EMBEDDING_DOCUMENT_CHUNK_CHARS;
    process.env.QUASAR_EMBEDDING_DOCUMENT_CHUNK_CHARS = "5";
    const seen: string[][] = [];
    const embedder: Embedder = {
      embedMany: async (values) => {
        seen.push([...values]);
        return values.map((_, index) => vector(index));
      },
    };

    try {
      const [report, cached, sqliteRows] = await withEmbeddings(
        embedder,
        Effect.gen(function* () {
          const store = yield* LocalStore;
          const queue = yield* DurableQueue;
          const embeddings = yield* Embeddings;
          yield* store.upsertSession(mappedSession("abcdefghij"));
          yield* enqueueEmbeddingJob(queue);
          const report = yield* embeddings.processBatch({ workerId: "worker-a", limit: 10, leaseMs: 60_000, now: "2099-06-18T10:00:00.000Z" });
          const cached = yield* embeddings.getCached("hash-a");
          const sqliteRows = yield* store.listMessageVectorsBySession({ sessionId: "session-a", model: defaultEmbeddingProfile.cacheNamespace });
          return [report, cached, sqliteRows] as const;
        }),
      );

      expect(seen).toEqual([["abcde", "fghij"]]);
      expect(report).toMatchObject({ leased: 1, cacheMisses: 1, embedded: 1, retried: 0, failed: 0 });
      expect(cached?.contentHash).toBe("hash-a");
      expect(cached?.vector[0]).toBe(0.5);
      expect(cached?.vector[1]).toBe(0.5);
      expect(sqliteRows).toHaveLength(1);
      expect(sqliteRows[0]?.contentHash).toBe("hash-a");
    } finally {
      if (previousChunkSize === undefined) delete process.env.QUASAR_EMBEDDING_DOCUMENT_CHUNK_CHARS;
      else process.env.QUASAR_EMBEDDING_DOCUMENT_CHUNK_CHARS = previousChunkSize;
    }
  });

  test("large prefixed messages cache by full prefixed document identity", async () => {
    const previousChunkSize = process.env.QUASAR_EMBEDDING_DOCUMENT_CHUNK_CHARS;
    process.env.QUASAR_EMBEDDING_DOCUMENT_CHUNK_CHARS = "5";
    const profile = makeEmbeddingProfile({
      model: "hf:nomic-ai/nomic-embed-text-v1.5",
      dimensions: 1536,
      task: "search_document",
      documentPrefix: "search_document: ",
      queryPrefix: "search_query: ",
    });
    const seen: string[][] = [];
    const embedder: Embedder = {
      embedMany: async (values) => {
        seen.push([...values]);
        return values.map((_, index) => vector(index));
      },
    };

    try {
      const cached = await withEmbeddingsAt(
        join(tempDir(), "quasar.sqlite"),
        embedder,
        profile,
        Effect.gen(function* () {
          const store = yield* LocalStore;
          const queue = yield* DurableQueue;
          const embeddings = yield* Embeddings;
          yield* store.upsertSession(mappedSession("abcdefghij"));
          yield* enqueueEmbeddingJob(queue, 2, profile.cacheNamespace);
          yield* embeddings.processBatch({ workerId: "worker-a", limit: 10, leaseMs: 60_000, now: "2099-06-18T10:00:00.000Z" });
          return yield* embeddings.getCached(hashText("search_document: abcdefghij"));
        }),
      );

      expect(seen).toEqual([["search_document: abcde", "search_document: fghij"]]);
      expect(cached?.vector[0]).toBe(0.5);
      expect(cached?.vector[1]).toBe(0.5);
    } finally {
      if (previousChunkSize === undefined) delete process.env.QUASAR_EMBEDDING_DOCUMENT_CHUNK_CHARS;
      else process.env.QUASAR_EMBEDDING_DOCUMENT_CHUNK_CHARS = previousChunkSize;
    }
  });

  test("retryable failures inside one large message split document chunks", async () => {
    const previousChunkSize = process.env.QUASAR_EMBEDDING_DOCUMENT_CHUNK_CHARS;
    process.env.QUASAR_EMBEDDING_DOCUMENT_CHUNK_CHARS = "5";
    const seen: string[][] = [];
    const embedder: Embedder = {
      embedMany: async (values) => {
        seen.push([...values]);
        if (values.length > 1) {
          throw new SyntheticEmbeddingError({ operation: "synthetic.embeddings", message: "chunk batch overloaded", status: 500 });
        }
        return values.map((_, index) => vector(index));
      },
    };

    try {
      const [report, queueStats] = await withEmbeddings(
        embedder,
        Effect.gen(function* () {
          const store = yield* LocalStore;
          const queue = yield* DurableQueue;
          const embeddings = yield* Embeddings;
          yield* store.upsertSession(mappedSession("abcdefghij"));
          yield* enqueueEmbeddingJob(queue, 2);
          const report = yield* embeddings.processBatch({ workerId: "worker-a", limit: 10, leaseMs: 60_000, now: "2099-06-18T10:00:00.000Z" });
          const queueStats = yield* queue.stats;
          return [report, queueStats] as const;
        }),
      );

      expect(seen).toEqual([["abcde", "fghij"], ["abcde"], ["fghij"]]);
      expect(report).toMatchObject({ leased: 1, embedded: 1, retried: 0, failed: 0 });
      expect(queueStats).toEqual({ pending: 0, leased: 0, failed: 0 });
    } finally {
      if (previousChunkSize === undefined) delete process.env.QUASAR_EMBEDDING_DOCUMENT_CHUNK_CHARS;
      else process.env.QUASAR_EMBEDDING_DOCUMENT_CHUNK_CHARS = previousChunkSize;
    }
  });

  test("short provider responses retry unacknowledged jobs", async () => {
    const embedder: Embedder = { embedMany: async () => [] };

    const [report, queueStats] = await withEmbeddings(
      embedder,
      Effect.gen(function* () {
        const store = yield* LocalStore;
        const queue = yield* DurableQueue;
        const embeddings = yield* Embeddings;
        yield* store.upsertSession(mappedSession());
        yield* enqueueEmbeddingJob(queue, 2);
        const report = yield* embeddings.processBatch({ workerId: "worker-a", limit: 10, leaseMs: 60_000, now: "2099-06-18T10:00:00.000Z" });
        const queueStats = yield* queue.stats;
        return [report, queueStats] as const;
      }),
    );

    expect(report).toMatchObject({ embedded: 0, retried: 1, failed: 0 });
    expect(queueStats).toEqual({ pending: 1, leased: 0, failed: 0 });
  });

  test("retryable provider failures use delayed exponential backoff", async () => {
    const previousBase = process.env.QUASAR_EMBEDDING_RETRY_BASE_MS;
    const previousMax = process.env.QUASAR_EMBEDDING_RETRY_MAX_MS;
    process.env.QUASAR_EMBEDDING_RETRY_BASE_MS = "1000";
    process.env.QUASAR_EMBEDDING_RETRY_MAX_MS = "1000";
    try {
      const embedder: Embedder = {
        embedMany: async () => {
          throw new SyntheticEmbeddingError({ operation: "synthetic.embeddings", message: "server overloaded", status: 500 });
        },
      };

      const [first, tooEarly, ready] = await withEmbeddings(
        embedder,
        Effect.gen(function* () {
          const store = yield* LocalStore;
          const queue = yield* DurableQueue;
          const embeddings = yield* Embeddings;
          yield* store.upsertSession(mappedSession());
          yield* enqueueEmbeddingJob(queue, 3);
          const first = yield* embeddings.processBatch({ workerId: "worker-a", limit: 10, leaseMs: 60_000, now: "2099-06-18T10:00:00.000Z" });
          const tooEarly = yield* embeddings.processBatch({ workerId: "worker-a", limit: 10, leaseMs: 60_000, now: "2099-06-18T10:00:00.500Z" });
          const ready = yield* embeddings.processBatch({ workerId: "worker-a", limit: 10, leaseMs: 60_000, now: "2099-06-18T10:00:01.001Z" });
          return [first, tooEarly, ready] as const;
        }),
      );

      expect(first).toMatchObject({ leased: 1, retried: 1, failed: 0 });
      expect(tooEarly).toMatchObject({ leased: 0, retried: 0, failed: 0 });
      expect(ready).toMatchObject({ leased: 1, retried: 1, failed: 0 });
    } finally {
      if (previousBase === undefined) delete process.env.QUASAR_EMBEDDING_RETRY_BASE_MS;
      else process.env.QUASAR_EMBEDDING_RETRY_BASE_MS = previousBase;
      if (previousMax === undefined) delete process.env.QUASAR_EMBEDDING_RETRY_MAX_MS;
      else process.env.QUASAR_EMBEDDING_RETRY_MAX_MS = previousMax;
    }
  });

  test("idempotent rerun after cache write does not re-pay the provider", async () => {
    let calls = 0;
    const embedder: Embedder = {
      embedMany: async () => {
        calls += 1;
        return [vector(0)];
      },
    };

    const [first, second] = await withEmbeddings(
      embedder,
      Effect.gen(function* () {
        const store = yield* LocalStore;
        const queue = yield* DurableQueue;
        const embeddings = yield* Embeddings;
        yield* store.upsertSession(mappedSession());
        yield* enqueueEmbeddingJob(queue);
        const first = yield* embeddings.processBatch({ workerId: "worker-a", limit: 10, leaseMs: 60_000, now: "2099-06-18T10:00:00.000Z" });
        yield* enqueueEmbeddingJob(queue);
        const second = yield* embeddings.processBatch({ workerId: "worker-a", limit: 10, leaseMs: 60_000, now: "2099-06-18T10:01:00.000Z" });
        return [first, second] as const;
      }),
    );

    expect(calls).toBe(1);
    expect(first.embedded).toBe(1);
    expect(second.cacheHits).toBe(1);
  });

  test("embedding cache is isolated by profile namespace", async () => {
    const sqlite = join(tempDir(), "quasar.sqlite");
    const embedder: Embedder = { embedMany: async () => [vector(0)] };
    const profile = makeEmbeddingProfile({
      model: "profile-a",
      dimensions: 1536,
      task: "search_document",
    });
    const alternate = makeEmbeddingProfile({
      model: "profile-a",
      dimensions: 1536,
      task: "search_document",
      cacheNamespace: "alternate-profile",
    });

    const cachedInProfile = await withEmbeddingsAt(
      sqlite,
      embedder,
      profile,
      Effect.gen(function* () {
        const embeddings = yield* Embeddings;
        yield* embeddings.putCached({ contentHash: "hash-a", text: "alpha terminal", vector: vector(0) });
        return yield* embeddings.getCached("hash-a");
      }),
    );

    const cachedInAlternate = await withEmbeddingsAt(
      sqlite,
      embedder,
      alternate,
      Effect.gen(function* () {
        const embeddings = yield* Embeddings;
        return yield* embeddings.getCached("hash-a");
      }),
    );

    expect(cachedInProfile?.model).toBe("synthetic:profile-a:1536:search_document");
    expect(cachedInAlternate).toBeUndefined();
  });

  test("embedding cache rejects vectors with the wrong profile dimension", async () => {
    const embedder: Embedder = { embedMany: async () => [vector(0)] };

    await expect(
      withEmbeddings(
        embedder,
        Effect.gen(function* () {
          const embeddings = yield* Embeddings;
          yield* embeddings.putCached({ contentHash: "hash-a", text: "alpha terminal", vector: [1, 2, 3] });
        }),
      ),
    ).rejects.toThrow("embedding vector has dimension 3; expected 1536");
  });

  test("synthetic profile applies Nomic document and query prefixes", async () => {
    const seen: string[][] = [];
    const embedder: Embedder = {
      embedMany: async (values) => {
        seen.push([...values]);
        return values.map((_, offset) => vector(offset));
      },
    };
    const profile = makeEmbeddingProfile({
      model: "hf:nomic-ai/nomic-embed-text-v1.5",
      dimensions: 1536,
      task: "search_document",
      documentPrefix: "search_document: ",
      queryPrefix: "search_query: ",
    });

    await withEmbeddingsAt(
      join(tempDir(), "quasar.sqlite"),
      embedder,
      profile,
      Effect.gen(function* () {
        const store = yield* LocalStore;
        const queue = yield* DurableQueue;
        const embeddings = yield* Embeddings;
        yield* store.upsertSession(mappedSession("alpha terminal"));
        yield* enqueueEmbeddingJob(queue, 2, profile.cacheNamespace);
        yield* embeddings.processBatch({ workerId: "worker-a", limit: 10, leaseMs: 60_000 });
        yield* embeddings.embedText("find alpha");
      }),
    );

    expect(seen).toEqual([["search_document: alpha terminal"], ["search_query: find alpha"]]);
  });

  test("synthetic embedder preserves response order by index", async () => {
    const profile = makeEmbeddingProfile({
      model: "hf:nomic-ai/nomic-embed-text-v1.5",
      dimensions: 3,
      task: "search_document",
    });
    const calls: Array<{ url: string; body: unknown; authorization: string | null }> = [];
    const fakeFetch: typeof fetch = async (input, init) => {
      calls.push({
        url: String(input),
        body: JSON.parse(String(init?.body)) as unknown,
        authorization: new Headers(init?.headers).get("authorization"),
      });
      return new Response(JSON.stringify({
        object: "list",
        data: [
          { object: "embedding", index: 1, embedding: [0, 1, 0] },
          { object: "embedding", index: 0, embedding: [1, 0, 0] },
        ],
        model: profile.model,
      }), { status: 200, headers: { "content-type": "application/json" } });
    };

    const vectors = await makeSyntheticEmbedder(profile, {
      apiKey: "test-key",
      baseUrl: "https://synthetic.test/openai/v1/",
      fetch: fakeFetch,
    }).embedMany(["a", "b"]);

    expect(vectors).toEqual([[1, 0, 0], [0, 1, 0]]);
    expect(calls[0]?.url).toBe("https://synthetic.test/openai/v1/embeddings");
    expect(calls[0]?.authorization).toBe("Bearer test-key");
    expect(calls[0]?.body).toEqual({ model: profile.model, input: ["a", "b"], dimensions: 3 });
  });

  test("synthetic embedder rejects missing API key before fetching", async () => {
    const profile = makeEmbeddingProfile({
      model: "hf:nomic-ai/nomic-embed-text-v1.5",
      dimensions: 3,
      task: "search_document",
    });
    let calls = 0;
    const fakeFetch: typeof fetch = async () => {
      calls += 1;
      return new Response(JSON.stringify({ data: [] }), { status: 200, headers: { "content-type": "application/json" } });
    };

    await expect(makeSyntheticEmbedder(profile, { apiKey: "", fetch: fakeFetch }).embedMany(["a"]))
      .rejects.toThrow("SYNTHETIC_API_KEY is required for Synthetic embeddings");
    expect(calls).toBe(0);
  });

  test("synthetic embedder rejects invalid response indexes", async () => {
    const profile = makeEmbeddingProfile({
      model: "hf:nomic-ai/nomic-embed-text-v1.5",
      dimensions: 3,
      task: "search_document",
    });
    const fakeFetch: typeof fetch = async () =>
      new Response(JSON.stringify({
        data: [{ object: "embedding", index: 2, embedding: [1, 0, 0] }],
      }), { status: 200, headers: { "content-type": "application/json" } });

    await expect(makeSyntheticEmbedder(profile, { apiKey: "test-key", fetch: fakeFetch }).embedMany(["a"]))
      .rejects.toThrow("Synthetic embeddings response included invalid index 2");
  });

  test("synthetic embedder retries a truncated body exactly once, then succeeds", async () => {
    const profile = makeEmbeddingProfile({
      model: "hf:nomic-ai/nomic-embed-text-v1.5",
      dimensions: 3,
      task: "search_document",
    });
    let calls = 0;
    const fakeFetch: typeof fetch = async () => {
      calls += 1;
      if (calls === 1) {
        // The known ~6% flake: HTTP 200 with a truncated (non-JSON) body.
        return new Response('{"data": [{"index": 0, "embe', { status: 200, headers: { "content-type": "application/json" } });
      }
      return new Response(JSON.stringify({ data: [{ index: 0, embedding: [1, 0, 0] }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };

    const vectors = await makeSyntheticEmbedder(profile, { apiKey: "test-key", fetch: fakeFetch }).embedMany(["a"]);
    expect(vectors).toEqual([[1, 0, 0]]);
    expect(calls).toBe(2);
  });

  test("synthetic embedder gives up after the single retry (bounded, queue is the outer loop)", async () => {
    const profile = makeEmbeddingProfile({
      model: "hf:nomic-ai/nomic-embed-text-v1.5",
      dimensions: 3,
      task: "search_document",
    });
    let calls = 0;
    const fakeFetch: typeof fetch = async () => {
      calls += 1;
      return new Response("not json at all", { status: 200, headers: { "content-type": "application/json" } });
    };

    await expect(makeSyntheticEmbedder(profile, { apiKey: "test-key", fetch: fakeFetch }).embedMany(["a"]))
      .rejects.toThrow("Synthetic embeddings response was not JSON");
    expect(calls).toBe(2);
  });

  test("synthetic embedder does not retry non-retryable HTTP contract failures", async () => {
    const profile = makeEmbeddingProfile({
      model: "hf:nomic-ai/nomic-embed-text-v1.5",
      dimensions: 3,
      task: "search_document",
    });
    let calls = 0;
    const fakeFetch: typeof fetch = async () => {
      calls += 1;
      return new Response(JSON.stringify({ error: { message: "invalid api key" } }), {
        status: 401,
        headers: { "content-type": "application/json" },
      });
    };

    await expect(makeSyntheticEmbedder(profile, { apiKey: "bad-key", fetch: fakeFetch }).embedMany(["a"]))
      .rejects.toThrow("invalid api key");
    expect(calls).toBe(1);
  });
});
