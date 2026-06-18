import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { LanceDb, makeLanceDbLayer } from "@skastr0/quasar-search";
import { afterEach, describe, expect, test } from "bun:test";
import { Effect, Layer } from "effect";

import { embeddingProfileSearchTable, makeGeminiEmbeddingProfile, type EmbeddingProfile } from "../src/embeddingProfiles";
import { makeEmbeddingsLayer, type Embedder } from "../src/embeddings";
import type { MappedSession } from "../src/model";
import { Embeddings, DurableQueue, makeDurableQueueLayer } from "../src/services";
import type { DurableQueueService } from "../src/services";
import { LocalStore, makeLocalStoreLayer } from "../src/store";

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

const mappedSession = (text = "alpha terminal"): MappedSession => ({
  project: { projectKey: "project-a", displayName: "Project A", rawPath: "/tmp/project-a" },
  session: {
    sessionId: "session-a",
    projectKey: "project-a",
    provider: "codex",
    agentName: "codex",
    sourcePath: "/history/session-a.jsonl",
    sourceFingerprint: "fingerprint-a",
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

const enqueueEmbeddingJob = (queue: DurableQueueService, maxAttempts = 2) =>
  queue.enqueue({
    kind: "embed-message",
    payload: { sessionId: "session-a", seq: 1, contentHash: "hash-a" },
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
});
