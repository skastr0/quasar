import { expect, test } from "bun:test";
import { HttpClient, type HttpClientError, HttpClientRequest, HttpClientResponse } from "@effect/platform";
import { Effect } from "effect";

import { QuasarClient } from "./quasar-client";

/** A deterministic fake transport: handlers see the resolved request URL and
 * return a real `Response`, so the client's real decode path (the SDK's
 * envelope -> ok/error branch -> per-endpoint schema, plus this file's
 * SDK-row -> TUI-row adapters) runs unmodified, exactly like it would
 * against the live server — no curl process, no real IO. Mirrors
 * @skastr0/quasar-sdk's own test/client.test.ts fake-transport pattern. */
type FakeHandler = (
  request: HttpClientRequest.HttpClientRequest,
  url: URL,
) => Effect.Effect<HttpClientResponse.HttpClientResponse, HttpClientError.HttpClientError>;

const fakeHttpClient = (handler: FakeHandler): HttpClient.HttpClient => HttpClient.make((request, url) => handler(request, url));

const jsonResponse = (request: HttpClientRequest.HttpClientRequest, body: unknown, status = 200): HttpClientResponse.HttpClientResponse =>
  HttpClientResponse.fromWeb(request, new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }));

const clientFor = (handler: FakeHandler): QuasarClient => new QuasarClient("http://fake.quasar.local", 5, fakeHttpClient(handler));

test("search lifts matches out of the envelope row into flat SearchMatch", async () => {
  const client = clientFor((request) =>
    Effect.succeed(
      jsonResponse(request, {
        ok: true,
        command: "search/lexical",
        data: {
          matches: [
            {
              key: "kimi:7a43b7c9:178:reasoning",
              score: 14.163,
              row: {
                key: "kimi:7a43b7c9:178:reasoning",
                sessionId: "kimi:7a43b7c9",
                seq: 178,
                role: "reasoning",
                projectKey: "git:github.com/skastr0/quasar",
                provider: "kimi",
                text: "The code should create vector index…",
                contentHash: "h1",
              },
            },
          ],
        },
      }),
    ),
  );
  const out = await client.search("vector index", "lexical");
  expect(out.ok).toBe(true);
  if (!out.ok) return;
  expect(out.value).toHaveLength(1);
  expect(out.value[0]).toMatchObject({
    sessionId: "kimi:7a43b7c9",
    seq: 178,
    role: "reasoning",
    provider: "kimi",
    score: 14.163,
  });
});

test("search surfaces a ServiceUnavailable error envelope as a typed failure keyed by type", async () => {
  // The real server never emits a distinct `error.code` (see server.ts's
  // badRequest/semanticDisabled/etc builders) -- only `error.type`, drawn
  // from a fixed literal set. `type` is what the client-facing `code`
  // reflects, matching the pre-SDK parser's observed production behavior
  // (`str(e.code) || str(e.type)` always fell through to `type`).
  const client = clientFor((request) =>
    Effect.succeed(
      jsonResponse(
        request,
        {
          ok: false,
          route: "search/fusion",
          error: { type: "ServiceUnavailable", message: "structural index divergence (extra=1608, stale=0)" },
        },
        503,
      ),
    ),
  );
  const out = await client.search("vector index", "fusion");
  expect(out.ok).toBe(false);
  if (out.ok) return;
  expect(out.code).toBe("ServiceUnavailable");
  expect(out.message).toContain("divergence");
});

test("search surfaces SemanticDisabled — the real 'index not ready' condition — as a typed failure", async () => {
  const client = clientFor((request) =>
    Effect.succeed(
      jsonResponse(
        request,
        {
          ok: false,
          route: "search/semantic",
          error: { type: "SemanticDisabled", message: "semantic search disabled pending vector materialization (QSR-232)" },
        },
        503,
      ),
    ),
  );
  const out = await client.search("vector index", "semantic");
  expect(out.ok).toBe(false);
  if (out.ok) return;
  expect(out.code).toBe("SemanticDisabled");
});

test("search surfaces an empty match list", async () => {
  const client = clientFor((request) => Effect.succeed(jsonResponse(request, { ok: true, data: { matches: [] } })));
  const out = await client.search("nothing", "lexical");
  expect(out.ok).toBe(true);
  if (!out.ok) return;
  expect(out.value).toEqual([]);
});

test("search surfaces a QuasarDecodeError when the envelope fails schema decode", async () => {
  const client = clientFor((request) => Effect.succeed(jsonResponse(request, { ok: "maybe" })));
  const out = await client.search("bad envelope", "lexical");
  expect(out.ok).toBe(false);
  if (out.ok) return;
  expect(out.code).toBe("DecodeError");
});

test("sessions maps rows with null-safe fields", async () => {
  const client = clientFor((request) =>
    Effect.succeed(
      jsonResponse(request, {
        ok: true,
        command: "sessions",
        data: {
          rows: [
            {
              sessionId: "kimi:3f57",
              projectKey: "git:github.com/skastr0/quasar",
              provider: "kimi",
              agentName: "kimi-code",
              title: null,
              startedAt: "2026-06-27T10:03:09.305Z",
              updatedAt: "2026-06-27T10:06:56.218Z",
              sourcePath: "/x/session.jsonl",
              sourceFingerprint: "fp1",
              host: "mac-mini",
              identitySchemeVersion: 1,
              messageCount: 8,
              toolCallCount: 12,
            },
          ],
        },
      }),
    ),
  );
  const out = await client.sessions();
  expect(out.ok).toBe(true);
  if (!out.ok) return;
  expect(out.value[0]).toMatchObject({ sessionId: "kimi:3f57", title: null, messageCount: 8, toolCallCount: 12 });
});

test("messages narrows to the TUI's 4-field row", async () => {
  const client = clientFor((request) =>
    Effect.succeed(
      jsonResponse(request, {
        ok: true,
        data: {
          sessionId: "s1",
          rows: [{ sessionId: "s1", seq: 0, role: "user", text: "hi", ts: null, projectKey: "p1", contentHash: "h1" }],
        },
      }),
    ),
  );
  const out = await client.messages("s1");
  expect(out.ok).toBe(true);
  if (!out.ok) return;
  expect(out.value).toEqual([{ seq: 0, role: "user", text: "hi", ts: null }]);
});

test("toolCalls maps forensic rows", async () => {
  const client = clientFor((request) =>
    Effect.succeed(
      jsonResponse(request, {
        ok: true,
        command: "tool-calls",
        data: {
          rows: [
            {
              id: "antigravity:0eff:tool:abdf",
              sessionId: "antigravity:0eff",
              seq: 0,
              toolName: "list_dir",
              status: "completed",
              inputText: '{"DirectoryPath":"/tmp"}',
              outputText: "Empty directory",
              projectKey: "path:machine:129e",
              provider: "antigravity",
            },
          ],
        },
      }),
    ),
  );
  const out = await client.toolCalls();
  expect(out.ok).toBe(true);
  if (!out.ok) return;
  expect(out.value[0]).toMatchObject({ toolName: "list_dir", status: "completed", provider: "antigravity" });
});

test("toolCalls tolerates a null status column (SQL NULL, not absent)", async () => {
  const client = clientFor((request) =>
    Effect.succeed(
      jsonResponse(request, {
        ok: true,
        data: {
          rows: [
            {
              id: "t1",
              sessionId: "s1",
              seq: 0,
              toolName: "list_dir",
              status: null,
              inputText: "{}",
              outputText: "",
              projectKey: "p1",
              provider: "claude",
            },
          ],
        },
      }),
    ),
  );
  const out = await client.toolCalls();
  expect(out.ok).toBe(true);
  if (!out.ok) return;
  expect(out.value[0]?.status).toBe("");
});

test("projects maps the project list", async () => {
  const client = clientFor((request) =>
    Effect.succeed(
      jsonResponse(request, { ok: true, command: "projects", data: { rows: [{ projectKey: "git:github.com/agentjido/jido", displayName: "jido", rawPath: "/x/jido" }] } }),
    ),
  );
  const out = await client.projects();
  expect(out.ok).toBe(true);
  if (!out.ok) return;
  expect(out.value[0]).toMatchObject({ displayName: "jido", projectKey: "git:github.com/agentjido/jido" });
});

test("search reports an aborted request as a Network-coded failure, matching the pre-SDK contract", async () => {
  const client = clientFor(() => Effect.never);
  const controller = new AbortController();
  const pending = client.search("slow query", "lexical", { signal: controller.signal });
  controller.abort();
  const out = await pending;
  expect(out.ok).toBe(false);
  if (out.ok) return;
  expect(out.code).toBe("Network");
  expect(out.message).toBe("aborted");
});
