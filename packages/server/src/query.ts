import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";

import {
  QUERY_PROTOCOL_VERSION,
  QueryResponse,
  type QuerySpec,
  decodeQueryResponse,
} from "@skastr0/quasar-protocol";
import { Effect, Either, ParseResult, Schema } from "effect";

import type {
  QueryMessageRow,
  QuerySessionRow,
  QueryToolCallRow,
} from "./model";
import { recordSearchReceiptMetrics } from "./metrics";
import { Embeddings } from "./services";
import { LocalStore, type SearchHit } from "./store";
import { VectorMatrix, type VectorMatrixHit } from "./vectorMatrix";

const CursorPayload = Schema.Struct({
  version: Schema.Literal(1),
  kind: Schema.Literal("search", "sessions", "messages", "toolCalls"),
  fingerprint: Schema.String.pipe(Schema.length(64)),
  offset: Schema.Number.pipe(Schema.int(), Schema.nonNegative()),
}).annotations({
  identifier: "QuasarQueryCursorV1",
  parseOptions: { errors: "all", onExcessProperty: "error" },
});

const CursorPayloadFromJson = Schema.parseJson(CursorPayload);

export class QueryCursorError extends Schema.TaggedError<QueryCursorError>()(
  "QueryCursorError",
  {
    message: Schema.String,
  },
) {}

export class QuerySemanticDisabledError
  extends Schema.TaggedError<QuerySemanticDisabledError>()(
    "QuerySemanticDisabledError",
    { message: Schema.String },
  ) {}

export class QueryEmbeddingUnavailableError
  extends Schema.TaggedError<QueryEmbeddingUnavailableError>()(
    "QueryEmbeddingUnavailableError",
    { message: Schema.String },
  ) {}

type Projectable = Readonly<Record<string, unknown>>;

const queryFingerprint = (spec: QuerySpec): string => {
  const page = { limit: spec.page.limit };
  return createHash("sha256")
    .update(JSON.stringify({ ...spec, page }))
    .digest("hex");
};

const encodeCursor = (
  spec: QuerySpec,
  offset: number,
): string =>
  Buffer.from(JSON.stringify({
    version: 1,
    kind: spec.kind,
    fingerprint: queryFingerprint(spec),
    offset,
  }), "utf8").toString("base64url");

const decodeCursorOffset = (
  spec: QuerySpec,
): Effect.Effect<number, QueryCursorError> =>
  Effect.gen(function* () {
    const cursor = spec.page.cursor;
    if (cursor === undefined) return 0;
    const json = yield* Effect.try({
      try: () => Buffer.from(cursor, "base64url").toString("utf8"),
      catch: () => new QueryCursorError({ message: "cursor is not valid base64url" }),
    });
    const decoded = Schema.decodeUnknownEither(CursorPayloadFromJson, {
      errors: "all",
      onExcessProperty: "error",
    })(json);
    if (Either.isLeft(decoded)) {
      return yield* new QueryCursorError({
        message: ParseResult.TreeFormatter.formatErrorSync(decoded.left),
      });
    }
    if (
      decoded.right.kind !== spec.kind
      || decoded.right.fingerprint !== queryFingerprint(spec)
    ) {
      return yield* new QueryCursorError({
        message: "cursor does not belong to this query",
      });
    }
    return decoded.right.offset;
  });

const responsePage = (
  spec: QuerySpec,
  offset: number,
  returned: number,
  hasMore: boolean,
) => ({
  returned,
  ...(hasMore ? { nextCursor: encodeCursor(spec, offset + returned) } : {}),
});

const selectFields = (
  fields: ReadonlyArray<string>,
  row: Projectable,
): Record<string, unknown> =>
  Object.fromEntries(fields.map((field) => [field, row[field] ?? null]));

const timestampOrNull = (value: string | null): string | null =>
  value !== null && Number.isFinite(Date.parse(value)) ? value : null;

const sessionProjectionRow = (row: QuerySessionRow): Projectable => ({
  ...row,
  startedAt: timestampOrNull(row.startedAt),
  endedAt: timestampOrNull(row.endedAt),
});

const messageProjectionRow = (row: QueryMessageRow): Projectable => ({
  ...row,
  timestamp: timestampOrNull(row.timestamp),
});

const parseToolPayload = (text: string | undefined): unknown => {
  if (text === undefined) return null;
  if (text === "") return "";
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
};

const toolCallProjectionRow = (row: QueryToolCallRow): Projectable => ({
  toolCallId: row.toolCallId,
  sessionId: row.sessionId,
  projectKey: row.projectKey,
  provider: row.provider,
  sequence: row.sequence,
  toolName: row.toolName,
  timestamp: timestampOrNull(row.timestamp),
  status: row.status,
  startedAt: timestampOrNull(row.startedAt),
  completedAt: timestampOrNull(row.completedAt),
  inputBytes: row.inputBytes,
  outputBytes: row.outputBytes,
  agentName: row.agentName,
  agentRole: row.agentRole,
  model: row.model,
  modelProvider: row.modelProvider,
  input: parseToolPayload(row.inputText),
  output: parseToolPayload(row.outputText),
  // Quasar persists provider tool output losslessly, but providers do not
  // expose one common standalone error field. Null is the honest projection;
  // callers can request output alongside it.
  error: null,
});

const searchProjectionRow = (hit: SearchHit): Projectable => ({
  ...hit.row,
  score: hit.score,
});

const pageRows = <A>(
  rows: readonly A[],
  limit: number,
): { readonly rows: readonly A[]; readonly hasMore: boolean } => ({
  rows: rows.slice(0, limit),
  hasMore: rows.length > limit,
});

const projectResponse = (
  spec: QuerySpec,
  offset: number,
  rows: readonly Projectable[],
  hasMore: boolean,
) => {
  const items = rows.map((row) => selectFields(spec.projection.fields, row));
  return {
    protocolVersion: QUERY_PROTOCOL_VERSION,
    kind: spec.kind,
    projection: spec.projection,
    page: responsePage(spec, offset, items.length, hasMore),
    items,
  };
};

const hydrateSemanticHits = (
  hits: readonly VectorMatrixHit[],
  filters: Extract<QuerySpec, { readonly kind: "search" }>["filters"],
) =>
  Effect.gen(function* () {
    const store = yield* LocalStore;
    const rows = yield* store.queryMessagesBySessionSeq({
      pairs: hits.map(({ sessionId, seq }) => ({ sessionId, seq })),
      sessionId: filters?.sessionId,
      agentName: filters?.agentName,
      agentRole: filters?.agentRole,
      model: filters?.model,
      modelProvider: filters?.modelProvider,
    });
    const scoreByKey = new Map(
      hits.map((hit) => [`${hit.sessionId}\0${hit.seq}`, hit.score]),
    );
    return rows.map((row) => ({
      key: `${row.sessionId}:${row.sequence}`,
      score: scoreByKey.get(`${row.sessionId}\0${row.sequence}`) ?? 0,
      row: messageProjectionRow(row),
    } satisfies SearchHit));
  });

const semanticSearch = (
  spec: Extract<QuerySpec, { readonly kind: "search" }>,
  candidateLimit: number,
) =>
  Effect.gen(function* () {
    const [matrix, embeddings, store] = yield* Effect.all([
      VectorMatrix,
      Embeddings,
      LocalStore,
    ]);
    const status = yield* matrix.status.pipe(Effect.withSpan("search.readiness"));
    if (!status.enabled) {
      return yield* new QuerySemanticDisabledError({
        message: "semantic search disabled pending vector materialization",
      });
    }
    const embedStarted = performance.now();
    const vectorResult = yield* embeddings.embedText(spec.text).pipe(Effect.either);
    if (Either.isLeft(vectorResult)) {
      return yield* new QueryEmbeddingUnavailableError({
        message: vectorResult.left instanceof Error
          ? vectorResult.left.message
          : String(vectorResult.left),
      });
    }
    const embedMs = Math.round(performance.now() - embedStarted);
    const filters = spec.filters;
    const needsSessionMask = filters?.sessionId !== undefined
      || filters?.agentName !== undefined
      || filters?.agentRole !== undefined
      || filters?.model !== undefined
      || filters?.modelProvider !== undefined;
    const sessionIds = needsSessionMask
      ? new Set(yield* store.querySessionIds({
        projectKey: filters?.projectKey,
        providers: filters?.providers,
        sessionId: filters?.sessionId,
        agentName: filters?.agentName,
        agentRole: filters?.agentRole,
        model: filters?.model,
        modelProvider: filters?.modelProvider,
      }))
      : undefined;
    const hits = yield* matrix.search({
      vector: vectorResult.right,
      limit: candidateLimit,
      projectKey: filters?.projectKey,
      role: filters?.role,
      providers: filters?.providers,
      sessionIds,
    }).pipe(
      Effect.catchTag(
        "VectorMatrixDisabledError",
        () => new QuerySemanticDisabledError({
          message: "semantic search disabled pending vector materialization",
        }),
      ),
    );
    const matches = yield* hydrateSemanticHits(hits, spec.filters);
    return { matches, embedMs };
  });

const RRF_K = 60;
const MAX_SEARCH_CANDIDATES = 256;

const fuseByReciprocalRank = (
  lexical: readonly SearchHit[],
  semantic: readonly SearchHit[],
): readonly SearchHit[] => {
  const fused = new Map<string, { score: number; row: SearchHit["row"] }>();
  const add = (hits: readonly SearchHit[]) => {
    for (const [rank, hit] of hits.entries()) {
      const contribution = 1 / (RRF_K + rank + 1);
      const current = fused.get(hit.key);
      if (current === undefined) {
        fused.set(hit.key, { score: contribution, row: hit.row });
      } else {
        current.score += contribution;
      }
    }
  };
  add(lexical);
  add(semantic);
  return [...fused.entries()]
    .map(([key, value]) => ({ key, score: value.score, row: value.row }))
    .sort((left, right) => right.score - left.score
      || left.key.localeCompare(right.key));
};

const runSearch = (
  spec: Extract<QuerySpec, { readonly kind: "search" }>,
  offset: number,
) =>
  Effect.gen(function* () {
    const started = performance.now();
    const store = yield* LocalStore;
    const target = offset + spec.page.limit + 1;
    if (spec.mode === "lexical") {
      const searchStarted = performance.now();
      const matches = yield* store.lexicalSearch({
        query: spec.text,
        projectKey: spec.filters?.projectKey,
        role: spec.filters?.role,
        providers: spec.filters?.providers,
        sessionId: spec.filters?.sessionId,
        agentName: spec.filters?.agentName,
        agentRole: spec.filters?.agentRole,
        model: spec.filters?.model,
        modelProvider: spec.filters?.modelProvider,
        limit: spec.page.limit + 1,
        offset,
      }).pipe(Effect.withSpan("search.lexicalScan"));
      const searchMs = Math.round(performance.now() - searchStarted);
      yield* recordSearchReceiptMetrics({
        mode: "lexical",
        readinessMs: 0,
        searchMs,
        totalMs: Math.round(performance.now() - started),
      });
      return pageRows(matches, spec.page.limit);
    }

    const hasPostMatrixFilters = spec.filters?.sessionId !== undefined
      || spec.filters?.agentName !== undefined
      || spec.filters?.agentRole !== undefined
      || spec.filters?.model !== undefined
      || spec.filters?.modelProvider !== undefined;
    const candidateLimit = Math.min(
      MAX_SEARCH_CANDIDATES,
      hasPostMatrixFilters ? MAX_SEARCH_CANDIDATES : Math.max(target, 50),
    );

    if (spec.mode === "semantic") {
      const searchStarted = performance.now();
      const outcome = yield* semanticSearch(spec, candidateLimit).pipe(
        Effect.withSpan("search.semantic"),
      );
      const sliced = outcome.matches.slice(offset, offset + spec.page.limit + 1);
      const searchMs = Math.round(performance.now() - searchStarted);
      yield* recordSearchReceiptMetrics({
        mode: "semantic",
        readinessMs: 0,
        searchMs,
        embedMs: outcome.embedMs,
        totalMs: Math.round(performance.now() - started),
      });
      return pageRows(sliced, spec.page.limit);
    }

    const searchStarted = performance.now();
    const [lexical, semantic] = yield* Effect.all(
      [
        store.lexicalSearch({
          query: spec.text,
          projectKey: spec.filters?.projectKey,
          role: spec.filters?.role,
          providers: spec.filters?.providers,
          sessionId: spec.filters?.sessionId,
          agentName: spec.filters?.agentName,
          agentRole: spec.filters?.agentRole,
          model: spec.filters?.model,
          modelProvider: spec.filters?.modelProvider,
          limit: candidateLimit,
          offset: 0,
        }).pipe(Effect.withSpan("search.lexicalScan")),
        semanticSearch(spec, candidateLimit).pipe(
          Effect.withSpan("search.semantic"),
          Effect.either,
        ),
      ],
      { concurrency: "unbounded" },
    );
    let semanticHits: readonly SearchHit[] = [];
    let embedMs: number | undefined;
    if (Either.isRight(semantic)) {
      semanticHits = semantic.right.matches;
      embedMs = semantic.right.embedMs;
    } else if (semantic.left._tag !== "QueryEmbeddingUnavailableError") {
      return yield* semantic.left;
    }
    const fused = yield* Effect.sync(() =>
      fuseByReciprocalRank(lexical, semanticHits)
        .slice(offset, offset + spec.page.limit + 1)).pipe(
      Effect.withSpan("search.rrfFuse"),
    );
    const searchMs = Math.round(performance.now() - searchStarted);
    yield* recordSearchReceiptMetrics({
      mode: "fusion",
      readinessMs: 0,
      searchMs,
      embedMs,
      totalMs: Math.round(performance.now() - started),
    });
    return pageRows(fused, spec.page.limit);
  }).pipe(Effect.withSpan("search.fusion"));

export const executeQuery = (
  spec: QuerySpec,
): Effect.Effect<
  QueryResponse,
  QueryCursorError
  | QuerySemanticDisabledError
  | QueryEmbeddingUnavailableError
  | ParseResult.ParseError
  | unknown,
  LocalStore | VectorMatrix | Embeddings
> =>
  Effect.gen(function* () {
    const offset = yield* decodeCursorOffset(spec);
    const store = yield* LocalStore;
    let response: unknown;

    switch (spec.kind) {
      case "search": {
        const result = yield* runSearch(spec, offset);
        response = projectResponse(
          spec,
          offset,
          result.rows.map(searchProjectionRow),
          result.hasMore,
        );
        break;
      }
      case "sessions": {
        const result = pageRows(
          yield* store.querySessions({
            projectKey: spec.filters?.projectKey,
            providers: spec.filters?.providers,
            sessionId: spec.filters?.sessionId,
            agentName: spec.filters?.agentName,
            agentRole: spec.filters?.agentRole,
            model: spec.filters?.model,
            modelProvider: spec.filters?.modelProvider,
            limit: spec.page.limit + 1,
            offset,
          }),
          spec.page.limit,
        );
        response = projectResponse(
          spec,
          offset,
          result.rows.map(sessionProjectionRow),
          result.hasMore,
        );
        break;
      }
      case "messages": {
        const result = pageRows(
          yield* store.queryMessages({
            sessionId: spec.filters.sessionId,
            role: spec.filters.role,
            model: spec.filters.model,
            modelProvider: spec.filters.modelProvider,
            limit: spec.page.limit + 1,
            offset,
          }),
          spec.page.limit,
        );
        response = projectResponse(
          spec,
          offset,
          result.rows.map(messageProjectionRow),
          result.hasMore,
        );
        break;
      }
      case "toolCalls": {
        const selected = new Set(spec.projection.fields);
        const result = pageRows(
          yield* store.queryToolCalls({
            projectKey: spec.filters?.projectKey,
            providers: spec.filters?.providers,
            sessionId: spec.filters?.sessionId,
            toolCallId: spec.filters?.toolCallId,
            toolName: spec.filters?.toolName,
            agentName: spec.filters?.agentName,
            agentRole: spec.filters?.agentRole,
            model: spec.filters?.model,
            modelProvider: spec.filters?.modelProvider,
            includeInput: selected.has("input"),
            includeOutput: selected.has("output")
              || selected.has("error"),
            limit: spec.page.limit + 1,
            offset,
          }),
          spec.page.limit,
        );
        response = projectResponse(
          spec,
          offset,
          result.rows.map(toolCallProjectionRow),
          result.hasMore,
        );
        break;
      }
    }

    return yield* decodeQueryResponse(response);
  });
