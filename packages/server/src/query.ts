import { performance } from "node:perf_hooks";

import { Effect, Either, Schema } from "effect";

import type { QueryMessageRow, QuerySessionRow, QueryToolCallRow } from "./model";
import { recordSearchReceiptMetrics } from "./metrics";
import { Embeddings } from "./services";
import { LocalStore, type SearchHit } from "./store";
import { VectorMatrix, type VectorMatrixHit } from "./vectorMatrix";

export const RESOURCE_PAGE_MAXIMUM = 200;

export interface ResourcePageRequest {
  readonly limit: number;
  readonly offset: number;
}

export interface ResourceFilters {
  readonly projectKey?: string;
  readonly providers?: readonly string[];
  readonly sessionId?: string;
  readonly role?: string;
  readonly agentName?: string;
  readonly agentRole?: string;
  readonly model?: string;
  readonly modelProvider?: string;
  readonly toolName?: string;
}

export type ResourceQuery =
  | { readonly kind: "sessions"; readonly filters: ResourceFilters; readonly page: ResourcePageRequest }
  | { readonly kind: "messages"; readonly filters: ResourceFilters & { readonly sessionId: string }; readonly page: ResourcePageRequest }
  | { readonly kind: "toolCalls"; readonly filters: ResourceFilters; readonly page: ResourcePageRequest }
  | { readonly kind: "toolCall"; readonly id: string }
  | { readonly kind: "search"; readonly mode: SearchMode; readonly text: string; readonly filters: ResourceFilters; readonly page: ResourcePageRequest };

export type SearchMode = "lexical" | "semantic" | "fusion";

export interface ResourcePage {
  readonly limit: number;
  readonly offset: number;
  readonly nextOffset: number | null;
}

export interface SearchReceipt {
  readonly mode: SearchMode;
  readonly query: string;
  readonly readinessMs: number;
  readonly searchMs: number;
  readonly embedMs?: number;
  readonly totalMs: number;
}

export type ResourceQueryResult =
  | { readonly kind: "sessions"; readonly rows: readonly QuerySessionRow[]; readonly page: ResourcePage }
  | { readonly kind: "messages"; readonly rows: readonly QueryMessageRow[]; readonly page: ResourcePage }
  | { readonly kind: "toolCalls"; readonly rows: readonly QueryToolCallRow[]; readonly page: ResourcePage }
  | { readonly kind: "toolCall"; readonly row: QueryToolCallRow | undefined }
  | { readonly kind: "search"; readonly matches: readonly SearchHit[]; readonly page: ResourcePage; readonly receipt: SearchReceipt; readonly degraded: boolean; readonly degradedReason?: string };

export class QuerySemanticDisabledError extends Schema.TaggedError<QuerySemanticDisabledError>()(
  "QuerySemanticDisabledError",
  { message: Schema.String },
) {}

export class QueryEmbeddingUnavailableError extends Schema.TaggedError<QueryEmbeddingUnavailableError>()(
  "QueryEmbeddingUnavailableError",
  { message: Schema.String },
) {}

const pageRows = <A>(rows: readonly A[], page: ResourcePageRequest) => ({
  rows: rows.slice(0, page.limit),
  page: {
    limit: page.limit,
    offset: page.offset,
    nextOffset: rows.length > page.limit ? page.offset + page.limit : null,
  } satisfies ResourcePage,
});

const hydrateSemanticHits = (hits: readonly VectorMatrixHit[], filters: ResourceFilters) =>
  Effect.gen(function* () {
    const store = yield* LocalStore;
    const rows = yield* store.queryMessagesBySessionSeq({
      pairs: hits.map(({ sessionId, seq }) => ({ sessionId, seq })),
      sessionId: filters.sessionId,
      agentName: filters.agentName,
      agentRole: filters.agentRole,
      model: filters.model,
      modelProvider: filters.modelProvider,
    });
    const scoreByKey = new Map(hits.map((hit) => [`${hit.sessionId}\0${hit.seq}`, hit.score]));
    return rows.map((row) => ({
      key: `${row.sessionId}:${row.sequence}`,
      score: scoreByKey.get(`${row.sessionId}\0${row.sequence}`) ?? 0,
      row: { ...row },
    } satisfies SearchHit));
  });

const semanticSearch = (text: string, filters: ResourceFilters, candidateLimit: number) =>
  Effect.gen(function* () {
    const [matrix, embeddings, store] = yield* Effect.all([VectorMatrix, Embeddings, LocalStore]);
    const status = yield* matrix.status.pipe(Effect.withSpan("search.readiness"));
    if (!status.enabled) {
      return yield* new QuerySemanticDisabledError({ message: "semantic search disabled pending vector materialization" });
    }
    const embedStarted = performance.now();
    const vectorResult = yield* embeddings.embedText(text).pipe(Effect.either);
    if (Either.isLeft(vectorResult)) {
      return yield* new QueryEmbeddingUnavailableError({
        message: vectorResult.left instanceof Error ? vectorResult.left.message : String(vectorResult.left),
      });
    }
    const embedMs = Math.round(performance.now() - embedStarted);
    const needsSessionMask = filters.sessionId !== undefined || filters.agentName !== undefined
      || filters.agentRole !== undefined || filters.model !== undefined || filters.modelProvider !== undefined;
    const sessionIds = needsSessionMask
      ? new Set(yield* store.querySessionIds({
        projectKey: filters.projectKey, providers: filters.providers, sessionId: filters.sessionId,
        agentName: filters.agentName, agentRole: filters.agentRole, model: filters.model, modelProvider: filters.modelProvider,
      }))
      : undefined;
    const hits = yield* matrix.search({
      vector: vectorResult.right, limit: candidateLimit, projectKey: filters.projectKey,
      role: filters.role, providers: filters.providers, sessionIds,
    }).pipe(Effect.catchTag("VectorMatrixDisabledError", () => new QuerySemanticDisabledError({
      message: "semantic search disabled pending vector materialization",
    })));
    return { matches: yield* hydrateSemanticHits(hits, filters), embedMs };
  });

const RRF_K = 60;
const MAX_SEARCH_CANDIDATES = 256;

const fuseByReciprocalRank = (lexical: readonly SearchHit[], semantic: readonly SearchHit[]) => {
  const fused = new Map<string, { score: number; row: SearchHit["row"] }>();
  for (const hits of [lexical, semantic]) {
    for (const [rank, hit] of hits.entries()) {
      const current = fused.get(hit.key);
      const score = 1 / (RRF_K + rank + 1);
      fused.set(hit.key, current === undefined ? { score, row: hit.row } : { ...current, score: current.score + score });
    }
  }
  return [...fused.entries()].map(([key, value]) => ({ key, ...value }))
    .sort((left, right) => right.score - left.score || left.key.localeCompare(right.key));
};

const executeSearch = (request: Extract<ResourceQuery, { readonly kind: "search" }>) =>
  Effect.gen(function* () {
    const started = performance.now();
    const store = yield* LocalStore;
    const target = request.page.offset + request.page.limit + 1;
    const lexical = (limit: number, offset: number) => store.lexicalSearch({
      query: request.text, projectKey: request.filters.projectKey, role: request.filters.role,
      providers: request.filters.providers, sessionId: request.filters.sessionId, agentName: request.filters.agentName,
      agentRole: request.filters.agentRole, model: request.filters.model, modelProvider: request.filters.modelProvider,
      limit, offset,
    }).pipe(Effect.withSpan("search.lexicalScan"));
    if (request.mode === "lexical") {
      const searchStarted = performance.now();
      const result = pageRows(yield* lexical(request.page.limit + 1, request.page.offset), request.page);
      const searchMs = Math.round(performance.now() - searchStarted);
      const receipt = { mode: request.mode, query: request.text, readinessMs: 0, searchMs, totalMs: Math.round(performance.now() - started) } satisfies SearchReceipt;
      yield* recordSearchReceiptMetrics(receipt);
      return { kind: "search" as const, matches: result.rows, page: result.page, receipt, degraded: false };
    }
    const hasSessionFilters = request.filters.sessionId !== undefined || request.filters.agentName !== undefined
      || request.filters.agentRole !== undefined || request.filters.model !== undefined || request.filters.modelProvider !== undefined;
    const candidateLimit = Math.min(MAX_SEARCH_CANDIDATES, hasSessionFilters ? MAX_SEARCH_CANDIDATES : Math.max(target, 50));
    if (request.mode === "semantic") {
      const searchStarted = performance.now();
      const outcome = yield* semanticSearch(request.text, request.filters, candidateLimit).pipe(Effect.withSpan("search.semantic"));
      const result = pageRows(outcome.matches.slice(request.page.offset, request.page.offset + request.page.limit + 1), request.page);
      const receipt = { mode: request.mode, query: request.text, readinessMs: 0, searchMs: Math.round(performance.now() - searchStarted), embedMs: outcome.embedMs, totalMs: Math.round(performance.now() - started) } satisfies SearchReceipt;
      yield* recordSearchReceiptMetrics(receipt);
      return { kind: "search" as const, matches: result.rows, page: result.page, receipt, degraded: false };
    }
    const searchStarted = performance.now();
    const [lexicalHits, semantic] = yield* Effect.all([
      lexical(candidateLimit, 0),
      semanticSearch(request.text, request.filters, candidateLimit).pipe(Effect.withSpan("search.semantic"), Effect.either),
    ], { concurrency: "unbounded" });
    if (Either.isLeft(semantic) && semantic.left._tag !== "QueryEmbeddingUnavailableError") return yield* semantic.left;
    const semanticHits = Either.isRight(semantic) ? semantic.right.matches : [];
    const result = pageRows(fuseByReciprocalRank(lexicalHits, semanticHits).slice(request.page.offset, request.page.offset + request.page.limit + 1), request.page);
    const receipt = {
      mode: request.mode, query: request.text, readinessMs: 0, searchMs: Math.round(performance.now() - searchStarted),
      ...(Either.isRight(semantic) ? { embedMs: semantic.right.embedMs } : {}), totalMs: Math.round(performance.now() - started),
    } satisfies SearchReceipt;
    yield* recordSearchReceiptMetrics(receipt);
    return {
      kind: "search" as const, matches: result.rows, page: result.page, receipt,
      degraded: Either.isLeft(semantic),
      ...(Either.isLeft(semantic) ? { degradedReason: semantic.left.message } : {}),
    };
  }).pipe(Effect.withSpan("search.fusion"));

/** The sole typed read/search execution surface. HTTP handlers parse params and render it. */
export const executeResourceQuery = (request: ResourceQuery): Effect.Effect<ResourceQueryResult, unknown, LocalStore | VectorMatrix | Embeddings> =>
  Effect.gen(function* () {
    const store = yield* LocalStore;
    switch (request.kind) {
      case "sessions": {
        const rows = yield* store.querySessions({ ...request.filters, limit: request.page.limit + 1, offset: request.page.offset });
        const result = pageRows(rows, request.page);
        return { kind: "sessions", ...result };
      }
      case "messages": {
        const rows = yield* store.queryMessages({ sessionId: request.filters.sessionId, role: request.filters.role, model: request.filters.model, modelProvider: request.filters.modelProvider, limit: request.page.limit + 1, offset: request.page.offset });
        const result = pageRows(rows, request.page);
        return { kind: "messages", ...result };
      }
      case "toolCalls": {
        const rows = yield* store.queryToolCalls({ ...request.filters, includeInput: false, includeOutput: false, limit: request.page.limit + 1, offset: request.page.offset });
        const result = pageRows(rows, request.page);
        return { kind: "toolCalls", ...result };
      }
      case "toolCall": {
        const rows = yield* store.queryToolCalls({ toolCallId: request.id, includeInput: true, includeOutput: true, limit: 1, offset: 0 });
        return { kind: "toolCall", row: rows[0] };
      }
      case "search": return yield* executeSearch(request);
    }
  });
