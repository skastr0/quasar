import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { NORMALIZED_SESSION_PROTOCOL_VERSION } from "@skastr0/quasar-protocol";
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
  protocolVersion: NORMALIZED_SESSION_PROTOCOL_VERSION,
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
    { sessionId: "codex:session-http", eventId: "event-http-user", seq: 0, role: "user", text: overrides.firstText ?? "hello over http", ts: "2026-06-18T10:00:30.000Z", projectKey: "project-http", contentHash: `hash-http-1-${(overrides.firstText ?? "hello over http").length}`, model: "gpt-5.6-sol", modelProvider: "openai" },
    { sessionId: "codex:session-http", eventId: "event-http-assistant", seq: 1, role: "assistant", text: "assistant-only http memory", ts: "2026-06-18T10:00:35.000Z", projectKey: "project-http", contentHash: "hash-http-2", model: "gpt-5.6-sol", modelProvider: "openai" },
  ],
  toolCalls: [{ id: "tool-http", sessionId: "codex:session-http", eventId: "event-http-tool", seq: 2, toolName: "shell_command", status: "ok", inputText: "echo http", outputText: "http", startedAt: "2026-06-18T10:00:40.000Z", completedAt: "2026-06-18T10:00:41.000Z", projectKey: "project-http", provider: "codex", model: "gpt-5.6-sol", modelProvider: "openai" }],
  events: [
    {
      id: "event-http-user",
      sessionId: "codex:session-http",
      sequence: 0,
      timestamp: "2026-06-18T10:00:30.000Z",
      machineId: "machine-http",
      provider: "codex",
      agentName: "codex",
      projectIdentityKey: "project-http",
      role: "user",
      kind: "message",
      contentText: overrides.firstText ?? "hello over http",
      contentBlocks: [],
      rawReference: { sourcePath: "/history/codex-session-http.jsonl", line: 1 },
    },
    {
      id: "event-http-assistant",
      sessionId: "codex:session-http",
      sequence: 1,
      timestamp: "2026-06-18T10:00:35.000Z",
      machineId: "machine-http",
      provider: "codex",
      agentName: "codex",
      projectIdentityKey: "project-http",
      role: "assistant",
      kind: "message",
      contentText: "assistant-only http memory",
      contentBlocks: [],
      rawReference: { sourcePath: "/history/codex-session-http.jsonl", line: 2 },
    },
    {
      id: "event-http-tool",
      sessionId: "codex:session-http",
      sequence: 2,
      timestamp: "2026-06-18T10:00:40.000Z",
      machineId: "machine-http",
      provider: "codex",
      agentName: "codex",
      projectIdentityKey: "project-http",
      role: "tool",
      kind: "tool_call",
      contentBlocks: [],
      toolCallId: "tool-http",
      rawReference: { sourcePath: "/history/codex-session-http.jsonl", line: 3 },
    },
  ],
  usageRecords: [], sessionEdges: [], artifacts: [], executionContexts: [],
});

const descendantSession = (
  sessionId: string,
  parentSessionId: string,
): MappedSession => {
  const source: any = structuredClone(mappedSession());
  const eventIds = new Map(
    source.events.map((event: any, index: number) => [
      event.id,
      `${sessionId}:event:${index}`,
    ]),
  );
  const toolIds = new Map(
    source.toolCalls.map((toolCall: any, index: number) => [
      toolCall.id,
      `${sessionId}:tool:${index}`,
    ]),
  );
  source.session = {
    ...source.session,
    sessionId,
    parentSessionId,
    title: `Child ${sessionId}`,
    sourcePath: `/history/${encodeURIComponent(sessionId)}.jsonl`,
    sourceFingerprint: `fingerprint-${sessionId}`,
  };
  source.messages = source.messages.map((message: any) => ({
    ...message,
    sessionId,
    eventId: eventIds.get(message.eventId),
  }));
  source.toolCalls = source.toolCalls.map((toolCall: any) => ({
    ...toolCall,
    id: toolIds.get(toolCall.id),
    sessionId,
    eventId: eventIds.get(toolCall.eventId),
  }));
  source.events = source.events.map((event: any) => ({
    ...event,
    id: eventIds.get(event.id),
    sessionId,
    ...(event.toolCallId !== undefined
      ? { toolCallId: toolIds.get(event.toolCallId) }
      : {}),
    rawReference: {
      ...event.rawReference,
      sourcePath: source.session.sourcePath,
    },
  }));
  source.sessionEdges = [{
    id: `${sessionId}:edge:subagent`,
    sessionId,
    machineId: source.events[0].machineId,
    provider: source.session.provider,
    agentName: source.session.agentName,
    projectIdentityKey: source.session.projectKey,
    kind: "subagent_of",
    fromId: parentSessionId,
    toId: sessionId,
  }];
  return source as MappedSession;
};

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

  test("GET messages scans globally and continues from a stable keyset page", async () => {
    const dir = tempDir();
    const sqlite = join(dir, "quasar.sqlite");
    const root = mappedSession();
    const child = descendantSession(
      "codex:session-http:child",
      root.session.sessionId,
    );
    const grandchild = descendantSession(
      "codex:session-http:grandchild",
      child.session.sessionId,
    );
    await seed(sqlite, [root, child, grandchild]);
    const { proc, base } = startServer(sqlite);
    try {
      await waitFor(`${base}/health`);
      const firstResponse = await fetch(`${base}/messages?limit=3`);
      expect(firstResponse.status).toBe(200);
      const first = await firstResponse.json();
      expect(first.data.sessionId).toBeUndefined();
      expect(first.data.rows.map((row: { sessionId: string; sequence: number }) => [
        row.sessionId,
        row.sequence,
      ])).toEqual([
        ["codex:session-http", 0],
        ["codex:session-http", 1],
        ["codex:session-http:child", 0],
      ]);
      expect(first.data.page).toEqual({
        limit: 3,
        snapshot: expect.any(String),
        next: {
          sessionId: "codex:session-http:child",
          sequence: 0,
        },
      });

      const next = first.data.page.next as {
        sessionId: string;
        sequence: number;
      };
      const continuation = new URLSearchParams({
        limit: "3",
        afterSessionId: next.sessionId,
        afterSequence: String(next.sequence),
        snapshot: first.data.page.snapshot,
      });
      const secondResponse = await fetch(`${base}/messages?${continuation}`);
      expect(secondResponse.status).toBe(200);
      const second = await secondResponse.json();
      expect(second.data.rows.map((row: { sessionId: string; sequence: number }) => [
        row.sessionId,
        row.sequence,
      ])).toEqual([
        ["codex:session-http:child", 1],
        ["codex:session-http:grandchild", 0],
        ["codex:session-http:grandchild", 1],
      ]);
      expect(second.data.page).toEqual({
        limit: 3,
        snapshot: first.data.page.snapshot,
        next: null,
      });
    } finally {
      proc.kill();
      await proc.exited;
    }
  });

  test("GET messages applies time, root, and recursive lineage filters", async () => {
    const dir = tempDir();
    const sqlite = join(dir, "quasar.sqlite");
    const root = mappedSession();
    const child = descendantSession(
      "codex:session-http:child",
      root.session.sessionId,
    );
    const grandchild = descendantSession(
      "codex:session-http:grandchild",
      child.session.sessionId,
    );
    await seed(sqlite, [root, child, grandchild]);
    const { proc, base } = startServer(sqlite);
    try {
      await waitFor(`${base}/health`);
      const [
        messageWindow,
        inclusiveSessionStart,
        exclusiveSessionStart,
        roots,
        lineage,
      ] = await Promise.all([
        fetch(`${base}/messages?messageAfter=2026-06-18T10%3A00%3A30.000Z&messageBefore=2026-06-18T10%3A00%3A35.000Z&limit=100`).then((response) => response.json()),
        fetch(`${base}/messages?sessionStartedAfter=2026-06-18T10%3A00%3A00.000Z&sessionStartedBefore=2026-06-18T10%3A00%3A00.001Z&limit=100`).then((response) => response.json()),
        fetch(`${base}/messages?sessionStartedBefore=2026-06-18T10%3A00%3A00.000Z&limit=100`).then((response) => response.json()),
        fetch(`${base}/messages?rootsOnly=true&limit=100`).then((response) => response.json()),
        fetch(`${base}/messages?lineageRootSessionId=codex%3Asession-http%3Achild&limit=100`).then((response) => response.json()),
      ]);
      expect(messageWindow.data.rows.map((row: { sequence: number }) => row.sequence)).toEqual([0, 0, 0]);
      expect(inclusiveSessionStart.data.rows).toHaveLength(6);
      expect(exclusiveSessionStart.data.rows).toEqual([]);
      expect(new Set(roots.data.rows.map((row: { sessionId: string }) => row.sessionId))).toEqual(
        new Set(["codex:session-http"]),
      );
      expect(new Set(lineage.data.rows.map((row: { sessionId: string }) => row.sessionId))).toEqual(
        new Set([
          "codex:session-http:child",
          "codex:session-http:grandchild",
        ]),
      );
      expect(lineage.data.rows).toHaveLength(4);
    } finally {
      proc.kill();
      await proc.exited;
    }
  });

  test("GET messages rejects offsets and expires a cursor after forced ingest", async () => {
    const dir = tempDir();
    const sqlite = join(dir, "quasar.sqlite");
    const root = mappedSession();
    const child = descendantSession(
      "codex:session-http:child",
      root.session.sessionId,
    );
    await seed(sqlite, [root, child]);
    const { proc, base } = startServer(sqlite, "test-ingest-token");
    try {
      await waitFor(`${base}/health`);
      const [offset, unknown, firstResponse] = await Promise.all([
        fetch(`${base}/messages?offset=1`),
        fetch(`${base}/messages?bogus=true`),
        fetch(`${base}/messages?limit=1`),
      ]);
      expect(offset.status).toBe(400);
      expect(await offset.json()).toMatchObject({
        error: {
          type: "BadRequest",
          message: expect.stringContaining("offset"),
        },
      });
      expect(unknown.status).toBe(400);
      expect(await unknown.json()).toMatchObject({
        error: {
          type: "BadRequest",
          message: expect.stringContaining("bogus"),
        },
      });
      expect(firstResponse.status).toBe(200);
      const first = await firstResponse.json();
      expect(first.data.page.next).toEqual({
        sessionId: "codex:session-http",
        sequence: 0,
      });

      const forced = await fetch(`${base}/ingest/session?force=true`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-quasar-ingest-token": "test-ingest-token",
        },
        body: JSON.stringify({
          session: mappedSession({ firstText: "cursor invalidation rewrite" }),
        }),
      });
      expect(forced.status).toBe(200);
      expect((await forced.json()).data.outcome.status).toBe("ok");

      const continuation = new URLSearchParams({
        limit: "1",
        afterSessionId: first.data.page.next.sessionId,
        afterSequence: String(first.data.page.next.sequence),
        snapshot: first.data.page.snapshot,
      });
      const expired = await fetch(`${base}/messages?${continuation}`);
      expect(expired.status).toBe(409);
      expect(await expired.json()).toMatchObject({
        error: {
          type: "QuerySnapshotExpiredError",
          action: expect.stringContaining("Restart"),
        },
      });
    } finally {
      proc.kill();
      await proc.exited;
    }
  });

  test("GET messages continues an unchanged scan after server restart", async () => {
    const dir = tempDir();
    const sqlite = join(dir, "quasar.sqlite");
    await seed(sqlite, [mappedSession()]);

    const firstServer = startServer(sqlite);
    let continuation: URLSearchParams;
    try {
      await waitFor(`${firstServer.base}/health`);
      const firstResponse = await fetch(
        `${firstServer.base}/messages?limit=1`,
      );
      expect(firstResponse.status).toBe(200);
      const first = await firstResponse.json();
      continuation = new URLSearchParams({
        limit: "1",
        afterSessionId: first.data.page.next.sessionId,
        afterSequence: String(first.data.page.next.sequence),
        snapshot: first.data.page.snapshot,
      });
    } finally {
      firstServer.proc.kill();
      await firstServer.proc.exited;
    }

    const secondServer = startServer(sqlite);
    try {
      await waitFor(`${secondServer.base}/health`);
      const continued = await fetch(
        `${secondServer.base}/messages?${continuation!}`,
      );
      expect(continued.status).toBe(200);
      expect(await continued.json()).toMatchObject({
        data: {
          rows: [{
            sessionId: "codex:session-http",
            sequence: 1,
          }],
          page: {
            snapshot: continuation!.get("snapshot"),
            next: null,
          },
        },
      });
    } finally {
      secondServer.proc.kill();
      await secondServer.proc.exited;
    }
  });

  test("ingest rejects malformed and invalid provider input without writing rows", async () => {
    const dir = tempDir();
    const { proc, base } = startServer(join(dir, "quasar.sqlite"), "test-ingest-token");
    try {
      await waitFor(`${base}/health`);
      const missingToken = await fetch(`${base}/ingest/session`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ session: mappedSession() }) });
      const malformed = await fetch(`${base}/ingest/session`, { method: "POST", headers: { "content-type": "application/json", "x-quasar-ingest-token": "test-ingest-token" }, body: "{" });
      const invalid = await fetch(`${base}/ingest/session`, { method: "POST", headers: { "content-type": "application/json", "x-quasar-ingest-token": "test-ingest-token" }, body: JSON.stringify({ session: { ...mappedSession(), session: { ...mappedSession().session, provider: "nova-cli" } } }) });
      const skewed = await fetch(`${base}/ingest/session`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-quasar-ingest-token": "test-ingest-token",
        },
        body: JSON.stringify({
          session: {
            ...mappedSession(),
            protocolVersion: "quasar.normalized-session/v0",
          },
        }),
      });
      const sessions = await fetch(`${base}/sessions?limit=100`).then((response) => response.json());
      expect(missingToken.status).toBe(401);
      expect(malformed.status).toBe(400);
      expect(invalid.status).toBe(400);
      expect(skewed.status).toBe(400);
      expect(await skewed.json()).toMatchObject({
        error: {
          type: "ProtocolVersionMismatch",
          expected: NORMALIZED_SESSION_PROTOCOL_VERSION,
          received: "quasar.normalized-session/v0",
        },
      });
      expect(sessions.data.rows).toEqual([]);
    } finally { proc.kill(); await proc.exited; }
  });

  test("trajectory rejects stale stored source facts with an actionable replay error", async () => {
    const dir = tempDir();
    const sqlite = join(dir, "quasar.sqlite");
    await seed(sqlite);
    const db = new Database(sqlite);
    try {
      db.query(
        "DELETE FROM session_events WHERE session_id = ? AND id = ?",
      ).run("codex:session-http", "event-http-user");
    } finally {
      db.close();
    }
    const { proc, base } = startServer(sqlite);
    try {
      await waitFor(`${base}/health`);
      const response = await fetch(
        `${base}/trajectory?sessionId=codex%3Asession-http`,
      );
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({
        error: {
          type: "TrajectorySourceInvalid",
          sessionId: "codex:session-http",
          action: expect.stringContaining("Re-ingest"),
        },
      });
    } finally {
      proc.kill();
      await proc.exited;
    }
  });

  test("ATIF trajectory embeds the complete stored subagent tree", async () => {
    const dir = tempDir();
    const sqlite = join(dir, "quasar.sqlite");
    const root = mappedSession();
    const child = descendantSession(
      "codex:session-http:child",
      root.session.sessionId,
    );
    const grandchild = descendantSession(
      "codex:session-http:grandchild",
      child.session.sessionId,
    );
    await seed(sqlite, [root, child, grandchild]);
    const { proc, base } = startServer(sqlite);
    try {
      await waitFor(`${base}/health`);
      const response = await fetch(
        `${base}/trajectory?sessionId=codex%3Asession-http&format=atif`,
      );
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.data).toMatchObject({
        format: "quasar.trajectory.atif-export/v1",
        schemaVersion: "ATIF-v1.7",
        compatibility: {
          valid: true,
          counts: {
            sourceSessions: 3,
            embeddedSubagents: 2,
          },
        },
      });
      const embeddedChild = body.data.trajectory.subagent_trajectories[0];
      expect(embeddedChild.session_id).toBe(child.session.sessionId);
      expect(embeddedChild.subagent_trajectories[0].session_id).toBe(
        grandchild.session.sessionId,
      );
      expect(
        body.data.trajectory.steps.at(-1).observation.results[0]
          .subagent_trajectory_ref[0].trajectory_id,
      ).toBe(child.session.sessionId);
    } finally {
      proc.kill();
      await proc.exited;
    }
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
      const [sessions, messages, toolCalls, toolCall, lexical, semantic, fusion, missingToolCall, legacy] = await Promise.all([
        fetch(`${base}/sessions?projectKey=project-http&sessionId=codex%3Asession-http&provider=codex&agentRole=builder&model=gpt-5.6-sol&modelProvider=openai&limit=999`).then((response) => response.json()),
        fetch(`${base}/messages?sessionId=codex%3Asession-http&limit=1`).then((response) => response.json()),
        fetch(`${base}/tool-calls?toolName=shell_command&limit=200`).then((response) => response.json()),
        fetch(`${base}/tool-call?id=tool-http`).then((response) => response.json()),
        fetch(`${base}/search/lexical?q=http&limit=20`).then((response) => response.json()),
        fetch(`${base}/search/semantic?q=http`).then((response) => ({ status: response.status, body: response.json() })),
        fetch(`${base}/search/fusion?q=http`).then((response) => ({ status: response.status, body: response.json() })),
        fetch(`${base}/tool-call?id=missing`), fetch(`${base}/query`, { method: "POST" }),
      ]);
      expect(sessions.data.page).toEqual({ limit: 200, offset: 0, nextOffset: null });
      expect(sessions.data.rows[0]).toMatchObject({ sessionId: "codex:session-http", sourcePath: "/history/codex-session-http.jsonl", host: "host-http", identitySchemeVersion: 1, normalizationVersion: 4 });
      expect(sessions.data.rows[0].sourceFingerprint).toContain("fingerprint-http");
      expect(messages.data.page).toEqual({
        limit: 1,
        snapshot: expect.any(String),
        next: { sessionId: "codex:session-http", sequence: 0 },
      });
      expect(messages.data.rows[0].text).toBe("hello over http");
      expect(toolCalls.data.rows[0]).toMatchObject({ toolCallId: "tool-http", inputBytes: Buffer.byteLength("echo http"), outputBytes: Buffer.byteLength("http") });
      expect(toolCalls.data.rows[0].inputText).toBeUndefined();
      expect(toolCall.data.row).toMatchObject({ toolCallId: "tool-http", inputText: "echo http", outputText: "http" });
      expect(lexical.data.matches.map((match: { key: string; score: number; row: { text: string } }) => match.row.text)).toEqual(["hello over http", "assistant-only http memory"]);
      expect(lexical.data.matches.every((match: { key: string; score: number; row: { textTruncated: boolean; textBytes: number } }) => typeof match.key === "string" && typeof match.score === "number" && typeof match.row.textTruncated === "boolean" && typeof match.row.textBytes === "number")).toBe(true);
      expect(semantic.status).toBe(503);
      expect(fusion.status).toBe(503);
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
