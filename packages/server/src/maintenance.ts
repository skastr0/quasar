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
  readonly maintain: (options?: {
    readonly includeVector?: boolean;
    readonly optimize?: boolean;
  }) => Effect.Effect<MaintenanceReport, unknown>;
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
      maintain: (options = {}) =>
        Effect.gen(function* () {
          const indexesCreated = ["text_idx"];
          yield* derived.createLexicalIndex;
          if (options.includeVector ?? true) {
            yield* derived.createVectorIndex;
            indexesCreated.push("vector_idx");
          }
          if (options.optimize ?? true) {
            yield* Effect.forEach(activeTables, (tableName) => search.optimizeTable({ tableName }), { discard: true });
          }
          const stats = yield* derived.stats;
          return { indexesCreated, optimized: options.optimize ?? true, stats };
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
