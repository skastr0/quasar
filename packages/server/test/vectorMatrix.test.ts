import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { Effect, Layer } from "effect";

import { makeEmbeddingProfile } from "../src/embeddingProfiles";
import type { MappedSession } from "../src/model";
import { LocalStore, makeLocalStoreLayer, type MessageVectorUpsert } from "../src/store";
import { encodeFloat16Vector } from "../src/vectorBlob";
import { cosineSimilarityF16Reference, encodeQueryVectorF16 } from "../src/vectorKernel";
import {
  makeVectorMatrixLayer,
  VectorMatrix,
  type VectorMatrixService,
} from "../src/vectorMatrix";
import type { LocalStoreService } from "../src/store";

const tempDirs: string[] = [];

const sqlitePath = () => {
  const dir = mkdtempSync(join(tmpdir(), "quasar-vector-matrix-"));
  tempDirs.push(dir);
  return join(dir, "quasar.sqlite");
};

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

const DIMS = 8;
const MODEL = "test-matrix-model";

const profile = makeEmbeddingProfile({
  model: "test",
  dimensions: DIMS,
  task: "search_document",
  cacheNamespace: MODEL,
});

const withMatrix = <A>(
  path: string,
  run: (services: { matrix: VectorMatrixService; store: LocalStoreService }) => Effect.Effect<A, unknown, never>,
  options: { kernel?: "auto" | "js" } = {},
) =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const matrix = yield* VectorMatrix;
        const store = yield* LocalStore;
        return yield* run({ matrix, store });
      }).pipe(
        Effect.provide(
          makeVectorMatrixLayer({ profile, kernel: options.kernel ?? "auto" }).pipe(
            Layer.provideMerge(makeLocalStoreLayer(path)),
          ),
        ),
      ),
    ),
  );

const sessionFixture = (sessionId: string, projectKey: string, messageCount: number): MappedSession => ({
  project: { projectKey, displayName: projectKey, rawPath: `/tmp/${projectKey}` },
  session: {
    sessionId,
    projectKey,
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
    messageCount,
    toolCallCount: 0,
  },
  messages: Array.from({ length: messageCount }, (_, seq) => ({
    sessionId,
    seq,
    role: seq % 2 === 0 ? ("assistant" as const) : ("user" as const),
    text: `message ${seq} of ${sessionId}`,
    ts: "2026-07-01T10:00:00.000Z",
    projectKey,
    contentHash: `hash-${sessionId}-${seq}`,
  })),
  toolCalls: [],
});

const vectorUpsert = (
  sessionId: string,
  projectKey: string,
  seq: number,
  vector: readonly number[],
): MessageVectorUpsert => ({
  model: MODEL,
  modality: "text",
  sessionId,
  seq,
  role: seq % 2 === 0 ? "assistant" : "user",
  projectKey,
  provider: "codex",
  contentHash: `hash-${sessionId}-${seq}`,
  documentHash: `doc-${sessionId}-${seq}`,
  vector,
  now: "2026-07-01T10:10:00.000Z",
});

/** Angle-spread vectors: similarity to the [1, 0, ...] query equals cos(theta). */
const angleVector = (theta: number): number[] => {
  const vector = Array(DIMS).fill(0);
  vector[0] = Math.cos(theta);
  vector[1] = Math.sin(theta);
  return vector;
};

const queryVector = (): number[] => {
  const vector = Array(DIMS).fill(0);
  vector[0] = 1;
  return vector;
};

const seedCorpus = (store: LocalStoreService) =>
  Effect.gen(function* () {
    yield* store.upsertSession(sessionFixture("codex:alpha", "project-alpha", 4));
    yield* store.upsertSession(sessionFixture("codex:beta", "project-beta", 3));
    // Angles ordered so ranking is unambiguous: seq 0 of alpha is closest.
    const rows = [
      vectorUpsert("codex:alpha", "project-alpha", 0, angleVector(0.1)),
      vectorUpsert("codex:alpha", "project-alpha", 1, angleVector(0.4)),
      vectorUpsert("codex:alpha", "project-alpha", 2, angleVector(0.9)),
      vectorUpsert("codex:alpha", "project-alpha", 3, angleVector(1.4)),
      vectorUpsert("codex:beta", "project-beta", 0, angleVector(0.25)),
      vectorUpsert("codex:beta", "project-beta", 1, angleVector(0.7)),
      vectorUpsert("codex:beta", "project-beta", 2, angleVector(1.2)),
    ];
    const accepted = yield* store.upsertMessageVectors(rows);
    expect(accepted).toBe(rows.length);
    return rows;
  });

describe("vectorMatrix boot", () => {
  test("empty boot stays disabled and mid-process writes never enable it", async () => {
    const path = sqlitePath();
    await withMatrix(path, ({ matrix, store }) =>
      Effect.gen(function* () {
        yield* matrix.awaitLoaded;
        const before = yield* matrix.status;
        expect(before.enabled).toBe(false);
        expect(before.kernel).toBe("none");
        expect(before.rows).toBe(0);

        // Vectors written after an empty boot are dropped by design: the
        // matrix exists iff boot found rows, keeping the 503 contract stable.
        yield* seedCorpus(store);
        const after = yield* matrix.status;
        expect(after.enabled).toBe(false);
        expect(after.rows).toBe(0);
        expect(after.appendedRows).toBe(0);

        const outcome = yield* matrix.search({ vector: queryVector(), limit: 3 }).pipe(Effect.either);
        expect(outcome._tag).toBe("Left");
        if (outcome._tag === "Left") {
          expect((outcome.left as { _tag: string })._tag).toBe("VectorMatrixDisabledError");
        }
      }),
    );
  });

  test("boot with rows enables exact top-k that matches the reference ranking", async () => {
    const path = sqlitePath();
    // Seed in a first scope (simulates the corpus existing before boot).
    await withMatrix(path, ({ store }) => seedCorpus(store));
    await withMatrix(path, ({ matrix }) =>
      Effect.gen(function* () {
        yield* matrix.awaitLoaded;
        const status = yield* matrix.status;
        expect(status.enabled).toBe(true);
        expect(status.rows).toBe(7);
        expect(status.kernel).toBe("simsimd-ffi");
        expect(status.watermark.matrixRows).toBe(7);
        expect(status.watermark.sqliteRows).toBe(7);

        const hits = yield* matrix.search({ vector: queryVector(), limit: 3 });
        expect(hits.map((hit) => `${hit.sessionId}:${hit.seq}`)).toEqual([
          "codex:alpha:0",
          "codex:beta:0",
          "codex:alpha:1",
        ]);
        // Scores match the pure-JS reference within f16 tolerance.
        const query = encodeQueryVectorF16(queryVector(), DIMS);
        const expected = cosineSimilarityF16Reference(
          Uint16Array.from(new Uint16Array(encodeFloat16Vector(angleVector(0.1)).buffer)),
          query,
        );
        expect(Math.abs((hits[0]?.score ?? 0) - expected)).toBeLessThan(1e-5);
      }),
    );
  });

  test("loader skips malformed rows with a diagnostic count and still serves the rest", async () => {
    const path = sqlitePath();
    await withMatrix(path, ({ store }) => seedCorpus(store));
    // Corrupt rows written around the store boundary: wrong dimensions, wrong encoding.
    const db = new Database(path);
    try {
      db.prepare(
        `INSERT INTO message_vectors(model, modality, session_id, seq, role, project_key, provider, content_hash, document_hash, dimensions, encoding, vector_blob, created_at, updated_at)
         VALUES (?, 'text', 'codex:alpha', 90, 'assistant', 'project-alpha', 'codex', 'h90', 'd90', 4, 'f16le', ?, '2026-07-01T10:00:00.000Z', '2026-07-01T10:00:00.000Z')`,
      ).run(MODEL, encodeFloat16Vector([1, 0, 0, 0]));
      db.prepare(
        `INSERT INTO message_vectors(model, modality, session_id, seq, role, project_key, provider, content_hash, document_hash, dimensions, encoding, vector_blob, created_at, updated_at)
         VALUES (?, 'text', 'codex:alpha', 91, 'assistant', 'project-alpha', 'codex', 'h91', 'd91', 8, 'f32le', ?, '2026-07-01T10:00:00.000Z', '2026-07-01T10:00:00.000Z')`,
      ).run(MODEL, encodeFloat16Vector(angleVector(0))); // encoding lies
    } finally {
      db.close();
    }
    await withMatrix(path, ({ matrix }) =>
      Effect.gen(function* () {
        yield* matrix.awaitLoaded;
        const status = yield* matrix.status;
        expect(status.enabled).toBe(true);
        expect(status.rows).toBe(7);
        expect(status.loadSkippedRows).toBe(2);
        const hits = yield* matrix.search({ vector: queryVector(), limit: 10 });
        expect(hits.every((hit) => hit.seq < 90)).toBe(true);
      }),
    );
  });
});

describe("vectorMatrix filtered scan", () => {
  test("scope filters (projectKey/role/providers) mask the exact scan in-matrix; unknown values short-circuit", async () => {
    const path = sqlitePath();
    await withMatrix(path, ({ store }) => seedCorpus(store));
    await withMatrix(path, ({ matrix }) =>
      Effect.gen(function* () {
        yield* matrix.awaitLoaded;

        const betaOnly = yield* matrix.search({
          vector: queryVector(),
          limit: 10,
          projectKey: "project-beta",
        });
        expect(betaOnly.map((hit) => `${hit.sessionId}:${hit.seq}`)).toEqual([
          "codex:beta:0",
          "codex:beta:1",
          "codex:beta:2",
        ]);

        // A projectKey never seen by this matrix short-circuits to [] without
        // scanning (no dictionary code exists for it).
        const unknownProjectKey = yield* matrix.search({ vector: queryVector(), limit: 10, projectKey: "project-nope" });
        expect(unknownProjectKey).toEqual([]);

        // An empty (or entirely-unknown) providers allow-list can never match.
        const emptyProviders = yield* matrix.search({ vector: queryVector(), limit: 10, providers: [] });
        expect(emptyProviders).toEqual([]);
        const unknownProvider = yield* matrix.search({
          vector: queryVector(),
          limit: 10,
          providers: ["nonexistent-provider"],
        });
        expect(unknownProvider).toEqual([]);

        const roleFiltered = yield* matrix.search({ vector: queryVector(), limit: 10, role: "user" });
        expect(roleFiltered.length).toBeGreaterThan(0);
        expect(roleFiltered.every((hit) => hit.seq % 2 === 1)).toBe(true);

        // All three filters combine as an AND: alpha's assistant rows via the
        // known "codex" provider are exactly seq 0 and 2.
        const combined = yield* matrix.search({
          vector: queryVector(),
          limit: 10,
          projectKey: "project-alpha",
          role: "assistant",
          providers: ["codex"],
        });
        expect(combined.map((hit) => `${hit.sessionId}:${hit.seq}`).sort()).toEqual([
          "codex:alpha:0",
          "codex:alpha:2",
        ]);
      }),
    );
  });
});

describe("vectorMatrix append path", () => {
  test("appends and in-place overwrites through the store write site update serving", async () => {
    const path = sqlitePath();
    await withMatrix(path, ({ store }) => seedCorpus(store));
    await withMatrix(path, ({ matrix, store }) =>
      Effect.gen(function* () {
        yield* matrix.awaitLoaded;

        // New session written while the process runs -> appended.
        yield* store.upsertSession(sessionFixture("codex:gamma", "project-gamma", 1));
        yield* store.upsertMessageVectors([
          vectorUpsert("codex:gamma", "project-gamma", 0, angleVector(0.05)),
        ]);
        let status = yield* matrix.status;
        expect(status.rows).toBe(8);
        expect(status.appendedRows).toBe(1);
        expect(status.watermark.matrixRows).toBe(8);
        expect(status.watermark.sqliteRows).toBe(8);

        let hits = yield* matrix.search({ vector: queryVector(), limit: 1 });
        expect(hits[0]?.sessionId).toBe("codex:gamma");

        // Re-embed of an existing key -> overwritten in place, ranking follows.
        yield* store.upsertMessageVectors([
          vectorUpsert("codex:alpha", "project-alpha", 3, angleVector(0.01)),
        ]);
        status = yield* matrix.status;
        expect(status.rows).toBe(8);
        expect(status.overwrittenRows).toBe(1);

        hits = yield* matrix.search({ vector: queryVector(), limit: 1 });
        expect(`${hits[0]?.sessionId}:${hits[0]?.seq}`).toBe("codex:alpha:3");
      }),
    );
  });

  test("vectors for other models are ignored by the append path", async () => {
    const path = sqlitePath();
    await withMatrix(path, ({ store }) => seedCorpus(store));
    await withMatrix(path, ({ matrix, store }) =>
      Effect.gen(function* () {
        yield* matrix.awaitLoaded;
        yield* store.upsertMessageVectors([
          { ...vectorUpsert("codex:alpha", "project-alpha", 0, angleVector(3)), model: "another-model" },
        ]);
        const status = yield* matrix.status;
        expect(status.rows).toBe(7);
        expect(status.appendedRows).toBe(0);
        expect(status.overwrittenRows).toBe(0);
      }),
    );
  });
});

describe("vectorMatrix kernel parity at matrix level", () => {
  test("js fallback kernel returns the same hits as the simsimd kernel", async () => {
    const path = sqlitePath();
    const random = (() => {
      let seed = 0x5eed;
      return () => {
        seed = (seed * 1103515245 + 12345) & 0x7fffffff;
        return seed / 0x7fffffff - 0.5;
      };
    })();
    const sessions = 6;
    const perSession = 20;
    await withMatrix(path, ({ store }) =>
      Effect.gen(function* () {
        for (let index = 0; index < sessions; index += 1) {
          const sessionId = `codex:rand${index}`;
          yield* store.upsertSession(sessionFixture(sessionId, "project-rand", perSession));
          yield* store.upsertMessageVectors(
            Array.from({ length: perSession }, (_, seq) =>
              vectorUpsert(sessionId, "project-rand", seq, Array.from({ length: DIMS }, () => random())),
            ),
          );
        }
      }),
    );
    const query = Array.from({ length: DIMS }, () => random());
    const nativeHits = await withMatrix(path, ({ matrix }) =>
      Effect.gen(function* () {
        yield* matrix.awaitLoaded;
        const status = yield* matrix.status;
        expect(status.kernel).toBe("simsimd-ffi");
        return yield* matrix.search({ vector: query, limit: 15 });
      }),
    );
    const fallbackHits = await withMatrix(
      path,
      ({ matrix }) =>
        Effect.gen(function* () {
          yield* matrix.awaitLoaded;
          const status = yield* matrix.status;
          expect(status.kernel).toBe("js-fallback");
          return yield* matrix.search({ vector: query, limit: 15 });
        }),
      { kernel: "js" },
    );
    expect(nativeHits.length).toBe(15);
    expect(fallbackHits.map((hit) => `${hit.sessionId}:${hit.seq}`)).toEqual(
      nativeHits.map((hit) => `${hit.sessionId}:${hit.seq}`),
    );
    for (let index = 0; index < nativeHits.length; index += 1) {
      expect(Math.abs((nativeHits[index]?.score ?? 0) - (fallbackHits[index]?.score ?? 0))).toBeLessThan(1e-5);
    }
  });
});

describe("vectorMatrix query boundary", () => {
  test("rejects invalid query vectors as errors, not results", async () => {
    const path = sqlitePath();
    await withMatrix(path, ({ store }) => seedCorpus(store));
    await withMatrix(path, ({ matrix }) =>
      Effect.gen(function* () {
        yield* matrix.awaitLoaded;
        for (const bad of [
          Array(DIMS).fill(0),
          [...Array(DIMS - 1).fill(0.5)],
          [Number.NaN, ...Array(DIMS - 1).fill(0.5)],
        ]) {
          const outcome = yield* matrix.search({ vector: bad, limit: 3 }).pipe(Effect.either);
          expect(outcome._tag).toBe("Left");
          if (outcome._tag === "Left") {
            expect((outcome.left as { _tag: string })._tag).toBe("VectorMatrixError");
          }
        }
      }),
    );
  });
});
