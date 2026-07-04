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
    messageCount: 2,
    toolCallCount: 1,
  },
  messages: [
    {
      sessionId: "codex:session-http",
      seq: 1,
      role: "user",
      text: overrides.firstText ?? "hello over http",
      ts: "2026-06-18T10:00:30.000Z",
      projectKey: "project-http",
      contentHash: "hash-http-1",
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
});

const seed = (sqlite: string) =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const store = yield* LocalStore;
        yield* store.upsertSession(mappedSession());
      }).pipe(Effect.provide(makeLocalStoreLayer(sqlite))),
    ),
  );

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
      const messages = await fetch(`http://127.0.0.1:${port}/messages?sessionId=codex%3Asession-http`).then((response) => response.json());
      const status = await fetch(`http://127.0.0.1:${port}/status`).then((response) => response.json());

      expect(first.data.outcome.status).toBe("ok");
      expect(first.data.outcome.messagesWritten).toBe(2);
      expect(first.data.outcome.toolCallsWritten).toBe(1);
      expect(first.data.outcome.jobsEnqueued).toBe(2);
      expect(second.data.outcome.status).toBe("skipped");
      expect(forced.data.outcome.status).toBe("ok");
      expect(messages.data.rows.map((row: { text: string }) => row.text)).toEqual(["forced http rewrite", "assistant-only http memory"]);
      expect(status.data.queue.pending).toBe(2);
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
      const sessionsAfter = await fetch(`http://127.0.0.1:${port}/sessions`).then((r) => r.json());

      expect(missingToken.status).toBe(401);
      expect(malformed.status).toBe(400);
      expect(wrongShape.status).toBe(400);
      expect(unknownProviderResponse.status).toBe(400);
      expect(unknownRoleResponse.status).toBe(400);
      expect(sessionsAfter.data.rows).toEqual([]);
    } finally {
      proc.kill();
      await proc.exited;
    }
  });

  test("serves local read APIs from SQLite truth", async () => {
    const dir = tempDir();
    const sqlite = join(dir, "quasar.sqlite");
    await seed(sqlite);

    const port = 20_000 + Math.floor(Math.random() * 20_000);
    const proc = Bun.spawn(["bun", "run", "src/main.ts", "--host", "127.0.0.1", "--port", String(port)], {
      cwd: join(import.meta.dir, ".."),
      env: {
        ...process.env,
        QUASAR_SEARCH_PROFILE: "1",
        QUASAR_LOCAL_SQLITE: sqlite,
      },
      stdout: "ignore",
      stderr: "ignore",
    });

    try {
      await waitFor(`http://127.0.0.1:${port}/health`);
      const [
        projects,
        messages,
        toolCalls,
        wrongProviderToolCalls,
        toolCall,
        missingToolCallId,
        search,
        roleSearch,
        providerSearch,
        wrongProviderSearch,
        projectSearch,
        wrongProjectSearch,
        statusBody,
        readyBody,
        semanticBody,
        fusionBody,
      ] = await Promise.all([
        fetch(`http://127.0.0.1:${port}/projects`).then((response) => response.json()),
        fetch(`http://127.0.0.1:${port}/messages?sessionId=codex%3Asession-http`).then((response) => response.json()),
        fetch(`http://127.0.0.1:${port}/tool-calls?provider=codex&toolName=shell_command`).then((response) => response.json()),
        fetch(`http://127.0.0.1:${port}/tool-calls?provider=grok&toolName=shell_command`).then((response) => response.json()),
        fetch(`http://127.0.0.1:${port}/tool-call?id=tool-http`).then((response) => response.json()),
        fetch(`http://127.0.0.1:${port}/tool-call`).then((response) => response.json()),
        fetch(`http://127.0.0.1:${port}/search/lexical?q=hello`).then((response) => response.json()),
        fetch(`http://127.0.0.1:${port}/search/lexical?q=http&role=assistant`).then((response) => response.json()),
        fetch(`http://127.0.0.1:${port}/search/lexical?q=http&provider=codex`).then((response) => response.json()),
        fetch(`http://127.0.0.1:${port}/search/lexical?q=http&provider=grok`).then((response) => response.json()),
        fetch(`http://127.0.0.1:${port}/search/lexical?q=http&projectKey=project-http`).then((response) => response.json()),
        fetch(`http://127.0.0.1:${port}/search/lexical?q=http&projectKey=project-other`).then((response) => response.json()),
        fetch(`http://127.0.0.1:${port}/status`).then((response) => response.json()),
        fetch(`http://127.0.0.1:${port}/ready`).then(async (response) => [response.status, await response.json()] as const),
        fetch(`http://127.0.0.1:${port}/search/semantic?q=http`).then(async (response) => [response.status, await response.json()] as const),
        fetch(`http://127.0.0.1:${port}/search/fusion?q=http`).then(async (response) => [response.status, await response.json()] as const),
      ]);

      expect(projects.data.rows.map((row: { projectKey: string }) => row.projectKey)).toEqual(["project-http"]);
      expect(messages.data.rows.map((row: { text: string }) => row.text)).toEqual(["hello over http", "assistant-only http memory"]);
      expect(toolCalls.data.rows.map((row: { id: string }) => row.id)).toEqual(["tool-http"]);
      expect(wrongProviderToolCalls.data.rows).toEqual([]);
      expect(toolCall.data.row.toolName).toBe("shell_command");
      expect(missingToolCallId.ok).toBe(false);
      expect(missingToolCallId.error.type).toBe("BadRequest");
      expect(search.data.receipt).toMatchObject({ route: "search/lexical", mode: "lexical", query: "hello" });
      expect(typeof search.data.receipt.startedAt).toBe("string");
      expect(typeof search.data.receipt.completedAt).toBe("string");
      expect(statusBody.data.lance).toBeUndefined();
      expect(statusBody.data.workers.workers).toEqual(["embeddings"]);
      expect(readyBody[0]).toBe(200);
      expect(readyBody[1]).toMatchObject({
        ok: true,
        data: {
          modes: { lexical: true, semantic: false, fusion: false },
          reason: "semantic pending vector materialization",
        },
      });
      expect(semanticBody[0]).toBe(503);
      expect(semanticBody[1]).toEqual({
        ok: false,
        route: "search/semantic",
        error: {
          type: "SemanticDisabled",
          message: "semantic search disabled pending vector materialization (QSR-232)",
        },
      });
      expect(fusionBody[0]).toBe(503);
      expect(fusionBody[1]).toMatchObject({ ok: false, route: "search/fusion", error: { type: "SemanticDisabled" } });
      expect(search.data.matches.map((hit: { row: { text: string } }) => hit.row.text)).toEqual(["hello over http"]);
      expect(roleSearch.data.matches.map((hit: { row: { text: string } }) => hit.row.text)).toEqual(["assistant-only http memory"]);
      expect(providerSearch.data.matches.map((hit: { row: { text: string } }) => hit.row.text).sort()).toEqual([
        "assistant-only http memory",
        "hello over http",
      ]);
      expect(wrongProviderSearch.data.matches).toEqual([]);
      expect(projectSearch.data.matches.map((hit: { row: { text: string } }) => hit.row.text).sort()).toEqual([
        "assistant-only http memory",
        "hello over http",
      ]);
      expect(wrongProjectSearch.data.matches).toEqual([]);
    } finally {
      proc.kill();
      await proc.exited;
    }
  }, 15_000);
});
