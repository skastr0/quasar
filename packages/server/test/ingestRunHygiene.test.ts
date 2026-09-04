import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { Effect, Layer } from "effect";

import { INGEST_RUN_REAPED_REASON, type IngestRunRow } from "../src/model";
import { IngestCoordinator, IngestCoordinatorLive, runIngestRunHygiene } from "../src/services";
import { LocalStore, makeLocalStoreLayer, type LocalStoreService } from "../src/store";

const tempDirs: string[] = [];

const sqlitePath = () => {
  const dir = mkdtempSync(join(tmpdir(), "quasar-ingest-run-hygiene-"));
  tempDirs.push(dir);
  return join(dir, "quasar.sqlite");
};

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

const NOW = "2026-08-18T12:00:00.000Z";
const HOUR_MS = 60 * 60 * 1_000;
const DAY_MS = 24 * HOUR_MS;

const ago = (ms: number) => new Date(Date.parse(NOW) - ms).toISOString();

const run = (overrides: Partial<IngestRunRow> & { readonly runId: string }): IngestRunRow => ({
  provider: "codex",
  status: "running",
  startedAt: ago(HOUR_MS),
  sessionsSeen: 0,
  sessionsWritten: 0,
  sessionsSkipped: 0,
  sessionsFailed: 0,
  ...overrides,
});

const withStore = <A>(
  path: string,
  body: (store: LocalStoreService) => Effect.Effect<A, unknown, never>,
) =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const store = yield* LocalStore;
        return yield* body(store);
      }).pipe(Effect.provide(makeLocalStoreLayer(path))),
    ),
  );

describe("ingest run ledger hygiene", () => {
  test("reaps only running rows whose own liveness evidence went stale, and names the reason", async () => {
    const path = sqlitePath();
    const report = await withStore(path, (store) =>
      Effect.gen(function* () {
        // Orphan: last wrote 8h ago and still claims to be running.
        yield* store.recordIngestRun(run({
          runId: "run-orphaned",
          startedAt: ago(9 * HOUR_MS),
          updatedAt: ago(8 * HOUR_MS),
        }));
        // Genuinely live: started long ago but wrote a minute ago. Age of the
        // run is not evidence; age of its last write is.
        yield* store.recordIngestRun(run({
          runId: "run-live-long",
          startedAt: ago(9 * HOUR_MS),
          updatedAt: ago(60 * 1_000),
        }));
        // Just started.
        yield* store.recordIngestRun(run({
          runId: "run-fresh",
          startedAt: ago(1_000),
          updatedAt: ago(1_000),
        }));
        // Already terminal: never a reaper target.
        yield* store.recordIngestRun(run({
          runId: "run-done",
          status: "completed",
          startedAt: ago(9 * HOUR_MS),
          completedAt: ago(8 * HOUR_MS),
          updatedAt: ago(8 * HOUR_MS),
        }));

        const hygiene = yield* runIngestRunHygiene(store, {
          now: NOW,
          staleAfterMs: 6 * HOUR_MS,
          retentionMs: 30 * DAY_MS,
        });

        const rows = new Map(
          (yield* store.listIngestRuns({ limit: 50 })).map((row) => [row.runId, row] as const),
        );
        return { hygiene, rows };
      }),
    );

    expect(report.hygiene.reaped).toEqual(["run-orphaned"]);
    expect(report.hygiene.pruned).toBe(0);

    const orphaned = report.rows.get("run-orphaned");
    expect(orphaned?.status).toBe("failed");
    expect(orphaned?.reason).toBe(INGEST_RUN_REAPED_REASON);
    expect(orphaned?.completedAt).toBe(NOW);

    // Untouched: still running, still without a server-authored reason.
    for (const runId of ["run-live-long", "run-fresh"]) {
      expect(report.rows.get(runId)?.status).toBe("running");
      expect(report.rows.get(runId)?.reason ?? null).toBeNull();
    }
    expect(report.rows.get("run-done")?.status).toBe("completed");
    expect(report.rows.get("run-done")?.reason ?? null).toBeNull();
  });

  test("rows predating the updated_at column fall back to their start instant instead of being unreapable", async () => {
    const path = sqlitePath();
    const reaped = await withStore(path, (store) =>
      Effect.gen(function* () {
        // Simulate a row migrated from before updated_at existed. The normal
        // write API always stamps updated_at, so clear it through raw SQLite.
        yield* store.recordIngestRun({
          runId: "run-legacy",
          provider: "codex",
          status: "running",
          startedAt: ago(9 * HOUR_MS),
          sessionsSeen: 0,
          sessionsWritten: 0,
          sessionsSkipped: 0,
          sessionsFailed: 0,
        });
        const db = new Database(path);
        try {
          db.exec("UPDATE ingest_runs SET updated_at = NULL WHERE run_id = 'run-legacy'");
          expect(db.query("SELECT updated_at FROM ingest_runs WHERE run_id = 'run-legacy'").get())
            .toEqual({ updated_at: null });
        } finally {
          db.close();
        }
        return yield* store.reapStaleIngestRuns({ staleBefore: ago(6 * HOUR_MS), now: NOW });
      }),
    );
    expect(reaped).toEqual(["run-legacy"]);
  });

  test("retention prunes terminal rows past the window and never prunes a running one", async () => {
    const path = sqlitePath();
    const report = await withStore(path, (store) =>
      Effect.gen(function* () {
        yield* store.recordIngestRun(run({
          runId: "run-ancient",
          status: "completed",
          startedAt: ago(90 * DAY_MS),
          completedAt: ago(90 * DAY_MS),
          updatedAt: ago(90 * DAY_MS),
        }));
        yield* store.recordIngestRun(run({
          runId: "run-ancient-failed",
          status: "failed",
          startedAt: ago(45 * DAY_MS),
          completedAt: ago(45 * DAY_MS),
          updatedAt: ago(45 * DAY_MS),
        }));
        yield* store.recordIngestRun(run({
          runId: "run-recent",
          status: "completed",
          startedAt: ago(2 * DAY_MS),
          completedAt: ago(2 * DAY_MS),
          updatedAt: ago(2 * DAY_MS),
        }));
        // Ancient but still running: the prune must leave it to the reaper so
        // the orphan is recorded, not silently deleted.
        yield* store.recordIngestRun(run({
          runId: "run-ancient-running",
          startedAt: ago(90 * DAY_MS),
          updatedAt: ago(90 * DAY_MS),
        }));

        const pruned = yield* store.pruneIngestRuns({ before: ago(30 * DAY_MS) });
        const remaining = (yield* store.listIngestRuns({ limit: 50 })).map((row) => row.runId).sort();
        const total = yield* store.countIngestRuns();
        return { pruned, remaining, total };
      }),
    );

    expect(report.pruned).toBe(2);
    expect(report.remaining).toEqual(["run-ancient-running", "run-recent"]);
    expect(report.total).toBe(2);
  });

  test("hygiene reaps before it prunes, so an orphan is recorded rather than deleted", async () => {
    const path = sqlitePath();
    const report = await withStore(path, (store) =>
      Effect.gen(function* () {
        yield* store.recordIngestRun(run({
          runId: "run-ancient-orphan",
          startedAt: ago(90 * DAY_MS),
          updatedAt: ago(90 * DAY_MS),
        }));
        const hygiene = yield* runIngestRunHygiene(store, {
          now: NOW,
          staleAfterMs: 6 * HOUR_MS,
          retentionMs: 30 * DAY_MS,
        });
        const row = yield* store.getIngestRun("run-ancient-orphan");
        return { hygiene, row };
      }),
    );

    expect(report.hygiene.reaped).toEqual(["run-ancient-orphan"]);
    expect(report.hygiene.pruned).toBe(0);
    expect(report.row?.status).toBe("failed");
    expect(report.row?.reason).toBe(INGEST_RUN_REAPED_REASON);
  });

  test("a client write after a reap clears the server-authored reason", async () => {
    const path = sqlitePath();
    const row = await withStore(path, (store) =>
      Effect.gen(function* () {
        yield* store.recordIngestRun(run({ runId: "run-resumed", updatedAt: ago(8 * HOUR_MS) }));
        yield* store.reapStaleIngestRuns({ staleBefore: ago(6 * HOUR_MS), now: NOW });
        yield* store.recordIngestRun(run({
          runId: "run-resumed",
          status: "completed",
          completedAt: NOW,
          sessionsSeen: 3,
          sessionsWritten: 3,
        }));
        return yield* store.getIngestRun("run-resumed");
      }),
    );
    expect(row?.status).toBe("completed");
    expect(row?.reason ?? null).toBeNull();
    expect(row?.sessionsWritten).toBe(3);
  });

  test("the coordinator runs hygiene at startup, so a killed process stops inflating activeRuns", async () => {
    const path = sqlitePath();
    const staleEnv = process.env.QUASAR_INGEST_RUN_STALE_MS;
    process.env.QUASAR_INGEST_RUN_STALE_MS = String(6 * HOUR_MS);
    try {
      await withStore(path, (store) =>
        Effect.gen(function* () {
          yield* store.recordIngestRun(run({
            runId: "run-killed-process",
            startedAt: new Date(Date.now() - 8 * HOUR_MS).toISOString(),
            updatedAt: new Date(Date.now() - 8 * HOUR_MS).toISOString(),
          }));
          yield* store.recordIngestRun(run({
            runId: "run-in-flight",
            startedAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          }));
          expect(yield* store.countIngestRuns("running")).toBe(2);
        }),
      );

      const status = await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const coordinator = yield* IngestCoordinator;
            return yield* coordinator.status;
          }).pipe(
            Effect.provide(IngestCoordinatorLive.pipe(Layer.provideMerge(makeLocalStoreLayer(path)))),
          ),
        ),
      );
      expect(status.activeRuns).toBe(1);

      const reaped = await withStore(path, (store) => store.getIngestRun("run-killed-process"));
      expect(reaped?.status).toBe("failed");
      expect(reaped?.reason).toBe(INGEST_RUN_REAPED_REASON);
    } finally {
      if (staleEnv === undefined) delete process.env.QUASAR_INGEST_RUN_STALE_MS;
      else process.env.QUASAR_INGEST_RUN_STALE_MS = staleEnv;
    }
  });
});
