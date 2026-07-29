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

import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";

import { postFingerprintProbe, postMappedSession } from "../src/ingest";
import { opencodeAdapter } from "../src/adapters/opencode";
import { mapSession } from "../src/map";
import type { MappedSession } from "../src/model";
import type { NormalizedSession } from "../src/core/schemas";
import { NORMALIZATION_VERSION } from "../src/normalization-version";
import {
  messageContentHash,
  NORMALIZED_SESSION_PROTOCOL_VERSION,
} from "@skastr0/quasar-protocol";
import {
  EMBEDDING_CACHE_VECTOR_ENCODING,
  encodeFloat32Vector,
} from "../../server/src/vectorBlob";

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

const exactToolInputText = JSON.stringify({
  patch: "@@ -1 +1 @@\n-old\n+new",
  state: { empty: "", nested: {} },
});
const exactToolOutputText = "line one\n  line two\n";
const exactEventText = "contract handshake\n\n```ts\nconst value = 1;\n```\n";

const mappedSession = (overrides: {
  readonly fingerprint?: string;
  readonly firstText?: string;
  readonly normalizationVersion?: number;
} = {}): MappedSession => {
  const firstText = overrides.firstText ?? "contract handshake over http";
  const assistantText = "assistant contract reply";
  return {
  protocolVersion: NORMALIZED_SESSION_PROTOCOL_VERSION,
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
    model: "gpt-5.6-terra",
    modelProvider: "openai",
    assignmentRole: "builder",
    messageCount: 2,
    toolCallCount: 1,
  },
  messages: [
    {
      sessionId: "contract-session",
      eventId: "contract-event-user",
      seq: 0,
      role: "user",
      text: firstText,
      ts: "2026-06-18T10:00:30.000Z",
      projectKey: "contract-project",
      contentHash: messageContentHash({
        sessionId: "contract-session",
        eventId: "contract-event-user",
        seq: 0,
        role: "user",
        text: firstText,
      }),
      executionContextId: "contract-context-1",
      model: "gpt-5.6-sol",
      modelProvider: "openai",
      reasoningEffort: "high",
    },
    {
      sessionId: "contract-session",
      eventId: "contract-event-assistant",
      seq: 1,
      role: "assistant",
      text: assistantText,
      ts: "2026-06-18T10:00:35.000Z",
      projectKey: "contract-project",
      contentHash: messageContentHash({
        sessionId: "contract-session",
        eventId: "contract-event-assistant",
        seq: 1,
        role: "assistant",
        text: assistantText,
      }),
      executionContextId: "contract-context-2",
      model: "gpt-5.6-terra",
      modelProvider: "openai",
      reasoningEffort: "high",
    },
  ],
  toolCalls: [
    {
      id: "contract-tool",
      sessionId: "contract-session",
      eventId: "contract-event-tool",
      seq: 2,
      toolName: "shell_command",
      status: "ok",
      inputText: exactToolInputText,
      outputText: exactToolOutputText,
      startedAt: "2026-06-18T10:00:40.000Z",
      completedAt: "2026-06-18T10:00:41.000Z",
      projectKey: "contract-project",
      provider: "codex",
      executionContextId: "contract-context-2",
      model: "gpt-5.6-terra",
      modelProvider: "openai",
      reasoningEffort: "high",
    },
  ],
  events: [
    {
      id: "contract-event-user",
      sessionId: "contract-session",
      nativeEventId: "native-user",
      sequence: 0,
      timestamp: "2026-06-18T10:00:30.000Z",
      machineId: "machine-contract",
      provider: "codex",
      agentName: "codex",
      projectIdentityKey: "contract-project",
      role: "user",
      kind: "message",
      contentText: firstText,
      contentBlocks: firstText === "contract handshake over http"
        ? [{
          id: "contract-content-user",
          sequence: 0,
          kind: "text" as const,
          text: exactEventText,
        }]
        : [],
      rawReference: { sourcePath: "/history/contract-session.jsonl", line: 1 },
    },
    {
      id: "contract-event-assistant",
      sessionId: "contract-session",
      nativeEventId: "native-assistant",
      sequence: 1,
      timestamp: "2026-06-18T10:00:35.000Z",
      machineId: "machine-contract",
      provider: "codex",
      agentName: "codex",
      projectIdentityKey: "contract-project",
      role: "assistant",
      kind: "message",
      contentText: assistantText,
      contentBlocks: [],
      rawReference: { sourcePath: "/history/contract-session.jsonl", line: 2 },
    },
    {
      id: "contract-event-tool",
      sessionId: "contract-session",
      nativeEventId: "native-tool",
      sequence: 2,
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
      rawReference: { sourcePath: "/history/contract-session.jsonl", line: 3 },
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
      model: "gpt-5.6-terra",
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
      toEventId: "contract-event-assistant",
    },
    {
      id: "contract-edge-2",
      sessionId: "contract-session",
      machineId: "machine-contract",
      provider: "codex",
      agentName: "codex",
      projectIdentityKey: "contract-project",
      kind: "artifact_of",
      fromEventId: "contract-event-assistant",
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
      model: "gpt-5.6-terra",
      modelProvider: "openai",
      reasoningEffort: "high",
    },
    {
      id: "contract-context-2",
      sessionId: "contract-session",
      sequence: 1,
      scope: "turn",
      timestamp: "2026-06-18T10:00:30.000Z",
      turnId: "contract-event-assistant",
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
};
};

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

const resourceJson = async (
  base: string,
  path: string,
  params: Record<string, string | number | readonly string[] | undefined> = {},
): Promise<{ readonly status: number; readonly body: any }> => {
  const url = new URL(path, `${base}/`);
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined) continue;
    url.searchParams.set(key, Array.isArray(value) ? value.join(",") : String(value));
  }
  const response = await fetch(url);
  return { status: response.status, body: await response.json() };
};

const searchQueryJson = (
  base: string,
  text: string,
  mode: "lexical" | "semantic" | "fusion",
  options: {
    readonly filters?: Record<string, unknown>;
    readonly limit?: number;
  } = {},
) => resourceJson(base, `search/${mode}`, {
  q: text,
  limit: options.limit ?? 5,
  offset: 0,
  projectKey: typeof options.filters?.projectKey === "string" ? options.filters.projectKey : undefined,
  provider: Array.isArray(options.filters?.providers)
    ? options.filters.providers as readonly string[]
    : undefined,
  sessionId: typeof options.filters?.sessionId === "string" ? options.filters.sessionId : undefined,
  role: typeof options.filters?.role === "string" ? options.filters.role : undefined,
  agentName: typeof options.filters?.agentName === "string" ? options.filters.agentName : undefined,
  agentRole: typeof options.filters?.agentRole === "string" ? options.filters.agentRole : undefined,
  model: typeof options.filters?.model === "string" ? options.filters.model : undefined,
  modelProvider: typeof options.filters?.modelProvider === "string" ? options.filters.modelProvider : undefined,
});

describe("CLI HTTP client <-> server contract", () => {
  test("mapSession projects visible conversational roles independent of event kind while preserving source identity, context, and tool linkage", () => {
    const normalized: NormalizedSession = {
      id: "codex:mapped-contract",
      nativeSessionId: "mapped-contract",
      provider: "codex",
      agentName: "codex",
      title: "Bearer sk-abcdefghijklmnopqrstuvwxyz123456",
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
          sequence: 0,
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
          sequence: 1,
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
          sequence: 2,
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
          id: "event-summary",
          sessionId: "codex:mapped-contract",
          sequence: 3,
          machineId: "machine-contract",
          provider: "codex",
          agentName: "codex",
          projectIdentityKey: "contract-project",
          role: "assistant",
          kind: "summary",
          contentText: "searchable compacted summary",
          contentBlocks: [],
          rawReference: { sourcePath: "/history/mapped-contract.jsonl", line: 4 },
        },
        {
          id: "event-tool",
          sessionId: "codex:mapped-contract",
          sequence: 4,
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
        input: {
          patch: "@@ -1 +1 @@\n-old\n+new",
          state: { empty: "", nested: {} },
          authorization: "Bearer sk-abcdefghijklmnopqrstuvwxyz123456",
        },
        output: {
          status: "completed",
          result: { output: "line one\n  line two\n" },
        },
      }],
      sessionEdges: [],
      executionContexts: [{
        id: "context-new",
        sessionId: "codex:mapped-contract",
        sequence: 3,
        scope: "turn",
        turnId: "event-summary",
        machineId: "machine-contract",
        provider: "codex",
        agentName: "codex",
        projectIdentityKey: "contract-project",
        model: "gpt-5.6-terra",
        modelProvider: "openai",
      }, {
        id: "context-old",
        sessionId: "codex:mapped-contract",
        sequence: 0,
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
      normalizationVersion: NORMALIZATION_VERSION,
      eventCount: 5,
      toolCallCount: 1,
      contentBlockCount: 0,
      sessionEdgeCount: 0,
      usageRecordCount: 0,
      artifactCount: 1,
    };

    const mapped = mapSession(normalized, "mapped-fingerprint");
    expect(mapped.messages.map((row) => ({ role: row.role, text: row.text }))).toEqual([
      { role: "user", text: "searchable user message" },
      { role: "assistant", text: "Bearer [redacted]" },
      { role: "reasoning", text: "searchable reasoning" },
      { role: "assistant", text: "searchable compacted summary" },
    ]);
    expect(mapped.messages.map((row) => ({
      eventId: row.eventId,
      seq: row.seq,
      executionContextId: row.executionContextId,
      model: row.model,
    }))).toEqual([
      { eventId: "event-user", seq: 0, executionContextId: "context-old", model: "gpt-5.6-sol" },
      { eventId: "event-preamble", seq: 1, executionContextId: "context-old", model: "gpt-5.6-sol" },
      { eventId: "event-reasoning", seq: 2, executionContextId: "context-old", model: "gpt-5.6-sol" },
      { eventId: "event-summary", seq: 3, executionContextId: "context-new", model: "gpt-5.6-terra" },
    ]);
    expect(mapped.toolCalls[0]).toMatchObject({
      eventId: "event-tool",
      seq: 4,
      executionContextId: "context-new",
      model: "gpt-5.6-terra",
    });
    expect(mapped.toolCalls[0]?.inputText).toContain("[redacted]");
    expect(JSON.parse(mapped.toolCalls[0]!.inputText)).toEqual({
      patch: "@@ -1 +1 @@\n-old\n+new",
      state: { empty: "", nested: {} },
      authorization: "Bearer [redacted]",
    });
    expect(JSON.parse(mapped.toolCalls[0]!.outputText)).toEqual({
      status: "completed",
      result: { output: "line one\n  line two\n" },
    });
    expect(mapped.events.find((event) => event.id === "event-preamble")?.contentText).toBe("Bearer [redacted]");
    expect(mapped.artifacts[0]?.metadata).toEqual({ apiKey: "[redacted]" });
    expect(mapped.session.title).toBe("Bearer [redacted]");
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
      usageRecordCount: 2,
    }, "usage-fallback-fingerprint");
    expect(usageFallback.session.model).toBe("gpt-5.6-luna");
    expect(() =>
      mapSession(
        { ...normalized, eventCount: normalized.eventCount - 1 },
        "invalid-source-contract",
      )
    ).toThrow("eventCount must equal 5");
  });

  test("an OpenCode mixed turn survives adapter, mapping, HTTP ingest, reads, and lexical search", async () => {
    const dir = tempDir();
    const sourceRoot = join(dir, "opencode-source");
    mkdirSync(sourceRoot);
    const sourceDb = new Database(join(sourceRoot, "opencode.db"));
    try {
      sourceDb.exec(`
        CREATE TABLE session (
          id TEXT PRIMARY KEY,
          title TEXT,
          directory TEXT,
          time_created INTEGER,
          time_updated INTEGER
        );
        CREATE TABLE message (
          id TEXT PRIMARY KEY,
          session_id TEXT,
          time_created INTEGER,
          data TEXT
        );
        CREATE TABLE part (
          id TEXT PRIMARY KEY,
          message_id TEXT,
          session_id TEXT,
          time_created INTEGER,
          data TEXT
        );

        INSERT INTO session VALUES (
          'ses_event_faithful_fixture',
          'event faithful fixture',
          '/tmp/quasar-event-faithful-fixture',
          1000,
          4000
        );
        INSERT INTO message VALUES (
          'msg_user',
          'ses_event_faithful_fixture',
          1000,
          json_object('role', 'user', 'time', json_object('created', 1000))
        );
        INSERT INTO part VALUES (
          'part_user',
          'msg_user',
          'ses_event_faithful_fixture',
          1000,
          json_object('type', 'text', 'text', 'start event faithful fixture')
        );
        INSERT INTO message VALUES (
          'msg_mixed',
          'ses_event_faithful_fixture',
          2000,
          json_object(
            'role', 'assistant',
            'time', json_object('created', 2000),
            'modelID', 'model-alpha',
            'providerID', 'provider-alpha'
          )
        );
        INSERT INTO part VALUES (
          'part_reasoning',
          'msg_mixed',
          'ses_event_faithful_fixture',
          2001,
          json_object('type', 'reasoning', 'text', 'reasoning-marker-before-tools')
        );
        INSERT INTO part VALUES (
          'part_visible',
          'msg_mixed',
          'ses_event_faithful_fixture',
          2002,
          json_object('type', 'text', 'text', 'mixed-visible-marker')
        );
        INSERT INTO part VALUES (
          'part_tool_one',
          'msg_mixed',
          'ses_event_faithful_fixture',
          2003,
          json_object(
            'type', 'tool',
            'tool', 'bash',
            'callID', 'call-one',
            'state', json_object(
              'status', 'completed',
              'input', json_object('command', 'pwd'),
              'output', '/tmp/quasar-event-faithful-fixture'
            )
          )
        );
        INSERT INTO part VALUES (
          'part_tool_two',
          'msg_mixed',
          'ses_event_faithful_fixture',
          2004,
          json_object(
            'type', 'tool',
            'tool', 'read',
            'callID', 'call-two',
            'state', json_object(
              'status', 'completed',
              'input', json_object('path', 'fixture.txt'),
              'output', 'fixture contents'
            )
          )
        );
        INSERT INTO message VALUES (
          'msg_later',
          'ses_event_faithful_fixture',
          3000,
          json_object(
            'role', 'assistant',
            'time', json_object('created', 3000),
            'modelID', 'model-beta',
            'providerID', 'provider-beta'
          )
        );
        INSERT INTO part VALUES (
          'part_later',
          'msg_later',
          'ses_event_faithful_fixture',
          3000,
          json_object('type', 'text', 'text', 'later-visible-marker')
        );
      `);
    } finally {
      sourceDb.close();
    }

    const adapted = await opencodeAdapter.read({
      machine: {
        machineId: "machine:http-event-faithful",
        hostname: "http-event-faithful",
        platform: "darwin",
      },
      now: "2026-07-26T00:00:00.000Z",
      roots: { opencode: sourceRoot },
    });
    expect(adapted.sessions).toHaveLength(1);
    const normalized = adapted.sessions[0]!;
    const mapped = mapSession(normalized, "event-faithful-source-fingerprint");
    const mixedEvent = normalized.events.find((event) => event.nativeEventId === "msg_mixed")!;
    const reasoningEvent = normalized.events.find(
      (event) => event.nativeEventId === "msg_mixed:reasoning",
    )!;
    const laterEvent = normalized.events.find((event) => event.nativeEventId === "msg_later")!;

    expect(normalized.events.map((event) => event.sequence)).toEqual([0, 1, 2, 3]);
    expect(mapped.toolCalls).toHaveLength(2);
    expect(mapped.toolCalls.every((call) => call.eventId === mixedEvent.id)).toBe(true);

    const sqlite = join(dir, "quasar.sqlite");
    const port = randomPort();
    const token = "event-faithful-ingest-token";
    const base = `http://127.0.0.1:${port}`;
    const proc = spawnServer(sqlite, port, token);
    try {
      await waitFor(`${base}/health`);
      const outcome = await postMappedSession(base, mapped, { ingestToken: token });
      expect(outcome).toMatchObject({
        status: "ok",
        messagesWritten: 4,
        toolCallsWritten: 2,
      });

      const messages = await resourceJson(base, "messages", {
        sessionId: normalized.id,
        limit: 20,
      });
      expect(messages.body.data.rows.map((row: {
        messageId: string;
        sequence: number;
        text: string;
        model: string | null;
        modelProvider: string | null;
      }) => ({
        messageId: row.messageId,
        sequence: row.sequence,
        text: row.text,
        model: row.model,
        modelProvider: row.modelProvider,
      }))).toEqual([
        {
          messageId: normalized.events[0]!.id,
          sequence: 0,
          text: "start event faithful fixture",
          model: null,
          modelProvider: null,
        },
        {
          messageId: mixedEvent.id,
          sequence: 1,
          text: "mixed-visible-marker",
          model: "model-alpha",
          modelProvider: "provider-alpha",
        },
        {
          messageId: reasoningEvent.id,
          sequence: 2,
          text: "reasoning-marker-before-tools",
          model: "model-alpha",
          modelProvider: "provider-alpha",
        },
        {
          messageId: laterEvent.id,
          sequence: 3,
          text: "later-visible-marker",
          model: "model-beta",
          modelProvider: "provider-beta",
        },
      ]);

      const toolCalls = await resourceJson(base, "tool-calls", {
        sessionId: normalized.id,
        limit: 20,
        offset: 0,
      });
      expect(toolCalls.body.data.rows).toHaveLength(2);
      expect(toolCalls.body.data.rows.every((row: {
        eventId: string;
        sequence: number;
        model: string;
      }) => row.eventId === mixedEvent.id
        && row.sequence === mixedEvent.sequence
        && row.model === "model-alpha")).toBe(true);

      const toolPayloadBefore = await searchQueryJson(
        base,
        "fixture contents",
        "lexical",
        { filters: { sessionId: normalized.id } },
      );
      expect(toolPayloadBefore.body.data.matches).toEqual([]);

      const trajectory = await resourceJson(base, "trajectory", {
        sessionId: normalized.id,
        format: "quasar",
        includeReasoning: "true",
        includeToolResults: "true",
        toolResultMaxBytes: 8,
      });
      expect(trajectory.status).toBe(200);
      expect(trajectory.body.data).toMatchObject({
        protocolVersion: "quasar.trajectory/v1",
        sessionId: normalized.id,
        counts: {
          sourceEvents: 4,
          sourceToolCalls: 2,
        },
      });
      expect(trajectory.body.data.records).toEqual(expect.arrayContaining([
        expect.objectContaining({
          role: "assistant",
          content: "mixed-visible-marker",
          sourceEventId: mixedEvent.id,
        }),
        expect.objectContaining({
          role: "reasoning",
          content: "reasoning-marker-before-tools",
          sourceEventId: reasoningEvent.id,
        }),
        expect.objectContaining({
          role: "tool_call",
          toolCallId: expect.any(String),
          sourceEventId: mixedEvent.id,
        }),
        expect.objectContaining({
          role: "tool_result",
          truncated: true,
          fullRead: expect.objectContaining({
            resource: "tool-call",
            sessionId: normalized.id,
            toolCallId: expect.any(String),
          }),
        }),
      ]));
      expect(trajectory.body.data.records.filter((record: {
        role: string;
      }) => record.role === "tool_call")).toHaveLength(2);
      expect(trajectory.body.data.records.filter((record: {
        role: string;
      }) => record.role === "tool_result")).toHaveLength(2);
      expect(trajectory.body.data.losses.filter((loss: {
        kind: string;
      }) => loss.kind === "truncated")).toHaveLength(2);

      const letta = await resourceJson(base, "trajectory", {
        sessionId: normalized.id,
        format: "letta",
      });
      expect(letta.status).toBe(200);
      expect(letta.body.data).toMatchObject({
        format: "letta.trajectory/v1",
        schemaId: "https://letta.ai/schemas/trajectory/v1.json",
      });
      expect(letta.body.data.trajectory).toEqual(expect.arrayContaining([
        expect.objectContaining({
          role: "assistant",
          content: "mixed-visible-marker",
        }),
        expect.objectContaining({
          role: "assistant",
          content: null,
          tool_calls: expect.arrayContaining([
            expect.objectContaining({ name: "bash" }),
            expect.objectContaining({ name: "read" }),
          ]),
        }),
      ]));
      expect(letta.body.data.compatibility.issues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ kind: "mixed_assistant_split" }),
        ]),
      );

      const atif = await resourceJson(base, "trajectory", {
        sessionId: normalized.id,
        format: "atif",
        includeReasoning: "true",
        includeToolResults: "true",
        toolResultMaxBytes: 8,
      });
      expect(atif.status).toBe(200);
      expect(atif.body.data).toMatchObject({
        format: "quasar.trajectory.atif-export/v1",
        schemaVersion: "ATIF-v1.7",
        schemaSource: {
          commit: "7db020ba5a5ceee918351dd8fc374d4d60bad442",
        },
        compatibility: {
          valid: true,
          counts: {
            sourceSessions: 1,
            sourceEvents: 4,
            sourceToolCalls: 2,
          },
        },
      });
      const atifToolStep = atif.body.data.trajectory.steps.find((step: {
        tool_calls?: readonly unknown[];
      }) => step.tool_calls?.length === 2);
      expect(atifToolStep).toMatchObject({
        source: "agent",
        message: "mixed-visible-marker",
        tool_calls: expect.arrayContaining([
          expect.objectContaining({ function_name: "bash" }),
          expect.objectContaining({ function_name: "read" }),
        ]),
        observation: {
          results: [
            expect.objectContaining({
              source_call_id: expect.any(String),
              content: expect.any(String),
            }),
            expect.objectContaining({
              source_call_id: expect.any(String),
              content: expect.any(String),
            }),
          ],
        },
      });
      expect(atif.body.data.compatibility.entries).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            status: "projection_adjustment",
            sourceKind: "tool_result",
          }),
        ]),
      );
      expect(JSON.stringify(atif.body.data.trajectory)).not.toContain(
        "fixture contents",
      );

      const toolPayloadAfter = await searchQueryJson(
        base,
        "fixture contents",
        "lexical",
        { filters: { sessionId: normalized.id } },
      );
      expect(toolPayloadAfter.body.data.matches).toEqual([]);

      for (const [text, eventId] of [
        ["mixed-visible-marker", mixedEvent.id],
        ["reasoning-marker-before-tools", reasoningEvent.id],
        ["later-visible-marker", laterEvent.id],
      ] as const) {
        const search = await searchQueryJson(base, text, "lexical", {
          filters: { sessionId: normalized.id },
        });
        expect(search.status).toBe(200);
        expect(search.body.data.matches).toEqual([
          expect.objectContaining({
            key: eventId,
            row: expect.objectContaining({ messageId: eventId, text }),
          }),
        ]);
      }
    } finally {
      proc.kill();
      await proc.exited;
    }
  }, 20_000);

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
      const [
        sessions,
        messages,
        solMessages,
        terraMessages,
        toolCalls,
        toolCallDetail,
        detail,
        status,
      ] = await Promise.all([
        resourceJson(base, "sessions", { limit: 20, offset: 0 }).then(({ body }) => body),
        resourceJson(base, "messages", {
          sessionId: "contract-session", limit: 20,
        }).then(({ body }) => body),
        resourceJson(base, "messages", {
          sessionId: "contract-session", model: "gpt-5.6-sol", limit: 20,
        }).then(({ body }) => body),
        resourceJson(base, "messages", {
          sessionId: "contract-session", model: "gpt-5.6-terra", limit: 20,
        }).then(({ body }) => body),
        resourceJson(base, "tool-calls", {
          provider: "codex", toolName: "shell_command", limit: 20, offset: 0,
        }).then(({ body }) => body),
        fetch(`${base}/tool-call?id=contract-tool`).then((r) => r.json()),
        fetch(`${base}/session-detail?sessionId=contract-session&messageLimit=1&eventLimit=1&usageLimit=1&edgeLimit=1&artifactLimit=1&contextLimit=1`).then((r) => r.json()),
        fetch(`${base}/status`).then((r) => r.json()),
      ]);

      expect(sessions.data.rows.map((row: { sessionId: string }) => row.sessionId)).toEqual(["contract-session"]);
      expect(sessions.data.rows[0].messageCount).toBe(2);
      expect(sessions.data.rows[0].toolCallCount).toBe(1);
      expect(sessions.data.rows[0]).toMatchObject({
        model: "gpt-5.6-terra",
        modelProvider: "openai",
        agentRole: "builder",
      });
      expect(messages.data.rows.map((row: {
        messageId: string;
        sequence: number;
        text: string;
        model: string;
        executionContextId: string;
      }) => ({
        messageId: row.messageId,
        sequence: row.sequence,
        text: row.text,
        model: row.model,
        executionContextId: row.executionContextId,
      }))).toEqual([
        {
          messageId: "contract-event-user",
          sequence: 0,
          text: "contract handshake over http",
          model: "gpt-5.6-sol",
          executionContextId: "contract-context-1",
        },
        {
          messageId: "contract-event-assistant",
          sequence: 1,
          text: "assistant contract reply",
          model: "gpt-5.6-terra",
          executionContextId: "contract-context-2",
        },
      ]);
      expect(solMessages.data.rows.map((row: { messageId: string }) => row.messageId)).toEqual([
        "contract-event-user",
      ]);
      expect(terraMessages.data.rows.map((row: { messageId: string }) => row.messageId)).toEqual([
        "contract-event-assistant",
      ]);
      expect(toolCalls.data.rows.map((row: { toolCallId: string }) => row.toolCallId)).toEqual(["contract-tool"]);
      expect(toolCallDetail.data.row).toMatchObject({
        inputText: exactToolInputText,
        outputText: exactToolOutputText,
      });
      expect(detail).toMatchObject({
        ok: true,
        command: "session-detail",
        data: {
          session: {
            sessionId: "contract-session",
            model: "gpt-5.6-terra",
            modelProvider: "openai",
            assignmentRole: "builder",
          },
          assignment: { nickname: "Laplace", role: "builder", depth: 1 },
          messages: { limit: 1, offset: 0, total: 2, hasMore: true },
          events: { limit: 1, offset: 0, total: 3, hasMore: true },
          usageRecords: { limit: 1, offset: 0, total: 2, hasMore: true },
          sessionEdges: { limit: 1, offset: 0, total: 2, hasMore: true },
          artifacts: { limit: 1, offset: 0, total: 2, hasMore: true },
          executionContexts: { limit: 1, offset: 0, total: 2, hasMore: true },
        },
      });
      expect(detail.data.events.rows[0].id).toBe("contract-event-user");
      expect(detail.data.events.rows[0].contentBlocks).toEqual([{
        id: "contract-content-user",
        sequence: 0,
        kind: "text",
        text: exactEventText,
      }]);
      expect(detail.data.usageRecords.rows[0].id).toBe("contract-usage-1");
      expect(detail.data.sessionEdges.rows[0].id).toBe("contract-edge-1");
      expect(detail.data.artifacts.rows[0].id).toBe("contract-artifact-1");
      expect(detail.data.executionContexts.rows[0].id).toBe("contract-context-1");

      const detailPageTwo = await fetch(
        `${base}/session-detail?sessionId=contract-session&messageLimit=1&messageOffset=1&eventLimit=1&eventOffset=1&usageLimit=1&usageOffset=1&edgeLimit=1&edgeOffset=1&artifactLimit=1&artifactOffset=1&contextLimit=1&contextOffset=1`,
      ).then((response) => response.json());
      expect(detailPageTwo.data.messages.rows[0].seq).toBe(1);
      expect(detailPageTwo.data.events.rows[0].id).toBe("contract-event-assistant");
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
        events: original.events,
        usageRecords: [{ ...original.usageRecords[1]!, model: "gpt-5.6-terra" }],
        sessionEdges: [],
        artifacts: [original.artifacts[1]!],
        executionContexts: [
          original.executionContexts[0]!,
          {
            ...original.executionContexts[1]!,
            model: "gpt-5.6-terra",
            reasoningEffort: "xhigh",
          },
        ],
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
      expect(detail.data.events.rows.map((row: { id: string }) => row.id)).toEqual([
        "contract-event-user",
        "contract-event-assistant",
        "contract-event-tool",
      ]);
      expect(detail.data.usageRecords.rows.map((row: { id: string }) => row.id)).toEqual(["contract-usage-2"]);
      expect(detail.data.sessionEdges.rows).toEqual([]);
      expect(detail.data.artifacts.rows.map((row: { id: string }) => row.id)).toEqual(["contract-artifact-2"]);
      expect(detail.data.executionContexts.rows.map((row: { id: string }) => row.id)).toEqual([
        "contract-context-1",
        "contract-context-2",
      ]);
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
      const sessions = await resourceJson(base, "sessions", { limit: 20, offset: 0 });
      expect(sessions.body.data.rows).toEqual([]);
      const messages = await resourceJson(base, "messages", {
        sessionId: "contract-session", limit: 20,
      });
      expect(messages.body.data.rows).toEqual([]);
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

      const emptyLexical = await searchQueryJson(base, "handshake", "lexical");
      expect(emptyLexical.status).toBe(200);
      expect(emptyLexical.body).toMatchObject({
        ok: true,
        command: "search/lexical",
      });
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
          `INSERT INTO embedding_cache(model, content_hash, dimensions, text_bytes, encoding, vector_blob, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          cacheNamespace,
          sha256(documentText),
          768,
          new TextEncoder().encode(documentText).byteLength,
          EMBEDDING_CACHE_VECTOR_ENCODING,
          encodeFloat32Vector(Array.from({ length: 768 }, (_, index) => index === 0 ? 1 : 0)),
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
          `INSERT INTO embedding_cache(model, content_hash, dimensions, text_bytes, encoding, vector_blob, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          cacheNamespace,
          sha256(secondDocumentText),
          768,
          new TextEncoder().encode(secondDocumentText).byteLength,
          EMBEDDING_CACHE_VECTOR_ENCODING,
          encodeFloat32Vector(Array.from({ length: 768 }, (_, index) => index === 1 ? 1 : 0)),
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

      const lexical = await searchQueryJson(base, "handshake", "lexical", {
        filters: { projectKey: "contract-project" },
      });
      expect(lexical.status).toBe(200);
      expect(lexical.body.data.matches).toEqual([
        expect.objectContaining({
          key: "contract-event-user",
          row: expect.objectContaining({
            messageId: "contract-event-user",
            text: "contract handshake over http",
            model: "gpt-5.6-sol",
            executionContextId: "contract-context-1",
          }),
        }),
      ]);

      const roleSearch = await searchQueryJson(base, "assistant", "lexical", {
        filters: { role: "assistant", model: "gpt-5.6-terra" },
      });
      expect(roleSearch.status).toBe(200);
      expect(roleSearch.body.data.matches).toEqual([
        expect.objectContaining({
          key: "contract-event-assistant",
          row: expect.objectContaining({
            messageId: "contract-event-assistant",
            role: "assistant",
            text: "assistant contract reply",
            model: "gpt-5.6-terra",
            executionContextId: "contract-context-2",
          }),
        }),
      ]);

      const hostileInput = "\" OR foo:bar - ()";
      const hostileQuery = await searchQueryJson(base, hostileInput, "lexical");
      expect(hostileQuery.status).toBe(200);
      expect(Array.isArray(hostileQuery.body.data.matches)).toBe(true);

      const missingQuery = await resourceJson(base, "search/lexical", { limit: 5, offset: 0 });
      expect(missingQuery.status).toBe(400);
      expect(missingQuery.body).toMatchObject({
        ok: false,
        route: "search/lexical",
        error: { type: "BadRequest" },
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

      const semantic = await searchQueryJson(base, "handshake", "semantic");
      expect(semantic.status).toBe(503);
      expect(semantic.body).toMatchObject({
        ok: false,
        route: "search/semantic",
        error: {
          type: "SemanticDisabled",
        },
      });
      const fusion = await searchQueryJson(base, "handshake", "fusion");
      expect(fusion.status).toBe(503);
      expect(fusion.body).toMatchObject({
        ok: false,
        route: "search/fusion",
        error: {
          type: "SemanticDisabled",
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
          `INSERT INTO embedding_cache(model, content_hash, dimensions, text_bytes, encoding, vector_blob, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          cacheNamespace,
          sha256(queryDocumentText),
          768,
          new TextEncoder().encode(queryDocumentText).byteLength,
          // Same direction as the first document vector: cosine 1.0 against
          // "contract handshake over http", 0.0 against the assistant reply.
          EMBEDDING_CACHE_VECTOR_ENCODING,
          encodeFloat32Vector(Array.from({ length: 768 }, (_, index) => index === 0 ? 1 : 0)),
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

      const semanticOn = await searchQueryJson(rebootBase, "handshake", "semantic");
      expect(semanticOn.status).toBe(200);
      expect(semanticOn.body).toMatchObject({
        ok: true,
        command: "search/semantic",
      });
      expect(semanticOn.body.data.matches.map((match: { row: { text: string } }) => match.row.text)).toEqual([
        "contract handshake over http",
        "assistant contract reply",
      ]);
      expect(semanticOn.body.data.matches[0].score).toBeGreaterThan(0.99);

      // Filtered semantic: SQL candidate-id set -> mask on the exact scan.
      const semanticFiltered = await searchQueryJson(rebootBase, "handshake", "semantic", {
        filters: { projectKey: "contract-project", role: "assistant" },
      });
      expect(semanticFiltered.status).toBe(200);
      expect(semanticFiltered.body.data.matches).toEqual([
        expect.objectContaining({
          row: expect.objectContaining({ role: "assistant", text: "assistant contract reply" }),
        }),
      ]);

      // Fusion: RRF over lexical + semantic lists; both rank the handshake
      // message first here, so it must fuse to the top.
      const fusionOn = await searchQueryJson(rebootBase, "handshake", "fusion");
      expect(fusionOn.status).toBe(200);
      expect(fusionOn.body.data.matches.length).toBeGreaterThanOrEqual(2);
      expect(fusionOn.body.data.matches[0].row.text).toBe("contract handshake over http");

      // Embedder loss for an uncached query (SYNTHETIC_API_KEY is "" in this
      // test's env, so any cache-miss embed call fails immediately):
      // The semantic resource keeps its own 503 contract, while fusion mode
      // degrades to the lexical leg alone.
      const uncachedQuery = "uncached embedder degrade probe";
      const semanticDegraded = await searchQueryJson(rebootBase, uncachedQuery, "semantic");
      expect(semanticDegraded.status).toBe(503);
      expect(semanticDegraded.body.error.type).toBe("EmbeddingUnavailable");

      const fusionDegraded = await searchQueryJson(rebootBase, uncachedQuery, "fusion");
      expect(fusionDegraded.status).toBe(200);
      expect(fusionDegraded.body.data.matches).toEqual([]);
      expect(fusionDegraded.body.data.degraded).toBe(true);
    } finally {
      proc.kill();
      await proc.exited;
    }
  }, 40_000);
});
