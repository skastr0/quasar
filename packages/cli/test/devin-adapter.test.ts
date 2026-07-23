import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { Schema } from "effect";

import { sessionIdFor } from "../src/adapters/common";
import { devinAdapter } from "../src/adapters/devin";
import {
  DevinAssistantMessageSchema,
  DevinChatMessageSchema,
  DevinMessageNodeRowSchema,
  DevinSessionRowSchema,
  DevinToolMessageSchema,
  classifyDevinMessage,
  classifyDevinRole,
} from "../src/adapters/devin-schema";
import { isSignal } from "../src/adapters/harness-schema";
import type { AdapterReadResult } from "../src/adapters/types";
import { DevinSessionId } from "../src/core/identity";

const MACHINE = {
  machineId: "machine:devin-test",
  hostname: "synthetic-host",
  platform: "darwin",
};
const NOW = "2099-01-01T00:00:00.000Z";
const roots: string[] = [];

const DATABASE_SCHEMA = `
create table sessions (
  id text primary key,
  working_directory text not null,
  backend_type text not null,
  model text not null,
  agent_mode text not null,
  created_at integer not null,
  last_activity_at integer not null,
  title text,
  main_chain_id integer,
  shell_last_seen_index integer not null,
  cogs_json text,
  workspace_dirs text,
  hidden integer not null,
  metadata text
);
create table message_nodes (
  row_id integer primary key autoincrement,
  session_id text not null,
  node_id integer not null,
  parent_node_id integer,
  chat_message text not null,
  created_at integer not null,
  metadata text,
  unique(session_id, node_id)
);
create table prompt_history (
  id integer primary key,
  content text,
  timestamp integer,
  session_id text,
  is_shell integer
);
create table rendered_commits (
  id integer primary key,
  session_id text,
  sequence_number integer,
  rendered_html text,
  created_at integer
);
`;

interface Fixture {
  readonly root: string;
  readonly database: Database;
}

const createFixture = (): Fixture => {
  const root = mkdtempSync(join(tmpdir(), "quasar-devin-adapter-"));
  roots.push(root);
  const database = new Database(join(root, "sessions.db"));
  database.exec(DATABASE_SCHEMA);
  return { root, database };
};

const commonMetadata = (createdAt: string) => ({
  created_at: createdAt,
  telemetry: {},
  finish_reason: null,
  is_user_input: null,
  metrics: null,
  num_tokens: null,
  request_id: null,
});

const systemMessage = (messageId: string, content: string, createdAt: string) => ({
  message_id: messageId,
  role: "system" as const,
  content,
  metadata: commonMetadata(createdAt),
});

const userMessage = (messageId: string, content: string, createdAt: string) => ({
  message_id: messageId,
  role: "user" as const,
  content,
  metadata: commonMetadata(createdAt),
});

const assistantMessage = (
  messageId: string,
  content: string,
  createdAt: string,
  extras: Record<string, unknown> = {},
) => ({
  message_id: messageId,
  role: "assistant" as const,
  content,
  metadata: {
    ...commonMetadata(createdAt),
    generation_model: "synthetic-model",
    started_generation_at: createdAt,
  },
  tool_calls: [],
  ...extras,
});

const toolMessage = (
  messageId: string,
  callId: string,
  content: string,
  createdAt: string,
  success: boolean,
) => ({
  message_id: messageId,
  role: "tool" as const,
  content,
  tool_call_id: callId,
  metadata: {
    ...commonMetadata(createdAt),
    extensions: {
      "chisel/tool_result_meta": {
        kind: "synthetic",
        success,
        ...(success ? {} : { failure_reason: "synthetic failure" }),
      },
      "chisel/tool_call_timing": {
        started_at: createdAt,
        finished_at: new Date(Date.parse(createdAt) + 1_000).toISOString(),
        duration_ms: 1_000,
      },
      ...(success
        ? {
            "chisel/terminal_output": {
              cwd: "/synthetic/project",
              text: "synthetic terminal output",
              original_bytes: 25,
              truncated_lines: 0,
            },
          }
        : { "chisel/tool_failure": { message: "synthetic failure" } }),
    },
  },
});

const insertSession = (
  database: Database,
  id: string,
  head: number | null,
  lastActivity = 4_071_004_000,
) => {
  database
    .query(`insert into sessions (
      id, working_directory, backend_type, model, agent_mode, created_at,
      last_activity_at, title, main_chain_id, shell_last_seen_index,
      cogs_json, workspace_dirs, hidden, metadata
    ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`) 
    .run(
      id,
      "/synthetic/project",
      "Windsurf",
      "synthetic-model",
      "normal",
      4_071_000_000,
      lastActivity,
      `Synthetic ${id}`,
      head,
      0,
      null,
      null,
      0,
      null,
    );
};

const insertNode = (
  database: Database,
  sessionId: string,
  nodeId: number,
  parentNodeId: number | null,
  message: unknown,
) => {
  database
    .query(`insert into message_nodes (
      session_id, node_id, parent_node_id, chat_message, created_at, metadata
    ) values (?, ?, ?, ?, ?, ?)`) 
    .run(sessionId, nodeId, parentNodeId, JSON.stringify(message), 4_071_000_000 + nodeId, "null");
};

const diagnosticNames = (result: AdapterReadResult) =>
  result.diagnostics.flatMap((diagnostic) => {
    const details = diagnostic.details as { readonly diagnostic?: unknown } | undefined;
    return typeof details?.diagnostic === "string" ? [details.diagnostic] : [];
  });

afterEach(() => {
  while (roots.length > 0) {
    const root = roots.pop();
    if (root !== undefined) rmSync(root, { recursive: true, force: true });
  }
});

describe("Devin SQLite adapter", () => {
  test("projects only main-chain ancestry, splits reasoning, and pairs exact tool results", async () => {
    const { root, database } = createFixture();
    insertSession(database, "synthetic-main", 6);
    insertNode(database, "synthetic-main", 1, null, systemMessage("root-id", "synthetic system", "2099-01-01T00:00:00.000Z"));
    insertNode(database, "synthetic-main", 2, 1, userMessage("duplicate-message-id", "canonical user", "2099-01-01T00:00:01.000Z"));
    insertNode(database, "synthetic-main", 3, 2, assistantMessage(
      "assistant-reasoning",
      "canonical assistant answer",
      "2099-01-01T00:00:02.000Z",
      { thinking: { thinking: "API_KEY=devin-secret", signature: "opaque-signature-not-prose" } },
    ));
    insertNode(database, "synthetic-main", 4, 3, assistantMessage(
      "assistant-tools",
      "",
      "2099-01-01T00:00:03.000Z",
      {
        tool_calls: [
          { id: "failed-call", index: 1, kind: "function", name: "synthetic_fail", arguments: { command: "fail" } },
          { id: "successful-call", index: 0, kind: "function", name: "synthetic_success", arguments: { command: "pass" } },
        ],
      },
    ));
    insertNode(database, "synthetic-main", 5, 4, toolMessage(
      "successful-result",
      "successful-call",
      "synthetic successful result",
      "2099-01-01T00:00:04.000Z",
      true,
    ));
    insertNode(database, "synthetic-main", 6, 5, toolMessage(
      "failed-result",
      "failed-call",
      "synthetic failed result",
      "2099-01-01T00:00:06.000Z",
      false,
    ));

    // Stale copied branch: duplicate embedded message_id and derived-looking content.
    insertNode(database, "synthetic-main", 20, 1, userMessage(
      "duplicate-message-id",
      "OFFCHAIN STALE ATIF EXPORT",
      "2099-01-01T00:00:20.000Z",
    ));
    insertNode(database, "synthetic-main", 21, 20, assistantMessage(
      "stale-assistant",
      "OFFCHAIN SUMMARY COPY",
      "2099-01-01T00:00:21.000Z",
    ));
    database.query("insert into prompt_history values (?, ?, ?, ?, ?)").run(
      1,
      "DERIVED PROMPT HISTORY",
      1,
      "synthetic-main",
      0,
    );
    database.query("insert into rendered_commits values (?, ?, ?, ?, ?)").run(
      1,
      "synthetic-main",
      1,
      "DERIVED RENDERED COMMIT",
      1,
    );
    database.close();

    const result = await devinAdapter.read({ machine: MACHINE, now: NOW, roots: { devin: root } });
    expect(result.sessions).toHaveLength(1);
    const session = result.sessions[0]!;
    expect(session.nativeSessionId).toBe("synthetic-main");
    expect(session.id).toBe(sessionIdFor("devin", DevinSessionId("synthetic-main")));
    expect(session.events.map((event) => [event.role, event.kind, event.contentText])).toEqual([
      ["system", "system", "synthetic system"],
      ["user", "message", "canonical user"],
      ["thinking", "reasoning", "API_KEY=[redacted]"],
      ["assistant", "message", "canonical assistant answer"],
      ["assistant", "tool_call", undefined],
      ["tool", "tool_result", "synthetic successful result"],
      ["tool", "tool_result", "synthetic failed result"],
    ]);
    expect(session.events.map((event) => event.sequence)).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(JSON.stringify(session)).not.toContain("OFFCHAIN");
    expect(JSON.stringify(session)).not.toContain("DERIVED PROMPT HISTORY");
    expect(JSON.stringify(session)).not.toContain("DERIVED RENDERED COMMIT");
    expect(JSON.stringify(session)).not.toContain("opaque-signature-not-prose");
    expect(JSON.stringify(session)).not.toContain("devin-secret");
    expect(
      session.executionContexts.map(
        ({ scope, sequence, turnId, model, permissionProfileType }) => ({
          scope,
          sequence,
          turnId,
          model,
          permissionProfileType,
        }),
      ),
    ).toEqual([
      {
        scope: "session",
        sequence: 0,
        turnId: undefined,
        model: "synthetic-model",
        permissionProfileType: "normal",
      },
      {
        scope: "turn",
        sequence: 3,
        turnId: "assistant-reasoning",
        model: "synthetic-model",
        permissionProfileType: undefined,
      },
      {
        scope: "turn",
        sequence: 4,
        turnId: "assistant-tools",
        model: "synthetic-model",
        permissionProfileType: undefined,
      },
    ]);

    expect(session.toolCalls.map((call) => [call.toolName, call.status])).toEqual([
      ["synthetic_success", "completed"],
      ["synthetic_fail", "failed"],
    ]);
    expect(session.toolCalls[0]).toMatchObject({
      startedAt: "2099-01-01T00:00:04.000Z",
      completedAt: "2099-01-01T00:00:05.000Z",
      output: {
        result: { kind: "synthetic", success: true },
        terminalOutput: { cwd: "/synthetic/project", original_bytes: 25, truncated_lines: 0 },
      },
    });
    expect(session.toolCalls[1]).toMatchObject({
      startedAt: "2099-01-01T00:00:06.000Z",
      completedAt: "2099-01-01T00:00:07.000Z",
      output: {
        result: { kind: "synthetic", success: false, failure_reason: "synthetic failure" },
      },
    });
    expect(session.sessionEdges.filter((edge) => edge.kind === "parent")).toHaveLength(5);
    expect(session.sessionEdges.filter((edge) => edge.kind === "tool_result_for")).toHaveLength(2);
    const reasoning = session.events.find((event) => event.kind === "reasoning")!;
    const reasoningMain = session.events.find(
      (event) => event.nativeEventId === "node:3:main",
    )!;
    const parentBeforeReasoning = session.sessionEdges.find(
      (edge) => edge.kind === "parent" && edge.toEventId === reasoning.id,
    );
    expect(parentBeforeReasoning?.fromEventId).toBe(
      session.events.find((event) => event.nativeEventId === "node:2:main")!.id,
    );
    expect(session.sessionEdges).toContainEqual(
      expect.objectContaining({
        kind: "next",
        fromEventId: reasoning.id,
        toEventId: reasoningMain.id,
      }),
    );
    const connectedEventIds = new Set(
      session.sessionEdges.flatMap((edge) => [edge.fromEventId, edge.toEventId]),
    );
    expect(session.events.every((event) => connectedEventIds.has(event.id))).toBe(true);
  });

  test("uses canonical native identity and distinct per-session fingerprints across logical roots", async () => {
    const { root, database } = createFixture();
    insertSession(database, "fingerprint-alpha", 1, 4_071_010_000);
    insertNode(database, "fingerprint-alpha", 1, null, userMessage("alpha-message", "alpha", "2099-01-01T00:00:00.000Z"));
    insertSession(database, "fingerprint-beta", 1, 4_071_010_000);
    insertNode(database, "fingerprint-beta", 1, null, userMessage("beta-message", "beta", "2099-01-01T00:00:00.000Z"));
    database.close();

    const streamed: Array<{ readonly id: string; readonly fingerprint: string }> = [];
    for await (const item of devinAdapter.stream!({ machine: MACHINE, now: NOW, roots: { devin: root } })) {
      if (item.type === "session") {
        streamed.push({ id: item.session.id, fingerprint: JSON.stringify(item.fingerprint) });
      }
    }
    expect(streamed).toHaveLength(2);
    expect(new Set(streamed.map((item) => item.id)).size).toBe(2);
    expect(new Set(streamed.map((item) => item.fingerprint)).size).toBe(2);

    const first = await devinAdapter.read({
      machine: MACHINE,
      now: NOW,
      roots: { devin: root },
      logicalRoots: { devin: "/logical/host-a/devin" },
      limit: 1,
    });
    const second = await devinAdapter.read({
      machine: MACHINE,
      now: NOW,
      roots: { devin: root },
      logicalRoots: { devin: "/logical/host-b/devin" },
      limit: 1,
    });
    expect(first.sessions[0]!.nativeSessionId).toBe("fingerprint-beta");
    expect(first.sessions[0]!.id).toBe(second.sessions[0]!.id);
    expect(first.sessions[0]!.events.map((event) => event.id)).toEqual(
      second.sessions[0]!.events.map((event) => event.id),
    );
    expect(first.sessions[0]!.sourcePath).not.toBe(second.sessions[0]!.sourcePath);
  });

  test("fails malformed messages and unsupported roles closed with named diagnostics", async () => {
    const { root, database } = createFixture();
    insertSession(database, "malformed-message", 1, 4_071_020_002);
    database
      .query("insert into message_nodes (session_id, node_id, parent_node_id, chat_message, created_at, metadata) values (?, ?, ?, ?, ?, ?)")
      .run("malformed-message", 1, null, "{not-json", 1, "null");
    insertSession(database, "unknown-role", 1, 4_071_020_001);
    insertNode(database, "unknown-role", 1, null, {
      message_id: "unknown-role-message",
      role: "observer",
      content: "must not survive",
      metadata: commonMetadata("2099-01-01T00:00:00.000Z"),
    });
    database.close();

    const result = await devinAdapter.read({ machine: MACHINE, now: NOW, roots: { devin: root } });
    expect(result.sessions).toHaveLength(0);
    expect(diagnosticNames(result)).toContain("devin.message.decode_failed");
    expect(diagnosticNames(result)).toContain("devin.message.role_unsupported");
  });

  test("fails missing heads and parents closed without guessing graph order", async () => {
    const { root, database } = createFixture();
    insertSession(database, "missing-head", 999, 4_071_030_002);
    insertSession(database, "missing-parent", 2, 4_071_030_001);
    insertNode(database, "missing-parent", 2, 777, userMessage(
      "dangling-message",
      "must not survive",
      "2099-01-01T00:00:00.000Z",
    ));
    database.close();

    const result = await devinAdapter.read({ machine: MACHINE, now: NOW, roots: { devin: root } });
    expect(result.sessions).toHaveLength(0);
    expect(diagnosticNames(result)).toContain("devin.graph.head_missing");
    expect(diagnosticNames(result)).toContain("devin.graph.parent_missing");
  });
  test("rejects empty session ids and contains invalid epoch timestamps to their session", async () => {
    const { root, database } = createFixture();
    insertSession(database, "   ", 1, 9_000_000_000_001);
    insertNode(database, "   ", 1, null, userMessage(
      "empty-id-message",
      "must not survive",
      "2099-01-01T00:00:00.000Z",
    ));
    insertSession(database, "invalid-time", 1, 9_000_000_000_000);
    database
      .query("update sessions set created_at = ? where id = ?")
      .run(9_000_000_000_000, "invalid-time");
    insertNode(database, "invalid-time", 1, null, userMessage(
      "invalid-time-message",
      "invalid time survives without timestamps",
      "2099-01-01T00:00:01.000Z",
    ));
    insertSession(database, "later-valid", 1, 4_071_050_000);
    insertNode(database, "later-valid", 1, null, userMessage(
      "later-valid-message",
      "later valid session",
      "2099-01-01T00:00:02.000Z",
    ));
    database.close();

    const result = await devinAdapter.read({
      machine: MACHINE,
      now: NOW,
      roots: { devin: root },
    });

    expect(result.sessions.map((session) => session.nativeSessionId)).toEqual([
      "invalid-time",
      "later-valid",
    ]);
    expect(result.sessions[0]).not.toHaveProperty("startedAt");
    expect(result.sessions[0]).not.toHaveProperty("updatedAt");
    expect(result.sessions[1]).toMatchObject({
      startedAt: "2099-01-02T01:20:00.000Z",
      updatedAt: "2099-01-02T15:13:20.000Z",
    });
    expect(diagnosticNames(result)).toContain("devin.session.id_invalid");
    expect(diagnosticNames(result)).toContain("devin.timestamp.invalid");
    expect(diagnosticNames(result)).not.toContain("devin.sqlite.schema_mismatch");
  });

  test("honors stat and parse gates before snapshot parsing and message JSON decoding", async () => {
    const statFixture = createFixture();
    insertSession(statFixture.database, "stat-gated", 1);
    insertNode(statFixture.database, "stat-gated", 1, null, userMessage(
      "stat-message",
      "unread",
      "2099-01-01T00:00:00.000Z",
    ));
    statFixture.database.close();
    let statGateCalls = 0;
    let parseGateCalls = 0;
    const statResult = await devinAdapter.read({
      machine: MACHINE,
      now: NOW,
      roots: { devin: statFixture.root },
      shouldReadFile: (path, stat) => {
        statGateCalls += 1;
        expect(path).toBe(join(statFixture.root, "sessions.db"));
        expect(stat.size).toBeGreaterThan(0);
        return false;
      },
      shouldParseSession: () => {
        parseGateCalls += 1;
        return true;
      },
    });
    expect(statGateCalls).toBe(1);
    expect(parseGateCalls).toBe(0);
    expect(statResult.sessions).toHaveLength(0);

    const parseFixture = createFixture();
    insertSession(parseFixture.database, "parse-gated", 1);
    parseFixture.database
      .query("insert into message_nodes (session_id, node_id, parent_node_id, chat_message, created_at, metadata) values (?, ?, ?, ?, ?, ?)")
      .run("parse-gated", 1, null, "{malformed-but-never-parsed", 1, "null");
    parseFixture.database.close();
    let seenProbe: { readonly sessionId: string; readonly sourceFingerprint: string } | undefined;
    const parseResult = await devinAdapter.read({
      machine: MACHINE,
      now: NOW,
      roots: { devin: parseFixture.root },
      shouldParseSession: (probe) => {
        seenProbe = probe;
        return false;
      },
    });
    expect(seenProbe?.sessionId).toBe(
      sessionIdFor("devin", DevinSessionId("parse-gated")),
    );
    expect(JSON.parse(seenProbe!.sourceFingerprint)).toMatchObject({
      size: expect.any(Number),
      tag: expect.stringMatching(/^[0-9a-f]{32}$/),
    });
    expect(parseResult.sessions).toHaveLength(0);
    expect(diagnosticNames(parseResult)).not.toContain("devin.message.decode_failed");
  });

  test("changes the session fingerprint when canonical node content changes in place", async () => {
    const { root, database } = createFixture();
    insertSession(database, "mutable-content", 1, 4_071_040_001);
    insertNode(database, "mutable-content", 1, null, userMessage(
      "mutable-message",
      "before",
      "2099-01-01T00:00:00.000Z",
    ));
    database.close();

    const readFingerprint = async () => {
      let fingerprint: string | undefined;
      for await (const item of devinAdapter.stream!({
        machine: MACHINE,
        now: NOW,
        roots: { devin: root },
      })) {
        if (item.type === "session") fingerprint = JSON.stringify(item.fingerprint);
      }
      return fingerprint;
    };

    const before = await readFingerprint();
    const mutable = new Database(join(root, "sessions.db"));
    mutable.query("update message_nodes set chat_message = ? where session_id = ? and node_id = ?").run(
      JSON.stringify(userMessage(
        "mutable-message",
        "after",
        "2099-01-01T00:00:00.000Z",
      )),
      "mutable-content",
      1,
    );
    mutable.close();
    const after = await readFingerprint();

    expect(before).toBeDefined();
    expect(after).toBeDefined();
    expect(after).not.toBe(before);
  });

  test("re-reads WAL-only changes when the main database stat is unchanged", async () => {
    const { root, database } = createFixture();
    const dbPath = join(root, "sessions.db");
    const walPath = `${dbPath}-wal`;
    const shmPath = `${dbPath}-shm`;
    database.exec("pragma journal_mode = WAL; pragma wal_autocheckpoint = 0;");
    insertSession(database, "wal-first", 1, 4_071_060_000);
    insertNode(database, "wal-first", 1, null, userMessage(
      "wal-first-message",
      "first committed WAL state",
      "2099-01-01T00:00:00.000Z",
    ));
    const first = await devinAdapter.read({
      machine: MACHINE,
      now: NOW,
      roots: { devin: root },
    });
    expect(first.sessions.map((session) => session.nativeSessionId)).toEqual(["wal-first"]);

    const dbStatBefore = statSync(dbPath);
    const walStatBefore = statSync(walPath);
    insertSession(database, "wal-second", 1, 4_071_060_001);
    insertNode(database, "wal-second", 1, null, userMessage(
      "wal-second-message",
      "second committed WAL state",
      "2099-01-01T00:00:01.000Z",
    ));
    const dbStatAfter = statSync(dbPath);
    const walStatAfter = statSync(walPath);
    expect({ size: dbStatAfter.size, mtimeMs: dbStatAfter.mtimeMs }).toEqual({
      size: dbStatBefore.size,
      mtimeMs: dbStatBefore.mtimeMs,
    });
    expect({ size: walStatAfter.size, mtimeMs: walStatAfter.mtimeMs }).not.toEqual({
      size: walStatBefore.size,
      mtimeMs: walStatBefore.mtimeMs,
    });

    const probedPaths: string[] = [];
    const second = await devinAdapter.read({
      machine: MACHINE,
      now: NOW,
      roots: { devin: root },
      shouldReadFile: (path, stat) => {
        probedPaths.push(path);
        if (path === dbPath) {
          return stat.size !== dbStatBefore.size || stat.mtimeMs !== dbStatBefore.mtimeMs;
        }
        if (path === walPath) {
          return stat.size !== walStatBefore.size || stat.mtimeMs !== walStatBefore.mtimeMs;
        }
        return false;
      },
    });
    database.close();

    expect(probedPaths).toEqual([dbPath, walPath, shmPath]);
    expect(second.sessions.map((session) => session.nativeSessionId)).toEqual([
      "wal-second",
      "wal-first",
    ]);
    expect(second.sessions[0]!.events[0]!.contentText).toBe("second committed WAL state");
  });

  test("exports closed schemas and classifiers for measured variants", () => {
    const assistant = Schema.decodeSync(DevinAssistantMessageSchema)(assistantMessage(
      "schema-assistant",
      "schema content",
      "2099-01-01T00:00:00.000Z",
    ));
    const tool = Schema.decodeSync(DevinToolMessageSchema)(toolMessage(
      "schema-tool",
      "schema-call",
      "schema result",
      "2099-01-01T00:00:01.000Z",
      false,
    ));
    expect(isSignal(classifyDevinMessage(assistant))).toBe(true);
    expect(isSignal(classifyDevinMessage(tool))).toBe(true);
    expect(Schema.decodeSync(DevinChatMessageSchema)(assistant).role).toBe("assistant");
    expect(Schema.decodeSync(DevinSessionRowSchema)({
      id: "schema-session",
      working_directory: "/synthetic/project",
      backend_type: "Windsurf",
      model: "synthetic-model",
      agent_mode: "normal",
      created_at: 1,
      last_activity_at: 2,
      title: null,
      main_chain_id: 1,
      shell_last_seen_index: 0,
      cogs_json: null,
      workspace_dirs: null,
      hidden: 0,
      metadata: null,
    }).id).toBe("schema-session");
    expect(Schema.decodeSync(DevinMessageNodeRowSchema)({
      row_id: 1,
      session_id: "schema-session",
      node_id: 1,
      parent_node_id: null,
      chat_message: JSON.stringify(assistant),
      created_at: 1,
      metadata: "null",
    }).node_id).toBe(1);

    const unsupported = classifyDevinRole({
      message_id: "unsupported",
      role: "observer",
      content: "drop",
      metadata: {},
    });
    expect(unsupported).toEqual({ _tag: "drop", reason: "devin.message.role_unsupported" });
  });
});
