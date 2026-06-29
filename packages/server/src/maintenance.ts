import { DEFAULT_SEARCH_TABLE, LanceDb } from "./lancedb";
import { Context, Effect, Layer, Ref } from "effect";

import { embeddingProfileFromEnv, embeddingProfileSearchTable } from "./embeddingProfiles";
import { DerivedSearch } from "./search";
import { VECTOR_READY_FILTER } from "./searchPolicy";
import { DurableQueue } from "./services";
import { LocalStore } from "./store";
import { mergeDivergence, verifyIndexed } from "./verify";

// Index maintenance follows LanceDB's documented canonical path: build each index
// ONCE, then keep it fresh with incremental optimize() — which folds newly-appended
// rows into the LIVE FTS/scalar/vector indexes and prunes superseded versions WITHOUT
// dropping anything [docs.lancedb.com/indexing/reindexing]. The serving index is never
// torn down on a routine tick (the drop-then-rebuild that did so was the 22s outage).
// optimize() is O(delta) and throttled per-table; it runs only under maintain()'s
// writer-idle guard so it never races an in-flight upsert (LanceDB commit-conflict).
const MAINTAIN_INTERVAL_MS = 120_000;
// Version retention for optimize()'s prune/cleanup. optimize() runs every
// MAINTAIN_INTERVAL_MS (~2 min), so a wide window lets superseded version manifests +
// data fragments pile up between prunes (measured: a 7-day window let 265/327 versions
// accumulate and the volume regrow to 31GB). A 10-minute window bounds it to ~5 versions
// per table; LanceDB never removes the CURRENT version regardless of the window
// [@lancedb/lancedb table.d.ts: "The current version will never be removed"], and
// deleteUnverified stays false so in-flight upsert files are never touched. NOTE: this
// reclaims the VERSION/data side only — optimize does NOT GC the _indices generation
// dirs (lance#7207); that needs a separate, grounded GC (see [[lancedb-index-dir-gc]]).
const VERSION_RETENTION_MS = 10 * 60 * 1000;
// Bound the durable queue: prune COMPLETED jobs older than the retention window on the
// interval below. Only status='completed' rows are deleted (never pending/leased/failed),
// and completed rows are not load-bearing (enqueue dedup deletes-then-reinserts by
// idempotency_key) — measured 800,957 completed >24h of 805,166 total, 0 active.
const QUEUE_COMPLETED_RETENTION_MS = 24 * 60 * 60 * 1000;
const QUEUE_PRUNE_INTERVAL_MS = 60 * 60 * 1000;

export interface IndexRebuildReport {
  readonly tableName: string;
  readonly rebuilt: boolean;
  readonly reclaimed: number;
}

export interface MaintenanceReport {
  readonly rebuilt: readonly IndexRebuildReport[];
  readonly stats: unknown;
}

export interface FreshnessReport {
  readonly sessionsChecked: number;
  readonly freshSessions: number;
  readonly repairsEnqueued: number;
  readonly staleSessions: readonly string[];
}

export interface RepairReport {
  readonly leased: number;
  readonly repaired: number;
  readonly failed: number;
}

export interface SearchMaintenanceService {
  readonly maintain: () => Effect.Effect<MaintenanceReport, unknown>;
  readonly reconcileFreshness: (options?: {
    readonly limit?: number;
    readonly offset?: number;
    readonly now?: string;
  }) => Effect.Effect<FreshnessReport, unknown>;
  readonly repairOnce: (options: {
    readonly workerId: string;
    readonly limit: number;
    readonly leaseMs: number;
    readonly now?: string;
  }) => Effect.Effect<RepairReport, unknown>;
}

export class SearchMaintenance extends Context.Tag("@quasar/SearchMaintenance")<
  SearchMaintenance,
  SearchMaintenanceService
>() {}

const isIndexSessionPayload = (payload: unknown): payload is { readonly sessionId: string } =>
  typeof payload === "object" && payload !== null && typeof (payload as { sessionId?: unknown }).sessionId === "string";

export const SearchMaintenanceLive = Layer.effect(
  SearchMaintenance,
  Effect.gen(function* () {
    const store = yield* LocalStore;
    const queue = yield* DurableQueue;
    const search = yield* LanceDb;
    const derived = yield* DerivedSearch;
    const profileTable = embeddingProfileSearchTable(embeddingProfileFromEnv());
    const lastHeavyAt = yield* Ref.make(new Map<string, number>());
    const lastRefreshedRows = yield* Ref.make(new Map<string, number>());
    const lastQueuePruneAt = yield* Ref.make(0);

    // Per-table incremental maintenance. Two steps, both of which leave a present
    // serving index untouched:
    //   1. ensure (every tick, cheap when present): build any MISSING index and migrate
    //      a stale vector type — first build / self-heal. NEVER drops a present index.
    //   2. optimize (throttled, skip-if-unchanged): fold newly-appended rows into the
    //      live FTS/scalar/vector indexes and prune superseded versions (the sole GC).
    // Calling ensure every tick is the self-heal: an index absent for any reason heals
    // to present on the next maintained tick by BUILDING (not dropping), so a stale
    // throttle Ref (reset on restart) can never strand the table index-less.
    const maintainTable = (
      tableName: string,
      options: { readonly includeVector: boolean; readonly vectorRowsFilter?: string },
    ): Effect.Effect<IndexRebuildReport> =>
      Effect.gen(function* () {
        const rows = yield* search.countRows({ tableName }).pipe(Effect.catchAll(() => Effect.succeed(-1)));
        if (rows < 0) return { tableName, rebuilt: false, reclaimed: 0 }; // table not created yet
        // Self-heal: ensure every index exists every tick (cheap when present; builds a
        // MISSING index / migrates a stale vector type — NEVER drops a present index).
        yield* search
          .createMessageIndexes({ tableName, includeVector: options.includeVector, vectorRowsFilter: options.vectorRowsFilter })
          .pipe(
            Effect.catchAll((error) =>
              Effect.logError(
                `quasar.index.ensure_failed table=${tableName} :: ${error instanceof Error ? error.message : String(error)}`,
              ),
            ),
          );
        // optimize() is DISABLED (emergency, 2026-06-27). At this corpus size optimize()
        // REWRITES the full FTS/vector index (~16-20GB) on each run, and LanceDB never GCs
        // the superseded _indices generation dirs (lance#7207) — so it minted ~3GB/min of
        // orphaned index files and filled the host disk (search.lance 8GB -> 106GB in
        // ~30 min). `ensure` above builds each index ONCE; newly-appended rows are served
        // from the small flat-scanned unindexed delta until a SAFE _indices GC is shipped
        // and optimize is re-enabled together with it. Re-enabling optimize WITHOUT a
        // working _indices GC is exactly what caused the outage — do not.
        void MAINTAIN_INTERVAL_MS;
        void VERSION_RETENTION_MS;
        void lastHeavyAt;
        void lastRefreshedRows;
        return { tableName, rebuilt: false, reclaimed: 0 };
      });

    return SearchMaintenance.of({
      maintain: () =>
        Effect.gen(function* () {
          // optimize()/build run ONLY when the table's writers are idle, so they never
          // race an in-flight upsert (LanceDB commit-conflict). The FTS (lexical) table
          // is written only by index-session; the vector/profile table by index-session
          // AND embed-message, so it additionally needs embed idle. Search stays correct
          // meanwhile: the existing index serves and the unindexed tail is flat-scanned
          // as a small delta, with the readiness gate failing closed if it grows.
          const byKind = yield* queue.statsByKind.pipe(Effect.catchAll(() => Effect.succeed([] as const)));
          const inflight = (kind: string): number => {
            const s = byKind.find((k) => k.kind === kind);
            return s ? s.pending + s.leased : 0;
          };
          const idxBusy = inflight("index-session") > 0;
          const embBusy = inflight("embed-message") > 0;
          const rebuilt: IndexRebuildReport[] = [];

          if (!idxBusy) {
            rebuilt.push(yield* maintainTable(DEFAULT_SEARCH_TABLE, { includeVector: false }));
            if (profileTable !== DEFAULT_SEARCH_TABLE && !embBusy) {
              rebuilt.push(
                yield* maintainTable(profileTable, { includeVector: true, vectorRowsFilter: VECTOR_READY_FILTER }),
              );
            }
          }
          // Bound the queue_jobs table: hourly, delete completed jobs older than the
          // retention window. Throttled independently of the maintenance tick cadence;
          // pruneCompleted touches only status='completed' rows, never in-flight work.
          const nowMs = Date.now();
          if (nowMs - (yield* Ref.get(lastQueuePruneAt)) >= QUEUE_PRUNE_INTERVAL_MS) {
            yield* Ref.set(lastQueuePruneAt, nowMs);
            yield* queue
              .pruneCompleted(new Date(nowMs - QUEUE_COMPLETED_RETENTION_MS).toISOString())
              .pipe(Effect.catchAll(() => Effect.succeed(0)));
          }
          const stats = yield* derived.stats.pipe(Effect.catchAll(() => Effect.succeed({ skipped: idxBusy || embBusy } as unknown)));
          return { rebuilt, stats };
        }),

      // Rolling reconciler: for each session in the batch, measure its index state
      // (keyed (key, contentHash) diff vs a Lance read-back — strictly more precise
      // than the old content-hash set compare) and heal. Converged stamps the proof
      // and clears the ledger; Divergent records the exact divergence and enqueues a
      // targeted index-session repair (idempotency-keyed, so a pending repair is not
      // duplicated). This is the producer that fills the divergence ledger the gate
      // reads, and the edge that was missing from the worker loop.
      reconcileFreshness: (options = {}) =>
        Effect.gen(function* () {
          const sessions = yield* store.listSessions({ limit: options.limit ?? 200, offset: options.offset ?? 0 });
          let freshSessions = 0;
          let repairsEnqueued = 0;
          const staleSessions: string[] = [];

          for (const session of sessions) {
            const state = yield* verifyIndexed(session.sessionId).pipe(
              Effect.provideService(LocalStore, store),
              Effect.provideService(LanceDb, search),
            );
            if (state._tag === "Converged") {
              yield* store.markSessionIndexed(state.proof);
              yield* store.clearDivergence(state.sessionId);
              freshSessions += 1;
            } else if (state._tag === "Divergent") {
              // Remove the proven EXTRA rows first: keys present in the Lance table but
              // NOT in the session's intended (key, contentHash) set — the orphan/
              // duplicate rows left by re-keying that inflate vectorRowCount and trip the
              // fail-closed structural-divergence gate (503 on semantic/fusion). Only keys
              // the read-back proved extra are deleted, per their own table; the repair
              // then re-adds any genuinely missing rows and the next reconcile converges.
              for (const delta of state.deltas) {
                if (delta.extraKeys.length > 0) {
                  yield* search
                    .deleteByKeys({ tableName: delta.table, keys: [...delta.extraKeys] })
                    .pipe(Effect.catchAll(() => Effect.succeed(0)));
                }
              }
              yield* store.putDivergence(mergeDivergence(state.sessionId, state.deltas));
              yield* queue.enqueue({
                kind: "index-session",
                payload: { sessionId: state.sessionId },
                idempotencyKey: `index-session:${state.sessionId}`,
                nextRunAt: options.now,
              });
              repairsEnqueued += 1;
              staleSessions.push(state.sessionId);
            }
          }

          return { sessionsChecked: sessions.length, freshSessions, repairsEnqueued, staleSessions };
        }),

      repairOnce: ({ workerId, limit, leaseMs, now }) =>
        Effect.gen(function* () {
          yield* queue.recoverStaleLeases(now);
          const jobs = yield* queue.leaseBatch({ workerId, kind: "index-session", limit, leaseMs, now });
          let repaired = 0;
          let failed = 0;
          for (const job of jobs) {
            if (!isIndexSessionPayload(job.payload)) {
              yield* queue.fail(job.jobId, "invalid index-session payload", now);
              failed += 1;
              continue;
            }
            const result = yield* derived.indexSession(job.payload.sessionId).pipe(Effect.either);
            if (result._tag === "Right") {
              yield* queue.ack(job.jobId, now);
              repaired += 1;
            } else if (job.attempts >= job.maxAttempts) {
              yield* queue.fail(job.jobId, result.left instanceof Error ? result.left.message : String(result.left), now);
              failed += 1;
            } else {
              yield* queue.retry(job.jobId, {
                error: result.left instanceof Error ? result.left.message : String(result.left),
                delayMs: 30_000,
                now,
              });
            }
          }
          return { leased: jobs.length, repaired, failed };
        }),
    });
  }),
);
