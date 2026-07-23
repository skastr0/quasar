import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "bun:test";
import { Deferred, Effect, Either, Layer } from "effect";

import { enqueueDownstreamJobs, ingestMappedSession } from "../src/ingest";
import type { MappedSession } from "../src/model";
import { DurableQueue, DurableQueueError, makeDurableQueueLayer } from "../src/services";
import type { DurableQueueService } from "../src/services";
import { LocalStore, makeLocalStoreLayer } from "../src/store";

const tempDirs: string[] = [];

const tempDir = () => {
  const dir = mkdtempSync(join(tmpdir(), "quasar-ingest-"));
  tempDirs.push(dir);
  return dir;
};

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

// Two searchable messages with IDENTICAL content (same contentHash) at different
// seq — the QSR-219 / QSR-221 case. Each row needs its own vector, so each must
// get its own embed-message job; keying the job by contentHash alone collapses
// them to one and leaves the second row zero-vector forever.
const duplicateContentSession = (): MappedSession => ({
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
    normalizationVersion: 2,
    messageCount: 2,
    toolCallCount: 0,
  },
  messages: [
    { sessionId: "session-a", seq: 1, role: "user", text: "identical", projectKey: "project-a", contentHash: "dup-hash" },
    { sessionId: "session-a", seq: 2, role: "user", text: "identical", projectKey: "project-a", contentHash: "dup-hash" },
  ],
  toolCalls: [],
  events: [],
  usageRecords: [],
  sessionEdges: [],
  artifacts: [],
  executionContexts: [],
});

const withQueue = <A>(run: Effect.Effect<A, unknown, LocalStore | DurableQueue>) => {
  const sqlite = join(tempDir(), "quasar.sqlite");
  const layer = Layer.merge(makeLocalStoreLayer(sqlite), makeDurableQueueLayer(sqlite));
  return Effect.runPromise(run.pipe(Effect.provide(layer)));
};

const leaseEmbedJobs = (queue: DurableQueueService) =>
  queue.leaseBatch({ workerId: "w", kind: "embed-message", limit: 10, leaseMs: 60_000, now: "2099-01-01T00:00:00.000Z" });

describe("enqueueDownstreamJobs", () => {
  test("identical content at different seq each gets its own embed-message job (no contentHash dedup)", async () => {
    const jobs = await withQueue(
      Effect.gen(function* () {
        const queue = yield* DurableQueue;
        yield* enqueueDownstreamJobs(queue, duplicateContentSession().messages);
        return yield* leaseEmbedJobs(queue);
      }),
    );

    expect(jobs.length).toBe(2);
    expect(jobs.map((job) => (job.payload as { seq: number }).seq).sort()).toEqual([1, 2]);

    const keys = jobs.map((job) => job.idempotencyKey ?? "");
    expect(new Set(keys).size).toBe(2);
    for (const job of jobs) {
      const { sessionId, seq } = job.payload as { sessionId: string; seq: number };
      expect(job.idempotencyKey).toContain(`${sessionId}:${seq}:`);
    }
  });

  test("re-enqueuing the same session is idempotent (same sessionId+seq+contentHash collapses)", async () => {
    const jobs = await withQueue(
      Effect.gen(function* () {
        const queue = yield* DurableQueue;
        yield* enqueueDownstreamJobs(queue, duplicateContentSession().messages);
        yield* enqueueDownstreamJobs(queue, duplicateContentSession().messages);
        return yield* leaseEmbedJobs(queue);
      }),
    );

    expect(jobs.length).toBe(2);
  });

  test("a partial fan-out failure leaves the fingerprint stale and the next ingest converges every required job", async () => {
    const sqlite = join(tempDir(), "quasar.sqlite");
    const queueLayer = makeDurableQueueLayer(sqlite);
    const failSecondEnqueueLayer = Layer.effect(
      DurableQueue,
      Effect.gen(function* () {
        const queue = yield* DurableQueue;
        const firstDurable = yield* Deferred.make<void>();
        let enqueueAttempt = 0;
        return DurableQueue.of({
          ...queue,
          enqueue: (job) =>
            Effect.suspend(() => {
              enqueueAttempt += 1;
              if (enqueueAttempt === 1) {
                return queue.enqueue(job).pipe(
                  Effect.tap(() => Deferred.succeed(firstDurable, undefined)),
                );
              }
              if (enqueueAttempt === 2) {
                return Deferred.await(firstDurable).pipe(
                  Effect.andThen(Effect.fail(new DurableQueueError({
                    operation: "enqueue",
                    message: "injected second enqueue failure",
                  }))),
                );
              }
              return queue.enqueue(job);
            }),
        });
      }),
    ).pipe(Layer.provide(queueLayer));
    const layer = Layer.merge(makeLocalStoreLayer(sqlite), failSecondEnqueueLayer);
    const mapped = duplicateContentSession();

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const store = yield* LocalStore;
        const queue = yield* DurableQueue;
        const first = yield* Effect.either(ingestMappedSession(mapped));
        const freshAfterFailure = yield* store.hasSessionFingerprint(
          mapped.session.sessionId,
          mapped.session.sourceFingerprint,
          mapped.session.normalizationVersion,
        );
        const queueAfterFailure = yield* queue.stats;
        const second = yield* ingestMappedSession(mapped);
        const freshAfterRetry = yield* store.hasSessionFingerprint(
          mapped.session.sessionId,
          mapped.session.sourceFingerprint,
          mapped.session.normalizationVersion,
        );
        const jobs = yield* leaseEmbedJobs(queue);
        return { first, freshAfterFailure, queueAfterFailure, second, freshAfterRetry, jobs };
      }).pipe(Effect.provide(layer)),
    );

    expect(Either.isLeft(result.first)).toBe(true);
    expect(result.freshAfterFailure).toBe(false);
    expect(result.queueAfterFailure).toEqual({ pending: 1, leased: 0, failed: 0 });
    expect(result.second).toMatchObject({
      status: "ok",
      messagesWritten: 0,
      jobsEnqueued: 2,
    });
    expect(result.freshAfterRetry).toBe(true);
    expect(result.jobs).toHaveLength(2);
    expect(result.jobs.map((job) => (job.payload as { seq: number }).seq).sort()).toEqual([1, 2]);
    expect(new Set(result.jobs.map((job) => job.idempotencyKey)).size).toBe(2);
  });
});
