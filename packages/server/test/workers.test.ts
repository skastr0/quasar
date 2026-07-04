import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "bun:test";
import { Effect, Layer } from "effect";

import { makeEmbeddingProfile } from "../src/embeddingProfiles";
import { makeEmbeddingsLayer, type Embedder } from "../src/embeddings";
import type { MappedSession } from "../src/model";
import { DurableQueue, Embeddings, makeDurableQueueLayer, WorkerSupervisor } from "../src/services";
import { LocalStore, makeLocalStoreLayer } from "../src/store";
import { WorkerSupervisorLive } from "../src/workers";

const tempDirs: string[] = [];

const tempDir = () => {
  const dir = mkdtempSync(join(tmpdir(), "quasar-local-workers-"));
  tempDirs.push(dir);
  return dir;
};

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

const vector = () => Array.from({ length: 1536 }, (_, index) => (index === 0 ? 1 : 0));

const workerEmbeddingProfile = makeEmbeddingProfile({
  model: "test-worker",
  dimensions: 1536,
  task: "search_document",
});

const mappedSession = (): MappedSession => ({
  project: { projectKey: "project-a", displayName: "Project A" },
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
  messages: [{ sessionId: "session-a", seq: 1, role: "user", text: "alpha terminal", projectKey: "project-a", contentHash: "hash-a" }],
  toolCalls: [],
});

const withWorkers = <A>(run: Effect.Effect<A, unknown, LocalStore | DurableQueue | Embeddings | WorkerSupervisor>) => {
  const sqlite = join(tempDir(), "quasar.sqlite");
  const embedder: Embedder = { embedMany: async () => [vector()] };
  const dataLayer = makeLocalStoreLayer(sqlite);
  const queueLayer = makeDurableQueueLayer(sqlite);
  const embeddingsLayer = makeEmbeddingsLayer({
    sqlite,
    profile: workerEmbeddingProfile,
    embedder,
  }).pipe(Layer.provide(Layer.merge(dataLayer, queueLayer)));
  const workersLayer = WorkerSupervisorLive.pipe(Layer.provide(embeddingsLayer));
  return Effect.runPromise(run.pipe(Effect.provide(Layer.mergeAll(dataLayer, queueLayer, embeddingsLayer, workersLayer))));
};

describe("WorkerSupervisor", () => {
  test("tickOnce drains embed-message work into SQLite message_vectors and records reports", async () => {
    const [status, queueStats, vectors] = await withWorkers(
      Effect.gen(function* () {
        const store = yield* LocalStore;
        const queue = yield* DurableQueue;
        const workers = yield* WorkerSupervisor;
        yield* store.upsertSession(mappedSession());
        yield* queue.enqueue({
          kind: "embed-message",
          payload: { sessionId: "session-a", seq: 1, contentHash: "hash-a", embeddingProfile: workerEmbeddingProfile.cacheNamespace },
          idempotencyKey: `embed-message:${workerEmbeddingProfile.cacheNamespace}:hash-a`,
        });
        const status = yield* workers.tickOnce;
        const queueStats = yield* queue.statsByKind;
        const vectors = yield* store.listMessageVectorsBySession({
          sessionId: "session-a",
          model: workerEmbeddingProfile.cacheNamespace,
        });
        return [status, queueStats, vectors] as const;
      }),
    );

    expect(status.enabled).toBe(true);
    expect(Object.keys(status.lastReports)).toEqual(["embeddings"]);
    expect(status.lastErrors).toEqual({});
    expect(queueStats.filter((k) => k.kind === "embed-message" && k.pending + k.leased > 0)).toEqual([]);
    expect(vectors.length).toBe(1);
    expect(vectors[0]?.contentHash).toBe("hash-a");
  });

  test("workers are always on: status reflects the embedding worker", async () => {
    const status = await withWorkers(
      Effect.gen(function* () {
        const workers = yield* WorkerSupervisor;
        return yield* workers.status;
      }),
    );

    expect(status.enabled).toBe(true);
    expect(status.workers).toEqual(["embeddings"]);
  });
});
