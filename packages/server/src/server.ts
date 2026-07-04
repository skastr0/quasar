import { HttpMiddleware, HttpRouter, HttpServer, HttpServerRequest, HttpServerResponse } from "@effect/platform";
import { BunHttpServer, BunRuntime } from "@effect/platform-bun";
import { DEFAULT_SEARCH_TABLE, LanceDb, MESSAGE_SEARCH_COLUMNS } from "./lancedb";
import { Effect, Layer, Schema } from "effect";

import { LocalServerConfig } from "./config";
import { embeddingProfileSearchTable } from "./embeddingProfiles";
import { ingestMappedSession } from "./ingest";
import { ok } from "./json";
import { SearchMaintenance } from "./maintenance";
import type { MappedSession } from "./model";
import { Provider } from "./provider";
import { AppLayer } from "./runtime";
import { DerivedSearch, messageSearchFilter } from "./search";
import { SearchReadiness, type SearchMode } from "./searchReadiness";
import { VECTOR_READY_FILTER } from "./searchPolicy";
import { DurableQueue, Embeddings, IngestCoordinator, WorkerSupervisor } from "./services";
import { LocalStore } from "./store";

const json = (value: unknown, options?: { readonly status?: number }) =>
  HttpServerResponse.unsafeJson(value, { status: options?.status });

const badRequest = (route: string, message: string) =>
  json({ ok: false, route, error: { type: "BadRequest", message } }, { status: 400 });

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

const nonNegativeInt = (params: URLSearchParams, name: string, fallback: number): number => {
  const raw = params.get(name);
  if (raw === null) return fallback;
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : fallback;
};

const health = Effect.gen(function* () {
  const config = yield* LocalServerConfig;
  const store = yield* LocalStore;
  const stats = yield* store.stats.pipe(Effect.either);
  return json(ok("health", { status: "ok", home: config.home, sqlite: store.dbPath, stats }));
});

// /ready: 200 only when ALL search modes pass assertSearchReady.
// /health: always 200 if the process is up (never blocks on index state).
const ready = Effect.gen(function* () {
  const readiness = yield* SearchReadiness;
  const [lexical, semantic, fusion] = yield* Effect.all([
    readiness.assertSearchReady("lexical"),
    readiness.assertSearchReady("semantic"),
    readiness.assertSearchReady("fusion"),
  ]);
  const allReady = lexical.ok && semantic.ok && fusion.ok;
  if (!allReady) {
    return json(
      {
        ok: false,
        error: {
          type: "ServiceUnavailable",
          code: "SearchIndexNotReady",
          message: "Search index is not ready",
          modes: { lexical, semantic, fusion },
        },
      },
      { status: 503 },
    );
  }
  return json(ok("ready", { status: "ready", modes: { lexical, semantic, fusion } }));
});

const status = Effect.gen(function* () {
  const params = yield* query;
  const includeLanceStats = booleanParam(params, "lance", false) || booleanParam(params, "heavy", false);
  const [store, search, queue, embeddings, ingest, workers] = yield* Effect.all([
    LocalStore,
    LanceDb,
    DurableQueue,
    Embeddings,
    IngestCoordinator,
    WorkerSupervisor,
  ]);
  const [sqlite, queueStats, queueByKind, embeddingStatus, ingestStatus, workerStatus] = yield* Effect.all([
    store.stats.pipe(Effect.either),
    queue.stats,
    queue.statsByKind,
    embeddings.status,
    ingest.status,
    workers.status,
  ]);
  const activeVectorTableName = embeddingProfileSearchTable(embeddings.profile);
  const lance = includeLanceStats
    ? {
        defaultTable: yield* search.tableStats({ tableName: DEFAULT_SEARCH_TABLE }).pipe(Effect.either),
        activeVectorTableName,
        activeVectorTable: activeVectorTableName === DEFAULT_SEARCH_TABLE
          ? yield* search.tableStats({ tableName: DEFAULT_SEARCH_TABLE }).pipe(Effect.either)
          : yield* search.tableStats({ tableName: activeVectorTableName }).pipe(Effect.either),
      }
    : { _tag: "Right" as const, right: "skipped; pass ?lance=true for LanceDB table stats" };
  return json(ok("status", {
    sqlite,
    lance,
    queue: { ...queueStats, byKind: queueByKind },
    embeddings: embeddingStatus,
    ingest: ingestStatus,
    workers: workerStatus,
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

const isTableNotFoundError = (error: unknown): boolean => {
  const msg = error instanceof Error
    ? error.message
    : String((error as { message?: string }).message ?? error);
  return /not found|does not exist/i.test(msg);
};

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
  }).pipe(
    Effect.catchAll((error) =>
      isTableNotFoundError(error)
        ? Effect.succeed([] as readonly import("./lancedb").SearchHit[])
        : Effect.fail(error),
    ),
  );
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

const vectorReadyFilter = (params: URLSearchParams): string | undefined => {
  const projectKey = params.get("projectKey");
  const role = params.get("role");
  return messageSearchFilter(
    {
      projectKey: projectKey === null || projectKey.trim() === "" ? undefined : projectKey,
      role: role === null || role.trim() === "" ? undefined : role,
      providers: parseProviders(params),
    },
    VECTOR_READY_FILTER,
  );
};

const semanticSearch = Effect.gen(function* () {
  const routeStarted = performance.now();
  const startedAt = new Date().toISOString();
  const search = yield* LanceDb;
  const embeddings = yield* Embeddings;
  const params = yield* query;
  const text = params.get("q") ?? params.get("query");
  if (text === null || text.trim() === "") {
    return badRequest("search/semantic", "q is required");
  }
  const embedStarted = performance.now();
  const vector = yield* embeddings.embedText(text);
  const embedMs = Math.round(performance.now() - embedStarted);
  const tableName = embeddingProfileSearchTable(embeddings.profile);
  const searchStarted = performance.now();
  const matches = yield* search.vectorSearch({
    tableName,
    vector,
    vectorDimension: embeddings.profile.dimensions,
    limit: positiveInt(params, "limit", 10),
    filter: vectorReadyFilter(params),
    select: MESSAGE_SEARCH_COLUMNS,
  }).pipe(
    Effect.catchAll((error) =>
      isTableNotFoundError(error)
        ? Effect.succeed([] as readonly import("./lancedb").SearchHit[])
        : Effect.fail(error),
    ),
  );
  const searchMs = Math.round(performance.now() - searchStarted);
  const totalMs = Math.round(performance.now() - routeStarted);
  const receipt: SearchReceipt = {
    route: "search/semantic",
    mode: "semantic",
    query: text,
    limit: positiveInt(params, "limit", 10),
    statusCode: 200,
    startedAt,
    completedAt: new Date().toISOString(),
    tableName,
    readinessMs: 0,
    embedMs,
    searchMs,
    totalMs,
    residualMs: Math.max(0, totalMs - embedMs - searchMs),
    matches: matches.length,
  };
  yield* emitSearchProfile(receipt);
  return json(ok("search/semantic", { matches, receipt: searchProfileEnabled() ? receipt : undefined }));
});

const fusionSearch = Effect.gen(function* () {
  const routeStarted = performance.now();
  const startedAt = new Date().toISOString();
  const search = yield* LanceDb;
  const embeddings = yield* Embeddings;
  const params = yield* query;
  const text = params.get("q") ?? params.get("query");
  if (text === null || text.trim() === "") {
    return badRequest("search/fusion", "q is required");
  }
  const embedStarted = performance.now();
  const vector = yield* embeddings.embedText(text);
  const embedMs = Math.round(performance.now() - embedStarted);
  const tableName = embeddingProfileSearchTable(embeddings.profile);
  const searchStarted = performance.now();
  const matches = yield* search.hybridSearch({
    tableName,
    query: text,
    vector,
    vectorDimension: embeddings.profile.dimensions,
    limit: positiveInt(params, "limit", 10),
    filter: vectorReadyFilter(params),
    select: MESSAGE_SEARCH_COLUMNS,
  }).pipe(
    Effect.catchAll((error) =>
      isTableNotFoundError(error)
        ? Effect.succeed([] as readonly import("./lancedb").SearchHit[])
        : Effect.fail(error),
    ),
  );
  const searchMs = Math.round(performance.now() - searchStarted);
  const totalMs = Math.round(performance.now() - routeStarted);
  const receipt: SearchReceipt = {
    route: "search/fusion",
    mode: "fusion",
    query: text,
    limit: positiveInt(params, "limit", 10),
    statusCode: 200,
    startedAt,
    completedAt: new Date().toISOString(),
    tableName,
    readinessMs: 0,
    embedMs,
    searchMs,
    totalMs,
    residualMs: Math.max(0, totalMs - embedMs - searchMs),
    matches: matches.length,
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

const maintenanceRun = Effect.gen(function* () {
  const maintenance = yield* SearchMaintenance;
  const report = yield* maintenance.maintain();
  return json(ok("maintenance/run", report));
});

const maintenanceFreshness = Effect.gen(function* () {
  const maintenance = yield* SearchMaintenance;
  const params = yield* query;
  const report = yield* maintenance.reconcileFreshness({
    limit: positiveInt(params, "limit", 500),
  });
  return json(ok("maintenance/freshness", report));
});

const maintenanceRepair = Effect.gen(function* () {
  const maintenance = yield* SearchMaintenance;
  const params = yield* query;
  const report = yield* maintenance.repairOnce({
    workerId: params.get("workerId") ?? "http-maintenance",
    limit: positiveInt(params, "limit", 100),
    leaseMs: positiveInt(params, "leaseMs", 60_000),
  });
  return json(ok("maintenance/repair", report));
});

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

const maintenanceMaterializeEmbeddingVectors = Effect.gen(function* () {
  const embeddings = yield* Embeddings;
  const store = yield* LocalStore;
  const queue = yield* DurableQueue;
  const search = yield* LanceDb;
  const params = yield* query;
  const report = yield* embeddings.materializeMissingVectors({
    limit: positiveInt(params, "limit", 1_000),
    lanceOffset: nonNegativeInt(params, "lanceOffset", 0),
  });
  const coverage = yield* store.messageVectorCoverage(embeddings.profile.cacheNamespace);
  const queueByKind = yield* queue.statsByKind;
  const embedMessageQueue = queueByKind.find((stats) => stats.kind === "embed-message") ?? {
    kind: "embed-message",
    pending: 0,
    leased: 0,
    failed: 0,
  };
  const activeVectorTableName = embeddingProfileSearchTable(embeddings.profile);
  const activeVectorTable = yield* search.tableStats({ tableName: activeVectorTableName }).pipe(Effect.either);
  const lanceRowCount = activeVectorTable._tag === "Right" ? activeVectorTable.right.rowCount : undefined;
  const divergence = {
    sqliteVectorRows: coverage.vectorRows,
    lanceRowCount,
    rowCountMatches: lanceRowCount === coverage.vectorRows,
    rowCountDelta: lanceRowCount === undefined ? undefined : coverage.vectorRows - lanceRowCount,
  };
  return json(ok("maintenance/embeddings/materialize", {
    report,
    coverage,
    queue: { embedMessage: embedMessageQueue, byKind: queueByKind },
    lance: { activeVectorTableName, activeVectorTable, divergence },
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
  HttpRouter.get("/maintenance/run", maintenanceRun),
  HttpRouter.get("/maintenance/freshness", maintenanceFreshness),
  HttpRouter.get("/maintenance/repair", maintenanceRepair),
  HttpRouter.get("/maintenance/embeddings/replay-cache", maintenanceReplayEmbeddingCache),
  HttpRouter.get("/maintenance/embeddings/materialize", maintenanceMaterializeEmbeddingVectors),
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
