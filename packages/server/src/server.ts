import { HttpMiddleware, HttpRouter, HttpServer, HttpServerRequest, HttpServerResponse } from "@effect/platform";
import { BunHttpServer, BunRuntime } from "@effect/platform-bun";
import { LanceDb, MESSAGE_SEARCH_COLUMNS } from "@skastr0/quasar-search";
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
  const [sqlite, lance, queueStats, queueByKind, embeddingStatus, ingestStatus, workerStatus] = yield* Effect.all([
    store.stats.pipe(Effect.either),
    includeLanceStats ? search.tableStats({}).pipe(Effect.either) : Effect.succeed({ _tag: "Right" as const, right: "skipped; pass ?lance=true for LanceDB table stats" }),
    queue.stats,
    queue.statsByKind,
    embeddings.status,
    ingest.status,
    workers.status,
  ]);
  return json(
    ok("status", {
      sqlite,
      lance,
      queue: { ...queueStats, byKind: queueByKind },
      embeddings: embeddingStatus,
      ingest: ingestStatus,
      workers: workerStatus,
    }),
  );
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

const lexicalSearch = Effect.gen(function* () {
  const search = yield* DerivedSearch;
  const params = yield* query;
  const text = params.get("q") ?? params.get("query");
  if (text === null || text.trim() === "") {
    return badRequest("search/lexical", "q is required");
  }
  const matches = yield* search.lexicalSearch({
    query: text,
    projectKey: params.get("projectKey") ?? undefined,
    role: params.get("role") ?? undefined,
    limit: positiveInt(params, "limit", 10),
  });
  return json(ok("search/lexical", { matches }));
});

const vectorReadyFilter = (params: URLSearchParams): string | undefined => {
  const projectKey = params.get("projectKey");
  const role = params.get("role");
  return messageSearchFilter(
    {
      projectKey: projectKey === null || projectKey.trim() === "" ? undefined : projectKey,
      role: role === null || role.trim() === "" ? undefined : role,
    },
    VECTOR_READY_FILTER,
  );
};

const semanticSearch = Effect.gen(function* () {
  const search = yield* LanceDb;
  const embeddings = yield* Embeddings;
  const params = yield* query;
  const text = params.get("q") ?? params.get("query");
  if (text === null || text.trim() === "") {
    return badRequest("search/semantic", "q is required");
  }
  const vector = yield* embeddings.embedText(text);
  const tableName = embeddingProfileSearchTable(embeddings.profile);
  const matches = yield* search.vectorSearch({
    tableName,
    vector,
    vectorDimension: embeddings.profile.dimensions,
    limit: positiveInt(params, "limit", 10),
    filter: vectorReadyFilter(params),
    select: MESSAGE_SEARCH_COLUMNS,
  });
  return json(ok("search/semantic", { matches }));
});

const fusionSearch = Effect.gen(function* () {
  const search = yield* LanceDb;
  const embeddings = yield* Embeddings;
  const params = yield* query;
  const text = params.get("q") ?? params.get("query");
  if (text === null || text.trim() === "") {
    return badRequest("search/fusion", "q is required");
  }
  const vector = yield* embeddings.embedText(text);
  const tableName = embeddingProfileSearchTable(embeddings.profile);
  const matches = yield* search.hybridSearch({
    tableName,
    query: text,
    vector,
    vectorDimension: embeddings.profile.dimensions,
    limit: positiveInt(params, "limit", 10),
    filter: vectorReadyFilter(params),
    select: MESSAGE_SEARCH_COLUMNS,
  });
  return json(ok("search/fusion", { matches }));
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
  const params = yield* query;
  const report = yield* maintenance.maintain({
    includeVector: booleanParam(params, "vector", true),
    optimize: booleanParam(params, "optimize", true),
  });
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

const routes = HttpRouter.empty.pipe(
  HttpRouter.get("/health", health),
  HttpRouter.get("/ready", health),
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
  HttpRouter.get("/maintenance/run", maintenanceRun),
  HttpRouter.get("/maintenance/freshness", maintenanceFreshness),
  HttpRouter.get("/maintenance/repair", maintenanceRepair),
  HttpRouter.get("/", json(ok("root", { service: "quasar-server" }))),
  HttpRouter.get("*", json({ ok: false, error: { type: "NotFound", message: "No route" } }, { status: 404 })),
);

export const makeHttpLayer = (options: { readonly port: number; readonly hostname?: string }) =>
  routes.pipe(
    HttpServer.serve(HttpMiddleware.logger),
    HttpServer.withLogAddress,
    Layer.provide(AppLayer),
    Layer.provide(BunHttpServer.layer({ port: options.port, hostname: options.hostname ?? "127.0.0.1", idleTimeout: httpIdleTimeoutSeconds() })),
  );

export const serve = (options: { readonly port: number; readonly hostname?: string }): void => {
  BunRuntime.runMain(Layer.launch(makeHttpLayer(options)));
};
