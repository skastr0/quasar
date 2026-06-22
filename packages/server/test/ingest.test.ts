import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "bun:test";
import { Effect, Layer } from "effect";

import { enqueueDownstreamJobs } from "../src/ingest";
import type { MappedSession } from "../src/model";
import { DurableQueue, makeDurableQueueLayer } from "../src/services";
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
    messageCount: 2,
    toolCallCount: 0,
  },
  messages: [
    { sessionId: "session-a", seq: 1, role: "user", text: "identical", projectKey: "project-a", contentHash: "dup-hash" },
    { sessionId: "session-a", seq: 2, role: "user", text: "identical", projectKey: "project-a", contentHash: "dup-hash" },
  ],
  toolCalls: [],
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
        yield* enqueueDownstreamJobs(queue, duplicateContentSession());
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
        yield* enqueueDownstreamJobs(queue, duplicateContentSession());
        yield* enqueueDownstreamJobs(queue, duplicateContentSession());
        return yield* leaseEmbedJobs(queue);
      }),
    );

    expect(jobs.length).toBe(2);
  });
});
