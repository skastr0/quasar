import { HttpMiddleware, HttpRouter, HttpServer, HttpServerRequest, HttpServerResponse } from "@effect/platform";
import { BunHttpServer, BunRuntime } from "@effect/platform-bun";
import { GEMINI_EMBEDDING_DIMENSIONS, LanceDb, MESSAGE_SEARCH_COLUMNS } from "@skastr0/quasar-search";
import { Effect, Layer } from "effect";

import { LocalServerConfig } from "./config";
import { ok } from "./json";
import { SearchMaintenance } from "./maintenance";
import { AppLayer } from "./runtime";
import { DerivedSearch } from "./search";
import { VECTOR_READY_FILTER } from "./searchPolicy";
import { DurableQueue, Embeddings, IngestCoordinator, WorkerSupervisor } from "./services";
import { LocalStore } from "./store";

const json = (value: unknown, options?: { readonly status?: number }) =>
  HttpServerResponse.unsafeJson(value, { status: options?.status });

const badRequest = (route: string, message: string) =>
  json({ ok: false, route, error: { type: "BadRequest", message } }, { status: 400 });

const notFound = (route: string, message: string) =>
  json({ ok: false, route, error: { type: "NotFound", message } }, { status: 404 });

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
    search.tableStats({}).pipe(Effect.either),
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
    limit: positiveInt(params, "limit", 10),
  });
  return json(ok("search/lexical", { matches }));
});

const vectorReadyFilter = (projectKey: string | null): string | undefined => {
  const base = VECTOR_READY_FILTER;
  if (projectKey === null || projectKey.trim() === "") return base;
  return `${base} AND projectKey = '${projectKey.replaceAll("'", "''")}'`;
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
  const matches = yield* search.vectorSearch({
    vector,
    vectorDimension: GEMINI_EMBEDDING_DIMENSIONS,
    limit: positiveInt(params, "limit", 10),
    filter: vectorReadyFilter(params.get("projectKey")),
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
  const matches = yield* search.hybridSearch({
    query: text,
    vector,
    vectorDimension: GEMINI_EMBEDDING_DIMENSIONS,
    limit: positiveInt(params, "limit", 10),
    filter: vectorReadyFilter(params.get("projectKey")),
    select: MESSAGE_SEARCH_COLUMNS,
  });
  return json(ok("search/fusion", { matches }));
});

const booleanParam = (params: URLSearchParams, name: string, fallback: boolean): boolean => {
  const raw = params.get(name);
  if (raw === null) return fallback;
  return raw === "true" || raw === "1" || raw === "yes";
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
  HttpRouter.get("/search/lexical", lexicalSearch),
  HttpRouter.get("/search/semantic", semanticSearch),
  HttpRouter.get("/search/fusion", fusionSearch),
  HttpRouter.get("/maintenance/run", maintenanceRun),
  HttpRouter.get("/maintenance/freshness", maintenanceFreshness),
  HttpRouter.get("/maintenance/repair", maintenanceRepair),
  HttpRouter.get("/", json(ok("root", { service: "quasar-local-server" }))),
  HttpRouter.get("*", json({ ok: false, error: { type: "NotFound", message: "No route" } }, { status: 404 })),
);

export const makeHttpLayer = (options: { readonly port: number; readonly hostname?: string }) =>
  routes.pipe(
    HttpServer.serve(HttpMiddleware.logger),
    HttpServer.withLogAddress,
    Layer.provide(AppLayer),
    Layer.provide(BunHttpServer.layer({ port: options.port, hostname: options.hostname ?? "127.0.0.1" })),
  );

export const serve = (options: { readonly port: number; readonly hostname?: string }): void => {
  BunRuntime.runMain(Layer.launch(makeHttpLayer(options)));
};
