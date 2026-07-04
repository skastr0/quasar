import { HttpMiddleware, HttpRouter, HttpServer, HttpServerRequest, HttpServerResponse } from "@effect/platform";
import { BunHttpServer, BunRuntime } from "@effect/platform-bun";
import { Effect, Layer, Schema } from "effect";

import { LocalServerConfig } from "./config";
import { embeddingProviderFromEnv } from "./embeddingProfiles";
import { providerFromSessionId } from "./fts5";
import { ingestMappedSession } from "./ingest";
import { ok } from "./json";
import type { MappedSession } from "./model";
import { Provider } from "./provider";
import { AppLayer } from "./runtime";
import { DerivedSearch } from "./search";
import { DurableQueue, Embeddings, IngestCoordinator, WorkerSupervisor } from "./services";
import { LocalStore, type LocalStoreService, type SearchHit } from "./store";
import { VectorMatrix, type VectorMatrixHit } from "./vectorMatrix";

const json = (value: unknown, options?: { readonly status?: number }) =>
  HttpServerResponse.unsafeJson(value, { status: options?.status });

const badRequest = (route: string, message: string) =>
  json({ ok: false, route, error: { type: "BadRequest", message } }, { status: 400 });

/** Honest fast 503 for the semantic surfaces while no resident matrix exists
 * in this process (boot found no vectors for the active profile, or the boot
 * load has not finished). This is the degrade mode, not a gate: once the
 * matrix exists, semantic serves from it and never 503s again this process. */
const semanticDisabled = (route: string) =>
  json(
    {
      ok: false,
      route,
      error: {
        type: "SemanticDisabled",
        message: "semantic search disabled pending vector materialization (QSR-232)",
      },
    },
    { status: 503 },
  );

/** The matrix exists but the query embedder is unreachable: semantic queries
 * need a query vector, so the mode is temporarily unavailable. */
const embeddingUnavailable = (route: string, message: string) =>
  json(
    { ok: false, route, error: { type: "EmbeddingUnavailable", message } },
    { status: 503 },
  );

const unauthorized = (route: string, message: string) =>
  json({ ok: false, route, error: { type: "Unauthorized", message } }, { status: 401 });

const serviceUnavailable = (route: string, message: string) =>
  json({ ok: false, route, error: { type: "ServiceUnavailable", message } }, { status: 503 });

const notFound = (route: string, message: string) =>
  json({ ok: false, route, error: { type: "NotFound", message } }, { status: 404 });

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const isString = (value: unknown): value is string => typeof value === "string";

const isOptionalString = (value: unknown): value is string | undefined =>
  value === undefined || typeof value === "string";

const isSeq = (value: unknown): value is number =>
  typeof value === "number" && Number.isInteger(value) && value >= 0;

const isNonNegativeInt = (value: unknown): value is number =>
  typeof value === "number" && Number.isInteger(value) && value >= 0;

const isFingerprintProbe = (value: unknown): value is { readonly sessionId: string; readonly sourceFingerprint: string } =>
  isRecord(value)
  && isString(value.sessionId)
  && value.sessionId.trim() !== ""
  && isString(value.sourceFingerprint)
  && value.sourceFingerprint.trim() !== "";

const providers = new Set<string>(Provider.literals);

const roles = new Set<string>(["user", "assistant", "reasoning"]);

const isProjectRow = (value: unknown): boolean =>
  isRecord(value)
  && isString(value.projectKey)
  && isString(value.displayName)
  && isOptionalString(value.rawPath);

const isSessionRow = (value: unknown): boolean =>
  isRecord(value)
  && isString(value.sessionId)
  && isString(value.projectKey)
  && isString(value.provider)
  && providers.has(value.provider)
  && isString(value.agentName)
  && isOptionalString(value.title)
  && isOptionalString(value.startedAt)
  && isOptionalString(value.updatedAt)
  && isString(value.sourcePath)
  && isString(value.sourceFingerprint)
  && isString(value.host)
  && isNonNegativeInt(value.identitySchemeVersion)
  && isOptionalString(value.parentSessionId)
  && isNonNegativeInt(value.messageCount)
  && isNonNegativeInt(value.toolCallCount);

const isMessageRow = (sessionId: string, projectKey: string, value: unknown): boolean =>
  isRecord(value)
  && value.sessionId === sessionId
  && value.projectKey === projectKey
  && isSeq(value.seq)
  && isString(value.role)
  && roles.has(value.role)
  && isString(value.text)
  && isOptionalString(value.ts)
  && isString(value.contentHash);

const isToolCallRow = (sessionId: string, projectKey: string, provider: string, value: unknown): boolean =>
  isRecord(value)
  && isString(value.id)
  && value.sessionId === sessionId
  && value.projectKey === projectKey
  && value.provider === provider
  && isSeq(value.seq)
  && isString(value.toolName)
  && isOptionalString(value.status)
  && isString(value.inputText)
  && isString(value.outputText)
  && isOptionalString(value.startedAt)
  && isOptionalString(value.completedAt);

const isMappedSession = (value: unknown): value is MappedSession => {
  if (!isRecord(value)) return false;
  const project = value.project;
  const session = value.session;
  if (!isRecord(project) || !isRecord(session)) return false;
  if (!isProjectRow(project) || !isSessionRow(session)) return false;
  if (project.projectKey !== session.projectKey) return false;
  if (!Array.isArray(value.messages) || !Array.isArray(value.toolCalls)) return false;
  const sessionId = session.sessionId as string;
  const projectKey = session.projectKey as string;
  const provider = session.provider as string;
  const messageCount = session.messageCount as number;
  const toolCallCount = session.toolCallCount as number;
  if (value.messages.length !== messageCount || value.toolCalls.length !== toolCallCount) return false;
  return value.messages.every((row) => isMessageRow(sessionId, projectKey, row))
    && value.toolCalls.every((row) => isToolCallRow(sessionId, projectKey, provider, row));
};

const configuredIngestToken = (): string | undefined => {
  const token = process.env.QUASAR_INGEST_TOKEN?.trim();
  return token === undefined || token === "" ? undefined : token;
};

const requestIngestToken = (request: HttpServerRequest.HttpServerRequest): string | undefined => {
  const header = request.headers["x-quasar-ingest-token"] ?? request.headers.authorization;
  if (header === undefined) return undefined;
  const trimmed = header.trim();
  return trimmed.toLowerCase().startsWith("bearer ") ? trimmed.slice(7).trim() : trimmed;
};

const query = Effect.map(HttpServerRequest.HttpServerRequest, (request) =>
  new URL(request.url, "http://quasar.local").searchParams,
);

const positiveInt = (params: URLSearchParams, name: string, fallback: number): number => {
  const raw = params.get(name);
  if (raw === null) return fallback;
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
};

const health = Effect.gen(function* () {
  const config = yield* LocalServerConfig;
  const store = yield* LocalStore;
  const stats = yield* store.stats.pipe(Effect.either);
  return json(ok("health", { status: "ok", home: config.home, sqlite: store.dbPath, stats }));
});

// /ready: cheap truth, no index probing. Lexical serves straight from the
// SQLite messages truth table; semantic/fusion serve from the resident vector
// matrix when this process booted with one, and are honestly disabled
// otherwise. Reads only in-memory state — never SQL, never the embedder.
// /health: always 200 if the process is up.
const ready = Effect.gen(function* () {
  const matrix = yield* VectorMatrix;
  const status = yield* matrix.status;
  if (!status.enabled) {
    return json(ok("ready", {
      modes: { lexical: true, semantic: false, fusion: false },
      reason: "semantic pending vector materialization",
    }));
  }
  return json(ok("ready", {
    modes: { lexical: true, semantic: true, fusion: true },
    matrix: {
      model: status.model,
      rows: status.rows,
      dimensions: status.dimensions,
      kernel: status.kernel,
      watermark: status.watermark,
    },
  }));
});

const status = Effect.gen(function* () {
  const [store, queue, embeddings, ingest, workers, matrix] = yield* Effect.all([
    LocalStore,
    DurableQueue,
    Embeddings,
    IngestCoordinator,
    WorkerSupervisor,
    VectorMatrix,
  ]);
  const [sqlite, queueStats, queueByKind, embeddingStatus, ingestStatus, workerStatus, matrixStatus] = yield* Effect.all([
    store.stats.pipe(Effect.either),
    queue.stats,
    queue.statsByKind,
    embeddings.status,
    ingest.status,
    workers.status,
    matrix.status,
  ]);
  return json(ok("status", {
    sqlite,
    queue: { ...queueStats, byKind: queueByKind },
    embeddings: embeddingStatus,
    ingest: ingestStatus,
    workers: workerStatus,
    vectorMatrix: matrixStatus,
  }));
});

const projects = Effect.gen(function* () {
  const store = yield* LocalStore;
  const params = yield* query;
  const rows = yield* store.listProjects({
    limit: positiveInt(params, "limit", 100),
    offset: positiveInt(params, "offset", 0),
  });
  return json(ok("projects", { rows }));
});

const sessions = Effect.gen(function* () {
  const store = yield* LocalStore;
  const params = yield* query;
  const rows = yield* store.listSessions({
    provider: params.get("provider") ?? undefined,
    projectKey: params.get("projectKey") ?? undefined,
    limit: positiveInt(params, "limit", 100),
    offset: positiveInt(params, "offset", 0),
  });
  return json(ok("sessions", { rows }));
});

const messages = Effect.gen(function* () {
  const store = yield* LocalStore;
  const params = yield* query;
  const sessionId = params.get("sessionId");
  if (sessionId === null || sessionId.trim() === "") {
    return badRequest("messages", "sessionId is required");
  }
  const rows = yield* store.readMessages(sessionId, positiveInt(params, "limit", 1000));
  return json(ok("messages", { sessionId, rows }));
});

const toolCalls = Effect.gen(function* () {
  const store = yield* LocalStore;
  const params = yield* query;
  const rows = yield* store.listToolCalls({
    sessionId: params.get("sessionId") ?? undefined,
    projectKey: params.get("projectKey") ?? undefined,
    provider: params.get("provider") ?? undefined,
    toolName: params.get("toolName") ?? undefined,
    limit: positiveInt(params, "limit", 100),
    offset: positiveInt(params, "offset", 0),
  });
  return json(ok("tool-calls", { rows }));
});

const toolCall = Effect.gen(function* () {
  const store = yield* LocalStore;
  const params = yield* query;
  const id = params.get("id");
  if (id === null || id.trim() === "") {
    return badRequest("tool-call", "id is required");
  }
  const row = yield* store.getToolCall(id);
  return row === undefined ? notFound("tool-call", `tool call not found: ${id}`) : json(ok("tool-call", { row }));
});

const ingestRuns = Effect.gen(function* () {
  const store = yield* LocalStore;
  const params = yield* query;
  const rows = yield* store.listIngestRuns({
    status: (params.get("status") ?? undefined) as never,
    limit: positiveInt(params, "limit", 100),
    offset: positiveInt(params, "offset", 0),
  });
  return json(ok("ingest-runs", { rows }));
});

const ingestRun = Effect.gen(function* () {
  const store = yield* LocalStore;
  const params = yield* query;
  const runId = params.get("runId");
  if (runId === null || runId.trim() === "") {
    return badRequest("ingest-run", "runId is required");
  }
  const row = yield* store.getIngestRun(runId);
  return row === undefined ? notFound("ingest-run", `ingest run not found: ${runId}`) : json(ok("ingest-run", { row }));
});

const ingestFingerprint = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const requiredToken = configuredIngestToken();
  if (requiredToken === undefined) {
    return serviceUnavailable("ingest/fingerprint", "QUASAR_INGEST_TOKEN must be configured before remote ingest is enabled");
  }
  if (requestIngestToken(request) !== requiredToken) {
    return unauthorized("ingest/fingerprint", "valid x-quasar-ingest-token header is required");
  }
  const bodyResult = yield* Effect.either(HttpServerRequest.schemaBodyJson(Schema.Unknown));
  if (bodyResult._tag === "Left") {
    return badRequest("ingest/fingerprint", "request body must be valid JSON");
  }
  const body = bodyResult.right;
  if (!isRecord(body) || !isFingerprintProbe(body.probe)) {
    return badRequest("ingest/fingerprint", "JSON body must be { probe: { sessionId, sourceFingerprint } }");
  }
  const store = yield* LocalStore;
  const unchanged = yield* store.hasSessionFingerprint(body.probe.sessionId, body.probe.sourceFingerprint).pipe(
    Effect.catchAll(() => Effect.succeed(false)),
  );
  return json(ok("ingest/fingerprint", { unchanged }));
});

const ingestSession = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const requiredToken = configuredIngestToken();
  if (requiredToken === undefined) {
    return serviceUnavailable("ingest/session", "QUASAR_INGEST_TOKEN must be configured before remote ingest is enabled");
  }
  if (requestIngestToken(request) !== requiredToken) {
    return unauthorized("ingest/session", "valid x-quasar-ingest-token header is required");
  }
  const params = yield* query;
  const bodyResult = yield* Effect.either(HttpServerRequest.schemaBodyJson(Schema.Unknown));
  if (bodyResult._tag === "Left") {
    return badRequest("ingest/session", "request body must be valid JSON");
  }
  const body = bodyResult.right;
  if (!isRecord(body) || !isMappedSession(body.session)) {
    return badRequest("ingest/session", "JSON body must be { session: MappedSession } with matching row counts and row ownership");
  }
  const mapped = body.session;
  const outcome = yield* ingestMappedSession(mapped, { force: booleanParam(params, "force", false) }).pipe(
    Effect.catchAll((error) =>
      Effect.succeed({
        sessionId: mapped.session.sessionId,
        status: "failed" as const,
        diagnostic: "write_or_enqueue_failed",
        detail: error instanceof Error ? error.message : String(error),
        messagesWritten: 0,
        toolCallsWritten: 0,
        jobsEnqueued: 0,
      }),
    ),
  );
  const status = outcome.status === "failed" ? 500 : 200;
  return json(ok("ingest/session", { outcome }), { status });
});

type SearchMode = "lexical" | "semantic" | "fusion";

interface SearchReceipt {
  readonly route: string;
  readonly mode: SearchMode;
  readonly query: string;
  readonly limit: number;
  readonly statusCode: number;
  readonly startedAt: string;
  readonly completedAt: string;
  readonly readinessMs: number;
  readonly searchMs: number;
  readonly totalMs: number;
  readonly residualMs: number;
  readonly matches: number;
  readonly tableName?: string;
  readonly embedMs?: number;
}

const searchProfileEnabled = (): boolean => process.env.QUASAR_SEARCH_PROFILE === "1";

const emitSearchProfile = (profile: SearchReceipt) =>
  Effect.sync(() => {
    if (!searchProfileEnabled()) return;
    console.log(JSON.stringify({ event: "search.profile", at: new Date().toISOString(), ...profile }));
  });

const lexicalSearch = Effect.gen(function* () {
  const routeStarted = performance.now();
  const startedAt = new Date().toISOString();
  const search = yield* DerivedSearch;
  const params = yield* query;
  const text = params.get("q") ?? params.get("query");
  if (text === null || text.trim() === "") {
    return badRequest("search/lexical", "q is required");
  }
  const searchStarted = performance.now();
  const matches = yield* search.lexicalSearch({
    query: text,
    projectKey: params.get("projectKey") ?? undefined,
    role: params.get("role") ?? undefined,
    providers: parseProviders(params),
    limit: positiveInt(params, "limit", 10),
  });
  const searchMs = Math.round(performance.now() - searchStarted);
  const totalMs = Math.round(performance.now() - routeStarted);
  const receipt: SearchReceipt = {
    route: "search/lexical",
    mode: "lexical",
    query: text,
    limit: positiveInt(params, "limit", 10),
    statusCode: 200,
    startedAt,
    completedAt: new Date().toISOString(),
    readinessMs: 0,
    searchMs,
    totalMs,
    residualMs: Math.max(0, totalMs - searchMs),
    matches: matches.length,
  };
  yield* emitSearchProfile(receipt);
  return json(ok("search/lexical", { matches, receipt: searchProfileEnabled() ? receipt : undefined }));
});

const parseProviders = (params: URLSearchParams): readonly string[] | undefined => {
  const raw = params.get("provider");
  if (raw === null || raw.trim() === "") return undefined;
  const list = raw.split(",").map((p) => p.trim()).filter((p) => p.length > 0);
  return list.length > 0 ? list : undefined;
};

/** Assemble semantic hits into lexical-shaped SearchHit rows by fetching the
 * current message truth rows for the top-k keys. Hits whose message no longer
 * exists are dropped — the matrix may run behind SQLite by design. */
const assembleSemanticMatches = (
  store: LocalStoreService,
  hits: readonly VectorMatrixHit[],
): Effect.Effect<readonly SearchHit[], unknown> =>
  Effect.gen(function* () {
    if (hits.length === 0) return [];
    const rows = yield* store.getMessagesBySessionSeq(
      hits.map((hit) => ({ sessionId: hit.sessionId, seq: hit.seq })),
    );
    const byKey = new Map(rows.map((row) => [`${row.sessionId} ${row.seq}`, row]));
    const matches: SearchHit[] = [];
    for (const hit of hits) {
      const row = byKey.get(`${hit.sessionId} ${hit.seq}`);
      if (row === undefined) continue;
      const key = `${row.sessionId}:${row.seq}:${row.role}`;
      matches.push({
        key,
        score: hit.score,
        row: {
          key,
          sessionId: row.sessionId,
          seq: row.seq,
          role: row.role,
          projectKey: row.projectKey,
          provider: providerFromSessionId(row.sessionId),
          text: row.text,
          contentHash: row.contentHash,
        },
      });
    }
    return matches;
  });

interface SemanticQueryOutcome {
  readonly matches: readonly SearchHit[];
  readonly embedMs: number;
  readonly searchMs: number;
}

/** Shared semantic pipeline for /search/semantic and the semantic arm of
 * /search/fusion: embed the query through the active profile, prefilter to an
 * exact candidate set when any scope filter is present, scan the resident
 * matrix, and assemble truth rows. */
const runSemanticQuery = (options: {
  readonly text: string;
  readonly limit: number;
  readonly model: string;
  readonly projectKey?: string;
  readonly role?: string;
  readonly providers?: readonly string[];
}) =>
  Effect.gen(function* () {
    const [matrix, embeddings, store] = yield* Effect.all([VectorMatrix, Embeddings, LocalStore]);
    const embedStarted = performance.now();
    const vector = yield* embeddings.embedText(options.text);
    const embedMs = Math.round(performance.now() - embedStarted);
    const searchStarted = performance.now();
    const filtered = options.projectKey !== undefined || options.role !== undefined || options.providers !== undefined;
    const candidates = filtered
      ? yield* store.listMessageVectorKeys({
        model: options.model,
        projectKey: options.projectKey,
        providers: options.providers,
        role: options.role,
      })
      : undefined;
    const hits = yield* matrix.search({ vector, limit: options.limit, candidates });
    const matches = yield* assembleSemanticMatches(store, hits);
    const searchMs = Math.round(performance.now() - searchStarted);
    return { matches, embedMs, searchMs } satisfies SemanticQueryOutcome;
  });

const semanticSearch = Effect.gen(function* () {
  const routeStarted = performance.now();
  const startedAt = new Date().toISOString();
  const matrix = yield* VectorMatrix;
  const matrixStatus = yield* matrix.status;
  if (!matrixStatus.enabled) return semanticDisabled("search/semantic");
  const params = yield* query;
  const text = params.get("q") ?? params.get("query");
  if (text === null || text.trim() === "") {
    return badRequest("search/semantic", "q is required");
  }
  const limit = positiveInt(params, "limit", 10);
  const outcome = yield* runSemanticQuery({
    text,
    limit,
    model: matrixStatus.model,
    projectKey: params.get("projectKey") ?? undefined,
    role: params.get("role") ?? undefined,
    providers: parseProviders(params),
  }).pipe(Effect.either);
  if (outcome._tag === "Left") {
    const failure = outcome.left;
    if (typeof failure === "object" && failure !== null && (failure as { _tag?: string })._tag === "VectorMatrixDisabledError") {
      return semanticDisabled("search/semantic");
    }
    if (typeof failure === "object" && failure !== null && (failure as { _tag?: string })._tag === "VectorMatrixError") {
      return yield* Effect.fail(failure);
    }
    return embeddingUnavailable(
      "search/semantic",
      failure instanceof Error ? failure.message : String(failure),
    );
  }
  const totalMs = Math.round(performance.now() - routeStarted);
  const receipt: SearchReceipt = {
    route: "search/semantic",
    mode: "semantic",
    query: text,
    limit,
    statusCode: 200,
    startedAt,
    completedAt: new Date().toISOString(),
    readinessMs: 0,
    searchMs: outcome.right.searchMs,
    totalMs,
    residualMs: Math.max(0, totalMs - outcome.right.searchMs - outcome.right.embedMs),
    matches: outcome.right.matches.length,
    embedMs: outcome.right.embedMs,
  };
  yield* emitSearchProfile(receipt);
  return json(ok("search/semantic", { matches: outcome.right.matches, receipt: searchProfileEnabled() ? receipt : undefined }));
});

// Reciprocal-rank fusion over the lexical and semantic lists: constant k, no
// tuning knobs in this slice. Ranks are 0-based positions in each list.
const RRF_K = 60;
const FUSION_POOL = 50;

const fuseByReciprocalRank = (
  lexical: readonly SearchHit[],
  semantic: readonly SearchHit[],
  limit: number,
): readonly SearchHit[] => {
  const fused = new Map<string, { score: number; row: SearchHit["row"] }>();
  const contribute = (hits: readonly SearchHit[]) => {
    for (let rank = 0; rank < hits.length; rank += 1) {
      const hit = hits[rank]!;
      const entry = fused.get(hit.key);
      const contribution = 1 / (RRF_K + rank + 1);
      if (entry === undefined) fused.set(hit.key, { score: contribution, row: hit.row });
      else entry.score += contribution;
    }
  };
  contribute(lexical);
  contribute(semantic);
  return [...fused.entries()]
    .map(([key, entry]) => ({ key, score: entry.score, row: entry.row }))
    .sort((left, right) => right.score - left.score || (left.key < right.key ? -1 : 1))
    .slice(0, limit);
};

const fusionSearch = Effect.gen(function* () {
  const routeStarted = performance.now();
  const startedAt = new Date().toISOString();
  const matrix = yield* VectorMatrix;
  const matrixStatus = yield* matrix.status;
  if (!matrixStatus.enabled) return semanticDisabled("search/fusion");
  const params = yield* query;
  const text = params.get("q") ?? params.get("query");
  if (text === null || text.trim() === "") {
    return badRequest("search/fusion", "q is required");
  }
  const limit = positiveInt(params, "limit", 10);
  const pool = Math.max(limit, FUSION_POOL);
  const projectKey = params.get("projectKey") ?? undefined;
  const role = params.get("role") ?? undefined;
  const providers = parseProviders(params);
  const search = yield* DerivedSearch;
  const searchStarted = performance.now();
  const lexicalHits = yield* search.lexicalSearch({ query: text, projectKey, role, providers, limit: pool });
  const semanticOutcome = yield* runSemanticQuery({
    text,
    limit: pool,
    model: matrixStatus.model,
    projectKey,
    role,
    providers,
  }).pipe(Effect.either);
  if (semanticOutcome._tag === "Left") {
    const failure = semanticOutcome.left;
    if (typeof failure === "object" && failure !== null && (failure as { _tag?: string })._tag === "VectorMatrixDisabledError") {
      return semanticDisabled("search/fusion");
    }
    if (typeof failure === "object" && failure !== null && (failure as { _tag?: string })._tag === "VectorMatrixError") {
      return yield* Effect.fail(failure);
    }
    return embeddingUnavailable(
      "search/fusion",
      failure instanceof Error ? failure.message : String(failure),
    );
  }
  const matches = fuseByReciprocalRank(lexicalHits, semanticOutcome.right.matches, limit);
  const searchMs = Math.round(performance.now() - searchStarted);
  const totalMs = Math.round(performance.now() - routeStarted);
  const receipt: SearchReceipt = {
    route: "search/fusion",
    mode: "fusion",
    query: text,
    limit,
    statusCode: 200,
    startedAt,
    completedAt: new Date().toISOString(),
    readinessMs: 0,
    searchMs,
    totalMs,
    residualMs: Math.max(0, totalMs - searchMs),
    matches: matches.length,
    embedMs: semanticOutcome.right.embedMs,
  };
  yield* emitSearchProfile(receipt);
  return json(ok("search/fusion", { matches, receipt: searchProfileEnabled() ? receipt : undefined }));
});

const booleanParam = (params: URLSearchParams, name: string, fallback: boolean): boolean => {
  const raw = params.get(name);
  if (raw === null) return fallback;
  return raw === "true" || raw === "1" || raw === "yes";
};

const httpIdleTimeoutSeconds = (): number => {
  const raw = process.env.QUASAR_HTTP_IDLE_TIMEOUT_SECONDS ?? "120";
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : 120;
};

const maintenanceReplayEmbeddingCache = Effect.gen(function* () {
  const embeddings = yield* Embeddings;
  const store = yield* LocalStore;
  const params = yield* query;
  const report = yield* embeddings.materializeCachedVectors({
    limit: positiveInt(params, "limit", 1_000),
  });
  const coverage = yield* store.messageVectorCoverage(embeddings.profile.cacheNamespace);
  return json(ok("maintenance/embeddings/replay-cache", { report, coverage }));
});

const maintenanceMaterializeSqliteEmbeddingVectors = Effect.gen(function* () {
  const embeddings = yield* Embeddings;
  const store = yield* LocalStore;
  const params = yield* query;
  const report = yield* embeddings.materializeMissingVectorsToSqlite({
    limit: positiveInt(params, "limit", 1_000),
  });
  const coverage = yield* store.messageVectorCoverage(embeddings.profile.cacheNamespace);
  return json(ok("maintenance/embeddings/materialize-sqlite", {
    report,
    coverage,
    embedding: { provider: embeddingProviderFromEnv(), profile: embeddings.profile },
  }));
});

// Minimal self-contained dashboard served at the canonical root URL. No external
// assets or egress: it calls the same-origin /status and /search/{mode} endpoints.
const DASHBOARD_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Quasar</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin:0; font:14px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace; background:#0b0e14; color:#c9d1d9; }
  header { padding:16px 20px; border-bottom:1px solid #1c2230; display:flex; align-items:baseline; gap:12px; }
  header h1 { margin:0; font-size:18px; color:#7ee787; letter-spacing:1px; }
  header .status { color:#768390; font-size:12px; }
  main { max-width:920px; margin:0 auto; padding:20px; }
  form { display:flex; gap:8px; margin-bottom:16px; flex-wrap:wrap; }
  input[type=text] { flex:1; min-width:240px; padding:10px 12px; background:#11151f; border:1px solid #1c2230; border-radius:6px; color:#c9d1d9; font:inherit; }
  select, button { padding:10px 12px; background:#11151f; border:1px solid #1c2230; border-radius:6px; color:#c9d1d9; font:inherit; cursor:pointer; }
  button { background:#238636; border-color:#2ea043; color:#fff; }
  button:hover { background:#2ea043; }
  .meta { color:#768390; font-size:12px; margin-bottom:12px; min-height:16px; }
  .result { padding:12px; border:1px solid #1c2230; border-radius:6px; margin-bottom:10px; background:#0e121b; }
  .result .head { display:flex; gap:10px; align-items:center; font-size:12px; color:#768390; margin-bottom:6px; }
  .badge { padding:1px 8px; border-radius:10px; background:#1c2230; color:#7ee787; font-size:11px; }
  .result .text { white-space:pre-wrap; word-break:break-word; color:#adbac7; }
  .empty { color:#768390; padding:24px; text-align:center; }
</style>
</head>
<body>
<header><h1>QUASAR</h1><span class="status" id="status">connecting…</span></header>
<main>
  <form id="f">
    <input type="text" id="q" placeholder="search session memory…" autofocus>
    <select id="mode"><option value="fusion">fusion</option><option value="lexical">lexical</option><option value="semantic">semantic</option></select>
    <button type="submit">search</button>
  </form>
  <div class="meta" id="meta"></div>
  <div id="results"></div>
</main>
<script>
  var statusEl=document.getElementById("status");
  fetch("/status").then(function(r){return r.json()}).then(function(d){
    var s=(((d.data||{}).sqlite||{}).right)||{};
    statusEl.textContent="server ok"+(s.sessions!=null?(" · "+s.sessions+" sessions"):"");
  }).catch(function(){statusEl.textContent="server unreachable";});
  function esc(s){return String(s==null?"":s).replace(/[&<>]/g,function(c){return c==="&"?"&amp;":c==="<"?"&lt;":"&gt;";});}
  var resultsEl=document.getElementById("results"), metaEl=document.getElementById("meta");
  document.getElementById("f").addEventListener("submit",function(e){
    e.preventDefault();
    var q=document.getElementById("q").value.trim(), mode=document.getElementById("mode").value;
    if(!q){return;}
    metaEl.textContent="searching…"; resultsEl.innerHTML=""; var t0=Date.now();
    fetch("/search/"+mode+"?q="+encodeURIComponent(q)+"&limit=20").then(function(r){return r.json()}).then(function(d){
      var m=((d.data||{}).matches)||[];
      metaEl.textContent=m.length+" results · "+mode+" · "+(Date.now()-t0)+"ms";
      if(!m.length){resultsEl.innerHTML='<div class="empty">no matches</div>';return;}
      resultsEl.innerHTML=m.map(function(x){
        var row=x.row||x, sid=String(row.sessionId||""), prov=sid.split(":")[0]||"?", text=String(row.text||row.preview||"");
        return '<div class="result"><div class="head"><span class="badge">'+esc(prov)+'</span><span>'+esc(sid)+'</span></div><div class="text">'+esc(text.slice(0,600))+'</div></div>';
      }).join("");
    }).catch(function(err){metaEl.textContent="error: "+err;});
  });
</script>
</body>
</html>`;

const dashboard = HttpServerResponse.html(DASHBOARD_HTML);

const routes = HttpRouter.empty.pipe(
  HttpRouter.get("/health", health),
  HttpRouter.get("/ready", ready),
  HttpRouter.get("/status", status),
  HttpRouter.get("/projects", projects),
  HttpRouter.get("/sessions", sessions),
  HttpRouter.get("/messages", messages),
  HttpRouter.get("/tool-calls", toolCalls),
  HttpRouter.get("/tool-call", toolCall),
  HttpRouter.get("/ingest-runs", ingestRuns),
  HttpRouter.get("/ingest-run", ingestRun),
  HttpRouter.post("/ingest/fingerprint", ingestFingerprint),
  HttpRouter.post("/ingest/session", ingestSession),
  HttpRouter.get("/search/lexical", lexicalSearch),
  HttpRouter.get("/search/semantic", semanticSearch),
  HttpRouter.get("/search/fusion", fusionSearch),
);

const routesWithMaintenance = routes.pipe(
  HttpRouter.get("/maintenance/embeddings/replay-cache", maintenanceReplayEmbeddingCache),
  HttpRouter.get("/maintenance/embeddings/materialize-sqlite", maintenanceMaterializeSqliteEmbeddingVectors),
  HttpRouter.get("/", dashboard),
  HttpRouter.get("*", json({ ok: false, error: { type: "NotFound", message: "No route" } }, { status: 404 })),
);

export const makeHttpLayer = (options: { readonly port: number; readonly hostname?: string }) =>
  routesWithMaintenance.pipe(
    HttpServer.serve(HttpMiddleware.logger),
    HttpServer.withLogAddress,
    Layer.provide(AppLayer),
    Layer.provide(BunHttpServer.layer({ port: options.port, hostname: options.hostname ?? "127.0.0.1", idleTimeout: httpIdleTimeoutSeconds() })),
  );

export const serve = (options: { readonly port: number; readonly hostname?: string }): void => {
  BunRuntime.runMain(Layer.launch(makeHttpLayer(options)));
};
