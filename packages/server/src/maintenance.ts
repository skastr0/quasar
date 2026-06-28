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
//
// gcSupersededIndexDirs runs AFTER optimize(), strictly yield*-sequenced, so the new
// generation is committed into the manifest before GC reads manifests and deletes only
// provably-unreferenced dirs (never the serving generation). See lancedb.ts for the
// full proof that detection is type-agnostic (FTS, BTree, AND IVF_PQ).
const MAINTAIN_INTERVAL_MS = 120_000;
// Version retention for optimize()'s cleanupOlderThan. With daily optimize, this
// prunes all but the current version each run; LanceDB never removes the CURRENT
// version regardless of the window [@lancedb/lancedb table.d.ts:88 "The current
// version will never be removed"]. deleteUnverified stays false so in-flight upsert
// files are never touched. This reclaims the VERSION/data side; gcSupersededIndexDirs
// handles the _indices generation dirs (lance#7207).
const VERSION_RETENTION_MS = 10 * 60 * 1000;
// Optimize+GC throttle (row-count delta OR wall-clock — grounded values):
// OPTIMIZE_ROW_DELTA: a 10k-row unindexed tail costs ~17ms at query time (proven:
// 1.1s for full ~660k-row brute-scan → 1.1s × 10000/660000 ≈ 17ms), within the
// "instant" bar; so 10k bounds the flat-scanned tail to sub-20ms before the next fold.
// Source: [[quasar-22s-latency-rootcause]] measured 1.1s/660k brute-scan.
// OPTIMIZE_MIN_INTERVAL_MS: daily floor ensures low-write tables still fold and prune
// their _versions so manifests/data do not accrete indefinitely.
const OPTIMIZE_ROW_DELTA = 10_000;
const OPTIMIZE_MIN_INTERVAL_MS = 24 * 60 * 60 * 1000;
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
        // optimize+GC: throttled by row-count delta AND wall-clock, writer-idle-gated
        // (inherited from maintain()'s !idxBusy/!embBusy branches above this call).
        // ORDER is load-bearing: optimize() FIRST (commits the new generation into the
        // manifest AND prunes superseded version manifests), THEN gcSupersededIndexDirs
        // (reads SURVIVING manifests, deletes only generation dirs no manifest references).
        // yield* sequencing guarantees GC runs strictly after optimize commits.
        void MAINTAIN_INTERVAL_MS; // used by outer maintain() tick, not here
        const now = Date.now();
        const lastAt = (yield* Ref.get(lastHeavyAt)).get(tableName) ?? 0;
        const lastRows = (yield* Ref.get(lastRefreshedRows)).get(tableName) ?? -1;
        const due = lastRows < 0 || now - lastAt >= OPTIMIZE_MIN_INTERVAL_MS || rows - lastRows >= OPTIMIZE_ROW_DELTA;
        if (!due) return { tableName, rebuilt: false, reclaimed: 0 };
        yield* search
          .optimize({ tableName, olderThanMs: VERSION_RETENTION_MS, deleteUnverified: false })
          .pipe(
            Effect.catchAll((e) =>
              Effect.logError(
                `quasar.index.optimize_failed table=${tableName} :: ${e instanceof Error ? e.message : String(e)}`,
              ),
            ),
          );
        const gc = yield* search
          .gcSupersededIndexDirs({ tableName })
          .pipe(Effect.catchAll(() => Effect.succeed({ scanned: 0, referenced: 0, deleted: 0 })));
        yield* Ref.update(lastHeavyAt, (m) => new Map(m).set(tableName, now));
        yield* Ref.update(lastRefreshedRows, (m) => new Map(m).set(tableName, rows));
        return { tableName, rebuilt: true, reclaimed: gc.deleted };
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
