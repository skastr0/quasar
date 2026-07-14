/**
 * In-process Quasar client for the TUI, built on `@skastr0/quasar-sdk`.
 *
 * Schemas, envelope/row decode, retry, and typed errors are single-sourced
 * from the SDK (`QuasarClientLive`) -- this file supplies only what the SDK
 * deliberately leaves pluggable: the transport, and a thin adapter down to
 * the TUI's own (narrower, pre-existing) row/Outcome shapes so app.tsx/
 * actions.ts/query.ts need no changes.
 *
 * The transport works AROUND an opentui constraint: the render loop runs
 * continuously and starves libuv's poll phase, so in-process async reads off
 * a LIVE socket (a real `fetch` response body stream) hang under an active
 * renderer (proven: headers return in ~30ms, bodies never resolve; pause()
 * does not help). But `setTimeout` and synchronous `fs` calls keep working.
 * So: spawn `curl` writing the body to a temp file (no streaming read, no
 * awaiting the also-starved process-exit), and POLL that file with
 * setTimeout + sync readFileSync until it parses as complete JSON. Once
 * complete, the full body is already in memory -- wrapping it as a Web
 * `Response` and handing it to `HttpClientResponse.fromWeb` lets the SDK's
 * `.json()` read run over an in-memory Blob (a microtask, not a socket
 * read), which is NOT the starved path this workaround exists for. The
 * result is genuinely asynchronous IO (the UI stays responsive -- animated
 * "searching…", cancellable) without ever touching a starved code path, and
 * the SDK's own retry/timeout/decode logic (`QuasarClientLive`) now runs
 * for the TUI too, exactly as it does for the CLI's read commands.
 */
import { spawn } from "node:child_process";
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { HttpClient, HttpClientError, HttpClientResponse } from "@effect/platform";
import { Cause, Effect, Exit, Layer, Option } from "effect";
import {
  makeQuasarConfig,
  QuasarClientLive,
  QuasarClientTag,
  type MessageRow as SdkMessageRow,
  type ProjectRow as SdkProjectRow,
  type Provider,
  type QuasarClientService,
  type QuasarError,
  type SearchHit,
  type SearchMode as SdkSearchMode,
  type SessionRow as SdkSessionRow,
  type ToolCallRow as SdkToolCallRow,
} from "@skastr0/quasar-sdk";

import { configuredServerUrl } from "../client-config";

// ----------------------------------------------------------- public surface
// Unchanged since before the SDK swap: app.tsx, actions.ts, and query.ts
// import these names and shapes directly.

export type SearchMode = SdkSearchMode;

export const SEARCH_MODES: readonly SearchMode[] = ["lexical", "semantic", "fusion"];

export interface SearchMatch {
  readonly key: string;
  readonly score: number;
  readonly sessionId: string;
  readonly seq: number;
  readonly role: string;
  readonly projectKey: string;
  readonly provider: string;
  readonly text: string;
}

export interface SessionRow {
  readonly sessionId: string;
  readonly projectKey: string;
  readonly provider: string;
  readonly agentName: string | null;
  readonly title: string | null;
  readonly startedAt: string | null;
  readonly updatedAt: string | null;
  readonly messageCount: number;
  readonly toolCallCount: number;
}

export interface MessageRow {
  readonly seq: number;
  readonly role: string;
  readonly text: string;
  readonly ts: string | null;
}

export interface ToolCallRow {
  readonly id: string;
  readonly sessionId: string;
  readonly seq: number;
  readonly toolName: string;
  readonly status: string;
  readonly inputText: string;
  readonly outputText: string;
  readonly provider: string;
  readonly projectKey: string;
}

export interface ProjectRow {
  readonly projectKey: string;
  readonly displayName: string;
  readonly rawPath: string;
}

/** A typed outcome: data on success, a structured failure otherwise. */
export type Outcome<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly code: string; readonly message: string };

/** The slice of the client the TUI depends on — injectable so tests use a fake. */
export interface QuasarClientLike {
  search(
    query: string,
    mode: SearchMode,
    opts?: { limit?: number; projectKey?: string; provider?: string; role?: string; signal?: AbortSignal },
  ): Promise<Outcome<readonly SearchMatch[]>>;
  messages(sessionId: string, opts?: { limit?: number; signal?: AbortSignal }): Promise<Outcome<readonly MessageRow[]>>;
  toolCalls(opts?: {
    sessionId?: string;
    projectKey?: string;
    provider?: string;
    toolName?: string;
    limit?: number;
    signal?: AbortSignal;
  }): Promise<Outcome<readonly ToolCallRow[]>>;
}

// ------------------------------------------------- SDK row -> TUI row shape
// The TUI's row types are a pre-existing, narrower projection of the SDK's
// full rows (e.g. no sourcePath/sourceFingerprint/host on SessionRow). These
// adapters keep that projection; nothing downstream of quasar-client.ts
// changes shape.

const toSearchMatch = (hit: SearchHit): SearchMatch => ({
  key: hit.key,
  score: hit.score,
  sessionId: hit.row.sessionId,
  seq: hit.row.seq,
  role: hit.row.role,
  projectKey: hit.row.projectKey,
  provider: hit.row.provider,
  text: hit.row.text,
});

const toSessionRow = (row: SdkSessionRow): SessionRow => ({
  sessionId: row.sessionId,
  projectKey: row.projectKey,
  provider: row.provider,
  agentName: row.agentName,
  title: row.title ?? null,
  startedAt: row.startedAt ?? null,
  updatedAt: row.updatedAt ?? null,
  messageCount: row.messageCount,
  toolCallCount: row.toolCallCount,
});

const toMessageRow = (row: SdkMessageRow): MessageRow => ({
  seq: row.seq,
  role: row.role,
  text: row.text,
  ts: row.ts ?? null,
});

const toToolCallRow = (row: SdkToolCallRow): ToolCallRow => ({
  id: row.id,
  sessionId: row.sessionId,
  seq: row.seq,
  toolName: row.toolName,
  status: row.status ?? "",
  inputText: row.inputText,
  outputText: row.outputText,
  provider: row.provider,
  projectKey: row.projectKey,
});

const toProjectRow = (row: SdkProjectRow): ProjectRow => ({
  projectKey: row.projectKey,
  displayName: row.displayName,
  rawPath: row.rawPath ?? "",
});

// --------------------------------------------------- QuasarError -> Outcome
// The real server envelope (packages/server/src/server.ts's badRequest/
// semanticDisabled/embeddingUnavailable/unauthorized/serviceUnavailable/
// notFound builders) carries only `error.type`, never a separate `error.code`
// -- confirmed against the live server and against every server-side error
// builder. The pre-SDK hand-rolled parser's `str(e.code) || str(e.type)`
// therefore always fell through to `type` in production; this mapping
// reproduces that observed behavior exactly, now sourced from the SDK's
// typed QuasarServerError.type instead of a hand-parsed field.
const toOutcomeFailure = (error: QuasarError): { readonly code: string; readonly message: string } => {
  switch (error._tag) {
    case "QuasarServerError":
      return { code: error.type, message: error.message };
    case "QuasarTransportError":
      return { code: "Network", message: error.message };
    case "QuasarDecodeError":
      return { code: "DecodeError", message: error.message };
    case "QuasarConfigError":
      return { code: "Configuration", message: error.message };
  }
};

const toOutcomeFailureFromCause = (cause: Cause.Cause<QuasarError>): { readonly code: string; readonly message: string } => {
  const failure = Cause.failureOption(cause);
  if (Option.isSome(failure)) return toOutcomeFailure(failure.value);
  if (Cause.isInterruptedOnly(cause)) return { code: "Network", message: "aborted" };
  return { code: "Error", message: Cause.pretty(cause) };
};

// ----------------------------------------------------------------- transport
// curl-file-poll IO (see module doc) wrapped as an Effect `HttpClient`, so
// `QuasarClientLive` runs completely unmodified over it -- same envelope
// decode, same retry-on-transient-transport-error, same per-attempt timeout
// as the CLI's SDK-backed read commands.

let ioCounter = 0;

const curlBody = (url: string, timeoutSec: number, signal: AbortSignal | undefined): Promise<string> => {
  const tmp = join(tmpdir(), `quasar-tui-io-${process.pid}-${ioCounter++}`);

  return new Promise((resolve, reject) => {
    let settled = false;
    const child = spawn("curl", ["-s", "--max-time", String(timeoutSec), "-o", tmp, url], {
      stdio: "ignore",
    });
    const cleanup = () => {
      signal?.removeEventListener("abort", onAbort);
      try {
        unlinkSync(tmp);
      } catch {
        // best-effort
      }
    };
    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      cleanup();
      fn();
    };
    const onAbort = () => {
      try {
        child.kill();
      } catch {
        // best-effort
      }
      settle(() => reject(new Error("aborted")));
    };
    if (signal?.aborted) {
      onAbort();
      return;
    }
    signal?.addEventListener("abort", onAbort);

    const deadline = Date.now() + (timeoutSec + 5) * 1000;
    const poll = () => {
      if (settled) return;
      if (existsSync(tmp)) {
        try {
          const text = readFileSync(tmp, "utf8");
          JSON.parse(text); // throws while the write is partial
          return settle(() => resolve(text));
        } catch {
          // partial write — keep polling
        }
      }
      if (Date.now() > deadline) {
        try {
          child.kill();
        } catch {
          // best-effort
        }
        return settle(() => reject(new Error("request timed out")));
      }
      setTimeout(poll, 40);
    };
    setTimeout(poll, 20);
  });
};

/** curl-backed `HttpClient`. `HttpClient.make` hands the handler a fresh
 * `AbortController.signal` per request, tied to fiber interruption by
 * @effect/platform itself — wiring it into curl's spawn/kill means an
 * interrupted/superseded search kills its curl process, no separate
 * cancellation plumbing needed. Reading the resolved body is done via
 * `HttpClientResponse.fromWeb` over an in-memory `Response`, so the SDK's
 * `.json()` decode never touches a live socket (see module doc). */
const curlHttpClient: HttpClient.HttpClient = HttpClient.make((request, url, signal) =>
  Effect.tryPromise({
    try: () => curlBody(url.toString(), 30, signal),
    catch: (cause) => new HttpClientError.RequestError({ request, reason: "Transport", cause }),
  }).pipe(Effect.map((body) => HttpClientResponse.fromWeb(request, new Response(body, { status: 200 })))),
);

/** Builds the resolved `QuasarClientTag` layer for a given transport.
 * Exported so tests can inject a fake `HttpClient` (mirrors
 * `@skastr0/quasar-sdk`'s own test/client.test.ts pattern) instead of
 * spawning a real curl process. */
export const quasarClientLayer = (
  config: { readonly serverUrl: string; readonly httpTimeoutMs?: number },
  httpClient: HttpClient.HttpClient = curlHttpClient,
): Layer.Layer<QuasarClientTag> =>
  QuasarClientLive.pipe(Layer.provide([makeQuasarConfig(config), Layer.succeed(HttpClient.HttpClient, httpClient)]));

export class QuasarClient implements QuasarClientLike {
  private readonly layer: Layer.Layer<QuasarClientTag>;

  constructor(
    private readonly serverUrl: string,
    private readonly timeoutSec = 30,
    httpClient?: HttpClient.HttpClient,
  ) {
    this.layer = quasarClientLayer({ serverUrl, httpTimeoutMs: timeoutSec * 1000 }, httpClient);
  }

  /** Resolve a client from the same config the CLI uses; null if unconfigured. */
  static fromConfig(timeoutSec = 30): QuasarClient | null {
    const url = configuredServerUrl();
    return url === undefined ? null : new QuasarClient(url, timeoutSec);
  }

  private async execute<A>(
    program: (client: QuasarClientService) => Effect.Effect<A, QuasarError>,
    signal?: AbortSignal,
  ): Promise<Outcome<A>> {
    const exit = await Effect.runPromiseExit(
      Effect.gen(function* () {
        const client = yield* QuasarClientTag;
        return yield* program(client);
      }).pipe(Effect.provide(this.layer)),
      { signal },
    );
    if (Exit.isSuccess(exit)) return { ok: true, value: exit.value };
    return { ok: false, ...toOutcomeFailureFromCause(exit.cause) };
  }

  search(
    query: string,
    mode: SearchMode,
    opts: { limit?: number; projectKey?: string; provider?: string; role?: string; signal?: AbortSignal } = {},
  ): Promise<Outcome<readonly SearchMatch[]>> {
    return this.execute(
      (client) =>
        client
          .search(mode, {
            query,
            projectKey: opts.projectKey,
            role: opts.role as SdkMessageRow["role"] | undefined,
            providers: opts.provider ? [opts.provider as Provider] : undefined,
            limit: opts.limit,
          })
          .pipe(Effect.map((hits) => hits.map(toSearchMatch))),
      opts.signal,
    );
  }

  sessions(
    opts: { provider?: string; projectKey?: string; limit?: number; offset?: number; signal?: AbortSignal } = {},
  ): Promise<Outcome<readonly SessionRow[]>> {
    return this.execute(
      (client) =>
        client
          .listSessions({
            provider: opts.provider as Provider | undefined,
            projectKey: opts.projectKey,
            limit: opts.limit,
            offset: opts.offset,
          })
          .pipe(Effect.map((rows) => rows.map(toSessionRow))),
      opts.signal,
    );
  }

  messages(sessionId: string, opts: { limit?: number; signal?: AbortSignal } = {}): Promise<Outcome<readonly MessageRow[]>> {
    return this.execute(
      (client) => client.readMessages(sessionId, { limit: opts.limit }).pipe(Effect.map((rows) => rows.map(toMessageRow))),
      opts.signal,
    );
  }

  toolCalls(
    opts: { sessionId?: string; projectKey?: string; provider?: string; toolName?: string; limit?: number; signal?: AbortSignal } = {},
  ): Promise<Outcome<readonly ToolCallRow[]>> {
    return this.execute(
      (client) =>
        client
          .listToolCalls({
            sessionId: opts.sessionId,
            projectKey: opts.projectKey,
            provider: opts.provider as Provider | undefined,
            toolName: opts.toolName,
            limit: opts.limit,
          })
          .pipe(Effect.map((rows) => rows.map(toToolCallRow))),
      opts.signal,
    );
  }

  projects(
    opts: { limit?: number; offset?: number; signal?: AbortSignal } = {},
  ): Promise<Outcome<readonly ProjectRow[]>> {
    return this.execute(
      (client) => client.listProjects({ limit: opts.limit, offset: opts.offset }).pipe(Effect.map((rows) => rows.map(toProjectRow))),
      opts.signal,
    );
  }
}
