/**
 * CLI <-> server HTTP contract (QSR-217).
 *
 * This is the executable lock on the wire contract between the Quasar CLI
 * (the sole ingest writer) and the Quasar server (storage + serving only).
 *
 * It spawns the REAL server process (packages/server/src/main.ts) on a random
 * port and drives the REAL CLI HTTP client code (postMappedSession /
 * postFingerprintProbe from packages/cli/src/ingest.ts) against it. The
 * contract is locked on the actual client path on purpose: not a raw `fetch`,
 * so a regression in the CLI client write path fails here.
 *
 * Read-back is over plain HTTP GET to prove the normalized MappedSession the
 * CLI client POSTed persisted as sessions, messages, tool calls, and queue
 * state, and that the derived lexical search index serves it.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";

import { postFingerprintProbe, postMappedSession } from "../src/ingest";
import type { MappedSession } from "../src/model";

const serverRoot = join(import.meta.dir, "..", "..", "server");

const tempDirs: string[] = [];

const tempDir = () => {
  const dir = mkdtempSync(join(tmpdir(), "quasar-http-contract-"));
  tempDirs.push(dir);
  return dir;
};

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

const randomPort = () => 20_000 + Math.floor(Math.random() * 20_000);

const sha256 = (text: string): string => createHash("sha256").update(text).digest("hex");

const mappedSession = (overrides: { readonly fingerprint?: string; readonly firstText?: string } = {}): MappedSession => ({
  project: { projectKey: "contract-project", displayName: "Contract Project", rawPath: "/tmp/contract-project" },
  session: {
    sessionId: "contract-session",
    projectKey: "contract-project",
    provider: "codex",
    agentName: "codex",
    title: "Contract fixture",
    startedAt: "2026-06-18T10:00:00.000Z",
    updatedAt: "2026-06-18T10:01:00.000Z",
    sourcePath: "/history/contract-session.jsonl",
    sourceFingerprint: overrides.fingerprint ?? "contract-fingerprint",
    host: "contract-host",
    identitySchemeVersion: 1,
    messageCount: 2,
    toolCallCount: 1,
  },
  messages: [
    {
      sessionId: "contract-session",
      seq: 1,
      role: "user",
      text: overrides.firstText ?? "contract handshake over http",
      ts: "2026-06-18T10:00:30.000Z",
      projectKey: "contract-project",
      contentHash: "contract-hash-1",
    },
    {
      sessionId: "contract-session",
      seq: 2,
      role: "assistant",
      text: "assistant contract reply",
      ts: "2026-06-18T10:00:35.000Z",
      projectKey: "contract-project",
      contentHash: "contract-hash-2",
    },
  ],
  toolCalls: [
    {
      id: "contract-tool",
      sessionId: "contract-session",
      seq: 3,
      toolName: "shell_command",
      status: "ok",
      inputText: "echo contract",
      outputText: "contract",
      startedAt: "2026-06-18T10:00:40.000Z",
      completedAt: "2026-06-18T10:00:41.000Z",
      projectKey: "contract-project",
      provider: "codex",
    },
  ],
});

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

const spawnServer = (
  sqlite: string,
  port: number,
  token: string,
  env: Record<string, string | undefined> = {},
) =>
  Bun.spawn(["bun", "run", "src/main.ts", "--host", "127.0.0.1", "--port", String(port)], {
    cwd: serverRoot,
    env: {
      ...process.env,
      QUASAR_INGEST_TOKEN: token,
      QUASAR_LOCAL_SQLITE: sqlite,
      ...env,
    },
    stdout: "ignore",
    stderr: "ignore",
  });

const fetchJson = async (url: string): Promise<{ readonly status: number; readonly body: any }> => {
  const response = await fetch(url);
  return { status: response.status, body: await response.json() };
};

describe("CLI HTTP client <-> server contract", () => {
  test("a normalized MappedSession POSTed via the CLI client persists and is served back over HTTP", async () => {
    const dir = tempDir();
    const sqlite = join(dir, "quasar.sqlite");
    const port = randomPort();
    const token = "contract-ingest-token";
    const base = `http://127.0.0.1:${port}`;
    const proc = spawnServer(sqlite, port, token);

    try {
      await waitFor(`${base}/health`);

      // Drive the REAL CLI client write path, not a raw fetch.
      const outcome = await postMappedSession(base, mappedSession(), { ingestToken: token });
      expect(outcome.status).toBe("ok");
      expect(outcome.messagesWritten).toBe(2);
      expect(outcome.toolCallsWritten).toBe(1);
      expect(outcome.jobsEnqueued).toBe(2);

      // The CLI client fingerprint probe must agree the session is now unchanged.
      const unchanged = await postFingerprintProbe(
        base,
        { sessionId: "contract-session", sourceFingerprint: "contract-fingerprint" },
        { ingestToken: token },
      );
      expect(unchanged).toBe(true);

      // Read everything back over plain HTTP — the server's serving surface.
      const [sessions, messages, toolCalls, status] = await Promise.all([
        fetch(`${base}/sessions`).then((r) => r.json()),
        fetch(`${base}/messages?sessionId=contract-session`).then((r) => r.json()),
        fetch(`${base}/tool-calls?provider=codex&toolName=shell_command`).then((r) => r.json()),
        fetch(`${base}/status`).then((r) => r.json()),
      ]);

      expect(sessions.data.rows.map((row: { sessionId: string }) => row.sessionId)).toEqual(["contract-session"]);
      expect(sessions.data.rows[0].messageCount).toBe(2);
      expect(sessions.data.rows[0].toolCallCount).toBe(1);
      expect(messages.data.rows.map((row: { text: string }) => row.text)).toEqual([
        "contract handshake over http",
        "assistant contract reply",
      ]);
      expect(toolCalls.data.rows.map((row: { id: string }) => row.id)).toEqual(["contract-tool"]);
      // The store/queue enqueued the derived work: one embed-message job per
      // searchable message (the two messages). Lexical search is trigger-
      // maintained in SQLite, so there is no index-session job; that the queue
      // holds exactly this work is the locked CLI->server contract on the
      // write path.
      expect(status.data.queue.pending).toBe(2);
      const byKind = status.data.queue.byKind as readonly { readonly kind: string; readonly pending: number }[];
      const pendingFor = (kind: string) => byKind.find((entry) => entry.kind === kind)?.pending;
      expect(pendingFor("index-session")).toBeUndefined();
      expect(pendingFor("embed-message")).toBe(2);
    } finally {
      proc.kill();
      await proc.exited;
    }
  }, 20_000);

  test("a malformed wire payload yields an explicit 4xx via the CLI client and never falls back to local runtime", async () => {
    const dir = tempDir();
    const sqlite = join(dir, "quasar.sqlite");
    const port = randomPort();
    const token = "contract-ingest-token";
    const base = `http://127.0.0.1:${port}`;
    const proc = spawnServer(sqlite, port, token);

    try {
      await waitFor(`${base}/health`);

      // A MappedSession whose declared messageCount disagrees with the rows is
      // garbage at the wire boundary. The server must reject it BEFORE any store
      // write, and the CLI client must surface that as a thrown error — never
      // silently swallow it or fall back to embedded/local persistence.
      const broken = mappedSession();
      const malformed = {
        ...broken,
        session: { ...broken.session, messageCount: 99 },
      } as MappedSession;

      let rejected: unknown;
      try {
        await postMappedSession(base, malformed, { ingestToken: token });
      } catch (error) {
        rejected = error;
      }
      expect(rejected).toBeInstanceOf(Error);
      expect((rejected as Error).name).toBe("RemoteIngestError");

      // Fail-closed proof: nothing was persisted; the boundary rejection wrote
      // zero rows, so the CLI client did NOT fall back to a local write.
      const sessions = await fetch(`${base}/sessions`).then((r) => r.json());
      expect(sessions.data.rows).toEqual([]);
      const messages = await fetch(`${base}/messages?sessionId=contract-session`).then((r) => r.json());
      expect(messages.data.rows).toEqual([]);
    } finally {
      proc.kill();
      await proc.exited;
    }
  }, 20_000);

  test("search and readiness expose the current HTTP contract over derived index state", async () => {
    const dir = tempDir();
    const sqlite = join(dir, "quasar.sqlite");
    const port = randomPort();
    const token = "contract-ingest-token";
    const base = `http://127.0.0.1:${port}`;
    const searchEnv = {
      QUASAR_SEARCH_PROFILE: "1",
      QUASAR_EMBEDDING_PROVIDER: "synthetic",
      SYNTHETIC_API_KEY: "",
    };
    let proc = spawnServer(sqlite, port, token, searchEnv);

    try {
      await waitFor(`${base}/health`);

      const emptyLexical = await fetchJson(`${base}/search/lexical?q=${encodeURIComponent("handshake")}&limit=5`);
      expect(emptyLexical.status).toBe(200);
      expect(emptyLexical.body).toMatchObject({ ok: true, command: "search/lexical" });
      expect(emptyLexical.body.data.matches).toEqual([]);

      // /ready is cheap truth: lexical serves from the SQLite truth table;
      // semantic/fusion are disabled pending vector materialization (QSR-232).
      const emptyReady = await fetchJson(`${base}/ready`);
      expect(emptyReady.status).toBe(200);
      expect(emptyReady.body).toMatchObject({
        ok: true,
        command: "ready",
        data: {
          modes: { lexical: true, semantic: false, fusion: false },
          reason: "semantic pending vector materialization",
        },
      });

      const outcome = await postMappedSession(base, mappedSession(), { ingestToken: token });
      expect(outcome.status).toBe("ok");

      const embeddingStatus = await fetchJson(`${base}/status`);
      const cacheNamespace = embeddingStatus.body.data.embeddings.profile.cacheNamespace as string;
      const documentText = "search_document: contract handshake over http";
      const db = new Database(sqlite);
      try {
        db.prepare(
          `INSERT INTO embedding_cache(model, content_hash, dimensions, text_bytes, vector_json, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          cacheNamespace,
          sha256(documentText),
          768,
          new TextEncoder().encode(documentText).byteLength,
          JSON.stringify(Array.from({ length: 768 }, (_, index) => index === 0 ? 1 : 0)),
          "2026-06-18T10:00:00.000Z",
          "2026-06-18T10:00:00.000Z",
        );
      } finally {
        db.close();
      }

      const replay = await fetchJson(`${base}/maintenance/embeddings/replay-cache?limit=10`);
      expect(replay.status).toBe(200);
      expect(replay.body).toMatchObject({
        ok: true,
        command: "maintenance/embeddings/replay-cache",
        data: {
          report: { scanned: 2, cacheHits: 1, missingCache: 1, sqliteVectorsUpserted: 1 },
          coverage: { searchableMessages: 2, vectorRows: 1, vectorlessMessages: 1, staleVectorRows: 0 },
        },
      });

      const secondDocumentText = "search_document: assistant contract reply";
      const dbAfterReplay = new Database(sqlite);
      try {
        dbAfterReplay.prepare(
          `INSERT INTO embedding_cache(model, content_hash, dimensions, text_bytes, vector_json, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          cacheNamespace,
          sha256(secondDocumentText),
          768,
          new TextEncoder().encode(secondDocumentText).byteLength,
          JSON.stringify(Array.from({ length: 768 }, (_, index) => index === 1 ? 1 : 0)),
          "2026-06-18T10:00:00.000Z",
          "2026-06-18T10:00:00.000Z",
        );
      } finally {
        dbAfterReplay.close();
      }

      const materialize = await fetchJson(`${base}/maintenance/embeddings/materialize-sqlite?limit=10`);
      expect(materialize.status).toBe(200);
      expect(materialize.body).toMatchObject({
        ok: true,
        command: "maintenance/embeddings/materialize-sqlite",
        data: {
          report: {
            scanned: 1,
            cacheHits: 1,
            cacheMisses: 0,
            embedded: 0,
            skipped: 0,
            sqliteVectorsUpserted: 1,
          },
          coverage: { searchableMessages: 2, vectorRows: 2, vectorlessMessages: 0, staleVectorRows: 0 },
          embedding: { provider: "synthetic" },
        },
      });
      expect(materialize.body.data.lance).toBeUndefined();
      expect(materialize.body.data.queue).toBeUndefined();

      const lexical = await fetchJson(
        `${base}/search/lexical?q=${encodeURIComponent("handshake")}&limit=5&projectKey=contract-project`,
      );
      expect(lexical.status).toBe(200);
      expect(lexical.body).toMatchObject({
        ok: true,
        command: "search/lexical",
        data: {
          receipt: {
            route: "search/lexical",
            mode: "lexical",
            query: "handshake",
            limit: 5,
            statusCode: 200,
          },
        },
      });
      expect(lexical.body.data.matches.map((hit: { row: { text: string } }) => hit.row.text)).toEqual([
        "contract handshake over http",
      ]);

      const roleSearch = await fetchJson(
        `${base}/search/lexical?q=${encodeURIComponent("assistant")}&role=assistant&limit=5`,
      );
      expect(roleSearch.status).toBe(200);
      expect(roleSearch.body.data.matches.map((hit: { row: { role: string; text: string } }) => hit.row)).toEqual([
        expect.objectContaining({ role: "assistant", text: "assistant contract reply" }),
      ]);

      const hostileInput = "\" OR foo:bar - ()";
      const hostileQuery = await fetchJson(`${base}/search/lexical?q=${encodeURIComponent(hostileInput)}&limit=5`);
      expect(hostileQuery.status).toBe(200);
      expect(hostileQuery.body).toMatchObject({
        ok: true,
        command: "search/lexical",
        data: {
          receipt: {
            route: "search/lexical",
            mode: "lexical",
            query: hostileInput,
            limit: 5,
            statusCode: 200,
          },
        },
      });
      expect(Array.isArray(hostileQuery.body.data.matches)).toBe(true);

      const missingQuery = await fetchJson(`${base}/search/lexical`);
      expect(missingQuery.status).toBe(400);
      expect(missingQuery.body).toEqual({
        ok: false,
        route: "search/lexical",
        error: { type: "BadRequest", message: "q is required" },
      });

      // Empty-boot degrade mode: this process booted with ZERO vector rows, and
      // appends/materialization never resurrect an empty-boot matrix
      // mid-process, so semantic surfaces stay an honest fast 503 until reboot.
      const ready = await fetchJson(`${base}/ready`);
      expect(ready.status).toBe(200);
      expect(ready.body).toMatchObject({
        ok: true,
        command: "ready",
        data: {
          modes: { lexical: true, semantic: false, fusion: false },
          reason: "semantic pending vector materialization",
        },
      });

      const semantic = await fetchJson(`${base}/search/semantic?q=${encodeURIComponent("handshake")}&limit=5`);
      expect(semantic.status).toBe(503);
      expect(semantic.body).toEqual({
        ok: false,
        route: "search/semantic",
        error: {
          type: "SemanticDisabled",
          message: "semantic search disabled pending vector materialization (QSR-232)",
        },
      });
      const fusion = await fetchJson(`${base}/search/fusion?q=${encodeURIComponent("handshake")}&limit=5`);
      expect(fusion.status).toBe(503);
      expect(fusion.body).toEqual({
        ok: false,
        route: "search/fusion",
        error: {
          type: "SemanticDisabled",
          message: "semantic search disabled pending vector materialization (QSR-232)",
        },
      });

      // --- RE-ENABLED contract (QSR-232 cutover): vectors exist in
      // message_vectors, so the next boot loads the resident matrix and
      // semantic/fusion serve 200 + matches. Seed the QUERY vector in the
      // embedding cache first: embedText is cache-first over
      // sha256(queryPrefix + text), so no external embedder is touched.
      const queryDocumentText = "search_query: handshake";
      const queryDb = new Database(sqlite);
      try {
        queryDb.prepare(
          `INSERT INTO embedding_cache(model, content_hash, dimensions, text_bytes, vector_json, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          cacheNamespace,
          sha256(queryDocumentText),
          768,
          new TextEncoder().encode(queryDocumentText).byteLength,
          // Same direction as the first document vector: cosine 1.0 against
          // "contract handshake over http", 0.0 against the assistant reply.
          JSON.stringify(Array.from({ length: 768 }, (_, index) => index === 0 ? 1 : 0)),
          "2026-06-18T10:00:00.000Z",
          "2026-06-18T10:00:00.000Z",
        );
      } finally {
        queryDb.close();
      }

      proc.kill();
      await proc.exited;
      const rebootPort = randomPort();
      const rebootBase = `http://127.0.0.1:${rebootPort}`;
      proc = spawnServer(sqlite, rebootPort, token, searchEnv);
      await waitFor(`${rebootBase}/health`);

      // The matrix boot load is forked; poll /ready until semantic flips true.
      const deadline = Date.now() + 10_000;
      let readyOn = await fetchJson(`${rebootBase}/ready`);
      while (readyOn.body?.data?.modes?.semantic !== true && Date.now() < deadline) {
        await Bun.sleep(100);
        readyOn = await fetchJson(`${rebootBase}/ready`);
      }
      expect(readyOn.status).toBe(200);
      expect(readyOn.body).toMatchObject({
        ok: true,
        command: "ready",
        data: {
          modes: { lexical: true, semantic: true, fusion: true },
          matrix: {
            model: cacheNamespace,
            rows: 2,
            dimensions: 768,
            watermark: { matrixRows: 2, sqliteRows: 2 },
          },
        },
      });
      expect(readyOn.body.data.reason).toBeUndefined();

      const semanticOn = await fetchJson(`${rebootBase}/search/semantic?q=${encodeURIComponent("handshake")}&limit=5`);
      expect(semanticOn.status).toBe(200);
      expect(semanticOn.body).toMatchObject({
        ok: true,
        command: "search/semantic",
        data: {
          receipt: {
            route: "search/semantic",
            mode: "semantic",
            query: "handshake",
            limit: 5,
            statusCode: 200,
          },
        },
      });
      expect(semanticOn.body.data.matches.map((hit: { row: { text: string } }) => hit.row.text)).toEqual([
        "contract handshake over http",
        "assistant contract reply",
      ]);
      expect(semanticOn.body.data.matches[0].score).toBeGreaterThan(0.99);

      // Filtered semantic: SQL candidate-id set -> mask on the exact scan.
      const semanticFiltered = await fetchJson(
        `${rebootBase}/search/semantic?q=${encodeURIComponent("handshake")}&limit=5&projectKey=contract-project&role=assistant`,
      );
      expect(semanticFiltered.status).toBe(200);
      expect(semanticFiltered.body.data.matches.map((hit: { row: { role: string; text: string } }) => hit.row)).toEqual([
        expect.objectContaining({ role: "assistant", text: "assistant contract reply" }),
      ]);

      // Fusion: RRF over lexical + semantic lists; both rank the handshake
      // message first here, so it must fuse to the top.
      const fusionOn = await fetchJson(`${rebootBase}/search/fusion?q=${encodeURIComponent("handshake")}&limit=5`);
      expect(fusionOn.status).toBe(200);
      expect(fusionOn.body).toMatchObject({
        ok: true,
        command: "search/fusion",
        data: {
          receipt: {
            route: "search/fusion",
            mode: "fusion",
            query: "handshake",
            limit: 5,
            statusCode: 200,
          },
        },
      });
      expect(fusionOn.body.data.matches.length).toBeGreaterThanOrEqual(2);
      expect(fusionOn.body.data.matches[0].row.text).toBe("contract handshake over http");
    } finally {
      proc.kill();
      await proc.exited;
    }
  }, 40_000);
});
