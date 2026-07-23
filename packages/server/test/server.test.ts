import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "bun:test";
import { Effect } from "effect";

import type { MappedSession } from "../src/model";
import { SERVER_MAX_REQUEST_BODY_SIZE_BYTES } from "../src/server";
import { LocalStore, makeLocalStoreLayer } from "../src/store";

const tempDirs: string[] = [];
const tempDir = () => {
  const dir = mkdtempSync(join(tmpdir(), "quasar-server-"));
  tempDirs.push(dir);
  return dir;
};

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const mappedSession = (overrides: { readonly fingerprint?: string; readonly firstText?: string } = {}): MappedSession => ({
  project: { projectKey: "project-http", displayName: "HTTP Project", rawPath: "/tmp/project-http" },
  session: {
    sessionId: "codex:session-http", projectKey: "project-http", provider: "codex", agentName: "codex",
    title: "HTTP fixture", startedAt: "2026-06-18T10:00:00.000Z", updatedAt: "2026-06-18T10:01:00.000Z",
    sourcePath: "/history/codex-session-http.jsonl", sourceFingerprint: overrides.fingerprint ?? "fingerprint-http",
    host: "host-http", identitySchemeVersion: 1, normalizationVersion: 4, model: "gpt-5.6-sol",
    modelProvider: "openai", assignmentRole: "builder", messageCount: 2, toolCallCount: 1,
  },
  assignment: { nickname: "server-query", role: "builder", path: "/root/server-query", depth: 1 },
  messages: [
    { sessionId: "codex:session-http", seq: 1, role: "user", text: overrides.firstText ?? "hello over http", ts: "2026-06-18T10:00:30.000Z", projectKey: "project-http", contentHash: `hash-http-1-${(overrides.firstText ?? "hello over http").length}` },
    { sessionId: "codex:session-http", seq: 2, role: "assistant", text: "assistant-only http memory", ts: "2026-06-18T10:00:35.000Z", projectKey: "project-http", contentHash: "hash-http-2" },
  ],
  toolCalls: [{ id: "tool-http", sessionId: "codex:session-http", seq: 3, toolName: "shell_command", status: "ok", inputText: "echo http", outputText: "http", startedAt: "2026-06-18T10:00:40.000Z", completedAt: "2026-06-18T10:00:41.000Z", projectKey: "project-http", provider: "codex" }],
  events: [], usageRecords: [], sessionEdges: [], artifacts: [], executionContexts: [],
});

const seed = (sqlite: string, sessions: readonly MappedSession[] = [mappedSession()]) => Effect.runPromise(
  Effect.scoped(Effect.gen(function* () {
    const store = yield* LocalStore;
    for (const session of sessions) yield* store.upsertSession(session);
  }).pipe(Effect.provide(makeLocalStoreLayer(sqlite)))),
);

const waitFor = async (url: string) => {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    try { if ((await fetch(url)).ok) return; } catch { /* server booting */ }
    await Bun.sleep(50);
  }
  throw new Error(`server did not become ready: ${url}`);
};

const startServer = (sqlite: string, token?: string) => {
  const port = 20_000 + Math.floor(Math.random() * 20_000);
  const proc = Bun.spawn(["bun", "run", "src/main.ts", "--host", "127.0.0.1", "--port", String(port)], {
    cwd: join(import.meta.dir, ".."),
    env: { ...process.env, QUASAR_LOCAL_SQLITE: sqlite, QUASAR_QUERY_EMBEDDING_PROVIDER: "synthetic", ...(token === undefined ? {} : { QUASAR_INGEST_TOKEN: token }) },
    stdout: "ignore", stderr: "ignore",
  });
  return { proc, base: `http://127.0.0.1:${port}` };
};

describe("HTTP server resources", () => {
  test("does not let Bun's 128 MiB default reject aggregate session requests", async () => {
    expect(SERVER_MAX_REQUEST_BODY_SIZE_BYTES).toBe(Number.MAX_SAFE_INTEGER);
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      maxRequestBodySize: SERVER_MAX_REQUEST_BODY_SIZE_BYTES,
      fetch: async (request) => new Response(String((await request.arrayBuffer()).byteLength)),
    });

    const bodySize = 167_743_747;
    const body = new Uint8Array(bodySize);

    try {
      const response = await fetch(`http://127.0.0.1:${server.port}/`, {
        method: "POST",
        body,
      });
      expect(response.status).toBe(200);
      expect(await response.text()).toBe(String(bodySize));
    } finally {
      await server.stop(true);
    }
  }, 30_000);

  test("ingest is authenticated and GET messages reflects a forced rewrite", async () => {
    const dir = tempDir();
    const { proc, base } = startServer(join(dir, "quasar.sqlite"), "test-ingest-token");
    try {
      await waitFor(`${base}/health`);
      const ingest = (session: MappedSession, force = false) => fetch(`${base}/ingest/session${force ? "?force=true" : ""}`, {
        method: "POST", headers: { "content-type": "application/json", "x-quasar-ingest-token": "test-ingest-token" }, body: JSON.stringify({ session }),
      }).then((response) => response.json());
      const first = await ingest(mappedSession());
      const second = await ingest(mappedSession());
      const forced = await ingest(mappedSession({ firstText: "forced http rewrite" }), true);
      const messages = await fetch(`${base}/messages?sessionId=codex%3Asession-http&limit=100`).then((response) => response.json());
      expect(first.data.outcome.status).toBe("ok");
      expect(second.data.outcome.status).toBe("skipped");
      expect(forced.data.outcome.status).toBe("ok");
      expect(messages.data.rows.map((row: { text: string }) => row.text)).toEqual(["forced http rewrite", "assistant-only http memory"]);
    } finally { proc.kill(); await proc.exited; }
  });

  test("ingest rejects malformed and invalid provider input without writing rows", async () => {
    const dir = tempDir();
    const { proc, base } = startServer(join(dir, "quasar.sqlite"), "test-ingest-token");
    try {
      await waitFor(`${base}/health`);
      const missingToken = await fetch(`${base}/ingest/session`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ session: mappedSession() }) });
      const malformed = await fetch(`${base}/ingest/session`, { method: "POST", headers: { "content-type": "application/json", "x-quasar-ingest-token": "test-ingest-token" }, body: "{" });
      const invalid = await fetch(`${base}/ingest/session`, { method: "POST", headers: { "content-type": "application/json", "x-quasar-ingest-token": "test-ingest-token" }, body: JSON.stringify({ session: { ...mappedSession(), session: { ...mappedSession().session, provider: "nova-cli" } } }) });
      const sessions = await fetch(`${base}/sessions?limit=100`).then((response) => response.json());
      expect(missingToken.status).toBe(401);
      expect(malformed.status).toBe(400);
      expect(invalid.status).toBe(400);
      expect(sessions.data.rows).toEqual([]);
    } finally { proc.kill(); await proc.exited; }
  });

  test("ingest run lifecycle persists running, completed, and failed ledger rows", async () => {
    const dir = tempDir();
    const { proc, base } = startServer(join(dir, "quasar.sqlite"), "test-ingest-token");
    const writeRun = (run: Record<string, unknown>) => fetch(`${base}/ingest/run`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-quasar-ingest-token": "test-ingest-token" },
      body: JSON.stringify({ run }),
    });
    const startedAt = "2026-07-23T12:00:00.000Z";
    try {
      await waitFor(`${base}/health`);
      const running = {
        runId: "run-recovery", provider: "codex", status: "running", startedAt,
        sessionsSeen: 0, sessionsWritten: 0, sessionsSkipped: 0, sessionsFailed: 0,
      };
      expect((await writeRun(running)).status).toBe(200);
      const recovery = await fetch(`${base}/ingest-run?runId=run-recovery`).then((response) => response.json());
      expect(recovery.data.row).toMatchObject({ ...running, completedAt: null });
      const whileRunning = await fetch(`${base}/status`).then((response) => response.json());
      expect(whileRunning.data.ingest).toEqual({ activeRuns: 1 });

      expect((await writeRun({ ...running, status: "completed", completedAt: "2026-07-23T12:01:00.000Z", sessionsSeen: 3, sessionsWritten: 2, sessionsSkipped: 1 })).status).toBe(200);
      const afterCompletion = await fetch(`${base}/status`).then((response) => response.json());
      expect(afterCompletion.data.ingest).toEqual({ activeRuns: 0 });
      expect((await writeRun({ ...running, runId: "run-failed", status: "failed", completedAt: "2026-07-23T12:02:00.000Z", sessionsSeen: 1, sessionsFailed: 1 })).status).toBe(200);
      const rows = await fetch(`${base}/ingest-runs?limit=10`).then((response) => response.json());
      expect(rows.data.rows).toEqual(expect.arrayContaining([
        expect.objectContaining({ runId: "run-recovery", status: "completed", sessionsSeen: 3, sessionsWritten: 2, sessionsSkipped: 1 }),
        expect.objectContaining({ runId: "run-failed", status: "failed", sessionsFailed: 1 }),
      ]));
      expect((await fetch(`${base}/ingest/run`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ run: running }) })).status).toBe(401);
      expect((await writeRun({ ...running, extra: true })).status).toBe(400);
      expect((await writeRun({ ...running, status: "completed" })).status).toBe(400);
    } finally { proc.kill(); await proc.exited; }
  });

  test("GET resources use enriched rows, bounded pages, summary tool calls, and typed failures", async () => {
    const dir = tempDir();
    const sqlite = join(dir, "quasar.sqlite");
    const rich = mappedSession();
    await seed(sqlite, [rich]);
    const { proc, base } = startServer(sqlite);
    try {
      await waitFor(`${base}/health`);
      const [sessions, messages, toolCalls, toolCall, lexical, semantic, fusion, missingMessages, missingToolCall, legacy] = await Promise.all([
        fetch(`${base}/sessions?projectKey=project-http&sessionId=codex%3Asession-http&provider=codex&agentRole=builder&model=gpt-5.6-sol&modelProvider=openai&limit=999`).then((response) => response.json()),
        fetch(`${base}/messages?sessionId=codex%3Asession-http&limit=1&offset=1`).then((response) => response.json()),
        fetch(`${base}/tool-calls?toolName=shell_command&limit=200`).then((response) => response.json()),
        fetch(`${base}/tool-call?id=tool-http`).then((response) => response.json()),
        fetch(`${base}/search/lexical?q=http&limit=20`).then((response) => response.json()),
        fetch(`${base}/search/semantic?q=http`).then((response) => ({ status: response.status, body: response.json() })),
        fetch(`${base}/search/fusion?q=http`).then((response) => ({ status: response.status, body: response.json() })),
        fetch(`${base}/messages`), fetch(`${base}/tool-call?id=missing`), fetch(`${base}/query`, { method: "POST" }),
      ]);
      expect(sessions.data.page).toEqual({ limit: 200, offset: 0, nextOffset: null });
      expect(sessions.data.rows[0]).toMatchObject({ sessionId: "codex:session-http", sourcePath: "/history/codex-session-http.jsonl", host: "host-http", identitySchemeVersion: 1, normalizationVersion: 4 });
      expect(sessions.data.rows[0].sourceFingerprint).toContain("fingerprint-http");
      expect(messages.data.page).toEqual({ limit: 1, offset: 1, nextOffset: null });
      expect(messages.data.rows[0].text).toBe("assistant-only http memory");
      expect(toolCalls.data.rows[0]).toMatchObject({ toolCallId: "tool-http", inputBytes: Buffer.byteLength("echo http"), outputBytes: Buffer.byteLength("http") });
      expect(toolCalls.data.rows[0].inputText).toBeUndefined();
      expect(toolCall.data.row).toMatchObject({ toolCallId: "tool-http", inputText: "echo http", outputText: "http" });
      expect(lexical.data.matches.map((match: { key: string; score: number; row: { text: string } }) => match.row.text)).toEqual(["hello over http", "assistant-only http memory"]);
      expect(lexical.data.matches.every((match: { key: string; score: number; row: { textTruncated: boolean; textBytes: number } }) => typeof match.key === "string" && typeof match.score === "number" && typeof match.row.textTruncated === "boolean" && typeof match.row.textBytes === "number")).toBe(true);
      expect(semantic.status).toBe(503);
      expect(fusion.status).toBe(503);
      expect(missingMessages.status).toBe(400);
      expect(missingToolCall.status).toBe(404);
      expect(legacy.status).toBe(404);
    } finally { proc.kill(); await proc.exited; }
  }, 15_000);

  test("search excerpts preserve UTF-8 boundaries inside the byte limit", async () => {
    const dir = tempDir();
    const sqlite = join(dir, "quasar.sqlite");
    const text = `${"a".repeat(1_999)}€ boundary`;
    await seed(sqlite, [mappedSession({ firstText: text })]);
    const { proc, base } = startServer(sqlite);
    try {
      await waitFor(`${base}/health`);
      const response = await fetch(`${base}/search/lexical?q=boundary`).then((result) => result.json());
      const row = response.data.matches[0].row as { text: string; textBytes: number; textTruncated: boolean };
      expect(row.text).toBe("a".repeat(1_999));
      expect(Buffer.byteLength(row.text)).toBeLessThanOrEqual(2_000);
      expect(row.text).not.toContain("�");
      expect(row.textBytes).toBe(Buffer.byteLength(text));
      expect(row.textTruncated).toBe(true);
    } finally { proc.kill(); await proc.exited; }
  }, 15_000);
});
