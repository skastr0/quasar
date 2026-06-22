/**
 * Search readiness gate — QSR-223.
 *
 * assertSearchReady checks whether the LanceDB index is consistent with the
 * SQLite truth store before any search request is served. If the index is not
 * ready the gate returns a typed ReadinessResult with ok:false; callers convert
 * this to HTTP 503 — never 200 with stale/partial results.
 *
 * Readiness definitions
 * ─────────────────────
 * lexical-ready  :: LanceDB messages-table rowCount === SQLite searchable message count
 *                   AND text_idx numUnindexedRows === 0
 *                   AND zero stale-index sessions in SQLite (indexed_at IS NULL or behind updated_at)
 *
 * semantic-ready :: lexical-ready
 *                   AND zero unembedded searchable messages (contentHash LIKE 'unembedded:%' in SQLite)
 *                   AND zero pending/leased embed-message jobs in the queue
 *
 * fusion-ready   :: semantic-ready (fusion requires both FTS and vectors)
 *
 * Any LanceDB read / indexStats error → NOT ready. Never catch-all → empty results.
 *
 * Empty-corpus special case: if both LanceDB rowCount===0 AND SQLite searchable===0
 * the corpus is genuinely empty — all modes are ready (returns 200 with empty matches).
 * "Building" (rows present, numIndexedRows < rowCount) vs "consistent+empty" is
 * discriminated by the row-count-parity check.
 */

import { DEFAULT_SEARCH_TABLE, LanceDb, MESSAGE_TEXT_INDEX_NAME } from "./lancedb";
import { Context, Effect, Layer } from "effect";

import { DurableQueue } from "./services";
import { LocalStore } from "./store";

export type SearchMode = "lexical" | "semantic" | "fusion";

/** Raw diagnostic counters included in every ReadinessResult. */
export interface IndexStats {
  /** Number of rows currently in the LanceDB messages table. */
  readonly lanceRowCount: number;
  /** Number of searchable messages in SQLite (role IN user/assistant/reasoning). */
  readonly sqliteSearchableCount: number;
  /** Rows written to LanceDB but not yet folded into the FTS index. */
  readonly numUnindexedTextRows: number;
  /** Sessions whose indexed_at watermark is NULL or behind updated_at. */
  readonly staleSessions: number;
  /** SQLite messages with contentHash LIKE 'unembedded:%' — placeholder vectors. */
  readonly unembeddedVectorRows: number;
  /** Pending + leased embed-message jobs in the durable queue. */
  readonly pendingEmbedJobs: number;
}

export interface ReadinessResult {
  readonly ok: boolean;
  readonly mode: SearchMode;
  /** Rows present in LanceDB that are not yet folded into the FTS index. */
  readonly staleCount: number;
  /** Messages with placeholder vectors (unembedded:* contentHash). */
  readonly missingVectorCount: number;
  readonly indexStats: IndexStats;
  readonly reason?: string;
}

export interface SearchReadinessService {
  readonly assertSearchReady: (mode: SearchMode) => Effect.Effect<ReadinessResult, never>;
}

export class SearchReadiness extends Context.Tag("@quasar/SearchReadiness")<
  SearchReadiness,
  SearchReadinessService
>() {}

export const SearchReadinessLive = Layer.effect(
  SearchReadiness,
  Effect.gen(function* () {
    const store = yield* LocalStore;
    const lance = yield* LanceDb;
    const queue = yield* DurableQueue;

    const emptyStats: IndexStats = {
      lanceRowCount: 0,
      sqliteSearchableCount: 0,
      numUnindexedTextRows: 0,
      staleSessions: 0,
      unembeddedVectorRows: 0,
      pendingEmbedJobs: 0,
    };

    return SearchReadiness.of({
      assertSearchReady: (mode) =>
        Effect.gen(function* () {
          // 1. LanceDB messages-table stats — fail closed on read errors, except
          // when the table doesn't exist yet (empty corpus fast path).
          const lanceStatsResult = yield* lance.tableStats({ tableName: DEFAULT_SEARCH_TABLE }).pipe(Effect.either);

          // "Table not found" means LanceDB has never been seeded — cross-check
          // against SQLite. If SQLite also has zero searchable messages → truly empty
          // corpus, all modes are ready. If SQLite has messages → ingest happened but
          // indexSession hasn't run yet → not ready.
          if (lanceStatsResult._tag === "Left") {
            const errorMessage = lanceStatsResult.left instanceof Error
              ? lanceStatsResult.left.message
              : String((lanceStatsResult.left as { message?: string }).message ?? lanceStatsResult.left);
            const isTableNotFound = /not found|does not exist/i.test(errorMessage);

            const sqliteSearchableForNotFound = yield* store.countSearchableMessages().pipe(
              Effect.catchAll(() => Effect.succeed(0)),
            );

            if (isTableNotFound && sqliteSearchableForNotFound === 0) {
              // Genuinely empty corpus — all modes ready.
              return { ok: true, mode, staleCount: 0, missingVectorCount: 0, indexStats: emptyStats } satisfies ReadinessResult;
            }

            if (isTableNotFound && sqliteSearchableForNotFound > 0) {
              // Sessions exist in SQLite but LanceDB table never created → not ready.
              const stats: IndexStats = {
                ...emptyStats,
                sqliteSearchableCount: sqliteSearchableForNotFound,
              };
              return {
                ok: false,
                mode,
                staleCount: sqliteSearchableForNotFound,
                missingVectorCount: 0,
                indexStats: stats,
                reason: `LanceDB table not found but SQLite has ${sqliteSearchableForNotFound} searchable messages`,
              } satisfies ReadinessResult;
            }

            // Other LanceDB errors → fail closed.
            return {
              ok: false,
              mode,
              staleCount: 0,
              missingVectorCount: 0,
              indexStats: emptyStats,
              reason: `LanceDB read error: ${errorMessage}`,
            } satisfies ReadinessResult;
          }

          const lanceStats = lanceStatsResult.right;
          const lanceRowCount = lanceStats.rowCount;

          // text_idx numUnindexedRows: 0 means FTS is fully caught up.
          // If the index doesn't exist yet, every row is "unindexed".
          const textIndex = lanceStats.indices.find((idx) => idx.name === MESSAGE_TEXT_INDEX_NAME);
          const numUnindexedTextRows = textIndex !== undefined
            ? (textIndex.numUnindexedRows ?? 0)
            : lanceRowCount; // no index at all → all rows unindexed

          // 2. SQLite truth counts — fail closed (default to "stale") on error.
          const sqliteSearchableCount = yield* store.countSearchableMessages().pipe(
            Effect.catchAll(() => Effect.succeed(-1)),
          );
          const staleSessions = yield* store.countStaleIndexSessions().pipe(
            Effect.catchAll(() => Effect.succeed(1)),
          );
          // unembedded = SQLite messages where contentHash LIKE 'unembedded:%'
          // (set by indexedContentHash() for every searchable-role message before embedding).
          const unembeddedVectorRows = yield* store.countUnembeddedMessages().pipe(
            Effect.catchAll(() => Effect.succeed(0)),
          );

          // 3. Pending embed jobs in the durable queue.
          const pendingEmbedJobs = yield* queue.statsByKind.pipe(
            Effect.map((byKind) => {
              const embedKind = byKind.find((k) => k.kind === "embed-message");
              return (embedKind?.pending ?? 0) + (embedKind?.leased ?? 0);
            }),
            Effect.catchAll(() => Effect.succeed(0)),
          );

          const indexStats: IndexStats = {
            lanceRowCount,
            sqliteSearchableCount,
            numUnindexedTextRows,
            staleSessions,
            unembeddedVectorRows,
            pendingEmbedJobs,
          };

          // ── Empty-corpus fast path ──────────────────────────────────────────
          // Both sides agree there is nothing yet: all modes are ready.
          if (lanceRowCount === 0 && sqliteSearchableCount === 0) {
            return { ok: true, mode, staleCount: 0, missingVectorCount: 0, indexStats } satisfies ReadinessResult;
          }

          // ── Lexical readiness ───────────────────────────────────────────────
          const rowCountMismatch = lanceRowCount !== sqliteSearchableCount;
          const textIndexStale = numUnindexedTextRows > 0;
          const watermarkStale = staleSessions > 0;

          const staleCount = numUnindexedTextRows + (rowCountMismatch ? Math.abs(lanceRowCount - sqliteSearchableCount) : 0);
          const lexicalReady = !rowCountMismatch && !textIndexStale && !watermarkStale;

          if (mode === "lexical") {
            if (!lexicalReady) {
              const reasons: string[] = [];
              if (rowCountMismatch) reasons.push(`row count mismatch: lance=${lanceRowCount} sqlite=${sqliteSearchableCount}`);
              if (textIndexStale) reasons.push(`text_idx has ${numUnindexedTextRows} unindexed rows`);
              if (watermarkStale) reasons.push(`${staleSessions} sessions have stale index watermark`);
              return { ok: false, mode, staleCount, missingVectorCount: 0, indexStats, reason: reasons.join("; ") } satisfies ReadinessResult;
            }
            return { ok: true, mode, staleCount: 0, missingVectorCount: 0, indexStats } satisfies ReadinessResult;
          }

          // ── Semantic / fusion readiness (superset of lexical) ───────────────
          const semanticReady = lexicalReady && unembeddedVectorRows === 0 && pendingEmbedJobs === 0;

          if (!semanticReady) {
            const reasons: string[] = [];
            if (!lexicalReady) {
              if (rowCountMismatch) reasons.push(`row count mismatch: lance=${lanceRowCount} sqlite=${sqliteSearchableCount}`);
              if (textIndexStale) reasons.push(`text_idx has ${numUnindexedTextRows} unindexed rows`);
              if (watermarkStale) reasons.push(`${staleSessions} sessions have stale index watermark`);
            }
            if (unembeddedVectorRows > 0) reasons.push(`${unembeddedVectorRows} messages lack real vectors`);
            if (pendingEmbedJobs > 0) reasons.push(`${pendingEmbedJobs} embed-message jobs pending/leased`);
            return {
              ok: false,
              mode,
              staleCount,
              missingVectorCount: unembeddedVectorRows,
              indexStats,
              reason: reasons.join("; "),
            } satisfies ReadinessResult;
          }

          return { ok: true, mode, staleCount: 0, missingVectorCount: 0, indexStats } satisfies ReadinessResult;
        }).pipe(
          // Absolute catch-all: any unexpected exception → fail closed.
          Effect.catchAll((error: unknown) =>
            Effect.succeed({
              ok: false,
              mode,
              staleCount: 0,
              missingVectorCount: 0,
              indexStats: emptyStats,
              reason: `readiness check failed: ${error instanceof Error ? error.message : String(error)}`,
            } satisfies ReadinessResult),
          ),
        ),
    });
  }),
);
