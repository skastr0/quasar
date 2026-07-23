import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "bun:test";
import { Effect } from "effect";

import type { MappedSession } from "../src/model";
import { LocalStore, makeLocalStoreLayer } from "../src/store";

const tempDirs: string[] = [];

const tempDir = () => {
  const dir = mkdtempSync(join(tmpdir(), "quasar-server-"));
  tempDirs.push(dir);
  return dir;
};

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

const mappedSession = (overrides: { readonly fingerprint?: string; readonly firstText?: string } = {}): MappedSession => ({
  project: { projectKey: "project-http", displayName: "HTTP Project", rawPath: "/tmp/project-http" },
  session: {
    sessionId: "codex:session-http",
    projectKey: "project-http",
    provider: "codex",
    agentName: "codex",
    title: "HTTP fixture",
    startedAt: "2026-06-18T10:00:00.000Z",
    updatedAt: "2026-06-18T10:01:00.000Z",
    sourcePath: "/history/codex-session-http.jsonl",
    sourceFingerprint: overrides.fingerprint ?? "fingerprint-http",
    host: "host-http",
    identitySchemeVersion: 1,
    normalizationVersion: 4,
    model: "gpt-5.6-sol",
    modelProvider: "openai",
    assignmentRole: "builder",
    messageCount: 2,
    toolCallCount: 1,
  },
  assignment: {
    nickname: "server-query",
    role: "builder",
    path: "/root/server-query",
    depth: 1,
  },
  messages: [
    {
      sessionId: "codex:session-http",
      seq: 1,
      role: "user",
      text: overrides.firstText ?? "hello over http",
      ts: "2026-06-18T10:00:30.000Z",
      projectKey: "project-http",
      // Content hashes derive from the text in production (mapSession); the
      // fixture must honor that contract or the diff apply rightly treats a
      // text mutation with an unchanged hash as an unchanged row.
      contentHash: `hash-http-1-${(overrides.firstText ?? "hello over http").length}`,
    },
    {
      sessionId: "codex:session-http",
      seq: 2,
      role: "assistant",
      text: "assistant-only http memory",
      ts: "2026-06-18T10:00:35.000Z",
      projectKey: "project-http",
      contentHash: "hash-http-2",
    },
  ],
  toolCalls: [
    {
      id: "tool-http",
      sessionId: "codex:session-http",
      seq: 3,
      toolName: "shell_command",
      status: "ok",
      inputText: "echo http",
      outputText: "http",
      startedAt: "2026-06-18T10:00:40.000Z",
      completedAt: "2026-06-18T10:00:41.000Z",
      projectKey: "project-http",
      provider: "codex",
    },
  ],
  events: [],
  usageRecords: [],
  sessionEdges: [],
  artifacts: [],
  executionContexts: [],
});

const seedSessions = (sqlite: string, sessions: readonly MappedSession[]) =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const store = yield* LocalStore;
        for (const session of sessions) yield* store.upsertSession(session);
      }).pipe(Effect.provide(makeLocalStoreLayer(sqlite))),
    ),
  );

const seed = (sqlite: string) => seedSessions(sqlite, [mappedSession()]);

const waitFor = async (url: string) => {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // server not ready yet
    }
    await Bun.sleep(50);
  }
  throw new Error(`server did not become ready: ${url}`);
};

const postQuery = (
  port: number,
  body: Record<string, unknown>,
) => fetch(`http://127.0.0.1:${port}/query`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

const queryBase = {
  protocolVersion: "quasar.query/v1",
} as const;

describe("HTTP server", () => {
  test("accepts authenticated remote session ingest, skips unchanged fingerprints, and honors force", async () => {
    const dir = tempDir();
    const sqlite = join(dir, "quasar.sqlite");
    const port = 20_000 + Math.floor(Math.random() * 20_000);
    const token = "test-ingest-token";
    const proc = Bun.spawn(["bun", "run", "src/main.ts", "--host", "127.0.0.1", "--port", String(port)], {
      cwd: join(import.meta.dir, ".."),
      env: {
        ...process.env,
        QUASAR_INGEST_TOKEN: token,
        QUASAR_LOCAL_SQLITE: sqlite,
        // Hermetic: never eager-load the local fp32 query pipeline in tests.
        QUASAR_QUERY_EMBEDDING_PROVIDER: "synthetic",
      },
      stdout: "ignore",
      stderr: "ignore",
    });

    try {
      await waitFor(`http://127.0.0.1:${port}/health`);
      const first = await fetch(`http://127.0.0.1:${port}/ingest/session`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-quasar-ingest-token": token },
        body: JSON.stringify({ session: mappedSession() }),
      }).then((response) => response.json());
      const second = await fetch(`http://127.0.0.1:${port}/ingest/session`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-quasar-ingest-token": token },
        body: JSON.stringify({ session: mappedSession() }),
      }).then((response) => response.json());
      const forced = await fetch(`http://127.0.0.1:${port}/ingest/session?force=true`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-quasar-ingest-token": token },
        body: JSON.stringify({ session: mappedSession({ firstText: "forced http rewrite" }) }),
      }).then((response) => response.json());
      const messages = await postQuery(port, {
        ...queryBase,
        kind: "messages",
        filters: { sessionId: "codex:session-http" },
        projection: { detail: "summary", fields: ["text"] },
        page: { limit: 100 },
      }).then((response) => response.json());
      const status = await fetch(`http://127.0.0.1:${port}/status`).then((response) => response.json());

      expect(first.data.outcome.status).toBe("ok");
      expect(first.data.outcome.messagesWritten).toBe(2);
      expect(first.data.outcome.toolCallsWritten).toBe(1);
      expect(first.data.outcome.jobsEnqueued).toBe(2);
      expect(second.data.outcome.status).toBe("skipped");
      expect(forced.data.outcome.status).toBe("ok");
      expect(messages.items.map((row: { text: string }) => row.text)).toEqual(["forced http rewrite", "assistant-only http memory"]);
      // 2 jobs from the first ingest + 1 for the forced rewrite's new content
      // hash (the unchanged row's key dedups; the stale-hash job later no-ops
      // against the content-hash guard on message_vectors writes).
      expect(status.data.queue.pending).toBe(3);
      expect(status.data.lance).toBeUndefined();
    } finally {
      proc.kill();
      await proc.exited;
    }
  });

  test("remote session ingest fails closed without token and returns bad request for malformed JSON", async () => {
    const dir = tempDir();
    const sqlite = join(dir, "quasar.sqlite");
    const port = 20_000 + Math.floor(Math.random() * 20_000);
    const token = "test-ingest-token";
    const proc = Bun.spawn(["bun", "run", "src/main.ts", "--host", "127.0.0.1", "--port", String(port)], {
      cwd: join(import.meta.dir, ".."),
      env: {
        ...process.env,
        QUASAR_INGEST_TOKEN: token,
        QUASAR_LOCAL_SQLITE: sqlite,
        // Hermetic: never eager-load the local fp32 query pipeline in tests.
        QUASAR_QUERY_EMBEDDING_PROVIDER: "synthetic",
      },
      stdout: "ignore",
      stderr: "ignore",
    });

    try {
      await waitFor(`http://127.0.0.1:${port}/health`);
      const missingToken = await fetch(`http://127.0.0.1:${port}/ingest/session`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ session: mappedSession() }),
      });
      const malformed = await fetch(`http://127.0.0.1:${port}/ingest/session`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-quasar-ingest-token": token },
        body: "{",
      });
      const wrongShape = await fetch(`http://127.0.0.1:${port}/ingest/session`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-quasar-ingest-token": token },
        body: JSON.stringify({ session: { ...mappedSession(), messages: [] } }),
      });
      const unknownProviderSession = mappedSession();
      const unknownProviderResponse = await fetch(`http://127.0.0.1:${port}/ingest/session`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-quasar-ingest-token": token },
        body: JSON.stringify({
          session: {
            ...unknownProviderSession,
            session: { ...unknownProviderSession.session, provider: "nova-cli" },
          },
        }),
      });
      const unknownRoleSession = mappedSession();
      const unknownRoleResponse = await fetch(`http://127.0.0.1:${port}/ingest/session`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-quasar-ingest-token": token },
        body: JSON.stringify({
          session: {
            ...unknownRoleSession,
            messages: [{ ...unknownRoleSession.messages[0], role: "system" }, unknownRoleSession.messages[1]],
          },
        }),
      });
      // The boundary rejection must have written zero rows: nothing persisted.
      const sessionsAfter = await postQuery(port, {
        ...queryBase,
        kind: "sessions",
        projection: { detail: "summary", fields: ["sessionId"] },
        page: { limit: 100 },
      }).then((response) => response.json());

      expect(missingToken.status).toBe(401);
      expect(malformed.status).toBe(400);
      expect(wrongShape.status).toBe(400);
      expect(unknownProviderResponse.status).toBe(400);
      expect(unknownRoleResponse.status).toBe(400);
      expect(sessionsAfter.items).toEqual([]);
    } finally {
      proc.kill();
      await proc.exited;
    }
  });

  test("serves the strict projected query contract from SQLite truth", async () => {
    const dir = tempDir();
    const sqlite = join(dir, "quasar.sqlite");
    const inputText = JSON.stringify({ payload: "i".repeat(50_000) });
    const outputText = JSON.stringify({ payload: "o".repeat(50_000) });
    const rich = mappedSession();
    const minimal: MappedSession = {
      project: rich.project,
      session: {
        ...rich.session,
        sessionId: "codex:session-minimal",
        agentName: "codex-minimal",
        title: undefined,
        sourcePath: "/history/codex-session-minimal.jsonl",
        sourceFingerprint: "fingerprint-minimal",
        model: undefined,
        modelProvider: undefined,
        assignmentRole: undefined,
        messageCount: 0,
        toolCallCount: 0,
      },
      messages: [],
      toolCalls: [],
      events: [],
      usageRecords: [],
      sessionEdges: [],
      artifacts: [],
      executionContexts: [],
    };
    await seedSessions(sqlite, [
      {
        ...rich,
        toolCalls: [{ ...rich.toolCalls[0]!, inputText, outputText }],
      },
      minimal,
    ]);

    const port = 20_000 + Math.floor(Math.random() * 20_000);
    const proc = Bun.spawn(["bun", "run", "src/main.ts", "--host", "127.0.0.1", "--port", String(port)], {
      cwd: join(import.meta.dir, ".."),
      env: {
        ...process.env,
        QUASAR_LOCAL_SQLITE: sqlite,
        QUASAR_QUERY_EMBEDDING_PROVIDER: "synthetic",
      },
      stdout: "ignore",
      stderr: "ignore",
    });

    try {
      await waitFor(`http://127.0.0.1:${port}/health`);
      const projects = await fetch(`http://127.0.0.1:${port}/projects`).then((response) => response.json());
      const sessions = await postQuery(port, {
        ...queryBase,
        kind: "sessions",
        filters: {
          projectKey: "project-http",
          providers: ["codex"],
          agentRole: "builder",
          model: "gpt-5.6-sol",
          modelProvider: "openai",
        },
        projection: {
          detail: "detail",
          fields: ["sessionId", "model", "modelProvider", "agentRole", "agentPath", "agentDepth"],
        },
        page: { limit: 20 },
      }).then((response) => response.json());
      const firstPage = await postQuery(port, {
        ...queryBase,
        kind: "messages",
        filters: { sessionId: "codex:session-http" },
        projection: {
          detail: "detail",
          fields: ["messageId", "text", "model", "modelProvider", "agentRole"],
        },
        page: { limit: 1 },
      }).then((response) => response.json());
      const secondPage = await postQuery(port, {
        ...queryBase,
        kind: "messages",
        filters: { sessionId: "codex:session-http" },
        projection: {
          detail: "detail",
          fields: ["messageId", "text", "model", "modelProvider", "agentRole"],
        },
        page: { limit: 1, cursor: firstPage.page.nextCursor },
      }).then((response) => response.json());
      const mismatchedCursor = await postQuery(port, {
        ...queryBase,
        kind: "messages",
        filters: { sessionId: "codex:session-http", role: "assistant" },
        projection: {
          detail: "detail",
          fields: ["messageId", "text", "model", "modelProvider", "agentRole"],
        },
        page: { limit: 1, cursor: firstPage.page.nextCursor },
      });
      const summaryResponse = await postQuery(port, {
        ...queryBase,
        kind: "toolCalls",
        filters: { toolCallId: "tool-http" },
        projection: {
          detail: "summary",
          fields: ["toolCallId", "status", "inputBytes", "outputBytes"],
        },
        page: { limit: 1 },
      });
      const summaryText = await summaryResponse.text();
      const toolSummary = JSON.parse(summaryText);
      const toolDetail = await postQuery(port, {
        ...queryBase,
        kind: "toolCalls",
        filters: { toolCallId: "tool-http" },
        projection: {
          detail: "detail",
          fields: ["toolCallId", "input", "output", "error"],
        },
        page: { limit: 1 },
      }).then((response) => response.json());
      const nullProjection = await postQuery(port, {
        ...queryBase,
        kind: "sessions",
        filters: { sessionId: "codex:session-minimal" },
        projection: {
          detail: "detail",
          fields: ["sessionId", "model", "modelProvider", "agentRole", "agentPath", "agentDepth"],
        },
        page: { limit: 1 },
      }).then((response) => response.json());
      const lexical = await postQuery(port, {
        ...queryBase,
        kind: "search",
        text: "http",
        mode: "lexical",
        filters: {
          role: "assistant",
          agentRole: "builder",
          model: "gpt-5.6-sol",
          modelProvider: "openai",
        },
        projection: {
          detail: "detail",
          fields: ["sessionId", "text", "role", "model", "modelProvider", "agentRole"],
        },
        page: { limit: 20 },
      }).then((response) => response.json());
      const strictUnknown = await postQuery(port, {
        ...queryBase,
        kind: "sessions",
        projection: { detail: "summary", fields: ["sessionId"] },
        page: { limit: 1 },
        unknownField: true,
      });
      const semantic = await postQuery(port, {
        ...queryBase,
        kind: "search",
        text: "http",
        mode: "semantic",
        projection: { detail: "summary", fields: ["sessionId", "text", "score"] },
        page: { limit: 20 },
      });
      const fusion = await postQuery(port, {
        ...queryBase,
        kind: "search",
        text: "http",
        mode: "fusion",
        projection: { detail: "summary", fields: ["sessionId", "text", "score"] },
        page: { limit: 20 },
      });
      const [statusBody, readyBody, sessionDetail, ...legacy] = await Promise.all([
        fetch(`http://127.0.0.1:${port}/status`).then((response) => response.json()),
        fetch(`http://127.0.0.1:${port}/ready`).then((response) => response.json()),
        fetch(`http://127.0.0.1:${port}/session-detail?sessionId=codex%3Asession-http`),
        ...[
          "/sessions",
          "/messages?sessionId=codex%3Asession-http",
          "/tool-calls",
          "/tool-call?id=tool-http",
          "/search/lexical?q=http",
          "/search/semantic?q=http",
          "/search/fusion?q=http",
        ].map((path) => fetch(`http://127.0.0.1:${port}${path}`)),
      ]);

      expect(projects.data.rows.map((row: { projectKey: string }) => row.projectKey)).toEqual(["project-http"]);
      expect(sessions.items).toEqual([{
        sessionId: "codex:session-http",
        model: "gpt-5.6-sol",
        modelProvider: "openai",
        agentRole: "builder",
        agentPath: "/root/server-query",
        agentDepth: 1,
      }]);
      expect(Object.keys(sessions.items[0]).sort()).toEqual([...sessions.projection.fields].sort());
      expect(firstPage.items[0]).toEqual({
        messageId: "codex:session-http:1",
        text: "hello over http",
        model: "gpt-5.6-sol",
        modelProvider: "openai",
        agentRole: "builder",
      });
      expect(typeof firstPage.page.nextCursor).toBe("string");
      expect(secondPage.items[0].text).toBe("assistant-only http memory");
      expect(secondPage.page.nextCursor).toBeUndefined();
      expect(mismatchedCursor.status).toBe(400);
      expect(summaryResponse.status).toBe(200);
      expect(summaryText.length).toBeLessThan(2_000);
      expect(Object.keys(toolSummary.items[0]).sort()).toEqual(
        ["toolCallId", "status", "inputBytes", "outputBytes"].sort(),
      );
      expect(toolSummary.items[0]).toEqual({
        toolCallId: "tool-http",
        status: "ok",
        inputBytes: Buffer.byteLength(inputText),
        outputBytes: Buffer.byteLength(outputText),
      });
      expect(toolDetail.items[0].input).toEqual({ payload: "i".repeat(50_000) });
      expect(toolDetail.items[0].output).toEqual({ payload: "o".repeat(50_000) });
      expect(toolDetail.items[0].error).toBeNull();
      expect(nullProjection.items[0]).toEqual({
        sessionId: "codex:session-minimal",
        model: null,
        modelProvider: null,
        agentRole: null,
        agentPath: null,
        agentDepth: null,
      });
      expect(lexical.items).toEqual([{
        sessionId: "codex:session-http",
        text: "assistant-only http memory",
        role: "assistant",
        model: "gpt-5.6-sol",
        modelProvider: "openai",
        agentRole: "builder",
      }]);
      expect(strictUnknown.status).toBe(400);
      expect((await strictUnknown.json()).error.type).toBe("BadRequest");
      expect(semantic.status).toBe(503);
      expect((await semantic.json()).error.type).toBe("ServiceUnavailable");
      expect(fusion.status).toBe(503);
      expect((await fusion.json()).error.type).toBe("ServiceUnavailable");
      expect(statusBody.data.workers.workers).toEqual(["embeddings"]);
      expect(readyBody.data.modes).toEqual({ lexical: true, semantic: false, fusion: false });
      expect(sessionDetail.status).toBe(200);
      const [
        legacySessions,
        legacyMessages,
        legacyToolCalls,
        legacyToolCall,
        legacyLexical,
        legacySemantic,
        legacyFusion,
      ] = await Promise.all(legacy.map(async (response) => ({
        status: response.status,
        body: await response.json(),
      })));
      expect(legacySessions.status).toBe(200);
      expect(legacySessions.body.data.rows[0]).toMatchObject({
        sessionId: "codex:session-http",
        model: "gpt-5.6-sol",
        modelProvider: "openai",
        assignmentRole: "builder",
      });
      expect(legacyMessages.status).toBe(200);
      expect(legacyMessages.body.data.rows.map(
        (row: { text: string }) => row.text,
      )).toEqual(["hello over http", "assistant-only http memory"]);
      expect(legacyToolCalls.status).toBe(200);
      expect(legacyToolCalls.body.data.rows[0].id).toBe("tool-http");
      expect(legacyToolCall.status).toBe(200);
      expect(legacyToolCall.body.data.row.id).toBe("tool-http");
      expect(legacyLexical.status).toBe(200);
      expect(legacyLexical.body.data.matches.map(
        (hit: { row: { text: string } }) => hit.row.text,
      )).toEqual(["hello over http", "assistant-only http memory"]);
      expect(legacySemantic.status).toBe(503);
      expect(legacySemantic.body.error.type).toBe("SemanticDisabled");
      expect(legacyFusion.status).toBe(503);
      expect(legacyFusion.body.error.type).toBe("SemanticDisabled");
    } finally {
      proc.kill();
      await proc.exited;
    }
  }, 15_000);
});
