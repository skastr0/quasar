/**
 * Search readiness — DIAGNOSTIC-ONLY surface consumed by /ready and /status.
 *
 * assertSearchReady is NO LONGER a per-request search gate. Search routes
 * (lexicalSearch, semanticSearch, fusionSearch) run immediately without any
 * readiness check; a genuinely absent table returns an honest empty 200 via
 * their own Effect.catchAll. This module is called only by:
 *   • /ready  — operator diagnostic; returns 503 when not ready but gates nothing
 *               on the request path (Docker HEALTHCHECK uses /health, not /ready)
 *   • /status — extended status reporting
 *
 * The embedder-health probe (`embeddingsService.value.readiness`) is now a
 * non-blocking Ref read (background fiber in embeddings.ts) so even /ready
 * never issues a per-call network probe.
 *
 * Readiness definitions (diagnostic only)
 * ────────────────────────────────────────
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
 */

import { DEFAULT_SEARCH_TABLE, LanceDb, MESSAGE_TEXT_INDEX_NAME, MESSAGE_VECTOR_INDEX_NAME } from "./lancedb";
import { Cause, Context, Effect, Layer } from "effect";

import { embeddingProfileFromEnv, embeddingProfileSearchTable } from "./embeddingProfiles";
import { DurableQueue, Embeddings } from "./services";
import { LocalStore } from "./store";

export type SearchMode = "lexical" | "semantic" | "fusion";

/** How far the derived index may diverge from truth before search fails closed, as a
 * fraction of the searchable corpus (missing + extra + stale rows combined). A
 * continuously-ingested index is ALWAYS slightly behind: the default 0.05 serves through
 * that normal lag (a measured 0.25% orphan tail was producing a 100% outage) and fails
 * closed only on gross corruption (the historical index failures were ~100% divergence).
 * Env-overridable via QUASAR_SEARCH_SHORTFALL_TOLERANCE. */
const shortfallTolerance = (): number => {
  const raw = Number(process.env.QUASAR_SEARCH_SHORTFALL_TOLERANCE);
  return Number.isFinite(raw) && raw >= 0 && raw <= 1 ? raw : 0.05;
};

interface CoverageVerdict {
  readonly serve: boolean;
  readonly completeness: number;
  readonly structural: boolean;
  readonly reason?: string;
}

/**
 * Classify a coverage gap. A continuously-ingested derived index is ALWAYS a little
 * behind truth: a small tail of missing (not-yet-folded), extra (orphan), or stale
 * (rekeyed) rows is the NORMAL steady state, not corruption. Gate on TOTAL divergence
 * as a fraction of the corpus and serve degraded (with disclosed completeness) under
 * tolerance; fail closed only when divergence is large enough to mean the index is
 * genuinely broken rather than merely lagging. The `structural` flag is still disclosed
 * (extra/stale can surface a deleted or wrong result) but no longer forces a 100% outage
 * for a sub-tolerance tail — which is what turned a measured 1,624-of-660k (0.25%) orphan
 * tail into a total semantic blackout on a system that ingests every minute.
 */
const classifyCoverage = (params: {
  readonly expected: number;
  readonly missing: number;
  readonly extra: number;
  readonly stale: number;
}): CoverageVerdict => {
  if (params.expected === 0) return { serve: true, completeness: 1, structural: false };
  const divergent = params.missing + params.extra + params.stale;
  const ratio = divergent / params.expected;
  const completeness = Math.max(0, 1 - ratio);
  const structural = params.extra > 0 || params.stale > 0;
  if (ratio > shortfallTolerance()) {
    return {
      serve: false,
      completeness,
      structural,
      reason: `index divergence ${ratio.toFixed(6)} exceeds tolerance ${shortfallTolerance()} (missing ${params.missing}, extra ${params.extra}, stale ${params.stale} of ${params.expected})`,
    };
  }
  return { serve: true, completeness, structural };
};

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
  /** Disclosed coverage in [0,1] when serving a degraded (incomplete-but-bounded)
   * index or failing on a shortfall; omitted at full coverage (silence is semantic). */
  readonly completeness?: number;
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
          const divergence = yield* store.divergenceAggregate.pipe(
            Effect.catchAll(() => Effect.succeed({ sessions: 0, missing: 0, stale: 0, extra: 0 })),
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

          // Classify-then-gate (replaces the exact-equality cliff). The divergence-only
          // ledger supplies the stale (present-but-wrong-content) signal a row-count
          // comparison cannot see; the coarse lexical/vector counts supply missing/extra.
          const lexicalCoverage = classifyCoverage({
            expected: sqliteSearchableCount,
            missing: Math.max(0, sqliteSearchableCount - lanceRowCount),
            extra: Math.max(0, lanceRowCount - sqliteSearchableCount),
            stale: divergence.stale,
          });
          if (!lexicalCoverage.serve) {
            return {
              ok: false,
              mode,
              staleCount: disclosedStale,
              missingVectorCount,
              indexStats,
              completeness: lexicalCoverage.completeness,
              syntheticEmbeddingReady: needsVectorIndex ? syntheticEmbeddingResult.ok : undefined,
              syntheticEmbeddingReason: needsVectorIndex ? syntheticEmbeddingResult.reason : undefined,
              reason: lexicalCoverage.reason,
            } satisfies ReadinessResult;
          }

          const vectorCoverage: CoverageVerdict = needsVectorIndex
            ? classifyCoverage({
                expected: sqliteSearchableCount,
                missing: Math.max(0, sqliteSearchableCount - vectorRowCount) + pendingEmbedJobs + unembeddedVectorRows,
                extra: Math.max(0, vectorRowCount - sqliteSearchableCount),
                stale: 0,
              })
            : { serve: true, completeness: 1, structural: false };
          if (needsVectorIndex && !vectorCoverage.serve) {
            return {
              ok: false,
              mode,
              staleCount: disclosedStale,
              missingVectorCount,
              indexStats,
              completeness: vectorCoverage.completeness,
              syntheticEmbeddingReady: syntheticEmbeddingResult.ok,
              syntheticEmbeddingReason: syntheticEmbeddingResult.reason,
              reason: vectorCoverage.reason,
            } satisfies ReadinessResult;
          }

          // ── Serve (possibly degraded) unless Synthetic embeddings are missing ──
          // Lexical serves while FTS catches up: LanceDB includes the unindexed tail
          // via flat scan, so the text tail is a disclosed latency property, not a 503.
          if (!syntheticReady) {
            return syntheticFailure(mode, disclosedStale, missingVectorCount, indexStats, undefined, syntheticEmbeddingResult.reason);
          }
          const completeness = Math.min(lexicalCoverage.completeness, vectorCoverage.completeness);
          return {
            ok: true,
            mode,
            staleCount: disclosedStale,
            missingVectorCount: 0,
            indexStats,
            completeness: completeness < 1 ? completeness : undefined,
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
