import { describe, it, expect } from "bun:test";
import { HttpClient, HttpClientError, HttpClientRequest, HttpClientResponse } from "@effect/platform";
import { Effect, Layer } from "effect";
import { QuasarClientLive, QuasarClientTag, type QuasarClientService } from "../src/client.js";
import { makeQuasarConfig } from "../src/config.js";
import { QuasarDecodeError, QuasarServerError, QuasarTransportError } from "../src/errors.js";

/** A deterministic fake transport: handlers see the resolved request URL and
 * return a real `Response`, so the client's own decode path (envelope ->
 * ok/error branch -> per-endpoint schema) runs unmodified, just like it
 * would against the live server. */
type FakeHandler = (
  request: HttpClientRequest.HttpClientRequest,
  url: URL,
) => Effect.Effect<HttpClientResponse.HttpClientResponse, HttpClientError.HttpClientError>;

const fakeHttpClient = (handler: FakeHandler): HttpClient.HttpClient =>
  HttpClient.make((request, url) => handler(request, url));

const jsonResponse = (
  request: HttpClientRequest.HttpClientRequest,
  body: unknown,
  status = 200,
): HttpClientResponse.HttpClientResponse =>
  HttpClientResponse.fromWeb(
    request,
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }),
  );

const layerFor = (handler: FakeHandler, httpTimeoutMs = 5_000) =>
  QuasarClientLive.pipe(
    Layer.provide([
      makeQuasarConfig({ serverUrl: "http://fake.quasar.local", httpTimeoutMs }),
      Layer.succeed(HttpClient.HttpClient, fakeHttpClient(handler)),
    ]),
  );

const runWithClient = <A, E>(handler: FakeHandler, program: (client: QuasarClientService) => Effect.Effect<A, E>) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const client = yield* QuasarClientTag;
      return yield* program(client);
    }).pipe(Effect.provide(layerFor(handler))),
  );

const runFailureWithClient = <A, E>(
  handler: FakeHandler,
  program: (client: QuasarClientService) => Effect.Effect<A, E>,
) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const client = yield* QuasarClientTag;
      return yield* program(client);
    }).pipe(Effect.provide(layerFor(handler)), Effect.flip),
  );

describe("QuasarClient", () => {
  it("decodes listProjects rows from a success envelope", async () => {
    const rows = await runWithClient(
      (request) =>
        Effect.succeed(
          jsonResponse(request, {
            ok: true,
            command: "projects",
            data: { rows: [{ projectKey: "p1", displayName: "Project 1" }] },
          }),
        ),
      (client) => client.listProjects({ limit: 10 }),
    );
    expect(rows).toEqual([{ projectKey: "p1", displayName: "Project 1" }]);
  });

  it("decodes readMessages rows for a session", async () => {
    const rows = await runWithClient(
      (request) =>
        Effect.succeed(
          jsonResponse(request, {
            ok: true,
            data: {
              sessionId: "s1",
              rows: [
                { sessionId: "s1", seq: 0, role: "user", text: "hi", projectKey: "p1", contentHash: "h1" },
              ],
            },
          }),
        ),
      (client) => client.readMessages("s1"),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.text).toBe("hi");
  });

  it("search joins providers into one comma-separated query param and decodes matches", async () => {
    let capturedUrl: URL | undefined;
    const rows = await runWithClient(
      (request, url) => {
        capturedUrl = url;
        return Effect.succeed(
          jsonResponse(request, {
            ok: true,
            data: {
              matches: [
                {
                  key: "k1",
                  score: 0.5,
                  row: {
                    key: "k1",
                    sessionId: "s1",
                    seq: 0,
                    role: "user",
                    projectKey: "p1",
                    provider: "claude",
                    text: "hello",
                    contentHash: "h1",
                  },
                },
              ],
              // receipt/degraded are real server fields excess to the frozen
              // public contract (SearchHit[] only) -- must be tolerated, not rejected.
              receipt: { route: "search/fusion" },
            },
          }),
        );
      },
      (client) => client.search("fusion", { query: "auth", providers: ["claude", "codex"], role: "assistant", limit: 5 }),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.row.text).toBe("hello");
    expect(capturedUrl?.pathname).toBe("/search/fusion");
    expect(capturedUrl?.searchParams.get("q")).toBe("auth");
    expect(capturedUrl?.searchParams.get("provider")).toBe("claude,codex");
    expect(capturedUrl?.searchParams.get("role")).toBe("assistant");
    expect(capturedUrl?.searchParams.get("limit")).toBe("5");
  });

  it("maps a NotFound error envelope to QuasarServerError carrying the response's httpStatus", async () => {
    const error = await runFailureWithClient(
      (request) =>
        Effect.succeed(
          jsonResponse(
            request,
            { ok: false, route: "tool-call", error: { type: "NotFound", message: "tool call not found: x" } },
            404,
          ),
        ),
      (client) => client.getToolCall("x"),
    );
    expect(error).toBeInstanceOf(QuasarServerError);
    if (error instanceof QuasarServerError) {
      expect(error.type).toBe("NotFound");
      expect(error.httpStatus).toBe(404);
      expect(error.message).toBe("tool call not found: x");
    }
  });

  it("surfaces a QuasarDecodeError when response data fails schema decode", async () => {
    const error = await runFailureWithClient(
      (request) => Effect.succeed(jsonResponse(request, { ok: true, data: { rows: [{ projectKey: "p1" }] } })),
      (client) => client.listProjects(),
    );
    expect(error).toBeInstanceOf(QuasarDecodeError);
  });

  it("surfaces a QuasarDecodeError when the envelope itself fails schema decode", async () => {
    const error = await runFailureWithClient(
      (request) => Effect.succeed(jsonResponse(request, { ok: "maybe" })),
      (client) => client.listProjects(),
    );
    expect(error).toBeInstanceOf(QuasarDecodeError);
  });

  it("retries a transient transport failure and succeeds on the next attempt", async () => {
    let calls = 0;
    const rows = await runWithClient(
      (request) => {
        calls += 1;
        if (calls < 3) {
          return Effect.fail(
            new HttpClientError.RequestError({ request, reason: "Transport", cause: new Error("ECONNRESET") }),
          );
        }
        return Effect.succeed(jsonResponse(request, { ok: true, data: { rows: [] } }));
      },
      (client) => client.listProjects(),
    );
    expect(rows).toEqual([]);
    expect(calls).toBe(3);
  });

  it("gives up with QuasarTransportError after exhausting the 3-attempt transient retry budget", async () => {
    let calls = 0;
    const error = await runFailureWithClient(
      (request) => {
        calls += 1;
        return Effect.fail(
          new HttpClientError.RequestError({ request, reason: "Transport", cause: new Error("ECONNRESET") }),
        );
      },
      (client) => client.listProjects(),
    );
    expect(error).toBeInstanceOf(QuasarTransportError);
    expect(calls).toBe(3);
  });

  it("does not retry a timeout, matching cli.ts fetchWithRetry (AbortSignal.timeout is never transient)", async () => {
    let calls = 0;
    const error = await Effect.runPromise(
      Effect.gen(function* () {
        const client = yield* QuasarClientTag;
        return yield* client.listProjects();
      }).pipe(
        Effect.provide(
          layerFor(() => {
            calls += 1;
            return Effect.never;
          }, 20),
        ),
        Effect.flip,
      ),
    );
    expect(error).toBeInstanceOf(QuasarTransportError);
    expect(calls).toBe(1);
  });

  it("does not retry a non-2xx status that isn't a transport failure (matches CLI: no status-based retry)", async () => {
    let calls = 0;
    const error = await runFailureWithClient(
      (request) => {
        calls += 1;
        return Effect.succeed(
          jsonResponse(request, { ok: false, error: { type: "ServiceUnavailable", message: "degraded" } }, 503),
        );
      },
      (client) => client.listProjects(),
    );
    expect(error).toBeInstanceOf(QuasarServerError);
    expect(calls).toBe(1);
  });
});
