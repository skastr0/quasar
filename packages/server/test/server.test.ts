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
