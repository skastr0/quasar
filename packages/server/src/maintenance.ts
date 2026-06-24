import { DEFAULT_SEARCH_TABLE, LanceDb } from "./lancedb";
import { Context, Effect, Layer, Ref } from "effect";

import { embeddingProfileFromEnv, embeddingProfileSearchTable } from "./embeddingProfiles";
import { DerivedSearch } from "./search";
import { indexedContentHash, isSearchableRole, normalizeIndexedContentHash, VECTOR_READY_FILTER } from "./searchPolicy";
import { DurableQueue } from "./services";
import { LocalStore } from "./store";

// How the index stays both bounded AND fresh, minimally: on a throttled tick, when a
// table's data has changed since its last rebuild, REBUILD all its indexes from
// scratch (drop-then-create) and delete the previous index dirs. The rebuild folds
// every row (LanceDB's optimize is unnecessary — queries flat-scan the unindexed
// tail, grounded against lance source) and is intrinsically leak-free; deleting the
// pre-rebuild snapshot is the only thing that reclaims superseded dirs, because
// LanceDB never does (lance#7207, open). No per-tick optimize, no dir budget, no
// grace window — those were scaffolding around optimize's leak.
//
// A full rebuild is O(rows) (~10-20s at this scale), so it is throttled to this
// interval, which must stay well above the rebuild duration so rebuilds never dominate.
const MAINTAIN_INTERVAL_MS = 120_000;

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

const sameContentHashes = (expected: readonly string[], actual: readonly string[]) => {
  if (expected.length !== actual.length) return false;
  const actualSet = new Set(actual);
  return expected.every((value) => actualSet.has(value));
};

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
    const activeTables = profileTable === DEFAULT_SEARCH_TABLE ? [DEFAULT_SEARCH_TABLE] : [DEFAULT_SEARCH_TABLE, profileTable];
    const lastHeavyAt = yield* Ref.make(new Map<string, number>());
    const lastRebuiltRows = yield* Ref.make(new Map<string, number>());

    // Rebuild a table's indexes from scratch and reclaim the pre-rebuild dirs, but
    // ONLY if its row count changed since the last rebuild (idle quiescence — an
    // unchanged table would rebuild an identical index for nothing). Snapshot BEFORE
    // the rebuild: the rebuild writes fresh dirs under new uuids and repoints the
    // manifest, so every snapshot name is then superseded and safe to delete. Runs
    // only under maintain()'s writer-idle guard, so no reader/writer races the delete.
    const maybeRebuild = (
      tableName: string,
      rebuild: Effect.Effect<unknown, unknown>,
    ): Effect.Effect<IndexRebuildReport> =>
      Effect.gen(function* () {
        // Per-table throttle: a full rebuild is O(rows), so it runs at most once per
        // interval PER TABLE (advanced only on an actual rebuild, so an idle table is
        // re-checked cheaply each tick and rebuilds promptly the moment data changes,
        // independent of the other table's cadence).
        const now = Date.now();
        const sinceRebuild = now - ((yield* Ref.get(lastHeavyAt)).get(tableName) ?? 0);
        if (sinceRebuild < MAINTAIN_INTERVAL_MS) return { tableName, rebuilt: false, reclaimed: 0 };
        const rows = yield* search.countRows({ tableName }).pipe(Effect.catchAll(() => Effect.succeed(-1)));
        if (rows < 0) return { tableName, rebuilt: false, reclaimed: 0 }; // table not created yet
        const last = (yield* Ref.get(lastRebuiltRows)).get(tableName);
        if (last === rows) return { tableName, rebuilt: false, reclaimed: 0 }; // unchanged since last rebuild
        const snapshot = yield* search.listIndexDirNames({ tableName });
        const rebuilt = yield* Effect.either(rebuild);
        if (rebuilt._tag === "Left") {
          yield* Effect.logError(
            `quasar.index.rebuild_failed table=${tableName} :: ${rebuilt.left instanceof Error ? rebuilt.left.message : String(rebuilt.left)}`,
          );
          return { tableName, rebuilt: false, reclaimed: 0 };
        }
        const reclaimed = yield* search.deleteIndexDirsByName({ tableName, names: snapshot });
        yield* Ref.update(lastHeavyAt, (map) => new Map(map).set(tableName, now));
        yield* Ref.update(lastRebuiltRows, (map) => new Map(map).set(tableName, rows));
        return { tableName, rebuilt: true, reclaimed };
      });

    return SearchMaintenance.of({
      maintain: () =>
        Effect.gen(function* () {
          // The rebuild runs HERE (not per indexSession) and ONLY when the table's
          // writers are idle, so it never races an upsert (LanceDB commit-conflict).
          // The FTS (lexical) table is written only by index-session; the vector table
          // by index-session AND embed-message, so it needs both idle. lastHeavyAt
          // throttles the O(rows) rebuild so it can't run on every worker tick, and is
          // only advanced when work actually ran, so a long busy stretch never starves
          // maintenance once writers go idle. Search stays correct meanwhile: queries
          // flat-scan the unindexed tail and the readiness gate fails closed.
          const byKind = yield* queue.statsByKind.pipe(Effect.catchAll(() => Effect.succeed([] as const)));
          const inflight = (kind: string): number => {
            const s = byKind.find((k) => k.kind === kind);
            return s ? s.pending + s.leased : 0;
          };
          const idxBusy = inflight("index-session") > 0;
          const embBusy = inflight("embed-message") > 0;
          const rebuilt: IndexRebuildReport[] = [];

          // Each table self-throttles and skips when unchanged (see maybeRebuild); here
          // we only gate on writer-idle so a rebuild never races an in-flight write. The
          // lexical table is written by index-session; the vector table also by
          // embed-message, so it additionally needs embed idle.
          if (!idxBusy) {
            rebuilt.push(
              yield* maybeRebuild(
                DEFAULT_SEARCH_TABLE,
                search.createMessageIndexes({ tableName: DEFAULT_SEARCH_TABLE, includeVector: false, replace: true }),
              ),
            );
            if (profileTable !== DEFAULT_SEARCH_TABLE && !embBusy) {
              rebuilt.push(
                yield* maybeRebuild(
                  profileTable,
                  search.createMessageIndexes({ tableName: profileTable, includeVector: true, vectorRowsFilter: VECTOR_READY_FILTER, replace: true }),
                ),
              );
            }
          }
          const stats = yield* derived.stats.pipe(Effect.catchAll(() => Effect.succeed({ skipped: idxBusy || embBusy } as unknown)));
          return { rebuilt, stats };
        }),

      reconcileFreshness: (options = {}) =>
        Effect.gen(function* () {
          const sessions = yield* store.listSessions({ limit: options.limit ?? 500 });
          let freshSessions = 0;
          let repairsEnqueued = 0;
          const staleSessions: string[] = [];

          for (const session of sessions) {
            const messages = yield* store.readMessages(session.sessionId, 100_000);
            const expected = messages
              .filter((message) => isSearchableRole(message.role))
              .map(indexedContentHash);
            const rowsByTable = yield* Effect.forEach(
              activeTables,
              (tableName) =>
                search.readMessageRowsBySession({
                  sessionId: session.sessionId,
                  tableName,
                  limit: 100_000,
                  select: ["contentHash"],
                }).pipe(Effect.catchAll(() => Effect.succeed([]))),
              { concurrency: 1 },
            );
            const normalizedExpected = expected
              .map(normalizeIndexedContentHash)
              .filter((value): value is string => value !== undefined);
            const tablesAreFresh = rowsByTable.every((rows) => {
              const actual = rows
                .map((row) => row.contentHash)
                .map(normalizeIndexedContentHash)
                .filter((value): value is string => value !== undefined);
              return sameContentHashes(normalizedExpected, actual);
            });

            if (tablesAreFresh) {
              freshSessions += 1;
              continue;
            }

            staleSessions.push(session.sessionId);
            yield* queue.enqueue({
              kind: "index-session",
              payload: { sessionId: session.sessionId },
              idempotencyKey: `index-session:${session.sessionId}`,
              nextRunAt: options.now,
            });
            repairsEnqueued += 1;
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
