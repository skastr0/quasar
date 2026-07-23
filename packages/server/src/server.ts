import { HttpMiddleware, HttpRouter, HttpServer, HttpServerRequest, HttpServerResponse } from "@effect/platform";
import { BunHttpServer, BunRuntime } from "@effect/platform-bun";
import { decodeQuerySpec } from "@skastr0/quasar-protocol";
import { Effect, Layer, ParseResult, Schema } from "effect";

import { LocalServerConfig } from "./config";
import { embeddingProviderFromEnv } from "./embeddingProfiles";
import { ingestMappedSession } from "./ingest";
import { ok } from "./json";
import type { MappedSession } from "./model";
import { Provider } from "./provider";
import {
  executeQuery,
  QueryCursorError,
  QueryEmbeddingUnavailableError,
  QuerySemanticDisabledError,
} from "./query";
import { AppLayer } from "./runtime";
import { DurableQueue, Embeddings, IngestCoordinator, WorkerSupervisor } from "./services";
import { LocalStore } from "./store";
import { VectorMatrix } from "./vectorMatrix";
import {
  publishEmbeddingReadiness,
  publishMatrixWatermarkGauges,
  publishQueueGauges,
  publishQueueKindGauges,
  recordIngestOutcome,
  statusMetricsPayload,
} from "./metrics";

const json = (value: unknown, options?: { readonly status?: number }) =>
  HttpServerResponse.unsafeJson(value, { status: options?.status });

const badRequest = (route: string, message: string) =>
  json({ ok: false, route, error: { type: "BadRequest", message } }, { status: 400 });

const unauthorized = (route: string, message: string) =>
  json({ ok: false, route, error: { type: "Unauthorized", message } }, { status: 401 });

const serviceUnavailable = (route: string, message: string) =>
  json({ ok: false, route, error: { type: "ServiceUnavailable", message } }, { status: 503 });

const internalError = (route: string, message: string) =>
  json({ ok: false, route, error: { type: "InternalError", message } }, { status: 500 });

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

const isFingerprintProbe = (value: unknown): value is {
  readonly sessionId: string;
  readonly sourceFingerprint: string;
  readonly normalizationVersion: number;
} =>
  isRecord(value)
  && isString(value.sessionId)
  && value.sessionId.trim() !== ""
  && isString(value.sourceFingerprint)
  && value.sourceFingerprint.trim() !== ""
  && isNonNegativeInt(value.normalizationVersion);

const providers = new Set<string>(Provider.literals);

const roles = new Set<string>(["user", "assistant", "reasoning"]);
const sessionEventRoles = new Set<string>([
  "user", "assistant", "developer", "system", "tool", "thinking", "unknown",
]);
const sessionEventKinds = new Set<string>([
  "message", "tool_call", "tool_result", "reasoning", "preamble", "system",
  "summary", "edit", "snapshot", "lifecycle", "usage", "unknown",
]);
const contentBlockKinds = new Set<string>(["text", "markdown", "thinking", "image", "file", "json"]);
const sessionEdgeKinds = new Set<string>([
  "next", "parent", "tool_result_for", "forked_from", "subagent_of", "compacted_into", "artifact_of",
]);

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
  && isNonNegativeInt(value.normalizationVersion)
  && isOptionalString(value.model)
  && isOptionalString(value.modelProvider)
  && isOptionalString(value.assignmentRole)
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
  && isOptionalString(value.eventId)
  && value.projectKey === projectKey
  && value.provider === provider
  && isSeq(value.seq)
  && isString(value.toolName)
  && isOptionalString(value.status)
  && isString(value.inputText)
  && isString(value.outputText)
  && isOptionalString(value.startedAt)
  && isOptionalString(value.completedAt);

const isOptionalNonNegativeInt = (value: unknown): boolean =>
  value === undefined || isNonNegativeInt(value);

const isAgentAssignment = (value: unknown): boolean =>
  isRecord(value)
  && isOptionalString(value.nickname)
  && isOptionalString(value.role)
  && isOptionalString(value.path)
  && isOptionalNonNegativeInt(value.depth);

const hasFactOwnership = (
  value: Record<string, unknown>,
  sessionId: string,
  projectKey: string,
  provider: string,
): boolean =>
  value.sessionId === sessionId
  && value.projectIdentityKey === projectKey
  && value.provider === provider;

const isContentBlockRow = (value: unknown): boolean =>
  isRecord(value)
  && isString(value.id)
  && isSeq(value.sequence)
  && isString(value.kind)
  && contentBlockKinds.has(value.kind)
  && isOptionalString(value.text)
  && isOptionalString(value.markdown)
  && isOptionalString(value.thinking)
  && isOptionalString(value.path)
  && isOptionalString(value.uri)
  && isOptionalString(value.mediaType);

const isRawReferenceRow = (value: unknown): boolean =>
  isRecord(value)
  && isString(value.sourcePath)
  && (value.line === undefined || (isNonNegativeInt(value.line) && value.line > 0))
  && isOptionalString(value.table)
  && isOptionalString(value.rowId)
  && isOptionalString(value.nativeType)
  && isOptionalNonNegativeInt(value.rawBytes);

const isSessionEventRow = (sessionId: string, projectKey: string, provider: string, value: unknown): boolean =>
  isRecord(value)
  && hasFactOwnership(value, sessionId, projectKey, provider)
  && isString(value.id)
  && isSeq(value.sequence)
  && isString(value.machineId)
  && isString(value.agentName)
  && isString(value.role)
  && sessionEventRoles.has(value.role)
  && isString(value.kind)
  && sessionEventKinds.has(value.kind)
  && isOptionalString(value.nativeEventId)
  && isOptionalString(value.timestamp)
  && isOptionalString(value.contentText)
  && Array.isArray(value.contentBlocks)
  && value.contentBlocks.every(isContentBlockRow)
  && isOptionalString(value.toolCallId)
  && isOptionalString(value.parentEventId)
  && isRawReferenceRow(value.rawReference);

const isUsageRecordRow = (sessionId: string, projectKey: string, provider: string, value: unknown): boolean =>
  isRecord(value)
  && hasFactOwnership(value, sessionId, projectKey, provider)
  && isString(value.id)
  && isString(value.machineId)
  && isString(value.agentName)
  && isOptionalString(value.eventId)
  && isOptionalString(value.timestamp)
  && isOptionalString(value.model)
  && isOptionalString(value.modelProvider)
  && isOptionalNonNegativeInt(value.inputTokens)
  && isOptionalNonNegativeInt(value.outputTokens)
  && isOptionalNonNegativeInt(value.reasoningTokens)
  && isOptionalNonNegativeInt(value.cacheCreationInputTokens)
  && isOptionalNonNegativeInt(value.cacheReadInputTokens)
  && isOptionalNonNegativeInt(value.totalTokens)
  && (value.cost === undefined || (typeof value.cost === "number" && Number.isFinite(value.cost) && value.cost >= 0))
  && isOptionalString(value.currency);

const isSessionEdgeRow = (sessionId: string, projectKey: string, provider: string, value: unknown): boolean =>
  isRecord(value)
  && hasFactOwnership(value, sessionId, projectKey, provider)
  && isString(value.id)
  && isString(value.machineId)
  && isString(value.agentName)
  && isString(value.kind)
  && sessionEdgeKinds.has(value.kind)
  && isOptionalString(value.fromEventId)
  && isOptionalString(value.toEventId)
  && isOptionalString(value.fromId)
  && isOptionalString(value.toId);

const isArtifactRow = (sessionId: string, projectKey: string, provider: string, value: unknown): boolean =>
  isRecord(value)
  && hasFactOwnership(value, sessionId, projectKey, provider)
  && isString(value.id)
  && isString(value.machineId)
  && isString(value.agentName)
  && isString(value.kind)
  && isOptionalString(value.eventId)
  && isOptionalString(value.path)
  && isOptionalString(value.uri)
  && isOptionalString(value.contentHash)
  && isOptionalString(value.sourcePath);

const isExecutionContextRow = (sessionId: string, projectKey: string, provider: string, value: unknown): boolean =>
  isRecord(value)
  && hasFactOwnership(value, sessionId, projectKey, provider)
  && isString(value.id)
  && isSeq(value.sequence)
  && (value.scope === "session" || value.scope === "turn")
  && isString(value.machineId)
  && isString(value.agentName)
  && isOptionalString(value.timestamp)
  && isOptionalString(value.turnId)
  && isOptionalString(value.model)
  && isOptionalString(value.modelProvider)
  && isOptionalString(value.reasoningEffort)
  && isOptionalString(value.serviceTier)
  && isOptionalString(value.approvalPolicy)
  && isOptionalString(value.collaborationMode)
  && isOptionalString(value.multiAgentMode)
  && isOptionalString(value.personality)
  && isOptionalString(value.permissionProfileType);

const isMappedSession = (value: unknown): value is MappedSession => {
  if (!isRecord(value)) return false;
  const project = value.project;
  const session = value.session;
  if (!isRecord(project) || !isRecord(session)) return false;
  if (!isProjectRow(project) || !isSessionRow(session)) return false;
  if (project.projectKey !== session.projectKey) return false;
  if (
    !Array.isArray(value.messages)
    || !Array.isArray(value.toolCalls)
    || !Array.isArray(value.events)
    || !Array.isArray(value.usageRecords)
    || !Array.isArray(value.sessionEdges)
    || !Array.isArray(value.artifacts)
    || !Array.isArray(value.executionContexts)
  ) return false;
  const sessionId = session.sessionId as string;
  const projectKey = session.projectKey as string;
  const provider = session.provider as string;
  const messageCount = session.messageCount as number;
  const toolCallCount = session.toolCallCount as number;
  if (value.messages.length !== messageCount || value.toolCalls.length !== toolCallCount) return false;
  if (value.assignment !== undefined && !isAgentAssignment(value.assignment)) return false;
  const assignmentRole = isRecord(value.assignment) ? value.assignment.role : undefined;
  if (session.assignmentRole !== assignmentRole) return false;
  return value.messages.every((row) => isMessageRow(sessionId, projectKey, row))
    && value.toolCalls.every((row) => isToolCallRow(sessionId, projectKey, provider, row))
    && value.events.every((row) => isSessionEventRow(sessionId, projectKey, provider, row))
    && value.usageRecords.every((row) => isUsageRecordRow(sessionId, projectKey, provider, row))
    && value.sessionEdges.every((row) => isSessionEdgeRow(sessionId, projectKey, provider, row))
    && value.artifacts.every((row) => isArtifactRow(sessionId, projectKey, provider, row))
    && value.executionContexts.every((row) => isExecutionContextRow(sessionId, projectKey, provider, row));
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

const boundedPositiveInt = (
  params: URLSearchParams,
  name: string,
  fallback: number,
  maximum: number,
): number => Math.min(positiveInt(params, name, fallback), maximum);

const nonNegativeInt = (params: URLSearchParams, name: string, fallback: number): number => {
  const raw = params.get(name);
  if (raw === null) return fallback;
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : fallback;
};

const SESSION_DETAIL_PAGE_DEFAULT = 100;
const SESSION_DETAIL_PAGE_MAXIMUM = 1_000;

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
  const [sqlite, queueStats, queueByKind, embeddingStatus, embeddingReadiness, ingestStatus, workerStatus, matrixStatus] = yield* Effect.all([
    store.stats.pipe(Effect.either),
    queue.stats,
    queue.statsByKind,
    embeddings.status,
    embeddings.readiness.pipe(Effect.catchAll(() => Effect.succeed({ ok: false, checkedAt: new Date().toISOString(), reason: "readiness unavailable" }))),
    ingest.status,
    workers.status,
    matrix.status,
  ]);
  // Refresh live gauges from current service state so /status is self-sufficient
  // even when OTLP export is off (Metric.snapshot still reflects these).
  yield* publishQueueGauges(queueStats);
  yield* publishQueueKindGauges(queueByKind);
  yield* publishEmbeddingReadiness(embeddingReadiness.ok);
  yield* publishMatrixWatermarkGauges(matrixStatus);
  const metrics = yield* statusMetricsPayload();
  return json(ok("status", {
    sqlite,
    queue: { ...queueStats, byKind: queueByKind },
    embeddings: { ...embeddingStatus, readiness: embeddingReadiness },
    ingest: ingestStatus,
    workers: workerStatus,
    vectorMatrix: matrixStatus,
    metrics,
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

const sessionDetail = Effect.gen(function* () {
  const store = yield* LocalStore;
  const params = yield* query;
  const sessionId = params.get("sessionId");
  if (sessionId === null || sessionId.trim() === "") {
    return badRequest("session-detail", "sessionId is required");
  }
  const window = (name: string) => ({
    limit: boundedPositiveInt(
      params,
      `${name}Limit`,
      SESSION_DETAIL_PAGE_DEFAULT,
      SESSION_DETAIL_PAGE_MAXIMUM,
    ),
    offset: nonNegativeInt(params, `${name}Offset`, 0),
  });
  const detail = yield* store.readSessionDetail(sessionId, {
    messages: window("message"),
    toolCalls: window("toolCall"),
    events: window("event"),
    usageRecords: window("usage"),
    sessionEdges: window("edge"),
    artifacts: window("artifact"),
    executionContexts: window("context"),
  });
  return detail === undefined
    ? notFound("session-detail", `session not found: ${sessionId}`)
    : json(ok("session-detail", detail));
});

const queryEndpoint = Effect.gen(function* () {
  const bodyResult = yield* HttpServerRequest.schemaBodyJson(Schema.Unknown).pipe(
    Effect.either,
  );
  if (bodyResult._tag === "Left") {
    return badRequest("query", "request body must be valid JSON");
  }

  const specResult = yield* decodeQuerySpec(bodyResult.right).pipe(Effect.either);
  if (specResult._tag === "Left") {
    return badRequest(
      "query",
      ParseResult.TreeFormatter.formatErrorSync(specResult.left),
    );
  }

  const result = yield* executeQuery(specResult.right).pipe(Effect.either);
  if (result._tag === "Right") return json(result.right);

  const failure = result.left;
  if (failure instanceof QueryCursorError) {
    return badRequest("query", failure.message);
  }
  if (failure instanceof QuerySemanticDisabledError) {
    return serviceUnavailable("query", failure.message);
  }
  if (failure instanceof QueryEmbeddingUnavailableError) {
    return serviceUnavailable("query", failure.message);
  }
  const tag = isRecord(failure) && isString(failure._tag)
    ? failure._tag
    : "QueryFailure";
  return internalError("query", `query execution failed (${tag})`);
}).pipe(Effect.withSpan("query"));

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
  const unchanged = yield* store.hasSessionFingerprint(
    body.probe.sessionId,
    body.probe.sourceFingerprint,
    body.probe.normalizationVersion,
  ).pipe(
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
  yield* recordIngestOutcome({
    status: outcome.status,
    diagnostic: outcome.diagnostic,
  });
  const status = outcome.status === "failed" ? 500 : 200;
  return json(ok("ingest/session", { outcome }), { status });
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

const maintenancePruneResolvedFailures = Effect.gen(function* () {
  const queue = yield* DurableQueue;
  const report = yield* queue.pruneResolvedFailures();
  return json(ok("maintenance/queue/prune-resolved-failures", { report }));
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
// assets or egress: it calls the same-origin /status and /query endpoints.
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
    fetch("/query",{
      method:"POST",
      headers:{"content-type":"application/json"},
      body:JSON.stringify({
        protocolVersion:"quasar.query/v1",
        kind:"search",
        text:q,
        mode:mode,
        projection:{detail:"summary",fields:["sessionId","provider","text","score"]},
        page:{limit:20}
      })
    }).then(function(r){return r.json().then(function(d){if(!r.ok){throw new Error(((d.error||{}).message)||("HTTP "+r.status));}return d;});}).then(function(d){
      var m=d.items||[];
      metaEl.textContent=m.length+" results · "+mode+" · "+(Date.now()-t0)+"ms";
      if(!m.length){resultsEl.innerHTML='<div class="empty">no matches</div>';return;}
      resultsEl.innerHTML=m.map(function(x){
        var row=x, sid=String(row.sessionId||""), prov=String(row.provider||"?"), text=String(row.text||"");
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
  HttpRouter.get("/session-detail", sessionDetail),
  HttpRouter.post("/query", queryEndpoint),
  HttpRouter.get("/ingest-runs", ingestRuns),
  HttpRouter.get("/ingest-run", ingestRun),
  HttpRouter.post("/ingest/fingerprint", ingestFingerprint),
  HttpRouter.post("/ingest/session", ingestSession),
);

const routesWithMaintenance = routes.pipe(
  HttpRouter.get("/maintenance/embeddings/replay-cache", maintenanceReplayEmbeddingCache),
  HttpRouter.get("/maintenance/embeddings/materialize-sqlite", maintenanceMaterializeSqliteEmbeddingVectors),
  HttpRouter.get("/maintenance/queue/prune-resolved-failures", maintenancePruneResolvedFailures),
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
