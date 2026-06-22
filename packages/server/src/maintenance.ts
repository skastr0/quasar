import { DEFAULT_SEARCH_TABLE, LanceDb } from "./lancedb";
import { Context, Effect, Layer } from "effect";

import { embeddingProfileFromEnv, embeddingProfileSearchTable } from "./embeddingProfiles";
import { DerivedSearch } from "./search";
import { indexedContentHash, isSearchableRole, normalizeIndexedContentHash } from "./searchPolicy";
import { DurableQueue } from "./services";
import { LocalStore } from "./store";

export interface MaintenanceReport {
  readonly indexesCreated: readonly string[];
  readonly optimized: boolean;
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

    return SearchMaintenance.of({
      maintain: () =>
        Effect.gen(function* () {
          // Coalesced + conflict-free. optimize() compacts the whole table, so it
          // runs HERE (not per indexSession) and ONLY when the writers for that
          // table are idle, so it never races an upsert (the LanceDB
          // commit-conflict). Per table: the FTS table is written only by
          // index-session -> safe once index-session is idle; the vector table is
          // written by index-session AND embed-message -> needs both idle. The
          // readiness gate keeps /search 503 until a quiet tick folds rows in, so
          // skipping when busy never serves unindexed rows.
          const byKind = yield* queue.statsByKind.pipe(Effect.catchAll(() => Effect.succeed([] as const)));
          const inflight = (kind: string): number => {
            const s = byKind.find((k) => k.kind === kind);
            return s ? s.pending + s.leased : 0;
          };
          const idxBusy = inflight("index-session") > 0;
          const embBusy = inflight("embed-message") > 0;
          const indexesCreated: string[] = [];
          let optimized = false;

          if (!idxBusy) {
            yield* derived.createLexicalIndex.pipe(Effect.catchAll(() => Effect.void));
            indexesCreated.push("text_idx");
            yield* search.optimizeTable({ tableName: DEFAULT_SEARCH_TABLE }).pipe(Effect.catchAll(() => Effect.void));
            optimized = true;
          }
          if (profileTable !== DEFAULT_SEARCH_TABLE && !idxBusy && !embBusy) {
            yield* derived.createVectorIndex.pipe(Effect.catchAll(() => Effect.void));
            indexesCreated.push("vector_idx");
            yield* search.optimizeTable({ tableName: profileTable }).pipe(Effect.catchAll(() => Effect.void));
            optimized = true;
          }
          const stats = yield* derived.stats.pipe(Effect.catchAll(() => Effect.succeed({ skipped: idxBusy || embBusy } as unknown)));
          return { indexesCreated, optimized, stats };
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
