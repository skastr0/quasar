import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
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
  return { provider: "antigravity", root, logicalRoot: "/fixture/antigravity", primaryPath };
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
    return value.replaceAll(fixture.root, "<fixture-root>");
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
