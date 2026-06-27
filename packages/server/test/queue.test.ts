import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "bun:test";
import { Effect } from "effect";

import { DurableQueue, makeDurableQueueLayer } from "../src/services";
import type { DurableQueueService } from "../src/services";

const tempDirs: string[] = [];

const sqlitePath = () => {
  const dir = mkdtempSync(join(tmpdir(), "quasar-local-queue-"));
  tempDirs.push(dir);
  return join(dir, "quasar.sqlite");
};

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

const withQueue = <A>(path: string, run: (queue: DurableQueueService) => Effect.Effect<A, unknown, never>) =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const queue = yield* DurableQueue;
        return yield* run(queue);
      }).pipe(Effect.provide(makeDurableQueueLayer(path))),
    ),
  );

describe("DurableQueue", () => {
  test("idempotency keys return the existing queued job", async () => {
    const path = sqlitePath();
    const [first, second, stats] = await withQueue(
      path,
      (queue) =>
        Effect.gen(function* () {
          const first = yield* queue.enqueue({ kind: "embed", payload: { messageId: "a" }, idempotencyKey: "embed:a" });
          const second = yield* queue.enqueue({ kind: "embed", payload: { messageId: "a" }, idempotencyKey: "embed:a" });
          const stats = yield* queue.stats;
          return [first, second, stats] as const;
        }),
    );

    expect(first.jobId).toBe(second.jobId);
    expect(stats).toEqual({ pending: 1, leased: 0, failed: 0 });
  });

  test("completed idempotent jobs can be enqueued again for later repairs", async () => {
    const path = sqlitePath();
    const [first, second, stats] = await withQueue(
      path,
      (queue) =>
        Effect.gen(function* () {
          const first = yield* queue.enqueue({ kind: "index-session", payload: { sessionId: "a" }, idempotencyKey: "index-session:a" });
          yield* queue.leaseBatch({ workerId: "worker-a", kind: "index-session", limit: 1, leaseMs: 60_000, now: "2099-06-18T10:00:00.000Z" });
          yield* queue.ack(first.jobId, "2099-06-18T10:00:01.000Z");
          const second = yield* queue.enqueue({ kind: "index-session", payload: { sessionId: "a" }, idempotencyKey: "index-session:a" });
          const stats = yield* queue.stats;
          return [first, second, stats] as const;
        }),
    );

    expect(second.jobId).not.toBe(first.jobId);
    expect(stats).toEqual({ pending: 1, leased: 0, failed: 0 });
  });

  test("leaseBatch leases ready jobs exclusively up to the requested limit", async () => {
    const path = sqlitePath();
    const [firstLease, secondLease, stats] = await withQueue(
      path,
      (queue) =>
        Effect.gen(function* () {
          yield* queue.enqueue({ kind: "index", payload: { sessionId: "a" } });
          yield* queue.enqueue({ kind: "index", payload: { sessionId: "b" } });
          const firstLease = yield* queue.leaseBatch({ workerId: "worker-a", limit: 1, leaseMs: 60_000, now: "2099-06-18T10:00:00.000Z" });
          const secondLease = yield* queue.leaseBatch({ workerId: "worker-b", limit: 10, leaseMs: 60_000, now: "2099-06-18T10:00:01.000Z" });
          const stats = yield* queue.stats;
          return [firstLease, secondLease, stats] as const;
        }),
    );

    expect(firstLease).toHaveLength(1);
    expect(firstLease[0]?.leasedBy).toBe("worker-a");
    expect(secondLease).toHaveLength(1);
    expect(secondLease[0]?.jobId).not.toBe(firstLease[0]?.jobId);
    expect(stats).toEqual({ pending: 0, leased: 2, failed: 0 });
  });

  test("leaseBatch can isolate workers by job kind", async () => {
    const path = sqlitePath();
    const [embedLease, indexLease] = await withQueue(
      path,
      (queue) =>
        Effect.gen(function* () {
          yield* queue.enqueue({ kind: "embed-message", payload: { sessionId: "a" } });
          yield* queue.enqueue({ kind: "index-session", payload: { sessionId: "a" } });
          const embedLease = yield* queue.leaseBatch({ workerId: "embedder", kind: "embed-message", limit: 10, leaseMs: 60_000, now: "2099-06-18T10:00:00.000Z" });
          const indexLease = yield* queue.leaseBatch({ workerId: "indexer", kind: "index-session", limit: 10, leaseMs: 60_000, now: "2099-06-18T10:00:00.000Z" });
          return [embedLease, indexLease] as const;
        }),
    );

    expect(embedLease.map((job) => job.kind)).toEqual(["embed-message"]);
    expect(indexLease.map((job) => job.kind)).toEqual(["index-session"]);
  });

  test("retry releases a job with delayed next_run_at", async () => {
    const path = sqlitePath();
    const [earlyLease, lateLease] = await withQueue(
      path,
      (queue) =>
        Effect.gen(function* () {
          const job = yield* queue.enqueue({ kind: "embed", payload: { messageId: "a" } });
          yield* queue.leaseBatch({ workerId: "worker-a", limit: 1, leaseMs: 60_000, now: "2099-06-18T10:00:00.000Z" });
          yield* queue.retry(job.jobId, { error: "rate limited", delayMs: 30_000, now: "2099-06-18T10:00:10.000Z" });
          const earlyLease = yield* queue.leaseBatch({ workerId: "worker-b", limit: 1, leaseMs: 60_000, now: "2099-06-18T10:00:20.000Z" });
          const lateLease = yield* queue.leaseBatch({ workerId: "worker-b", limit: 1, leaseMs: 60_000, now: "2099-06-18T10:00:40.000Z" });
          return [earlyLease, lateLease] as const;
        }),
    );

    expect(earlyLease).toHaveLength(0);
    expect(lateLease).toHaveLength(1);
    expect(lateLease[0]?.attempts).toBe(2);
    expect(lateLease[0]?.lastError).toBe("rate limited");
  });

  test("recoverStaleLeases makes expired leased jobs available", async () => {
    const path = sqlitePath();
    const [recovered, leased] = await withQueue(
      path,
      (queue) =>
        Effect.gen(function* () {
          yield* queue.enqueue({ kind: "index", payload: { sessionId: "a" } });
          yield* queue.leaseBatch({ workerId: "worker-a", limit: 1, leaseMs: 1_000, now: "2099-06-18T10:00:00.000Z" });
          const recovered = yield* queue.recoverStaleLeases("2099-06-18T10:00:02.000Z");
          const leased = yield* queue.leaseBatch({ workerId: "worker-b", limit: 1, leaseMs: 60_000, now: "2099-06-18T10:00:02.000Z" });
          return [recovered, leased] as const;
        }),
    );

    expect(recovered).toBe(1);
    expect(leased).toHaveLength(1);
    expect(leased[0]?.leasedBy).toBe("worker-b");
  });

  test("ack and fail remove jobs from active pending/leased counts", async () => {
    const path = sqlitePath();
    const stats = await withQueue(
      path,
      (queue) =>
        Effect.gen(function* () {
          const completed = yield* queue.enqueue({ kind: "index", payload: { sessionId: "done" } });
          const failed = yield* queue.enqueue({ kind: "index", payload: { sessionId: "bad" } });
          yield* queue.ack(completed.jobId, "2099-06-18T10:00:00.000Z");
          yield* queue.fail(failed.jobId, "bad payload", "2099-06-18T10:00:00.000Z");
          return yield* queue.stats;
        }),
    );

    expect(stats).toEqual({ pending: 0, leased: 0, failed: 1 });
  });

  test("pruneCompleted deletes only old completed jobs, never active or recent ones", async () => {
    const path = sqlitePath();
    const [pruned, stats] = await withQueue(
      path,
      (queue) =>
        Effect.gen(function* () {
          const a = yield* queue.enqueue({ kind: "embed-message", payload: { id: "a" } }); // -> completed (old)
          yield* queue.enqueue({ kind: "embed-message", payload: { id: "b" } });            // -> stays pending
          yield* queue.enqueue({ kind: "index-session", payload: { id: "c" } });            // -> leased
          const d = yield* queue.enqueue({ kind: "index-session", payload: { id: "d" } });  // -> failed
          const e = yield* queue.enqueue({ kind: "embed-message", payload: { id: "e" } });  // -> completed (recent)
          yield* queue.ack(a.jobId, "2099-06-18T10:00:00.000Z");
          yield* queue.leaseBatch({ workerId: "w", kind: "index-session", limit: 1, leaseMs: 600_000, now: "2099-06-18T10:00:00.000Z" });
          yield* queue.fail(d.jobId, "boom", "2099-06-18T10:00:00.000Z");
          yield* queue.ack(e.jobId, "2099-06-18T10:00:30.000Z");
          const pruned = yield* queue.pruneCompleted("2099-06-18T10:00:10.000Z");
          const stats = yield* queue.stats;
          return [pruned, stats] as const;
        }),
    );

    // Only the OLD completed job (a) is pruned; the recent completed (e, updated_at after the
    // cutoff) survives, and every ACTIVE job is untouched.
    expect(pruned).toBe(1);
    expect(stats).toEqual({ pending: 1, leased: 1, failed: 1 });
  });
});
