import { Database } from "bun:sqlite";
import { Context, Effect, Layer, Schema } from "effect";

import { makeEmbeddingProfile, type EmbeddingProfile } from "./embeddingProfiles";
import type { QueueJobRow } from "./model";
import { ensureParentDir, sqlitePath } from "./paths";

export class DurableQueueError extends Schema.TaggedError<DurableQueueError>()(
  "DurableQueueError",
  {
    operation: Schema.String,
    message: Schema.String,
    cause: Schema.optional(Schema.Unknown),
  },
) {}

export interface QueueStats {
  readonly pending: number;
  readonly leased: number;
  readonly failed: number;
}

export interface QueueKindStats extends QueueStats {
  readonly kind: string;
}

/** Per-class breakdown of a pruneResolvedFailures run. `remainingFailed` is the
 * failed-job count still in the queue after the prune — genuinely undone work
 * that must not be hidden. */
export interface PruneFailedReport {
  readonly resolvedEmbedMessage: number;
  readonly orphanedEmbedMessage: number;
  readonly retiredKind: number;
  readonly deleted: number;
  readonly remainingFailed: number;
}

/** The kinds the current server actively enqueues. A failed job of any other
 * kind is a fossil from a removed feature and is safe to prune. */
const LIVE_QUEUE_KINDS = ["embed-message"] as const;

export interface DurableQueueService {
  /** Enqueue idempotently. An explicit enqueue of a terminal job key creates
   * fresh pending work atomically: completed and failed rows are replaced,
   * while pending and leased rows remain untouched. */
  readonly enqueue: (job: {
    readonly kind: string;
    readonly payload: unknown;
    readonly idempotencyKey?: string;
    readonly nextRunAt?: string;
    readonly maxAttempts?: number;
  }) => Effect.Effect<QueueJobRow, DurableQueueError>;
  readonly leaseBatch: (options: {
    readonly workerId: string;
    readonly kind?: string;
    readonly limit: number;
    readonly leaseMs: number;
    readonly now?: string;
  }) => Effect.Effect<readonly QueueJobRow[], DurableQueueError>;
  readonly ack: (jobId: string, now?: string) => Effect.Effect<void, DurableQueueError>;
  readonly retry: (jobId: string, options: { readonly error: string; readonly delayMs: number; readonly now?: string }) => Effect.Effect<void, DurableQueueError>;
  readonly fail: (jobId: string, error: string, now?: string) => Effect.Effect<void, DurableQueueError>;
  readonly recoverStaleLeases: (now?: string) => Effect.Effect<number, DurableQueueError>;
  /**
   * Delete completed jobs whose updated_at is at or before olderThanIso; returns rows
   * deleted. Touches ONLY status='completed' rows — never pending/leased/failed — so an
   * in-flight job can never be pruned. Completed jobs are not load-bearing: enqueue
   * dedup deletes-then-reinserts by idempotency_key, and pending dedup uses the UNIQUE
   * constraint, so removing old completed rows cannot resurrect or duplicate work.
   */
  readonly pruneCompleted: (olderThanIso: string) => Effect.Effect<number, DurableQueueError>;
  /**
   * Delete `failed` jobs whose work is provably done, moot, or retired — never a
   * job that still represents undone work. Three safe classes (the queue and
   * store share one SQLite file, so completion is checked by direct join):
   *   - embed-message whose target (sessionId, seq) now HAS a message_vectors
   *     row: the vector was produced by another path (cache replay / materialize)
   *     after the job exhausted retries → the tombstone is inert.
   *   - embed-message whose target message no longer EXISTS: orphaned by a
   *     re-key or delete → nothing left to embed.
   *   - jobs of a retired kind the current server never enqueues (e.g.
   *     index-session, removed with LanceDB): a fossil job type.
   * An embed-message failure whose message exists but still lacks a vector is
   * LEFT untouched and stays visible — genuinely undone work is never hidden.
   * Returns a per-class breakdown plus the failed count that remains.
   */
  readonly pruneResolvedFailures: () => Effect.Effect<PruneFailedReport, DurableQueueError>;
  readonly stats: Effect.Effect<QueueStats, DurableQueueError>;
  readonly statsByKind: Effect.Effect<readonly QueueKindStats[], DurableQueueError>;
  readonly embedMessageStatsByProfile: (profile: string) => Effect.Effect<QueueKindStats, DurableQueueError>;
}

/** Which embedder currently serves query-side embedText (D8b): the local
 * fp32 ONNX pipeline once its eager background load finishes, else the
 * bounded synthetic path. */
export interface QueryEmbedderStatus {
  readonly provider: "local" | "synthetic";
  readonly active: "local" | "synthetic";
  readonly loadedAt?: string;
  readonly loadMs?: number;
  readonly loadFailure?: string;
}

export interface EmbeddingServiceStatus {
  readonly cached: number;
  readonly pending: number;
  readonly profile: EmbeddingProfile;
  readonly queryEmbedder: QueryEmbedderStatus;
}

export interface EmbeddingReadinessStatus {
  readonly ok: boolean;
  readonly checkedAt: string;
  readonly reason?: string;
}

export interface EmbeddingCacheRow {
  readonly model: string;
  readonly contentHash: string;
  readonly dimensions: number;
  readonly textBytes: number;
  readonly vector: readonly number[];
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface EmbeddingWorkerReport {
  readonly leased: number;
  readonly cacheHits: number;
  readonly cacheMisses: number;
  readonly embedded: number;
  readonly skipped: number;
  readonly retried: number;
  readonly failed: number;
  readonly sqliteVectorsUpserted: number;
}

export interface EmbeddingCacheReplayReport {
  readonly scanned: number;
  readonly cacheHits: number;
  readonly missingCache: number;
  readonly sqliteVectorsUpserted: number;
}

export interface EmbeddingSqliteMaterializationReport {
  readonly scanned: number;
  readonly cacheHits: number;
  readonly cacheMisses: number;
  readonly embedded: number;
  readonly skipped: number;
  readonly sqliteVectorsUpserted: number;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly elapsedMs: number;
}

export interface EmbeddingService {
  readonly model: string;
  readonly profile: EmbeddingProfile;
  readonly embedText: (text: string) => Effect.Effect<readonly number[], unknown>;
  readonly getCached: (contentHash: string) => Effect.Effect<EmbeddingCacheRow | undefined, unknown>;
  readonly putCached: (row: {
    readonly contentHash: string;
    readonly text: string;
    readonly vector: readonly number[];
    readonly now?: string;
  }) => Effect.Effect<EmbeddingCacheRow, unknown>;
  readonly processBatch: (options: {
    readonly workerId: string;
    readonly limit: number;
    readonly leaseMs: number;
    readonly now?: string;
  }) => Effect.Effect<EmbeddingWorkerReport, unknown>;
  readonly materializeCachedVectors: (options?: {
    readonly limit?: number;
    readonly now?: string;
  }) => Effect.Effect<EmbeddingCacheReplayReport, unknown>;
  readonly materializeMissingVectorsToSqlite: (options?: {
    readonly limit?: number;
    readonly now?: string;
  }) => Effect.Effect<EmbeddingSqliteMaterializationReport, unknown>;
  readonly status: Effect.Effect<EmbeddingServiceStatus, unknown>;
  readonly readiness: Effect.Effect<EmbeddingReadinessStatus, unknown>;
}

export interface IngestServiceStatus {
  readonly activeRuns: number;
}

export interface IngestService {
  readonly status: Effect.Effect<IngestServiceStatus>;
}

export interface WorkerSupervisorStatus {
  readonly enabled: boolean;
  readonly workers: readonly string[];
  readonly lastReports: Record<string, unknown>;
  readonly lastErrors: Record<string, string>;
}

export interface WorkerSupervisorService {
  readonly status: Effect.Effect<WorkerSupervisorStatus>;
  readonly tickOnce: Effect.Effect<WorkerSupervisorStatus, unknown>;
}

export class DurableQueue extends Context.Tag("@quasar/DurableQueue")<
  DurableQueue,
  DurableQueueService
>() {}

export class Embeddings extends Context.Tag("@quasar/Embeddings")<
  Embeddings,
  EmbeddingService
>() {}

export class IngestCoordinator extends Context.Tag("@quasar/IngestCoordinator")<
  IngestCoordinator,
  IngestService
>() {}

export class WorkerSupervisor extends Context.Tag("@quasar/WorkerSupervisor")<
  WorkerSupervisor,
  WorkerSupervisorService
>() {}

const nowIso = () => new Date().toISOString();

const addMs = (iso: string, ms: number) => new Date(new Date(iso).getTime() + ms).toISOString();

const queueMigrate = (db: Database): void => {
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
    CREATE TABLE IF NOT EXISTS queue_jobs (
      job_id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      status TEXT NOT NULL,
      attempts INTEGER NOT NULL,
      max_attempts INTEGER NOT NULL,
      leased_by TEXT,
      lease_until TEXT,
      next_run_at TEXT NOT NULL,
      last_error TEXT,
      idempotency_key TEXT UNIQUE,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS queue_jobs_ready ON queue_jobs(status, next_run_at, created_at);
    CREATE INDEX IF NOT EXISTS queue_jobs_stale_leases ON queue_jobs(status, lease_until);
    CREATE INDEX IF NOT EXISTS queue_jobs_kind_status ON queue_jobs(kind, status, next_run_at);
    CREATE INDEX IF NOT EXISTS queue_jobs_embed_profile_status ON queue_jobs(kind, status, json_extract(payload_json, '$.embeddingProfile'));
  `);
};

const queueTry = <A>(operation: string, run: () => A): Effect.Effect<A, DurableQueueError> =>
  Effect.try({
    try: run,
    catch: (cause) =>
      new DurableQueueError({
        operation,
        message: cause instanceof Error ? cause.message : String(cause),
        cause,
      }),
  });

const rowToJob = (row: Record<string, unknown>): QueueJobRow => ({
  jobId: row.jobId as string,
  kind: row.kind as string,
  payload: JSON.parse(row.payloadJson as string) as unknown,
  status: row.status as QueueJobRow["status"],
  attempts: row.attempts as number,
  maxAttempts: row.maxAttempts as number,
  leasedBy: (row.leasedBy as string | null) ?? undefined,
  leaseUntil: (row.leaseUntil as string | null) ?? undefined,
  nextRunAt: row.nextRunAt as string,
  lastError: (row.lastError as string | null) ?? undefined,
  idempotencyKey: (row.idempotencyKey as string | null) ?? undefined,
  createdAt: row.createdAt as string,
  updatedAt: row.updatedAt as string,
});

const selectQueueJob =
  "SELECT job_id AS jobId, kind, payload_json AS payloadJson, status, attempts, max_attempts AS maxAttempts, leased_by AS leasedBy, lease_until AS leaseUntil, next_run_at AS nextRunAt, last_error AS lastError, idempotency_key AS idempotencyKey, created_at AS createdAt, updated_at AS updatedAt FROM queue_jobs";

export const makeDurableQueueLayer = (path = sqlitePath()): Layer.Layer<DurableQueue> =>
  Layer.scoped(
    DurableQueue,
    Effect.acquireRelease(
      Effect.sync(() => {
        ensureParentDir(path);
        const db = new Database(path, { create: true });
        queueMigrate(db);
        return db;
      }),
      (db) => Effect.sync(() => db.close()),
    ).pipe(
      Effect.map((db) => {
        const insertJob = db.prepare(
          `INSERT INTO queue_jobs(job_id, kind, payload_json, status, attempts, max_attempts, leased_by, lease_until, next_run_at, last_error, idempotency_key, created_at, updated_at)
           VALUES ($jobId, $kind, $payloadJson, 'pending', 0, $maxAttempts, NULL, NULL, $nextRunAt, NULL, $idempotencyKey, $createdAt, $updatedAt)
           ON CONFLICT(idempotency_key) DO NOTHING`,
        );
        const selectJobById = db.prepare(`${selectQueueJob} WHERE job_id = ?`);
        const selectJobByIdempotencyKey = db.prepare(`${selectQueueJob} WHERE idempotency_key = ?`);
        const selectReadyJobs = db.prepare(`${selectQueueJob} WHERE status = 'pending' AND next_run_at <= ? ORDER BY next_run_at ASC, created_at ASC LIMIT ?`);
        const selectReadyJobsByKind = db.prepare(`${selectQueueJob} WHERE status = 'pending' AND next_run_at <= ? AND kind = ? ORDER BY next_run_at ASC, created_at ASC LIMIT ?`);
        const queueStatsByStatus = db.prepare("SELECT status, COUNT(*) AS count FROM queue_jobs WHERE status IN ('pending', 'leased', 'failed') GROUP BY status");
        const queueStatsByKind = db.prepare("SELECT kind, status, COUNT(*) AS count FROM queue_jobs WHERE status IN ('pending', 'leased', 'failed') GROUP BY kind, status ORDER BY kind ASC");
        const leaseReady = db.transaction((options: { readonly workerId: string; readonly kind?: string; readonly limit: number; readonly leaseUntil: string; readonly now: string }) => {
          const ready = (options.kind === undefined
            ? selectReadyJobs.all(options.now, options.limit)
            : selectReadyJobsByKind.all(options.now, options.kind, options.limit)) as Record<string, unknown>[];
          const update = db.prepare("UPDATE queue_jobs SET status = 'leased', attempts = attempts + 1, leased_by = ?, lease_until = ?, updated_at = ? WHERE job_id = ? AND status = 'pending'");
          const leased: QueueJobRow[] = [];
          for (const row of ready) {
            const result = update.run(options.workerId, options.leaseUntil, options.now, row.jobId as string);
            if (result.changes > 0) {
              const leasedRow = selectJobById.get(row.jobId as string) as Record<string, unknown>;
              leased.push(rowToJob(leasedRow));
            }
          }
          return leased;
        });
        const activeEmbedMessageStats = db.prepare(
          `SELECT status, COUNT(*) AS count
           FROM queue_jobs
           WHERE kind = 'embed-message'
             AND status IN ('pending', 'leased', 'failed')
             AND json_extract(payload_json, '$.embeddingProfile') = ?
           GROUP BY status`,
        );
        const enqueueJob = db.transaction((job: {
          readonly kind: string;
          readonly payloadJson: string;
          readonly idempotencyKey: string | null;
          readonly maxAttempts: number;
          readonly nextRunAt: string;
          readonly at: string;
        }) => {
          const jobId = crypto.randomUUID();
          if (job.idempotencyKey !== null) {
            db.prepare(
              "DELETE FROM queue_jobs WHERE idempotency_key = ? AND status IN ('completed', 'failed')",
            ).run(job.idempotencyKey);
          }
          insertJob.run({
            $jobId: jobId,
            $kind: job.kind,
            $payloadJson: job.payloadJson,
            $maxAttempts: job.maxAttempts,
            $nextRunAt: job.nextRunAt,
            $idempotencyKey: job.idempotencyKey,
            $createdAt: job.at,
            $updatedAt: job.at,
          });
          const row = job.idempotencyKey === null
            ? selectJobById.get(jobId)
            : selectJobByIdempotencyKey.get(job.idempotencyKey);
          return rowToJob(row as Record<string, unknown>);
        });

        return DurableQueue.of({
          enqueue: (job) =>
            queueTry("enqueue", () => {
              const at = nowIso();
              return enqueueJob({
                kind: job.kind,
                payloadJson: JSON.stringify(job.payload),
                idempotencyKey: job.idempotencyKey ?? null,
                maxAttempts: job.maxAttempts ?? 5,
                nextRunAt: job.nextRunAt ?? at,
                at,
              });
            }),
          leaseBatch: ({ workerId, kind, limit, leaseMs, now = nowIso() }) =>
            queueTry("leaseBatch", () => leaseReady({ workerId, kind, limit, leaseUntil: addMs(now, leaseMs), now })),
          ack: (jobId, now = nowIso()) =>
            queueTry("ack", () => {
              db.prepare("UPDATE queue_jobs SET status = 'completed', leased_by = NULL, lease_until = NULL, updated_at = ? WHERE job_id = ?").run(now, jobId);
            }),
          retry: (jobId, options) =>
            queueTry("retry", () => {
              const now = options.now ?? nowIso();
              db.prepare("UPDATE queue_jobs SET status = 'pending', leased_by = NULL, lease_until = NULL, next_run_at = ?, last_error = ?, updated_at = ? WHERE job_id = ?")
                .run(addMs(now, options.delayMs), options.error, now, jobId);
            }),
          fail: (jobId, error, now = nowIso()) =>
            queueTry("fail", () => {
              db.prepare("UPDATE queue_jobs SET status = 'failed', leased_by = NULL, lease_until = NULL, last_error = ?, updated_at = ? WHERE job_id = ?").run(error, now, jobId);
            }),
          recoverStaleLeases: (now = nowIso()) =>
            queueTry("recoverStaleLeases", () => {
              const result = db.prepare("UPDATE queue_jobs SET status = 'pending', leased_by = NULL, lease_until = NULL, updated_at = ? WHERE status = 'leased' AND lease_until <= ?").run(now, now);
              return result.changes;
            }),
          pruneCompleted: (olderThanIso) =>
            queueTry("pruneCompleted", () => {
              const result = db.prepare("DELETE FROM queue_jobs WHERE status = 'completed' AND updated_at <= ?").run(olderThanIso);
              return result.changes;
            }),
          pruneResolvedFailures: () =>
            queueTry("pruneResolvedFailures", () => {
              const livePlaceholders = LIVE_QUEUE_KINDS.map(() => "?").join(", ");
              // Count each safe class before deleting, so the report attributes
              // exactly why each row went. The three predicates are mutually
              // exclusive (retired-kind rows are not embed-message).
              const resolvedEmbedMessage = (db.prepare(
                `SELECT COUNT(*) AS c FROM queue_jobs
                 WHERE status = 'failed' AND kind = 'embed-message'
                   AND EXISTS (SELECT 1 FROM message_vectors v
                     WHERE v.session_id = json_extract(queue_jobs.payload_json, '$.sessionId')
                       AND v.seq = json_extract(queue_jobs.payload_json, '$.seq'))`,
              ).get() as { c: number }).c;
              const orphanedEmbedMessage = (db.prepare(
                `SELECT COUNT(*) AS c FROM queue_jobs
                 WHERE status = 'failed' AND kind = 'embed-message'
                   AND NOT EXISTS (SELECT 1 FROM message_vectors v
                     WHERE v.session_id = json_extract(queue_jobs.payload_json, '$.sessionId')
                       AND v.seq = json_extract(queue_jobs.payload_json, '$.seq'))
                   AND NOT EXISTS (SELECT 1 FROM messages m
                     WHERE m.session_id = json_extract(queue_jobs.payload_json, '$.sessionId')
                       AND m.seq = json_extract(queue_jobs.payload_json, '$.seq'))`,
              ).get() as { c: number }).c;
              const retiredKind = (db.prepare(
                `SELECT COUNT(*) AS c FROM queue_jobs
                 WHERE status = 'failed' AND kind NOT IN (${livePlaceholders})`,
              ).get(...LIVE_QUEUE_KINDS) as { c: number }).c;
              const prune = db.transaction(() => {
                db.prepare(
                  `DELETE FROM queue_jobs
                   WHERE status = 'failed' AND kind = 'embed-message'
                     AND EXISTS (SELECT 1 FROM message_vectors v
                       WHERE v.session_id = json_extract(queue_jobs.payload_json, '$.sessionId')
                         AND v.seq = json_extract(queue_jobs.payload_json, '$.seq'))`,
                ).run();
                db.prepare(
                  `DELETE FROM queue_jobs
                   WHERE status = 'failed' AND kind = 'embed-message'
                     AND NOT EXISTS (SELECT 1 FROM message_vectors v
                       WHERE v.session_id = json_extract(queue_jobs.payload_json, '$.sessionId')
                         AND v.seq = json_extract(queue_jobs.payload_json, '$.seq'))
                     AND NOT EXISTS (SELECT 1 FROM messages m
                       WHERE m.session_id = json_extract(queue_jobs.payload_json, '$.sessionId')
                         AND m.seq = json_extract(queue_jobs.payload_json, '$.seq'))`,
                ).run();
                db.prepare(
                  `DELETE FROM queue_jobs WHERE status = 'failed' AND kind NOT IN (${livePlaceholders})`,
                ).run(...LIVE_QUEUE_KINDS);
              });
              prune();
              const remainingFailed = (db.prepare(
                "SELECT COUNT(*) AS c FROM queue_jobs WHERE status = 'failed'",
              ).get() as { c: number }).c;
              return {
                resolvedEmbedMessage,
                orphanedEmbedMessage,
                retiredKind,
                deleted: resolvedEmbedMessage + orphanedEmbedMessage + retiredKind,
                remainingFailed,
              };
            }),
          stats: queueTry("stats", () => {
            const byStatus = queueStatsByStatus.all() as Array<{ status: string; count: number }>;
            const countFor = (status: string) => byStatus.find((row) => row.status === status)?.count ?? 0;
            return { pending: countFor("pending"), leased: countFor("leased"), failed: countFor("failed") };
          }),
          statsByKind: queueTry("statsByKind", () => {
            const rows = queueStatsByKind.all() as Array<{ kind: string; status: string; count: number }>;
            const byKind = new Map<string, { pending: number; leased: number; failed: number }>();
            for (const row of rows) {
              const stats = byKind.get(row.kind) ?? { pending: 0, leased: 0, failed: 0 };
              if (row.status === "pending" || row.status === "leased" || row.status === "failed") {
                stats[row.status] = row.count;
              }
              byKind.set(row.kind, stats);
            }
            return [...byKind.entries()].map(([kind, stats]) => ({ kind, ...stats }));
          }),
          embedMessageStatsByProfile: (profile) =>
            queueTry("embedMessageStatsByProfile", () => {
              const rows = activeEmbedMessageStats.all(profile) as Array<{ status: string; count: number }>;
              const countFor = (status: string) => rows.find((row) => row.status === status)?.count ?? 0;
              return {
                kind: "embed-message",
                pending: countFor("pending"),
                leased: countFor("leased"),
                failed: countFor("failed"),
              };
            }),
        });
      }),
    ),
  );

export const DurableQueueLive = makeDurableQueueLayer();

export const EmbeddingsLive = Layer.succeed(
  Embeddings,
  (() => {
    const profile = makeEmbeddingProfile({
      model: "unconfigured",
      dimensions: 768,
      task: "search_document",
      cacheNamespace: "unconfigured",
    });
    return Embeddings.of({
      model: profile.model,
      profile,
      embedText: () => Effect.fail(new Error("EmbeddingsLive is not configured")),
      getCached: () => Effect.succeed(undefined),
      putCached: () => Effect.fail(new Error("EmbeddingsLive is not configured")),
      processBatch: () => Effect.fail(new Error("EmbeddingsLive is not configured")),
      materializeCachedVectors: () => Effect.fail(new Error("EmbeddingsLive is not configured")),
      materializeMissingVectorsToSqlite: () => Effect.fail(new Error("EmbeddingsLive is not configured")),
      status: Effect.succeed({
        cached: 0,
        pending: 0,
        profile,
        queryEmbedder: { provider: "synthetic" as const, active: "synthetic" as const },
      }),
      readiness: Effect.succeed({ ok: false, checkedAt: nowIso(), reason: "EmbeddingsLive is not configured" }),
    });
  })(),
);

export const IngestCoordinatorLive = Layer.succeed(
  IngestCoordinator,
  IngestCoordinator.of({ status: Effect.succeed({ activeRuns: 0 }) }),
);
