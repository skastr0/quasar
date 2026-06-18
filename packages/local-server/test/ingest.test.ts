import { adaptersByProvider, type NormalizedSession, type SessionAdapter } from "@skastr0/quasar-core";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "bun:test";
import { Effect, Layer } from "effect";

import { ingest } from "../src/ingest";
import { DurableQueue, makeDurableQueueLayer } from "../src/services";
import { LocalStore, makeLocalStoreLayer } from "../src/store";

const tempDirs: string[] = [];

const sqlitePath = () => {
  const dir = mkdtempSync(join(tmpdir(), "quasar-local-ingest-"));
  tempDirs.push(dir);
  return join(dir, "quasar.sqlite");
};

afterEach(() => {
  adaptersByProvider.delete("unknown");
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

const session = (id = "session-a"): NormalizedSession => ({
  id,
  nativeSessionId: id,
  provider: "unknown",
  agentName: "test-agent",
  machineId: "machine-a",
  projectIdentity: {
    projectIdentityKey: "project-a",
    displayName: "Project A",
    confidence: "explicit",
    rawPath: "/tmp/project-a",
    signals: [],
  },
  title: "Fixture session",
  startedAt: "2026-06-18T10:00:00.000Z",
  updatedAt: "2026-06-18T10:02:00.000Z",
  sourceRoot: "/history",
  sourcePath: `/history/${id}.jsonl`,
  events: [
    {
      id: `${id}:event-1`,
      sessionId: id,
      sequence: 0,
      timestamp: "2026-06-18T10:00:00.000Z",
      machineId: "machine-a",
      provider: "unknown",
      agentName: "test-agent",
      projectIdentityKey: "project-a",
      role: "user",
      kind: "message",
      contentText: "hello from user",
      contentBlocks: [],
      rawReference: { sourcePath: `/history/${id}.jsonl` },
    },
    {
      id: `${id}:event-2`,
      sessionId: id,
      sequence: 1,
      timestamp: "2026-06-18T10:01:00.000Z",
      machineId: "machine-a",
      provider: "unknown",
      agentName: "test-agent",
      projectIdentityKey: "project-a",
      role: "assistant",
      kind: "message",
      contentText: "hello from assistant",
      contentBlocks: [],
      rawReference: { sourcePath: `/history/${id}.jsonl` },
    },
  ],
  toolCalls: [
    {
      id: `${id}:tool-1`,
      sessionId: id,
      eventId: `${id}:event-tool`,
      machineId: "machine-a",
      provider: "unknown",
      agentName: "test-agent",
      projectIdentityKey: "project-a",
      toolName: "shell_command",
      status: "ok",
      input: { command: "echo ok" },
      output: "ok",
      startedAt: "2026-06-18T10:02:00.000Z",
      completedAt: "2026-06-18T10:02:01.000Z",
    },
  ],
  sessionEdges: [],
  usageRecords: [],
  artifacts: [],
});

const sessionWithLargeMessage = (): NormalizedSession => ({
  ...session("session-oversized"),
  events: [
    ...(session("session-oversized").events ?? []),
    {
      id: "session-oversized:event-3",
      sessionId: "session-oversized",
      sequence: 2,
      timestamp: "2026-06-18T10:03:00.000Z",
      machineId: "machine-a",
      provider: "unknown",
      agentName: "test-agent",
      projectIdentityKey: "project-a",
      role: "assistant",
      kind: "message",
      contentText: "large message evidence\n".repeat(3_000),
      contentBlocks: [],
      rawReference: { sourcePath: "/history/session-oversized.jsonl" },
    },
  ],
});

const adapterFor = (sessions: readonly NormalizedSession[]): SessionAdapter => ({
  id: "fixture-adapter",
  provider: "unknown",
  displayName: "Fixture Adapter",
  stable: true,
  defaultRoot: () => undefined,
  read: async () => ({ sourceRoots: [], sessions: [...sessions], diagnostics: [] }),
  stream: async function* () {
    for (const item of sessions) {
      yield { type: "session" as const, session: item, fingerprint: { tag: `fingerprint:${item.id}` } };
    }
  },
});

const withIngest = <A>(path: string, run: Effect.Effect<A, unknown, LocalStore | DurableQueue>) =>
  Effect.runPromise(run.pipe(Effect.provide(Layer.merge(makeLocalStoreLayer(path), makeDurableQueueLayer(path)))));

describe("ingest", () => {
  test("writes sessions to SQLite and enqueues downstream jobs", async () => {
    const path = sqlitePath();
    adaptersByProvider.set("unknown", adapterFor([session()]));

    const [reports, storeStats, queueStats, leased] = await withIngest(
      path,
      Effect.gen(function* () {
        const reports = yield* ingest({ provider: "unknown" });
        const store = yield* LocalStore;
        const queue = yield* DurableQueue;
        const storeStats = yield* store.stats;
        const queueStats = yield* queue.stats;
        const leased = yield* queue.leaseBatch({ workerId: "worker-a", limit: 10, leaseMs: 60_000, now: "2099-06-18T10:10:00.000Z" });
        return [reports, storeStats, queueStats, leased] as const;
      }),
    );

    expect(reports[0]?.sessionsWritten).toBe(1);
    expect(reports[0]?.sessionsFailed).toBe(0);
    expect(reports[0]?.outcomes[0]?.status).toBe("ok");
    expect(storeStats.sessions).toBe(1);
    expect(storeStats.messages).toBe(2);
    expect(storeStats.toolCalls).toBe(1);
    expect(queueStats.pending).toBe(3);
    expect(leased.map((job) => job.kind).sort()).toEqual(["embed-message", "embed-message", "index-session"]);
  });

  test("enqueues embeddings for all user and assistant messages", async () => {
    const path = sqlitePath();
    adaptersByProvider.set("unknown", adapterFor([sessionWithLargeMessage()]));

    const [reports, queueStats, leased] = await withIngest(
      path,
      Effect.gen(function* () {
        const reports = yield* ingest({ provider: "unknown" });
        const queue = yield* DurableQueue;
        const queueStats = yield* queue.stats;
        const leased = yield* queue.leaseBatch({ workerId: "worker-a", limit: 10, leaseMs: 60_000, now: "2099-06-18T10:10:00.000Z" });
        return [reports, queueStats, leased] as const;
      }),
    );

    expect(reports[0]?.searchDocuments).toMatchObject({ total: 3, semanticEligible: 3, ignored: 0 });
    expect(queueStats.pending).toBe(4);
    expect(leased.map((job) => job.kind).sort()).toEqual(["embed-message", "embed-message", "embed-message", "index-session"]);
  });

  test("skips unchanged sessions by source fingerprint", async () => {
    const path = sqlitePath();
    adaptersByProvider.set("unknown", adapterFor([session()]));

    const [first, second] = await withIngest(
      path,
      Effect.gen(function* () {
        const first = yield* ingest({ provider: "unknown" });
        const second = yield* ingest({ provider: "unknown" });
        return [first, second] as const;
      }),
    );

    expect(first[0]?.sessionsWritten).toBe(1);
    expect(second[0]?.sessionsSkipped).toBe(1);
    expect(second[0]?.outcomes[0]?.status).toBe("skipped");
    expect(second[0]?.outcomes[0]?.diagnostic).toBe("unchanged_source_fingerprint");
  });

  test("reports boundary diagnostics without writing failed sessions", async () => {
    const path = sqlitePath();
    adaptersByProvider.set("unknown", {
      ...adapterFor([]),
      stream: async function* () {
        yield { type: "session" as const, session: session("bad-session"), sourceUnit: { provider: "unknown", adapterId: "fixture-adapter", rootPath: "/missing", sourcePath: "/missing/bad.jsonl", physicalPath: "/definitely/missing/quasar.jsonl" } };
      },
    });

    const [reports, stats] = await withIngest(
      path,
      Effect.gen(function* () {
        const reports = yield* ingest({ provider: "unknown" });
        const store = yield* LocalStore;
        const stats = yield* store.stats;
        return [reports, stats] as const;
      }),
    );

    expect(reports[0]?.sessionsFailed).toBe(1);
    expect(reports[0]?.outcomes[0]?.status).toBe("failed");
    expect(reports[0]?.outcomes[0]?.diagnostic).toBe("source_fingerprint_failed");
    expect(stats.sessions).toBe(0);
    expect(stats.messages).toBe(0);
    expect(stats.toolCalls).toBe(0);
  });
});
