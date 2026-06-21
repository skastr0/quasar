import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { LanceDb, makeLanceDbLayer } from "../src/lancedb";
import { afterEach, describe, expect, test } from "bun:test";
import { Effect, Layer } from "effect";
import { createHash } from "node:crypto";

import { embeddingProfileSearchTable, makeEmbeddingProfile, makeGeminiEmbeddingProfile, type EmbeddingProfile } from "../src/embeddingProfiles";
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
const vectorOf = (dimensions: number, seed: number) => Array.from({ length: dimensions }, (_, index) => (index === seed ? 1 : 0));
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

const enqueueEmbeddingJob = (queue: DurableQueueService, maxAttempts = 2, embeddingProfile = "test-embedding") =>
  queue.enqueue({
    kind: "embed-message",
    payload: { sessionId: "session-a", seq: 1, contentHash: "hash-a", embeddingProfile },
    idempotencyKey: `embed-message:hash-a:${crypto.randomUUID()}`,
    maxAttempts,
  });

const withEmbeddingsAt = <A>(
  paths: { readonly sqlite: string; readonly lance: string },
  embedder: Embedder,
  profile: EmbeddingProfile,
  run: Effect.Effect<A, unknown, LocalStore | DurableQueue | LanceDb | Embeddings>,
) => {
  const { sqlite, lance } = paths;
  const dataLayer = Layer.mergeAll(makeLocalStoreLayer(sqlite), makeLanceDbLayer({ dataDir: lance }));
  const queueLayer = makeDurableQueueLayer(sqlite);
  const embeddingsLayer = makeEmbeddingsLayer({ sqlite, profile, embedder }).pipe(
    Layer.provide(Layer.merge(dataLayer, queueLayer)),
  );
  return Effect.runPromise(run.pipe(Effect.provide(Layer.mergeAll(dataLayer, queueLayer, embeddingsLayer))));
};

const withEmbeddings = <A>(embedder: Embedder, run: Effect.Effect<A, unknown, LocalStore | DurableQueue | LanceDb | Embeddings>) =>
  withEmbeddingsAt(
    { sqlite: join(tempDir(), "quasar.sqlite"), lance: join(tempDir(), "search.lance") },
    embedder,
    makeGeminiEmbeddingProfile({ model: "test-embedding" }),
    run,
  );

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

  test("cache miss embeds, caches, updates LanceDB, and acks the job", async () => {
    let calls = 0;
    const embedder: Embedder = {
      embedMany: async (values) => {
        calls += 1;
        expect(values).toEqual(["alpha terminal"]);
        return [vector(0)];
      },
    };

    const [report, cached, rows, queueStats] = await withEmbeddings(
      embedder,
      Effect.gen(function* () {
        const store = yield* LocalStore;
        const queue = yield* DurableQueue;
        const embeddings = yield* Embeddings;
        const search = yield* LanceDb;
        yield* store.upsertSession(mappedSession());
        yield* enqueueEmbeddingJob(queue);
        const report = yield* embeddings.processBatch({ workerId: "worker-a", limit: 10, leaseMs: 60_000, now: "2099-06-18T10:00:00.000Z" });
        const cached = yield* embeddings.getCached("hash-a");
        const rows = yield* search.readMessageRowsBySession({ sessionId: "session-a", select: ["contentHash"] });
        const queueStats = yield* queue.stats;
        return [report, cached, rows, queueStats] as const;
      }),
    );

    expect(calls).toBe(1);
    expect(report).toMatchObject({ leased: 1, cacheHits: 0, cacheMisses: 1, embedded: 1, retried: 0, failed: 0 });
    expect(cached?.dimensions).toBe(1536);
    expect(rows[0]?.contentHash).toBe("hash-a");
    expect(queueStats).toEqual({ pending: 0, leased: 0, failed: 0 });
  });

  test("cache hit avoids provider calls and still updates LanceDB", async () => {
    let calls = 0;
    const embedder: Embedder = {
      embedMany: async () => {
        calls += 1;
        return [vector(1)];
      },
    };

    const [report, rows] = await withEmbeddings(
      embedder,
      Effect.gen(function* () {
        const store = yield* LocalStore;
        const queue = yield* DurableQueue;
        const embeddings = yield* Embeddings;
        const search = yield* LanceDb;
        yield* store.upsertSession(mappedSession());
        yield* embeddings.putCached({ contentHash: "hash-a", text: "alpha terminal", vector: vector(0), now: "2026-06-18T09:00:00.000Z" });
        yield* enqueueEmbeddingJob(queue);
        const report = yield* embeddings.processBatch({ workerId: "worker-a", limit: 10, leaseMs: 60_000, now: "2099-06-18T10:00:00.000Z" });
        const rows = yield* search.readMessageRowsBySession({ sessionId: "session-a", select: ["contentHash"] });
        return [report, rows] as const;
      }),
    );

    expect(calls).toBe(0);
    expect(report).toMatchObject({ leased: 1, cacheHits: 1, cacheMisses: 0, embedded: 0 });
    expect(rows[0]?.contentHash).toBe("hash-a");
  });

  test("provider failures retry then fail after max attempts", async () => {
    const embedder: Embedder = { embedMany: async () => { throw new Error("gemini unavailable"); } };

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
          payload: { sessionId: "session-a", seq: 1, contentHash: "hash-a", embeddingProfile: "test-embedding" },
          idempotencyKey: "embed-message:test-embedding:hash-a",
          maxAttempts: 2,
        });
        yield* queue.enqueue({
          kind: "embed-message",
          payload: { sessionId: "session-a", seq: 2, contentHash: "hash-b", embeddingProfile: "test-embedding" },
          idempotencyKey: "embed-message:test-embedding:hash-b",
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
      const [report, cached, rows] = await withEmbeddings(
        embedder,
        Effect.gen(function* () {
          const store = yield* LocalStore;
          const queue = yield* DurableQueue;
          const embeddings = yield* Embeddings;
          const search = yield* LanceDb;
          yield* store.upsertSession(mappedSession("abcdefghij"));
          yield* enqueueEmbeddingJob(queue);
          const report = yield* embeddings.processBatch({ workerId: "worker-a", limit: 10, leaseMs: 60_000, now: "2099-06-18T10:00:00.000Z" });
          const cached = yield* embeddings.getCached("hash-a");
          const rows = yield* search.readMessageRowsBySession({ sessionId: "session-a", select: ["contentHash", "vector"] });
          return [report, cached, rows] as const;
        }),
      );

      expect(seen).toEqual([["abcde", "fghij"]]);
      expect(report).toMatchObject({ leased: 1, cacheMisses: 1, embedded: 1, retried: 0, failed: 0 });
      expect(cached?.contentHash).toBe("hash-a");
      expect(cached?.vector[0]).toBe(0.5);
      expect(cached?.vector[1]).toBe(0.5);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.contentHash).toBe("hash-a");
    } finally {
      if (previousChunkSize === undefined) delete process.env.QUASAR_EMBEDDING_DOCUMENT_CHUNK_CHARS;
      else process.env.QUASAR_EMBEDDING_DOCUMENT_CHUNK_CHARS = previousChunkSize;
    }
  });

  test("large prefixed messages cache by full prefixed document identity", async () => {
    const previousChunkSize = process.env.QUASAR_EMBEDDING_DOCUMENT_CHUNK_CHARS;
    process.env.QUASAR_EMBEDDING_DOCUMENT_CHUNK_CHARS = "5";
    const profile = makeEmbeddingProfile({
      provider: "synthetic",
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
        { sqlite: join(tempDir(), "quasar.sqlite"), lance: join(tempDir(), "search.lance") },
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
    const lance = join(tempDir(), "search.lance");
    const embedder: Embedder = { embedMany: async () => [vector(0)] };
    const gemini = makeGeminiEmbeddingProfile({ model: "gemini-profile" });
    const alternate = makeGeminiEmbeddingProfile({ model: "gemini-profile", cacheNamespace: "alternate-profile" });

    const cachedInGemini = await withEmbeddingsAt(
      { sqlite, lance },
      embedder,
      gemini,
      Effect.gen(function* () {
        const embeddings = yield* Embeddings;
        yield* embeddings.putCached({ contentHash: "hash-a", text: "alpha terminal", vector: vector(0) });
        return yield* embeddings.getCached("hash-a");
      }),
    );

    const cachedInAlternate = await withEmbeddingsAt(
      { sqlite, lance },
      embedder,
      alternate,
      Effect.gen(function* () {
        const embeddings = yield* Embeddings;
        return yield* embeddings.getCached("hash-a");
      }),
    );

    expect(cachedInGemini?.model).toBe("gemini-profile");
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

  test("non-default profiles use separate LanceDB message tables", () => {
    const defaultGemini = makeGeminiEmbeddingProfile({ model: "gemini-profile" });
    const alternate = makeGeminiEmbeddingProfile({ model: "gemini-profile", cacheNamespace: "alternate-profile" });

    expect(embeddingProfileSearchTable(defaultGemini)).toBe("messages");
    expect(embeddingProfileSearchTable(alternate)).not.toBe("messages");
    expect(embeddingProfileSearchTable(alternate)).toStartWith("messages_");
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
      provider: "synthetic",
      model: "hf:nomic-ai/nomic-embed-text-v1.5",
      dimensions: 1536,
      task: "search_document",
      documentPrefix: "search_document: ",
      queryPrefix: "search_query: ",
    });

    await withEmbeddingsAt(
      { sqlite: join(tempDir(), "quasar.sqlite"), lance: join(tempDir(), "search.lance") },
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

  test("split-profile embeddings update only the profile vector table", async () => {
    const profile = makeEmbeddingProfile({
      provider: "synthetic",
      model: "hf:nomic-ai/nomic-embed-text-v1.5",
      dimensions: 768,
      task: "search_document",
      documentPrefix: "search_document: ",
      queryPrefix: "search_query: ",
    });
    const profileTable = embeddingProfileSearchTable(profile);
    const embedder: Embedder = {
      embedMany: async () => [vectorOf(768, 0)],
    };

    const [report, lexicalRows, profileRows] = await withEmbeddingsAt(
      { sqlite: join(tempDir(), "quasar.sqlite"), lance: join(tempDir(), "search.lance") },
      embedder,
      profile,
      Effect.gen(function* () {
        const store = yield* LocalStore;
        const queue = yield* DurableQueue;
        const embeddings = yield* Embeddings;
        const search = yield* LanceDb;
        yield* store.upsertSession(mappedSession("alpha terminal"));
        yield* search.upsertMessageRows({
          tableName: "messages",
          vectorDimension: 1536,
          rows: [{
            sessionId: "session-a",
            seq: 1,
            role: "user",
            projectKey: "project-a",
            text: "alpha terminal",
            contentHash: "unembedded:hash-a",
            vector: vector(0),
          }],
        });
        yield* enqueueEmbeddingJob(queue, 2, profile.cacheNamespace);
        const report = yield* embeddings.processBatch({ workerId: "worker-a", limit: 10, leaseMs: 60_000 });
        const lexicalRows = yield* search.readMessageRowsBySession({
          sessionId: "session-a",
          tableName: "messages",
          select: ["contentHash", "vector"],
        });
        const profileRows = yield* search.readMessageRowsBySession({
          sessionId: "session-a",
          tableName: profileTable,
          select: ["contentHash", "vector"],
        });
        return [report, lexicalRows, profileRows] as const;
      }),
    );

    expect(profileTable).not.toBe("messages");
    expect(report).toMatchObject({ leased: 1, cacheMisses: 1, embedded: 1, failed: 0 });
    expect(lexicalRows).toHaveLength(1);
    expect(lexicalRows[0]?.contentHash).toBe("unembedded:hash-a");
    expect((lexicalRows[0]?.vector as readonly number[] | undefined)?.length).toBe(1536);
    expect(profileRows).toHaveLength(1);
    expect(profileRows[0]?.contentHash).toBe("hash-a");
    expect((profileRows[0]?.vector as readonly number[] | undefined)?.length).toBe(768);
  });

  test("synthetic embedder preserves response order by index", async () => {
    const profile = makeEmbeddingProfile({
      provider: "synthetic",
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

  test("synthetic embedder rejects invalid response indexes", async () => {
    const profile = makeEmbeddingProfile({
      provider: "synthetic",
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
});
