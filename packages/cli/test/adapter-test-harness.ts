import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { stableAdapters } from "../src/adapters/registry";
import type { AdapterStreamItem, SessionAdapter } from "../src/adapters/types";

export const MACHINE = {
  machineId: "machine:test",
  hostname: "test-host",
  platform: "darwin",
};

export const NOW = "2026-06-11T00:00:00.000Z";

export type AdapterProvider = (typeof stableAdapters)[number]["provider"];

export type AdapterFixture = {
  readonly provider: AdapterProvider;
  readonly root: string;
  readonly logicalRoot: string;
  readonly primaryPath: string;
};

const line = (value: unknown) => JSON.stringify(value);

export const writeJsonLines = (path: string, records: readonly unknown[]) =>
  writeFileSync(path, records.map(line).join("\n") + "\n", "utf8");

export const appendText = (path: string, text: string) =>
  writeFileSync(path, text, { encoding: "utf8", flag: "a" });

const codexUuid = "0fab0000-fab0-7fab-8fab-000000000061";

const buildCodexFixture = (root: string): AdapterFixture => {
  const dir = join(root, "sessions", "2026", "06", "11");
  mkdirSync(dir, { recursive: true });
  const primaryPath = join(dir, `rollout-2026-06-11T00-00-00-${codexUuid}.jsonl`);
  writeJsonLines(primaryPath, [
    {
      timestamp: NOW,
      type: "session_meta",
      payload: {
        id: codexUuid,
        timestamp: NOW,
        cwd: "/fixture/quasar",
        originator: "fixture",
        cli_version: "0.0.0-fixture",
        type: "session_meta",
      },
    },
    {
      timestamp: NOW,
      type: "response_item",
      payload: {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "fixture user turn" }],
      },
    },
    {
      timestamp: NOW,
      type: "response_item",
      payload: {
        type: "function_call",
        call_id: "fixture-call",
        name: "bash",
        arguments: "{\"cmd\":\"pwd\"}",
      },
    },
    {
      timestamp: NOW,
      type: "response_item",
      payload: {
        type: "function_call_output",
        call_id: "fixture-call",
        output: "/fixture/quasar",
      },
    },
    {
      timestamp: NOW,
      type: "response_item",
      payload: {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "fixture assistant turn" }],
      },
    },
  ]);
  return { provider: "codex", root, logicalRoot: "/fixture/codex", primaryPath };
};

const buildClaudeFixture = (root: string): AdapterFixture => {
  const sessionId = "aaaa1111-0001-4001-8001-000000000061";
  const dir = join(root, "projects", "-fixture-quasar");
  mkdirSync(dir, { recursive: true });
  const primaryPath = join(dir, `${sessionId}.jsonl`);
  writeJsonLines(primaryPath, [
    {
      uuid: "claude-user-1",
      sessionId,
      cwd: "/fixture/quasar",
      timestamp: NOW,
      type: "user",
      message: { role: "user", content: [{ type: "text", text: "fixture user turn" }] },
    },
    {
      uuid: "claude-assistant-1",
      parentUuid: "claude-user-1",
      sessionId,
      timestamp: NOW,
      type: "assistant",
      message: { role: "assistant", content: [{ type: "text", text: "fixture assistant turn" }] },
    },
  ]);
  return { provider: "claude", root, logicalRoot: "/fixture/claude", primaryPath };
};

const buildOpenCodeFixture = (root: string): AdapterFixture => {
  mkdirSync(root, { recursive: true });
  const primaryPath = join(root, "opencode.db");
  execFileSync("sqlite3", [primaryPath, `
create table session (id text primary key, title text, directory text, time_created integer, time_updated integer);
create table message (id text primary key, session_id text, time_created integer, data text);
create table part (id text primary key, message_id text, session_id text, time_created integer, data text);
insert into session values ('ses_fixture061', 'fixture session', '/fixture/quasar', 1, 2);
insert into message values ('msg_user', 'ses_fixture061', 1, json_object('role', 'user', 'time', json_object('created', 1)));
insert into part values ('part_user', 'msg_user', 'ses_fixture061', 1, json_object('type', 'text', 'text', 'fixture user turn'));
insert into message values ('msg_assistant', 'ses_fixture061', 2, json_object('role', 'assistant', 'time', json_object('created', 2)));
insert into part values ('part_assistant', 'msg_assistant', 'ses_fixture061', 2, json_object('type', 'text', 'text', 'fixture assistant turn'));
insert into part values ('part_tool', 'msg_assistant', 'ses_fixture061', 3, json_object('type', 'tool', 'tool', 'bash', 'callID', 'call-fixture', 'state', json_object('status', 'completed', 'input', json_object('cmd', 'pwd'), 'output', '/fixture/quasar')));
`]);
  return { provider: "opencode", root, logicalRoot: "/fixture/opencode", primaryPath };
};

const buildGrokFixture = (root: string): AdapterFixture => {
  const sessionId = "01900000-0000-7000-8000-000000000061";
  const dir = join(root, "sessions", encodeURIComponent("/fixture/quasar"), sessionId);
  mkdirSync(dir, { recursive: true });
  const primaryPath = join(dir, "chat_history.jsonl");
  writeJsonLines(primaryPath, [
    { id: "grok-user-1", type: "user", timestamp: NOW, content: "fixture user turn" },
    {
      id: "grok-assistant-1",
      type: "assistant",
      timestamp: NOW,
      content: "fixture assistant turn",
      tool_calls: [{ id: "call-fixture", name: "bash", arguments: "{\"cmd\":\"pwd\"}" }],
    },
    {
      id: "grok-tool-1",
      type: "tool_result",
      timestamp: NOW,
      tool_call_id: "call-fixture",
      content: "/fixture/quasar",
    },
  ]);
  writeFileSync(join(dir, "summary.json"), JSON.stringify({ generated_title: "Fixture Grok Session" }), "utf8");
  return { provider: "grok", root, logicalRoot: "/fixture/grok", primaryPath };
};

const buildHermesFixture = (root: string): AdapterFixture => {
  mkdirSync(root, { recursive: true });
  const primaryPath = join(root, "state.db");
  execFileSync("sqlite3", [primaryPath, `
create table sessions (
  id text primary key,
  source text not null,
  user_id text,
  model text,
  model_config text,
  system_prompt text,
  parent_session_id text,
  started_at real not null,
  ended_at real,
  end_reason text,
  message_count integer default 0,
  tool_call_count integer default 0,
  input_tokens integer default 0,
  output_tokens integer default 0,
  cache_read_tokens integer default 0,
  cache_write_tokens integer default 0,
  reasoning_tokens integer default 0,
  billing_provider text,
  billing_base_url text,
  billing_mode text,
  estimated_cost_usd real,
  actual_cost_usd real,
  cost_status text,
  cost_source text,
  pricing_version text,
  title text,
  api_call_count integer default 0,
  handoff_state text,
  handoff_platform text,
  handoff_error text,
  cwd text,
  rewind_count integer not null default 0,
  archived integer not null default 0
);
create table messages (
  id integer primary key autoincrement,
  session_id text not null,
  role text not null,
  content text,
  tool_call_id text,
  tool_calls text,
  tool_name text,
  timestamp real not null,
  token_count integer,
  finish_reason text,
  reasoning text,
  reasoning_content text,
  reasoning_details text,
  codex_reasoning_items text,
  codex_message_items text,
  platform_message_id text
);
insert into sessions (id, source, title, cwd, started_at, message_count) values ('20260101_000000_00000061', 'cli', 'Fixture Hermes Session', '/fixture/quasar', 1000, 2);
insert into messages (session_id, role, content, timestamp) values ('20260101_000000_00000061', 'user', 'fixture user turn', 1000);
insert into messages (session_id, role, content, tool_call_id, tool_name, timestamp) values ('20260101_000000_00000061', 'assistant', 'fixture assistant turn', 'call-fixture', 'bash', 1001);
`]);
  return { provider: "hermes", root, logicalRoot: "/fixture/hermes", primaryPath };
};

const buildKimiFixture = (root: string): AdapterFixture => {
  const sessionId = "session_fixture061";
  const sessionDir = join(root, "sessions", "fixture-quasar", sessionId);
  const agentDir = join(sessionDir, "agents", "main");
  mkdirSync(agentDir, { recursive: true });
  writeFileSync(join(sessionDir, "state.json"), JSON.stringify({
    createdAt: NOW,
    updatedAt: NOW,
    title: "Fixture Kimi Session",
    isCustomTitle: true,
    agents: { main: { type: "main", parentAgentId: null } },
  }), "utf8");
  const primaryPath = join(agentDir, "wire.jsonl");
  writeJsonLines(primaryPath, [
    {
      type: "context.append_message",
      time: 1000,
      message: { role: "user", content: [{ type: "text", text: "fixture user turn" }] },
      origin: { kind: "user" },
    },
    {
      type: "context.append_message",
      time: 1001,
      message: { role: "assistant", content: [{ type: "text", text: "fixture assistant turn" }] },
      origin: { kind: "assistant" },
    },
  ]);
  writeJsonLines(join(root, "session_index.jsonl"), [
    { sessionId, sessionDir, workDir: "/fixture/quasar", updatedAt: NOW },
  ]);
  return { provider: "kimi", root, logicalRoot: "/fixture/kimi", primaryPath };
};

const buildAntigravityFixture = (root: string): AdapterFixture => {
  const sessionId = "01900000-0000-7000-8000-000000000061";
  const dir = join(root, "brain", sessionId, ".system_generated", "logs");
  mkdirSync(dir, { recursive: true });
  const primaryPath = join(dir, "transcript_full.jsonl");
  writeJsonLines(primaryPath, [
    {
      type: "USER_INPUT",
      created_at: NOW,
      step_index: 0,
      content: "fixture user turn",
    },
    {
      type: "PLANNER_RESPONSE",
      created_at: NOW,
      step_index: 1,
      content: "fixture assistant turn",
    },
  ]);
  // Deterministic project identity: conversation DB carries file:///fixture/quasar
  // so goldens never embed host HOME via the unknown-project fallback.
  const conversationsDir = join(root, "conversations");
  mkdirSync(conversationsDir, { recursive: true });
  const workdirBlobHex = Buffer.from("file:///fixture/quasar", "utf8").toString("hex");
  execFileSync("sqlite3", [
    join(conversationsDir, `${sessionId}.db`),
    `create table trajectory_metadata_blob (id text primary key, data blob);
     insert into trajectory_metadata_blob values ('main', x'${workdirBlobHex}');`,
  ]);
  return { provider: "antigravity", root, logicalRoot: "/fixture/antigravity", primaryPath };
};

const buildOmpFixture = (root: string): AdapterFixture => {
  const sessionId = "01900000-0000-7000-8000-000000000061";
  const dir = join(root, "-fixture-quasar");
  mkdirSync(dir, { recursive: true });
  const primaryPath = join(dir, "main.jsonl");
  writeJsonLines(primaryPath, [
    {
      type: "title",
      v: 1,
      title: "Fixture OMP Session",
      source: "user",
      updatedAt: NOW,
      pad: " ".repeat(80),
    },
    {
      type: "session",
      version: 3,
      id: sessionId,
      timestamp: NOW,
      cwd: "/fixture/quasar",
    },
    {
      type: "message",
      id: "omp-user-1",
      parentId: null,
      timestamp: NOW,
      message: {
        role: "user",
        content: [{ type: "text", text: "fixture user turn" }],
        timestamp: Date.parse(NOW),
      },
    },
    {
      type: "message",
      id: "omp-assistant-1",
      parentId: "omp-user-1",
      timestamp: NOW,
      message: {
        role: "assistant",
        content: [
          { type: "text", text: "fixture assistant turn" },
          {
            type: "toolCall",
            id: "fixture-call",
            name: "bash",
            arguments: { cmd: "pwd" },
          },
        ],
        api: "fixture-api",
        provider: "fixture-provider",
        model: "fixture-model",
        usage: {
          input: 1,
          output: 1,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 2,
          cost: { total: 0 },
        },
        stopReason: "toolUse",
        timestamp: Date.parse(NOW),
      },
    },
    {
      type: "message",
      id: "omp-result-1",
      parentId: "omp-assistant-1",
      timestamp: NOW,
      message: {
        role: "toolResult",
        toolCallId: "fixture-call",
        toolName: "bash",
        content: [{ type: "text", text: "/fixture/quasar" }],
        isError: false,
        timestamp: Date.parse(NOW),
      },
    },
  ]);
  return { provider: "omp", root, logicalRoot: "/fixture/omp", primaryPath };
};

const buildPiFixture = (root: string): AdapterFixture => {
  const dir = join(root, "--fixture-quasar--");
  mkdirSync(dir, { recursive: true });
  const primaryPath = join(dir, "fixture.jsonl");
  writeJsonLines(primaryPath, [
    {
      type: "session",
      version: 3,
      id: "pi-fixture061",
      timestamp: NOW,
      cwd: "/fixture/quasar",
    },
    {
      type: "message",
      id: "pi-user-1",
      parentId: null,
      timestamp: NOW,
      message: {
        role: "user",
        content: [{ type: "text", text: "fixture user turn" }],
        timestamp: Date.parse(NOW),
      },
    },
    {
      type: "message",
      id: "pi-assistant-1",
      parentId: "pi-user-1",
      timestamp: NOW,
      message: {
        role: "assistant",
        content: [
          { type: "text", text: "fixture assistant turn" },
          {
            type: "toolCall",
            id: "fixture-call",
            name: "bash",
            arguments: { cmd: "pwd" },
          },
        ],
        api: "fixture-api",
        provider: "fixture-provider",
        model: "fixture-model",
        usage: {
          input: 1,
          output: 1,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 2,
          cost: { total: 0 },
        },
        stopReason: "toolUse",
        timestamp: Date.parse(NOW),
      },
    },
    {
      type: "message",
      id: "pi-result-1",
      parentId: "pi-assistant-1",
      timestamp: NOW,
      message: {
        role: "toolResult",
        toolCallId: "fixture-call",
        toolName: "bash",
        content: [{ type: "text", text: "/fixture/quasar" }],
        isError: false,
        timestamp: Date.parse(NOW),
      },
    },
  ]);
  return { provider: "pi", root, logicalRoot: "/fixture/pi", primaryPath };
};

const encodeCursorVarint = (value: number): Buffer => {
  const bytes: number[] = [];
  let remaining = value;
  do {
    let byte = remaining & 0x7f;
    remaining = Math.floor(remaining / 128);
    if (remaining > 0) byte |= 0x80;
    bytes.push(byte);
  } while (remaining > 0);
  return Buffer.from(bytes);
};

const cursorFieldBytes = (fieldNumber: number, value: Uint8Array): Buffer =>
  Buffer.concat([
    encodeCursorVarint((fieldNumber << 3) | 2),
    encodeCursorVarint(value.length),
    Buffer.from(value),
  ]);

const cursorBlob = (value: unknown) => {
  const bytes = Buffer.from(JSON.stringify(value), "utf8");
  return {
    bytes,
    id: createHash("sha256").update(bytes).digest("hex"),
    reference: createHash("sha256").update(bytes).digest(),
  };
};

const buildCursorFixture = (root: string): AdapterFixture => {
  const sessionId = "8fd16ca4-4dfa-4fea-8c37-4df7c63c5577";
  const cwd = "/fixture/quasar";
  const workspace = createHash("md5").update(cwd).digest("hex");
  const dir = join(root, "chats", workspace, sessionId);
  mkdirSync(dir, { recursive: true });
  const primaryPath = join(dir, "store.db");
  const user = cursorBlob({
    role: "user",
    content: [{ type: "text", text: "fixture user turn" }],
  });
  const assistant = cursorBlob({
    role: "assistant",
    id: "cursor-assistant-1",
    content: [
      {
        type: "tool-call",
        toolCallId: "fixture-call",
        toolName: "bash",
        args: { cmd: "pwd" },
      },
      { type: "text", text: "fixture assistant turn" },
    ],
    providerOptions: { cursor: { modelName: "fixture-model" } },
  });
  const result = cursorBlob({
    role: "tool",
    id: "cursor-tool-1",
    content: [{
      type: "tool-result",
      toolCallId: "fixture-call",
      toolName: "bash",
      result: "/fixture/quasar",
    }],
    providerOptions: {
      cursor: {
        highLevelToolCallResult: {
          isError: false,
          output: "/fixture/quasar",
        },
      },
    },
  });
  const rootBytes = Buffer.concat([
    cursorFieldBytes(1, user.reference),
    cursorFieldBytes(1, assistant.reference),
    cursorFieldBytes(1, result.reference),
  ]);
  const rootId = createHash("sha256").update(rootBytes).digest("hex");
  const createdAt = Date.parse(NOW);
  const metadata = Buffer.from(JSON.stringify({
    agentId: sessionId,
    latestRootBlobId: rootId,
    name: "Fixture Cursor Session",
    createdAt,
    mode: "default",
    isRunEverything: false,
    approvalMode: "default",
    lastUsedModel: "fixture-model",
  }), "utf8").toString("hex");
  execFileSync("sqlite3", [primaryPath, `
pragma user_version = 1;
create table blobs (id text primary key, data blob);
create table meta (key text primary key, value text);
insert into blobs values ('${user.id}', x'${user.bytes.toString("hex")}');
insert into blobs values ('${assistant.id}', x'${assistant.bytes.toString("hex")}');
insert into blobs values ('${result.id}', x'${result.bytes.toString("hex")}');
insert into blobs values ('${rootId}', x'${rootBytes.toString("hex")}');
insert into meta values ('0', '${metadata}');
`]);
  const metaPath = join(dir, "meta.json");
  writeFileSync(metaPath, JSON.stringify({
    schemaVersion: 1,
    createdAtMs: createdAt,
    hasConversation: true,
    title: "Fixture Cursor Session",
    updatedAtMs: createdAt + 1_000,
    cwd,
  }), "utf8");
  const deterministicMtime = new Date(createdAt + 1_000);
  utimesSync(primaryPath, deterministicMtime, deterministicMtime);
  utimesSync(metaPath, deterministicMtime, deterministicMtime);
  return { provider: "cursor", root, logicalRoot: "/fixture/cursor", primaryPath };
};

export const rewriteCursorFixtureUserMessage = (
  fixture: AdapterFixture,
  message: unknown,
) => {
  if (fixture.provider !== "cursor") {
    throw new Error(`Expected cursor fixture, received ${fixture.provider}`);
  }
  const oldUserId = execFileSync("sqlite3", [
    fixture.primaryPath,
    "select id from blobs where cast(data as text) like '%fixture user turn%' limit 1;",
  ], { encoding: "utf8" }).trim();
  const metadataHex = execFileSync("sqlite3", [
    fixture.primaryPath,
    "select value from meta where key = '0';",
  ], { encoding: "utf8" }).trim();
  const metadata = JSON.parse(Buffer.from(metadataHex, "hex").toString("utf8")) as {
    latestRootBlobId: string;
    [key: string]: unknown;
  };
  const rootHex = execFileSync("sqlite3", [
    fixture.primaryPath,
    `select hex(data) from blobs where id = '${metadata.latestRootBlobId}';`,
  ], { encoding: "utf8" }).trim();
  const rootBytes = Buffer.from(rootHex, "hex");
  const oldReference = Buffer.from(oldUserId, "hex");
  const referenceOffset = rootBytes.indexOf(oldReference);
  if (referenceOffset < 0) {
    throw new Error("Cursor fixture root does not reference its user message");
  }

  const replacement = cursorBlob(message);
  replacement.reference.copy(rootBytes, referenceOffset);
  const replacementRootId = createHash("sha256").update(rootBytes).digest("hex");
  const replacementMetadata = Buffer.from(JSON.stringify({
    ...metadata,
    latestRootBlobId: replacementRootId,
  }), "utf8").toString("hex");
  execFileSync("sqlite3", [fixture.primaryPath, `
begin;
insert into blobs values ('${replacement.id}', x'${replacement.bytes.toString("hex")}');
insert into blobs values ('${replacementRootId}', x'${rootBytes.toString("hex")}');
update meta set value = '${replacementMetadata}' where key = '0';
commit;
`]);
};

const buildDevinFixture = (root: string): AdapterFixture => {
  mkdirSync(root, { recursive: true });
  const primaryPath = join(root, "sessions.db");
  const createdAt = Math.floor(Date.parse(NOW) / 1_000);
  const metadata = {
    created_at: NOW,
    telemetry: {},
    finish_reason: null,
    is_user_input: null,
    metrics: null,
    num_tokens: null,
    request_id: null,
  };
  const user = JSON.stringify({
    message_id: "devin-user-1",
    role: "user",
    content: "fixture user turn",
    metadata,
  }).replaceAll("'", "''");
  const assistant = JSON.stringify({
    message_id: "devin-assistant-1",
    role: "assistant",
    content: "fixture assistant turn",
    metadata: {
      ...metadata,
      generation_model: "fixture-model",
      started_generation_at: NOW,
    },
    tool_calls: [],
  }).replaceAll("'", "''");
  execFileSync("sqlite3", [primaryPath, `
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
insert into sessions values (
  'devin-fixture061', '/fixture/quasar', 'Windsurf', 'fixture-model', 'normal',
  ${createdAt}, ${createdAt + 2}, 'Fixture Devin Session', 2, 0, null, null, 0, null
);
insert into message_nodes (session_id, node_id, parent_node_id, chat_message, created_at, metadata)
values ('devin-fixture061', 1, null, '${user}', ${createdAt}, 'null');
insert into message_nodes (session_id, node_id, parent_node_id, chat_message, created_at, metadata)
values ('devin-fixture061', 2, 1, '${assistant}', ${createdAt + 1}, 'null');
`]);
  return { provider: "devin", root, logicalRoot: "/fixture/devin", primaryPath };
};

export const buildFixtureFor = (provider: AdapterProvider, root: string): AdapterFixture => {
  switch (provider) {
    case "codex":
      return buildCodexFixture(root);
    case "claude":
      return buildClaudeFixture(root);
    case "opencode":
      return buildOpenCodeFixture(root);
    case "grok":
      return buildGrokFixture(root);
    case "hermes":
      return buildHermesFixture(root);
    case "kimi":
      return buildKimiFixture(root);
    case "antigravity":
      return buildAntigravityFixture(root);
    case "omp":
      return buildOmpFixture(root);
    case "pi":
      return buildPiFixture(root);
    case "cursor":
      return buildCursorFixture(root);
    case "devin":
      return buildDevinFixture(root);
    case "amp":
      throw new Error("amp is a remote CLI adapter and is not covered by the filesystem fixture harness");
  }
};

export const adapterFor = (provider: AdapterProvider): SessionAdapter => {
  const adapter = stableAdapters.find((candidate) => candidate.provider === provider);
  if (adapter === undefined) throw new Error(`No adapter for ${provider}`);
  return adapter;
};

export const collectStreamItems = async (
  adapter: SessionAdapter,
  fixture: AdapterFixture,
): Promise<AdapterStreamItem[]> => {
  if (adapter.stream === undefined) throw new Error(`${adapter.id} has no stream`);
  const items: AdapterStreamItem[] = [];
  const roots = { [adapter.provider]: fixture.root } as Parameters<SessionAdapter["read"]>[0]["roots"];
  const logicalRoots = { [adapter.provider]: fixture.logicalRoot } as Parameters<SessionAdapter["read"]>[0]["logicalRoots"];
  for await (const item of adapter.stream({ machine: MACHINE, now: NOW, roots, logicalRoots })) {
    items.push(item);
  }
  return items;
};

const sortObject = (value: unknown, fixture: AdapterFixture): unknown => {
  if (Array.isArray(value)) return value.map((item) => sortObject(item, fixture));
  if (typeof value === "string") {
    let text = value.replaceAll(fixture.root, "<fixture-root>");
    // Guard host leakage: any residual HOME-derived path (unknown-project fallback)
    // must not land in committed goldens.
    const home = process.env.HOME;
    if (home !== undefined && home.length > 0) {
      text = text.replaceAll(home, "<home>");
    }
    return text;
  }
  if (value === null || typeof value !== "object") return value;
  const record = value as Record<string, unknown>;
  const entries = Object.keys(record)
    .sort()
    .map((key) => {
      const item = key === "mtimeMs" ? "<mtimeMs>" : sortObject(record[key], fixture);
      return [key, item] as const;
    });
  return Object.fromEntries(entries);
};

export const canonicalizeItems = (
  items: readonly AdapterStreamItem[],
  fixture: AdapterFixture,
) => sortObject(items, fixture);
