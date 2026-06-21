import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { LanceDb, makeLanceDbLayer } from "../src/lancedb";
import { afterEach, describe, expect, test } from "bun:test";
import { Effect, Layer } from "effect";

import { makeGeminiEmbeddingProfile } from "../src/embeddingProfiles";
import { makeEmbeddingsLayer, type Embedder } from "../src/embeddings";
import { SearchMaintenance, SearchMaintenanceLive } from "../src/maintenance";
import type { MappedSession } from "../src/model";
import { DerivedSearch, DerivedSearchLive } from "../src/search";
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

const withEnv = async <A>(values: Record<string, string | undefined>, run: () => Promise<A>): Promise<A> => {
  const previous = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(values)) {
    previous.set(key, process.env[key]);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return await run();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
};

const withWorkers = <A>(run: Effect.Effect<A, unknown, LocalStore | LanceDb | DurableQueue | DerivedSearch | SearchMaintenance | Embeddings | WorkerSupervisor>) => {
  const sqlite = join(tempDir(), "quasar.sqlite");
  const lance = join(tempDir(), "search.lance");
  const embedder: Embedder = { embedMany: async () => [vector()] };
  const dataLayer = Layer.mergeAll(makeLocalStoreLayer(sqlite), makeLanceDbLayer({ dataDir: lance }));
  const queueLayer = makeDurableQueueLayer(sqlite);
  const searchLayer = DerivedSearchLive.pipe(Layer.provide(dataLayer));
  const embeddingsLayer = makeEmbeddingsLayer({ sqlite, profile: makeGeminiEmbeddingProfile({ model: "test-worker" }), embedder }).pipe(Layer.provide(Layer.merge(dataLayer, queueLayer)));
  const maintenanceLayer = SearchMaintenanceLive.pipe(Layer.provide(Layer.mergeAll(dataLayer, queueLayer, searchLayer)));
  const workersLayer = WorkerSupervisorLive.pipe(Layer.provide(Layer.mergeAll(embeddingsLayer, maintenanceLayer)));
  return Effect.runPromise(run.pipe(Effect.provide(Layer.mergeAll(dataLayer, queueLayer, searchLayer, embeddingsLayer, maintenanceLayer, workersLayer))));
};

describe("WorkerSupervisor", () => {
  test("tickOnce processes embed/index/maintenance work and records reports", async () => {
    const [status, queueStats, rows] = await withWorkers(
      Effect.gen(function* () {
        const store = yield* LocalStore;
        const queue = yield* DurableQueue;
        const workers = yield* WorkerSupervisor;
        const search = yield* LanceDb;
        yield* store.upsertSession(mappedSession());
        yield* queue.enqueue({
          kind: "embed-message",
          payload: { sessionId: "session-a", seq: 1, contentHash: "hash-a", embeddingProfile: "test-worker" },
          idempotencyKey: "embed-message:test-worker:hash-a",
        });
        const status = yield* workers.tickOnce;
        const queueStats = yield* queue.statsByKind;
        const rows = yield* search.readMessageRowsBySession({ sessionId: "session-a", select: ["contentHash"] });
        return [status, queueStats, rows] as const;
      }),
    );

    expect(status.enabled).toBe(false);
    expect(Object.keys(status.lastReports)).toEqual(["embeddings", "index-repair", "freshness", "maintenance"]);
    expect(status.lastErrors).toEqual({});
    expect(queueStats).toEqual([]);
    expect(rows[0]?.contentHash).toBe("hash-a");
  });

  test("supports enabling only the embedding lane", async () => {
    const status = await withEnv(
      {
        QUASAR_WORKERS_ENABLED: "false",
        QUASAR_EMBEDDING_WORKER_ENABLED: "true",
        QUASAR_INDEX_REPAIR_WORKER_ENABLED: "false",
        QUASAR_FRESHNESS_WORKER_ENABLED: "false",
        QUASAR_MAINTENANCE_WORKER_ENABLED: "false",
        QUASAR_WORKER_INTERVAL_MS: "60000",
      },
      () => withWorkers(
        Effect.gen(function* () {
          const workers = yield* WorkerSupervisor;
          return yield* workers.status;
        }),
      ),
    );

    expect(status.enabled).toBe(true);
    expect(status.workers).toEqual(["embeddings"]);
  });
});
