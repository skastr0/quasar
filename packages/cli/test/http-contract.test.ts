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
import { mapSession } from "../src/map";
import type { MappedSession } from "../src/model";
import type { NormalizedSession } from "../src/core/schemas";
import { NORMALIZATION_VERSION } from "../src/normalization-version";

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

const mappedSession = (overrides: {
  readonly fingerprint?: string;
  readonly firstText?: string;
  readonly normalizationVersion?: number;
} = {}): MappedSession => ({
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
    normalizationVersion: overrides.normalizationVersion ?? NORMALIZATION_VERSION,
    model: "gpt-5.6-sol",
    modelProvider: "openai",
    assignmentRole: "builder",
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
      eventId: "contract-event-tool",
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
  events: [
    {
      id: "contract-event-user",
      sessionId: "contract-session",
      nativeEventId: "native-user",
      sequence: 10,
      timestamp: "2026-06-18T10:00:30.000Z",
      machineId: "machine-contract",
      provider: "codex",
      agentName: "codex",
      projectIdentityKey: "contract-project",
      role: "user",
      kind: "message",
      contentText: "contract handshake over http",
      contentBlocks: [],
      rawReference: { sourcePath: "/history/contract-session.jsonl", line: 1 },
    },
    {
      id: "contract-event-tool",
      sessionId: "contract-session",
      nativeEventId: "native-tool",
      sequence: 12,
      timestamp: "2026-06-18T10:00:40.000Z",
      machineId: "machine-contract",
      provider: "codex",
      agentName: "codex",
      projectIdentityKey: "contract-project",
      role: "tool",
      kind: "tool_call",
      contentText: "shell_command",
      contentBlocks: [],
      toolCallId: "contract-tool",
      rawReference: { sourcePath: "/history/contract-session.jsonl", line: 2 },
    },
  ],
  usageRecords: [
    {
      id: "contract-usage-1",
      sessionId: "contract-session",
      eventId: "contract-event-user",
      machineId: "machine-contract",
      provider: "codex",
      agentName: "codex",
      projectIdentityKey: "contract-project",
      timestamp: "2026-06-18T10:00:31.000Z",
      model: "gpt-5.6-sol",
      modelProvider: "openai",
      inputTokens: 20,
      outputTokens: 5,
      totalTokens: 25,
    },
    {
      id: "contract-usage-2",
      sessionId: "contract-session",
      eventId: "contract-event-tool",
      machineId: "machine-contract",
      provider: "codex",
      agentName: "codex",
      projectIdentityKey: "contract-project",
      timestamp: "2026-06-18T10:00:41.000Z",
      model: "gpt-5.6-sol",
      modelProvider: "openai",
      inputTokens: 30,
      outputTokens: 10,
      totalTokens: 40,
    },
  ],
  sessionEdges: [
    {
      id: "contract-edge-1",
      sessionId: "contract-session",
      machineId: "machine-contract",
      provider: "codex",
      agentName: "codex",
      projectIdentityKey: "contract-project",
      kind: "next",
      fromEventId: "contract-event-user",
      toEventId: "contract-event-tool",
    },
    {
      id: "contract-edge-2",
      sessionId: "contract-session",
      machineId: "machine-contract",
      provider: "codex",
      agentName: "codex",
      projectIdentityKey: "contract-project",
      kind: "artifact_of",
      fromEventId: "contract-event-tool",
      toId: "contract-artifact-1",
    },
  ],
  artifacts: [
    {
      id: "contract-artifact-1",
      sessionId: "contract-session",
      eventId: "contract-event-tool",
      machineId: "machine-contract",
      provider: "codex",
      agentName: "codex",
      projectIdentityKey: "contract-project",
      kind: "file",
      path: "/tmp/output-one.txt",
      contentHash: "artifact-hash-1",
    },
    {
      id: "contract-artifact-2",
      sessionId: "contract-session",
      eventId: "contract-event-tool",
      machineId: "machine-contract",
      provider: "codex",
      agentName: "codex",
      projectIdentityKey: "contract-project",
      kind: "file",
      path: "/tmp/output-two.txt",
      contentHash: "artifact-hash-2",
    },
  ],
  executionContexts: [
    {
      id: "contract-context-1",
      sessionId: "contract-session",
      sequence: 0,
      scope: "session",
      timestamp: "2026-06-18T10:00:00.000Z",
      machineId: "machine-contract",
      provider: "codex",
      agentName: "codex",
      projectIdentityKey: "contract-project",
      model: "gpt-5.6-sol",
      modelProvider: "openai",
      reasoningEffort: "high",
    },
    {
      id: "contract-context-2",
      sessionId: "contract-session",
      sequence: 1,
      scope: "turn",
      timestamp: "2026-06-18T10:00:30.000Z",
      turnId: "turn-1",
      machineId: "machine-contract",
      provider: "codex",
      agentName: "codex",
      projectIdentityKey: "contract-project",
      model: "gpt-5.6-sol",
      modelProvider: "openai",
      reasoningEffort: "high",
      approvalPolicy: "never",
    },
  ],
  assignment: {
    nickname: "Laplace",
    role: "builder",
    path: "/root/rich-store-roundtrip",
    depth: 1,
  },
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
  test("mapSession keeps only conversation messages in search while preserving redacted source facts and tool linkage", () => {
    const normalized: NormalizedSession = {
      id: "codex:mapped-contract",
      nativeSessionId: "mapped-contract",
      provider: "codex",
      agentName: "codex",
      assignment: { nickname: "Laplace", role: "builder", path: "/root/mapped", depth: 1 },
      machineId: "machine-contract",
      host: "contract-host",
      identitySchemeVersion: 1,
      projectIdentity: {
        projectIdentityKey: "contract-project",
        displayName: "Contract Project",
        confidence: "explicit",
        signals: [],
      },
      startedAt: "2026-06-18T10:00:00.000Z",
      updatedAt: "2026-06-18T10:01:00.000Z",
      sourceRoot: "/history",
      sourcePath: "/history/mapped-contract.jsonl",
      events: [
        {
          id: "event-user",
          sessionId: "codex:mapped-contract",
          sequence: 2,
          machineId: "machine-contract",
          provider: "codex",
          agentName: "codex",
          projectIdentityKey: "contract-project",
          role: "user",
          kind: "message",
          contentText: "searchable user message",
          contentBlocks: [],
          rawReference: { sourcePath: "/history/mapped-contract.jsonl", line: 1 },
        },
        {
          id: "event-preamble",
          sessionId: "codex:mapped-contract",
          sequence: 3,
          machineId: "machine-contract",
          provider: "codex",
          agentName: "codex",
          projectIdentityKey: "contract-project",
          role: "assistant",
          kind: "preamble",
          contentText: "Bearer sk-abcdefghijklmnopqrstuvwxyz123456",
          contentBlocks: [],
          rawReference: { sourcePath: "/history/mapped-contract.jsonl", line: 2 },
        },
        {
          id: "event-reasoning",
          sessionId: "codex:mapped-contract",
          sequence: 4,
          machineId: "machine-contract",
          provider: "codex",
          agentName: "codex",
          projectIdentityKey: "contract-project",
          role: "thinking",
          kind: "reasoning",
          contentText: "searchable reasoning",
          contentBlocks: [],
          rawReference: { sourcePath: "/history/mapped-contract.jsonl", line: 3 },
        },
        {
          id: "event-tool",
          sessionId: "codex:mapped-contract",
          sequence: 9,
          machineId: "machine-contract",
          provider: "codex",
          agentName: "codex",
          projectIdentityKey: "contract-project",
          role: "tool",
          kind: "tool_call",
          contentBlocks: [],
          toolCallId: "tool-linked",
          rawReference: { sourcePath: "/history/mapped-contract.jsonl", line: 4 },
        },
      ],
      toolCalls: [{
        id: "tool-linked",
        sessionId: "codex:mapped-contract",
        eventId: "event-tool",
        machineId: "machine-contract",
        provider: "codex",
        agentName: "codex",
        projectIdentityKey: "contract-project",
        toolName: "shell_command",
        input: { authorization: "Bearer sk-abcdefghijklmnopqrstuvwxyz123456" },
        output: "ok",
      }],
      sessionEdges: [],
      executionContexts: [{
        id: "context-new",
        sessionId: "codex:mapped-contract",
        sequence: 20,
        scope: "session",
        machineId: "machine-contract",
        provider: "codex",
        agentName: "codex",
        projectIdentityKey: "contract-project",
        model: "gpt-5.6-terra",
        modelProvider: "openai",
      }, {
        id: "context-old",
        sessionId: "codex:mapped-contract",
        sequence: 1,
        scope: "session",
        machineId: "machine-contract",
        provider: "codex",
        agentName: "codex",
        projectIdentityKey: "contract-project",
        model: "gpt-5.6-sol",
        modelProvider: "openai",
      }],
      usageRecords: [],
      artifacts: [{
        id: "artifact-1",
        sessionId: "codex:mapped-contract",
        machineId: "machine-contract",
        provider: "codex",
        agentName: "codex",
        projectIdentityKey: "contract-project",
        kind: "trace",
        metadata: { apiKey: "sk-abcdefghijklmnopqrstuvwxyz123456" },
      }],
    };

    const mapped = mapSession(normalized, "mapped-fingerprint");
    expect(mapped.messages.map((row) => ({ role: row.role, text: row.text }))).toEqual([
      { role: "user", text: "searchable user message" },
      { role: "reasoning", text: "searchable reasoning" },
    ]);
    expect(mapped.toolCalls[0]).toMatchObject({ eventId: "event-tool", seq: 9 });
    expect(mapped.toolCalls[0]?.inputText).toContain("[redacted]");
    expect(mapped.events.find((event) => event.id === "event-preamble")?.contentText).toBe("Bearer [redacted]");
    expect(mapped.artifacts[0]?.metadata).toEqual({ apiKey: "[redacted]" });
    expect(mapped.session).toMatchObject({
      model: "gpt-5.6-terra",
      modelProvider: "openai",
      assignmentRole: "builder",
    });
    const usageFallback = mapSession({
      ...normalized,
      executionContexts: [],
      usageRecords: [{
        id: "usage-old",
        sessionId: "codex:mapped-contract",
        machineId: "machine-contract",
        provider: "codex",
        agentName: "codex",
        projectIdentityKey: "contract-project",
        model: "gpt-5.4-mini",
        modelProvider: "openai",
      }, {
        id: "usage-new",
        sessionId: "codex:mapped-contract",
        machineId: "machine-contract",
        provider: "codex",
        agentName: "codex",
        projectIdentityKey: "contract-project",
        model: "gpt-5.6-luna",
        modelProvider: "openai",
      }],
    }, "usage-fallback-fingerprint");
    expect(usageFallback.session.model).toBe("gpt-5.6-luna");
  });

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
      const [sessions, messages, toolCalls, detail, status] = await Promise.all([
        fetch(`${base}/sessions`).then((r) => r.json()),
        fetch(`${base}/messages?sessionId=contract-session`).then((r) => r.json()),
        fetch(`${base}/tool-calls?provider=codex&toolName=shell_command`).then((r) => r.json()),
        fetch(`${base}/session-detail?sessionId=contract-session&messageLimit=1&eventLimit=1&usageLimit=1&edgeLimit=1&artifactLimit=1&contextLimit=1`).then((r) => r.json()),
        fetch(`${base}/status`).then((r) => r.json()),
      ]);

      expect(sessions.data.rows.map((row: { sessionId: string }) => row.sessionId)).toEqual(["contract-session"]);
      expect(sessions.data.rows[0].messageCount).toBe(2);
      expect(sessions.data.rows[0].toolCallCount).toBe(1);
      expect(sessions.data.rows[0]).toMatchObject({
        model: "gpt-5.6-sol",
        modelProvider: "openai",
        assignmentRole: "builder",
      });
      expect(messages.data.rows.map((row: { text: string }) => row.text)).toEqual([
        "contract handshake over http",
        "assistant contract reply",
      ]);
      expect(toolCalls.data.rows.map((row: { id: string }) => row.id)).toEqual(["contract-tool"]);
      expect(toolCalls.data.rows[0].eventId).toBe("contract-event-tool");
      expect(detail).toMatchObject({
        ok: true,
        command: "session-detail",
        data: {
          session: {
            sessionId: "contract-session",
            model: "gpt-5.6-sol",
            modelProvider: "openai",
            assignmentRole: "builder",
          },
          assignment: { nickname: "Laplace", role: "builder", depth: 1 },
          messages: { limit: 1, offset: 0, total: 2, hasMore: true },
          events: { limit: 1, offset: 0, total: 2, hasMore: true },
          usageRecords: { limit: 1, offset: 0, total: 2, hasMore: true },
          sessionEdges: { limit: 1, offset: 0, total: 2, hasMore: true },
          artifacts: { limit: 1, offset: 0, total: 2, hasMore: true },
          executionContexts: { limit: 1, offset: 0, total: 2, hasMore: true },
        },
      });
      expect(detail.data.events.rows[0].id).toBe("contract-event-user");
      expect(detail.data.usageRecords.rows[0].id).toBe("contract-usage-1");
      expect(detail.data.sessionEdges.rows[0].id).toBe("contract-edge-1");
      expect(detail.data.artifacts.rows[0].id).toBe("contract-artifact-1");
      expect(detail.data.executionContexts.rows[0].id).toBe("contract-context-1");

      const detailPageTwo = await fetch(
        `${base}/session-detail?sessionId=contract-session&messageLimit=1&messageOffset=1&eventLimit=1&eventOffset=1&usageLimit=1&usageOffset=1&edgeLimit=1&edgeOffset=1&artifactLimit=1&artifactOffset=1&contextLimit=1&contextOffset=1`,
      ).then((response) => response.json());
      expect(detailPageTwo.data.messages.rows[0].seq).toBe(2);
      expect(detailPageTwo.data.events.rows[0].id).toBe("contract-event-tool");
      expect(detailPageTwo.data.usageRecords.rows[0].id).toBe("contract-usage-2");
      expect(detailPageTwo.data.sessionEdges.rows[0].id).toBe("contract-edge-2");
      expect(detailPageTwo.data.artifacts.rows[0].id).toBe("contract-artifact-2");
      expect(detailPageTwo.data.executionContexts.rows[0].id).toBe("contract-context-2");
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

  test("unchanged repeats are no-ops and a normalization replay replaces typed source facts without duplicates", async () => {
    const dir = tempDir();
    const sqlite = join(dir, "quasar.sqlite");
    const port = randomPort();
    const token = "contract-ingest-token";
    const base = `http://127.0.0.1:${port}`;
    const proc = spawnServer(sqlite, port, token);

    try {
      await waitFor(`${base}/health`);
      const original = mappedSession({ normalizationVersion: NORMALIZATION_VERSION - 1 });
      const first = await postMappedSession(base, original, { ingestToken: token });
      const repeated = await postMappedSession(base, original, { ingestToken: token });
      expect(first.status).toBe("ok");
      expect(repeated).toMatchObject({
        status: "skipped",
        diagnostic: "unchanged_source_fingerprint",
        messagesWritten: 0,
        toolCallsWritten: 0,
        jobsEnqueued: 0,
      });

      const upgraded: MappedSession = {
        ...original,
        session: {
          ...original.session,
          normalizationVersion: NORMALIZATION_VERSION,
          model: "gpt-5.6-terra",
          assignmentRole: "reviewer",
        },
        events: [original.events[1]!],
        usageRecords: [{ ...original.usageRecords[1]!, model: "gpt-5.6-terra" }],
        sessionEdges: [],
        artifacts: [original.artifacts[1]!],
        executionContexts: [{
          ...original.executionContexts[1]!,
          model: "gpt-5.6-terra",
          reasoningEffort: "xhigh",
        }],
        assignment: { ...original.assignment, role: "reviewer" },
      };
      const replay = await postMappedSession(base, upgraded, { ingestToken: token });
      expect(replay.status).toBe("ok");
      expect(replay.messagesWritten).toBe(0);
      expect(replay.toolCallsWritten).toBe(0);

      const detail = await fetch(`${base}/session-detail?sessionId=contract-session`).then((response) => response.json());
      expect(detail.data.session).toMatchObject({
        normalizationVersion: NORMALIZATION_VERSION,
        model: "gpt-5.6-terra",
        assignmentRole: "reviewer",
      });
      expect(detail.data.assignment).toMatchObject({ role: "reviewer" });
      expect(detail.data.events.rows.map((row: { id: string }) => row.id)).toEqual(["contract-event-tool"]);
      expect(detail.data.usageRecords.rows.map((row: { id: string }) => row.id)).toEqual(["contract-usage-2"]);
      expect(detail.data.sessionEdges.rows).toEqual([]);
      expect(detail.data.artifacts.rows.map((row: { id: string }) => row.id)).toEqual(["contract-artifact-2"]);
      expect(detail.data.executionContexts.rows.map((row: { id: string }) => row.id)).toEqual(["contract-context-2"]);
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

      const invalidEvent = {
        ...broken,
        events: [{ ...broken.events[0]!, kind: "provider_private" }],
      } as unknown as MappedSession;
      await expect(postMappedSession(base, invalidEvent, { ingestToken: token })).rejects.toMatchObject({
        name: "RemoteIngestError",
      });

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
      // Hermetic: never eager-load the local fp32 query pipeline in tests.
      QUASAR_QUERY_EMBEDDING_PROVIDER: "synthetic",
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

      // Embedder loss for an uncached query (SYNTHETIC_API_KEY is "" in this
      // test's env, so any cache-miss embed call fails immediately):
      // /search/semantic keeps its own 503 contract, but /search/fusion never
      // 503s for this — it degrades to the lexical leg alone.
      const uncachedQuery = "uncached embedder degrade probe";
      const semanticDegraded = await fetchJson(
        `${rebootBase}/search/semantic?q=${encodeURIComponent(uncachedQuery)}&limit=5`,
      );
      expect(semanticDegraded.status).toBe(503);
      expect(semanticDegraded.body.error.type).toBe("EmbeddingUnavailable");

      const fusionDegraded = await fetchJson(
        `${rebootBase}/search/fusion?q=${encodeURIComponent(uncachedQuery)}&limit=5`,
      );
      expect(fusionDegraded.status).toBe(200);
      expect(fusionDegraded.body.ok).toBe(true);
      expect(fusionDegraded.body.data.degraded).toBe(true);
      expect(fusionDegraded.body.data.matches).toEqual([]);
    } finally {
      proc.kill();
      await proc.exited;
    }
  }, 40_000);
});
