import { HttpClient, HttpClientError, HttpClientRequest, HttpClientResponse } from "@effect/platform";
import { Context, Duration, Effect, Layer, ParseResult, Schedule, Schema, type Cause } from "effect";
import { QuasarConfigTag, type QuasarConfig } from "./config.js";
import { QuasarDecodeError, QuasarServerError, QuasarTransportError, type QuasarError } from "./errors.js";
import {
  Envelope,
  IngestRunRow,
  MessageRow,
  ProjectRow,
  SearchHit,
  SessionRow,
  ToolCallRow,
  type IngestRunStatus,
  type MessageRole,
  type Provider,
  type SearchMode,
} from "./schema.js";

/** Read plane only. Every method decodes the server's envelope + row shapes
 * internally and surfaces unwrapped typed data or a QuasarError — callers
 * never see raw JSON or the ok/error envelope discriminant. */

const HealthReportData = Schema.Struct({
  status: Schema.String,
  home: Schema.String,
  sqlite: Schema.String,
  stats: Schema.Unknown,
});
export type HealthReport = typeof HealthReportData.Type;

const ProjectsData = Schema.Struct({ rows: Schema.Array(ProjectRow) });
const SessionsData = Schema.Struct({ rows: Schema.Array(SessionRow) });
const MessagesData = Schema.Struct({ sessionId: Schema.String, rows: Schema.Array(MessageRow) });
const ToolCallsData = Schema.Struct({ rows: Schema.Array(ToolCallRow) });
const ToolCallData = Schema.Struct({ row: ToolCallRow });
const IngestRunsData = Schema.Struct({ rows: Schema.Array(IngestRunRow) });
const SearchResultData = Schema.Struct({ matches: Schema.Array(SearchHit) });

export interface ListProjectsOptions {
  readonly limit?: number;
  readonly offset?: number;
}

export interface ListSessionsOptions {
  readonly projectKey?: string;
  readonly provider?: Provider;
  readonly limit?: number;
  readonly offset?: number;
}

export interface ReadMessagesOptions {
  readonly limit?: number;
}

export interface ListToolCallsOptions {
  readonly sessionId?: string;
  readonly projectKey?: string;
  readonly provider?: Provider;
  readonly toolName?: string;
  readonly limit?: number;
  readonly offset?: number;
}

export interface ListIngestRunsOptions {
  readonly status?: IngestRunStatus;
  readonly limit?: number;
  readonly offset?: number;
}

export interface SearchOptions {
  readonly query: string;
  readonly projectKey?: string;
  readonly role?: MessageRole;
  readonly providers?: readonly Provider[];
  readonly limit?: number;
}

export interface QuasarClientService {
  /** GET /health — vellum doctor / reachability probe. */
  readonly health: Effect.Effect<HealthReport, QuasarError>;
  readonly listProjects: (opts?: ListProjectsOptions) => Effect.Effect<readonly ProjectRow[], QuasarError>;
  readonly listSessions: (opts?: ListSessionsOptions) => Effect.Effect<readonly SessionRow[], QuasarError>;
  readonly readMessages: (
    sessionId: string,
    opts?: ReadMessagesOptions,
  ) => Effect.Effect<readonly MessageRow[], QuasarError>;
  readonly listToolCalls: (opts?: ListToolCallsOptions) => Effect.Effect<readonly ToolCallRow[], QuasarError>;
  readonly getToolCall: (id: string) => Effect.Effect<ToolCallRow, QuasarError>;
  readonly listIngestRuns: (opts?: ListIngestRunsOptions) => Effect.Effect<readonly IngestRunRow[], QuasarError>;
  readonly search: (mode: SearchMode, opts: SearchOptions) => Effect.Effect<readonly SearchHit[], QuasarError>;
}

export class QuasarClientTag extends Context.Tag("@quasar/QuasarClient")<QuasarClientTag, QuasarClientService>() {}

export const QuasarClient = QuasarClientTag;

// ---- transport plumbing --------------------------------------------------
// Ports cli.ts urlFor(:285) + fetchWithRetry(:300) as Effect: same base-URL
// resolution, same 3-attempt/250ms-then-500ms transient retry. Timeout is
// per-attempt (mirrors AbortSignal.timeout being constructed fresh per
// fetch()), so a retried attempt gets a full fresh budget, not a shared one.

type UrlParamsInput = Record<string, string | number | boolean | undefined>;

const buildUrl = (serverUrl: string, path: string): string =>
  new URL(path, serverUrl.endsWith("/") ? serverUrl : `${serverUrl}/`).toString();

/** Only fetch()-level transport failures (DNS, connection reset, socket
 * closed) are transient — matches cli.ts isTransientFetchError(:296), which
 * never retries on a timeout or on a non-2xx response. A TimeoutException
 * from Effect.timeout is a distinct error shape and falls through untouched,
 * so a slow server fails once instead of stacking retries on top of a
 * timeout budget it already exhausted. */
const isTransientTransportError = (error: unknown): boolean =>
  HttpClientError.isHttpClientError(error) && error._tag === "RequestError" && error.reason === "Transport";

const TRANSIENT_RETRY_SCHEDULE = Schedule.fromDelays(Duration.millis(250), Duration.millis(500));

/** A per-attempt timeout widens the client's error channel to include
 * Effect's TimeoutException alongside the platform's own HttpClientError —
 * this is the resilient client's real type, distinct from the bare
 * HttpClient.HttpClient the config/HttpClient layers hand us. */
type ResilientHttpClient = HttpClient.HttpClient.With<HttpClientError.HttpClientError | Cause.TimeoutException, never>;

const withTimeoutAndRetry = (httpClient: HttpClient.HttpClient, config: QuasarConfig): ResilientHttpClient =>
  httpClient.pipe(
    HttpClient.transformResponse((effect) => effect.pipe(Effect.timeout(Duration.millis(config.httpTimeoutMs)))),
    HttpClient.retry({ while: isTransientTransportError, schedule: TRANSIENT_RETRY_SCHEDULE }),
  );

const errorMessage = (error: unknown): string => {
  if (error instanceof Error) return error.message;
  if (typeof error === "object" && error !== null && "message" in error) {
    const message = (error as { readonly message?: unknown }).message;
    if (typeof message === "string") return message;
  }
  return String(error);
};

const toTransportOrDecodeError = (error: unknown): QuasarTransportError | QuasarDecodeError => {
  if (ParseResult.isParseError(error)) {
    return new QuasarDecodeError({
      message: `envelope failed schema decode: ${ParseResult.TreeFormatter.formatErrorSync(error)}`,
      cause: error,
    });
  }
  return new QuasarTransportError({ message: errorMessage(error), cause: error });
};

/** GET path, decode the envelope, and surface {status, envelope} — decode
 * happens BEFORE branching on ok/error because a non-2xx response still
 * carries a well-formed JSON envelope the server always produces. */
const fetchEnvelope = (
  httpClient: ResilientHttpClient,
  serverUrl: string,
  path: string,
  urlParams: UrlParamsInput | undefined,
): Effect.Effect<
  { readonly status: number; readonly envelope: typeof Envelope.Type },
  QuasarTransportError | QuasarDecodeError
> =>
  Effect.gen(function* () {
    const request = HttpClientRequest.get(buildUrl(serverUrl, path), { urlParams: urlParams ?? {} });
    const response = yield* httpClient.execute(request);
    const envelope = yield* HttpClientResponse.schemaBodyJson(Envelope)(response);
    return { status: response.status, envelope };
  }).pipe(Effect.mapError(toTransportOrDecodeError));

/** Fetch + decode the envelope, branch ok/error, then decode `data` against
 * the endpoint's own shape. QuasarServerError carries the real HTTP status
 * so a consumer can branch on it (e.g. degrade semantic -> lexical). */
const runRead = <A>(
  httpClient: ResilientHttpClient,
  serverUrl: string,
  path: string,
  urlParams: UrlParamsInput | undefined,
  dataSchema: Schema.Schema<A, any, never>,
): Effect.Effect<A, QuasarError> =>
  Effect.gen(function* () {
    const { status, envelope } = yield* fetchEnvelope(httpClient, serverUrl, path, urlParams);
    if (!envelope.ok) {
      return yield* Effect.fail(
        new QuasarServerError({
          type: envelope.error.type,
          message: envelope.error.message,
          httpStatus: status,
          details: envelope.error.details,
        }),
      );
    }
    return yield* Schema.decodeUnknown(dataSchema)(envelope.data).pipe(
      Effect.mapError(
        (error) =>
          new QuasarDecodeError({
            message: `${path} response data failed schema decode: ${ParseResult.TreeFormatter.formatErrorSync(error)}`,
            cause: error,
          }),
      ),
    );
  });

const joinProviders = (providers: readonly Provider[] | undefined): string | undefined =>
  providers === undefined || providers.length === 0 ? undefined : providers.join(",");

export const QuasarClientLive: Layer.Layer<QuasarClientTag, never, QuasarConfigTag | HttpClient.HttpClient> =
  Layer.effect(
    QuasarClientTag,
    Effect.gen(function* () {
      const config = yield* QuasarConfigTag;
      const baseHttpClient = yield* HttpClient.HttpClient;
      const httpClient = withTimeoutAndRetry(baseHttpClient, config);
      const serverUrl = config.serverUrl;
      const read = <A>(path: string, urlParams: UrlParamsInput | undefined, dataSchema: Schema.Schema<A, any, never>) =>
        runRead(httpClient, serverUrl, path, urlParams, dataSchema);

      return QuasarClientTag.of({
        health: read("/health", undefined, HealthReportData),

        listProjects: (opts) =>
          read("/projects", { limit: opts?.limit, offset: opts?.offset }, ProjectsData).pipe(
            Effect.map((data) => data.rows),
          ),

        listSessions: (opts) =>
          read(
            "/sessions",
            { provider: opts?.provider, projectKey: opts?.projectKey, limit: opts?.limit, offset: opts?.offset },
            SessionsData,
          ).pipe(Effect.map((data) => data.rows)),

        readMessages: (sessionId, opts) =>
          read("/messages", { sessionId, limit: opts?.limit }, MessagesData).pipe(Effect.map((data) => data.rows)),

        listToolCalls: (opts) =>
          read(
            "/tool-calls",
            {
              sessionId: opts?.sessionId,
              projectKey: opts?.projectKey,
              provider: opts?.provider,
              toolName: opts?.toolName,
              limit: opts?.limit,
              offset: opts?.offset,
            },
            ToolCallsData,
          ).pipe(Effect.map((data) => data.rows)),

        getToolCall: (id) => read("/tool-call", { id }, ToolCallData).pipe(Effect.map((data) => data.row)),

        listIngestRuns: (opts) =>
          read(
            "/ingest-runs",
            { status: opts?.status, limit: opts?.limit, offset: opts?.offset },
            IngestRunsData,
          ).pipe(Effect.map((data) => data.rows)),

        search: (mode, opts) =>
          read(
            `/search/${mode}`,
            {
              q: opts.query,
              limit: opts.limit,
              projectKey: opts.projectKey,
              role: opts.role,
              provider: joinProviders(opts.providers),
            },
            SearchResultData,
          ).pipe(Effect.map((data) => data.matches)),
      });
    }),
  );
