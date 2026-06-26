/**
 * Search readiness gate — QSR-223.
 *
 * assertSearchReady is a cheap request-admission gate. It verifies that the
 * LanceDB search table exists when corpus data exists, discloses lightweight
 * catch-up counters, and keeps expensive consistency audits out of search.
 *
 * Readiness definitions
 * ─────────────────────
 * lexical-ready  :: empty corpus OR LanceDB messages table matches SQLite searchable count and is readable
 *
 * semantic-ready :: lexical-ready
 *                   and Synthetic embeddings are available
 *                   and the active vector table matches SQLite searchable count
 *                   with pending/leased embed-message jobs or unembedded rows absent
 *
 * fusion-ready   :: semantic-ready (fusion requires both FTS and vectors)
 *
 * Any LanceDB row-count read error → NOT ready unless SQLite has no messages.
 * Never catch-all → empty results.
 *
 * Exact SQLite searchable counts, unembedded counts, LanceDB versions, and disk
 * sizes are diagnostic work. They do not belong in request-time readiness.
 */

import { DEFAULT_SEARCH_TABLE, LanceDb, MESSAGE_TEXT_INDEX_NAME, MESSAGE_VECTOR_INDEX_NAME } from "./lancedb";
import { Cause, Context, Effect, Layer } from "effect";

import { embeddingProfileFromEnv, embeddingProfileSearchTable } from "./embeddingProfiles";
import { DurableQueue, Embeddings } from "./services";
import { LocalStore } from "./store";

export type SearchMode = "lexical" | "semantic" | "fusion";

/** Raw diagnostic counters included in every ReadinessResult. */
export interface IndexStats {
  /** Number of rows currently in the LanceDB messages table. */
  readonly lanceRowCount: number;
  /** Cheap corpus count from SQLite stats. Exact searchable counts are diagnostics. */
  readonly sqliteSearchableCount: number;
  /** Rows written to LanceDB but not yet folded into the FTS index. */
  readonly numUnindexedTextRows: number;
  /** Rows written to the active vector table but not yet folded into the vector index. */
  readonly numUnindexedVectorRows: number;
  /** Rows currently in the active vector search table. */
  readonly vectorRowCount: number;
  /** Whether the active vector index is caught up enough for semantic/fusion. */
  readonly vectorIndexReady: boolean;
  /** Sessions whose indexed_at watermark is NULL or behind updated_at. */
  readonly staleSessions: number;
  /** Cheap semantic frontier proxy: pending + leased embed-message jobs. */
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
  /** Synthetic embedding availability for semantic/fusion readiness checks. */
  readonly syntheticEmbeddingReady?: boolean;
  /** Synthetic embedding failure reason when readiness fails closed. */
  readonly syntheticEmbeddingReason?: string;
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
    const vectorTableName = embeddingProfileSearchTable(embeddingProfileFromEnv());
    const nowIso = () => new Date().toISOString();
    const syntheticFailure = (
      mode: SearchMode,
      staleCount: number,
      missingVectorCount: number,
      indexStats: IndexStats,
      reason?: string,
      syntheticReason?: string,
    ): ReadinessResult => ({
      ok: false,
      mode,
      staleCount,
      missingVectorCount: Math.max(missingVectorCount, 1),
      indexStats,
      syntheticEmbeddingReady: false,
      syntheticEmbeddingReason: syntheticReason,
      reason: reason ?? syntheticReason ?? "Synthetic embeddings are unavailable",
    });

    const emptyStats: IndexStats = {
      lanceRowCount: 0,
      sqliteSearchableCount: 0,
      numUnindexedTextRows: 0,
      numUnindexedVectorRows: 0,
      vectorRowCount: 0,
      vectorIndexReady: false,
      staleSessions: 0,
      unembeddedVectorRows: 0,
      pendingEmbedJobs: 0,
    };

    return SearchReadiness.of({
      assertSearchReady: (mode) =>
        Effect.gen(function* () {
          const needsEmbeddings = mode === "semantic" || mode === "fusion";
          const sqliteSearchableCount = yield* store.countSearchableMessages();
          const staleSessions = yield* store.countStaleIndexSessions().pipe(
            Effect.catchAll(() => Effect.succeed(1)),
          );
          const unembeddedVectorRows = yield* store.countUnembeddedMessages().pipe(
            Effect.catchAll(() => Effect.succeed(0)),
          );
          const pendingEmbedJobs = yield* queue.statsByKind.pipe(
            Effect.map((byKind) => {
              const embedKind = byKind.find((k) => k.kind === "embed-message");
              return (embedKind?.pending ?? 0) + (embedKind?.leased ?? 0);
            }),
            Effect.catchAll(() => Effect.succeed(0)),
          );
          const embeddingsService = yield* Effect.serviceOption(Embeddings);
          const syntheticEmbeddingResult = needsEmbeddings
            ? embeddingsService._tag === "None"
              ? {
                  ok: false as const,
                  checkedAt: nowIso(),
                  reason: "Synthetic embeddings service is unavailable",
                }
              : yield* embeddingsService.value.readiness.pipe(
                  Effect.catchAllCause((cause) =>
                    Effect.succeed({
                      ok: false,
                      checkedAt: nowIso(),
                      reason: Cause.pretty(cause),
                    }),
                  ),
                )
            : { ok: true as const, checkedAt: nowIso() };
          const syntheticReady = !needsEmbeddings || syntheticEmbeddingResult.ok;

          const lanceRowCountResult = yield* lance.countRows({ tableName: DEFAULT_SEARCH_TABLE }).pipe(Effect.either);

          // "Table not found" means LanceDB has never been seeded — cross-check
          // against cheap SQLite state. If SQLite has no messages and no stale
          // sessions, this is a genuine empty corpus. Otherwise ingest has data
          // but no search table yet.
          if (lanceRowCountResult._tag === "Left") {
            const errorMessage = lanceRowCountResult.left instanceof Error
              ? lanceRowCountResult.left.message
              : String((lanceRowCountResult.left as { message?: string }).message ?? lanceRowCountResult.left);
            const isTableNotFound = /not found|does not exist/i.test(errorMessage);
            const stats: IndexStats = {
              ...emptyStats,
              sqliteSearchableCount,
              staleSessions,
              unembeddedVectorRows,
              pendingEmbedJobs,
            };

            if (isTableNotFound && sqliteSearchableCount === 0) {
              if (!syntheticReady) {
                return syntheticFailure(mode, 0, Math.max(unembeddedVectorRows, pendingEmbedJobs, 1), stats, undefined, syntheticEmbeddingResult.reason);
              }
              // Genuinely empty corpus — ready once the Synthetic gate passes.
              return {
                ok: true,
                mode,
                staleCount: 0,
                missingVectorCount: 0,
                indexStats: stats,
                syntheticEmbeddingReady: needsEmbeddings ? syntheticEmbeddingResult.ok : undefined,
                syntheticEmbeddingReason: needsEmbeddings ? syntheticEmbeddingResult.reason : undefined,
              } satisfies ReadinessResult;
            }

            if (isTableNotFound) {
              // Sessions exist in SQLite but LanceDB table never created → not ready.
              return {
                ok: false,
                mode,
                staleCount: Math.max(staleSessions, sqliteSearchableCount),
                missingVectorCount: Math.max(unembeddedVectorRows, pendingEmbedJobs, needsEmbeddings && !syntheticEmbeddingResult.ok ? 1 : 0),
                indexStats: stats,
                syntheticEmbeddingReady: needsEmbeddings ? syntheticEmbeddingResult.ok : undefined,
                syntheticEmbeddingReason: needsEmbeddings ? syntheticEmbeddingResult.reason : undefined,
                reason: `LanceDB table not found but SQLite has ${sqliteSearchableCount} messages`,
              } satisfies ReadinessResult;
            }

            // Other LanceDB errors → fail closed.
            return {
              ok: false,
              mode,
              staleCount: 0,
              missingVectorCount: Math.max(unembeddedVectorRows, pendingEmbedJobs, needsEmbeddings && !syntheticEmbeddingResult.ok ? 1 : 0),
              indexStats: stats,
              syntheticEmbeddingReady: needsEmbeddings ? syntheticEmbeddingResult.ok : undefined,
              syntheticEmbeddingReason: needsEmbeddings ? syntheticEmbeddingResult.reason : undefined,
              reason: `LanceDB read error: ${errorMessage}`,
            } satisfies ReadinessResult;
          }

          const lanceRowCount = lanceRowCountResult.right;

          const textIndexResult = yield* lance.tableIndexStats({
            tableName: DEFAULT_SEARCH_TABLE,
            indexNames: [MESSAGE_TEXT_INDEX_NAME],
          }).pipe(
            Effect.map((indices) => indices.find((idx) => idx.name === MESSAGE_TEXT_INDEX_NAME)),
            Effect.either,
          );
          const textIndex = textIndexResult._tag === "Right" ? textIndexResult.right : undefined;
          const numUnindexedTextRows = textIndex?.numUnindexedRows ?? lanceRowCount;
          const needsVectorIndex = mode === "semantic" || mode === "fusion";
          const vectorRowCountResult = needsVectorIndex
            ? yield* lance.countRows({ tableName: vectorTableName }).pipe(Effect.either)
            : { _tag: "Right" as const, right: 0 };
          const vectorIndexResult = needsVectorIndex && vectorRowCountResult._tag === "Right"
            ? yield* lance.tableIndexStats({
              tableName: vectorTableName,
              indexNames: [MESSAGE_VECTOR_INDEX_NAME],
            }).pipe(
              Effect.map((indices) => indices.find((idx) => idx.name === MESSAGE_VECTOR_INDEX_NAME)),
              Effect.either,
            )
            : { _tag: "Right" as const, right: undefined };
          const vectorIndex = vectorIndexResult._tag === "Right" ? vectorIndexResult.right : undefined;
          const vectorRowCount = vectorRowCountResult._tag === "Right" ? vectorRowCountResult.right : 0;
          const numUnindexedVectorRows = vectorIndex?.numUnindexedRows ?? vectorRowCount;
          const vectorIndexReady = !needsVectorIndex || (vectorRowCount === sqliteSearchableCount && vectorIndex !== undefined && numUnindexedVectorRows === 0);
          const vectorCoverageGap = needsVectorIndex && vectorRowCount < sqliteSearchableCount
            ? sqliteSearchableCount - vectorRowCount
            : 0;
          const missingVectorCount = Math.max(unembeddedVectorRows, pendingEmbedJobs, vectorCoverageGap, needsVectorIndex && !syntheticEmbeddingResult.ok ? 1 : 0);

          const indexStats: IndexStats = {
            lanceRowCount,
            sqliteSearchableCount,
            numUnindexedTextRows,
            numUnindexedVectorRows,
            vectorRowCount,
            vectorIndexReady,
            staleSessions,
            unembeddedVectorRows,
            pendingEmbedJobs,
          };

          // ── Empty-corpus fast path ──────────────────────────────────────────
          // Lexical can serve with no rows; semantic/fusion still require
          // Synthetic embeddings to be available.
          if (lanceRowCount === 0 && sqliteSearchableCount === 0) {
            if (!syntheticReady) {
              return syntheticFailure(mode, 0, Math.max(missingVectorCount, 1), indexStats, undefined, syntheticEmbeddingResult.reason);
            }
            return {
              ok: true,
              mode,
              staleCount: 0,
              missingVectorCount: 0,
              indexStats,
              syntheticEmbeddingReady: needsVectorIndex ? syntheticEmbeddingResult.ok : undefined,
              syntheticEmbeddingReason: needsVectorIndex ? syntheticEmbeddingResult.reason : undefined,
            } satisfies ReadinessResult;
          }

          const rowCountMismatch = lanceRowCount !== sqliteSearchableCount;
          const disclosedStale = numUnindexedTextRows + staleSessions + (rowCountMismatch ? Math.abs(lanceRowCount - sqliteSearchableCount) : 0);

          if (needsVectorIndex && vectorRowCountResult._tag === "Left") {
            const errorMessage = vectorRowCountResult.left instanceof Error
              ? vectorRowCountResult.left.message
              : String((vectorRowCountResult.left as { message?: string }).message ?? vectorRowCountResult.left);
            return {
              ok: false,
              mode,
              staleCount: disclosedStale,
              missingVectorCount,
              indexStats,
              syntheticEmbeddingReady: needsVectorIndex ? syntheticEmbeddingResult.ok : undefined,
              syntheticEmbeddingReason: needsVectorIndex ? syntheticEmbeddingResult.reason : undefined,
              reason: `Vector search table not ready: ${errorMessage}`,
            } satisfies ReadinessResult;
          }

          if (rowCountMismatch) {
            return {
              ok: false,
              mode,
              staleCount: disclosedStale,
              missingVectorCount,
              indexStats,
              syntheticEmbeddingReady: needsVectorIndex ? syntheticEmbeddingResult.ok : undefined,
              syntheticEmbeddingReason: needsVectorIndex ? syntheticEmbeddingResult.reason : undefined,
              reason: `LanceDB row count ${lanceRowCount} does not match SQLite searchable count ${sqliteSearchableCount}`,
            } satisfies ReadinessResult;
          }

          if (needsVectorIndex && (vectorRowCount !== sqliteSearchableCount || pendingEmbedJobs > 0 || unembeddedVectorRows > 0)) {
            return {
              ok: false,
              mode,
              staleCount: disclosedStale,
              missingVectorCount,
              indexStats,
              syntheticEmbeddingReady: needsVectorIndex ? syntheticEmbeddingResult.ok : undefined,
              syntheticEmbeddingReason: needsVectorIndex ? syntheticEmbeddingResult.reason : undefined,
              reason: vectorRowCount !== sqliteSearchableCount
                ? `Vector search table row count ${vectorRowCount} does not match SQLite searchable count ${sqliteSearchableCount}`
                : `Vector search frontier is still moving: pending=${pendingEmbedJobs}, unembedded=${unembeddedVectorRows}`,
            } satisfies ReadinessResult;
          }

          // ── Serve unless we genuinely cannot ────────────────────────────────
          // Lexical can serve while FTS catches up: LanceDB includes the unindexed
          // tail via flat scan, so the text tail is a disclosed latency property.
          // Semantic/fusion require the active vector table to cover the searchable
          // corpus, and they fail closed if Synthetic embeddings are unavailable.
          if (!syntheticReady) {
            return syntheticFailure(mode, disclosedStale, missingVectorCount, indexStats, undefined, syntheticEmbeddingResult.reason);
          }
          return {
            ok: true,
            mode,
            staleCount: disclosedStale,
            missingVectorCount: 0,
            indexStats,
            syntheticEmbeddingReady: needsVectorIndex ? syntheticEmbeddingResult.ok : undefined,
            syntheticEmbeddingReason: needsVectorIndex ? syntheticEmbeddingResult.reason : undefined,
          } satisfies ReadinessResult;
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
