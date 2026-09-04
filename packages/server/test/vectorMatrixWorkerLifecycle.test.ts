import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";

import { afterEach, describe, expect, test } from "bun:test";
import { Effect, Layer } from "effect";

import { makeEmbeddingProfile } from "../src/embeddingProfiles";
import type { MappedSession } from "../src/model";
import { LocalStore, makeLocalStoreLayer, type LocalStoreService, type MessageVectorUpsert } from "../src/store";
import {
  makeVectorMatrixLayer,
  VectorMatrix,
  type VectorMatrixService,
} from "../src/vectorMatrix";
import { SCAN_WORKER_FAULT_MARKER, type ScanWorkerFault } from "./fixtures/scanWorkerFault";

const tempDirs: string[] = [];

const sqlitePath = () => {
  const dir = mkdtempSync(join(tmpdir(), "quasar-vector-worker-"));
  tempDirs.push(dir);
  return join(dir, "quasar.sqlite");
};

afterEach(() => {
  rmSync(SCAN_WORKER_FAULT_MARKER, { force: true });
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

const DIMS = 8;
const MODEL = "test-worker-lifecycle-model";
const FAULTY_SCAN_WORKER = new URL("./fixtures/faultyScanWorker.ts", import.meta.url);

const profile = makeEmbeddingProfile({
  model: "test",
  dimensions: DIMS,
  task: "search_document",
  cacheNamespace: MODEL,
});

const armFault = (fault: ScanWorkerFault) => {
  writeFileSync(SCAN_WORKER_FAULT_MARKER, fault, "utf8");
};

const withMatrix = <A>(
  path: string,
  run: (services: { matrix: VectorMatrixService; store: LocalStoreService }) => Effect.Effect<A, unknown, never>,
  options: { scanDeadlineMs?: number; workerInitTimeoutMs?: number; scanWorkerUrl?: URL } = {},
) =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const matrix = yield* VectorMatrix;
        const store = yield* LocalStore;
        return yield* run({ matrix, store });
      }).pipe(
        Effect.provide(
          makeVectorMatrixLayer({
            profile,
            kernel: "js",
            scanDeadlineMs: options.scanDeadlineMs,
            workerInitTimeoutMs: options.workerInitTimeoutMs,
            scanWorkerUrl: options.scanWorkerUrl,
          }).pipe(Layer.provideMerge(makeLocalStoreLayer(path))),
        ),
      ),
    ),
  );

const sessionFixture = (sessionId: string, projectKey: string, messageCount: number): MappedSession => ({
  protocolVersion: "quasar.normalized-session/v1",
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
    eventId: `${sessionId}:event:${seq}`,
    seq,
    role: seq % 2 === 0 ? ("assistant" as const) : ("user" as const),
    text: `message ${seq} of ${sessionId}`,
    ts: "2026-07-01T10:00:00.000Z",
    projectKey,
    contentHash: `hash-${sessionId}-${seq}`,
  })),
  toolCalls: [],
  events: [],
  usageRecords: [],
  sessionEdges: [],
  artifacts: [],
  executionContexts: [],
});

const vectorUpsert = (sessionId: string, seq: number, vector: readonly number[]): MessageVectorUpsert => ({
  model: MODEL,
  modality: "text",
  sessionId,
  seq,
  role: seq % 2 === 0 ? "assistant" : "user",
  projectKey: "project-alpha",
  provider: "codex",
  contentHash: `hash-${sessionId}-${seq}`,
  documentHash: `doc-${sessionId}-${seq}`,
  vector,
  now: "2026-07-01T10:10:00.000Z",
});

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
    const rows = [
      vectorUpsert("codex:alpha", 0, angleVector(0.1)),
      vectorUpsert("codex:alpha", 1, angleVector(0.4)),
      vectorUpsert("codex:alpha", 2, angleVector(0.9)),
      vectorUpsert("codex:alpha", 3, angleVector(1.4)),
    ];
    expect(yield* store.upsertMessageVectors(rows)).toBe(rows.length);
  });

/** The pool heals asynchronously; poll status rather than sleeping a guess. */
const awaitWorkerCount = (matrix: VectorMatrixService, expected: number, timeoutMs = 5_000) =>
  Effect.gen(function* () {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const status = yield* matrix.status;
      if (status.workerCount === expected) return status.workerCount;
      yield* Effect.sleep("20 millis");
    }
    return (yield* matrix.status).workerCount;
  });

const taggedError = (outcome: unknown): { _tag: string; operation?: string; message?: string } =>
  outcome as { _tag: string; operation?: string; message?: string };

describe("vectorMatrix worker death", () => {
  test("a worker that dies mid-chunk fails its scan typed, then the pool respawns and the next query succeeds", async () => {
    const path = sqlitePath();
    await withMatrix(path, ({ store }) => seedCorpus(store));
    await withMatrix(
      path,
      ({ matrix }) =>
        Effect.gen(function* () {
          yield* matrix.awaitLoaded;
          const booted = yield* matrix.status;
          expect(booted.enabled).toBe(true);
          expect(booted.workerCount).toBeGreaterThan(0);

          armFault("crash");
          const startedAt = performance.now();
          const outcome = yield* matrix.search({ vector: queryVector(), limit: 3 }).pipe(Effect.either);
          const elapsedMs = performance.now() - startedAt;

          // Typed failure, not a hang — and it does not ride the deadline out:
          // the death event settles the scan long before the backstop.
          expect(outcome._tag).toBe("Left");
          if (outcome._tag === "Left") {
            const error = taggedError(outcome.left);
            expect(error._tag).toBe("VectorMatrixError");
            expect(error.operation).toBe("search.scan");
            expect(error.message).toContain("died mid-chunk");
          }
          expect(elapsedMs).toBeLessThan(2_000);

          // The pool rebuilds itself from the resident SharedArrayBuffer.
          expect(yield* awaitWorkerCount(matrix, booted.workerCount)).toBe(booted.workerCount);

          const hits = yield* matrix.search({ vector: queryVector(), limit: 3 });
          expect(hits.map((hit) => `${hit.sessionId}:${hit.seq}`)).toEqual([
            "codex:alpha:0",
            "codex:alpha:1",
            "codex:alpha:2",
          ]);
        }),
      { scanDeadlineMs: 10_000, scanWorkerUrl: FAULTY_SCAN_WORKER },
    );
  });

  test("a worker that goes quiet is caught by the scan deadline and recycled", async () => {
    const path = sqlitePath();
    await withMatrix(path, ({ store }) => seedCorpus(store));
    await withMatrix(
      path,
      ({ matrix }) =>
        Effect.gen(function* () {
          yield* matrix.awaitLoaded;
          const booted = yield* matrix.status;
          expect(booted.workerCount).toBeGreaterThan(0);

          armFault("silent");
          const startedAt = performance.now();
          const outcome = yield* matrix.search({ vector: queryVector(), limit: 3 }).pipe(Effect.either);
          const elapsedMs = performance.now() - startedAt;

          expect(outcome._tag).toBe("Left");
          if (outcome._tag === "Left") {
            const error = taggedError(outcome.left);
            expect(error._tag).toBe("VectorMatrixError");
            expect(error.operation).toBe("search.scan");
            expect(error.message).toContain("deadline");
          }
          expect(elapsedMs).toBeGreaterThanOrEqual(300);
          expect(elapsedMs).toBeLessThan(5_000);

          expect(yield* awaitWorkerCount(matrix, booted.workerCount)).toBe(booted.workerCount);

          const hits = yield* matrix.search({ vector: queryVector(), limit: 2 });
          expect(hits.map((hit) => `${hit.sessionId}:${hit.seq}`)).toEqual([
            "codex:alpha:0",
            "codex:alpha:1",
          ]);
        }),
      { scanDeadlineMs: 400, scanWorkerUrl: FAULTY_SCAN_WORKER },
    );
  });

  test("a worker that exits during init settles its spawn instead of hanging the boot", async () => {
    const path = sqlitePath();
    await withMatrix(path, ({ store }) => seedCorpus(store));
    // A thread that exits inside its `init` handler emits `close` and NO
    // `error`. If the spawn promise only settles from a message or an error
    // event, `Promise.allSettled` over the pool never resolves, `awaitLoaded`
    // never fires, and the matrix boot hangs forever with no diagnostic.
    armFault("init-exit");
    const startedAt = performance.now();
    await withMatrix(
      path,
      ({ matrix }) =>
        Effect.gen(function* () {
          yield* matrix.awaitLoaded;
          const status = yield* matrix.status;
          // The boot FAILED — that is the honest outcome — but it failed fast
          // and observably rather than wedging the whole matrix.
          expect(status.enabled).toBe(false);
          const outcome = yield* matrix.search({ vector: queryVector(), limit: 1 }).pipe(Effect.either);
          expect(outcome._tag).toBe("Left");
        }),
      { scanDeadlineMs: 400, workerInitTimeoutMs: 2_000, scanWorkerUrl: FAULTY_SCAN_WORKER },
    );
    // Settled by the close event, not by riding out the init timeout.
    expect(performance.now() - startedAt).toBeLessThan(2_000);
  }, 15_000);

  test("recycling a slot at one scan's deadline settles the other scans that slot owed", async () => {
    const path = sqlitePath();
    await withMatrix(path, ({ store }) => seedCorpus(store));
    await withMatrix(
      path,
      ({ matrix }) =>
        Effect.gen(function* () {
          yield* matrix.awaitLoaded;
          expect((yield* matrix.status).workerCount).toBeGreaterThan(0);

          // One worker swallows every chunk, so it ends up holding BOTH scans.
          armFault("silent-all");
          const first = yield* Effect.fork(
            matrix.search({ vector: queryVector(), limit: 2 }).pipe(
              Effect.either,
              Effect.map((outcome) => ({ outcome, at: performance.now() })),
            ),
          );
          // Start the second scan late enough that its own deadline cannot be
          // what settles it: it must fail when the FIRST scan recycles the slot.
          yield* Effect.sleep("250 millis");
          const second = yield* Effect.fork(
            matrix.search({ vector: queryVector(), limit: 2 }).pipe(
              Effect.either,
              Effect.map((outcome) => ({ outcome, at: performance.now() })),
            ),
          );
          const secondStartedAt = performance.now();

          const firstResult = yield* first.await.pipe(Effect.flatten);
          const secondResult = yield* second.await.pipe(Effect.flatten);

          expect(firstResult.outcome._tag).toBe("Left");
          expect(secondResult.outcome._tag).toBe("Left");
          if (secondResult.outcome._tag === "Left") {
            const error = taggedError(secondResult.outcome.left);
            // The TRUE cause, not a misleading "your own deadline elapsed".
            expect(error.message).toContain("recycled");
          }
          // It did not wait out its own deadline on a worker that was already
          // gone: it settled with the recycle, not 400ms after it started.
          expect(secondResult.at - secondStartedAt).toBeLessThan(350);
        }),
      { scanDeadlineMs: 400, scanWorkerUrl: FAULTY_SCAN_WORKER },
    );
  }, 15_000);
});
