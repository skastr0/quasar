import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { describe, expect, test } from "vitest";

import { buildIngestBatch } from "../src/ingest";
import type { Provider } from "../src/schemas";

const machine = {
  machineId: "machine:test",
  hostname: "test-host",
  platform: "test",
};

const writeJsonl = (path: string, records: readonly unknown[]) =>
  writeFileSync(path, records.map((record) => JSON.stringify(record)).join("\n"));

const sql = (value: string) => `'${value.replaceAll("'", "''")}'`;

const localProviders = [
  "codex",
  "claude",
  "opencode",
  "grok",
  "amp",
  "pi",
  "kimi",
  "droid",
  "antigravity",
  "cursor",
] as const;

describe("adapter ingestion", () => {
  test("reads a Codex rollout fixture", async () => {
    const root = mkdtempSync(join(tmpdir(), "quasar-codex-"));
    const sessionDir = join(root, "sessions", "2026", "06", "03");
    mkdirSync(sessionDir, { recursive: true });
    writeFileSync(
      join(sessionDir, "rollout-2026-06-03T00-00-00-test.jsonl"),
      [
        JSON.stringify({
          type: "session_meta",
          timestamp: "2026-06-03T00:00:00.000Z",
          payload: { cwd: "/Users/a/Projects/quasar" },
        }),
        JSON.stringify({
          type: "response_item",
          timestamp: "2026-06-03T00:00:01.000Z",
          payload: { type: "message", role: "developer", content: "follow repo rules" },
        }),
        JSON.stringify({
          type: "response_item",
          timestamp: "2026-06-03T00:00:02.000Z",
          payload: { type: "message", role: "assistant", content: "hello quasar" },
        }),
        JSON.stringify({
          type: "event_msg",
          timestamp: "2026-06-03T00:00:03.000Z",
          payload: {
            type: "agent_message",
            phase: "commentary",
            message: "I am checking the repo first.",
          },
        }),
        JSON.stringify({
          type: "response_item",
          timestamp: "2026-06-03T00:00:04.000Z",
          payload: {
            type: "function_call",
            call_id: "call_test",
            name: "exec_command",
            arguments: "{\"cmd\":\"git status --short\"}",
          },
        }),
        JSON.stringify({
          type: "response_item",
          timestamp: "2026-06-03T00:00:05.000Z",
          payload: {
            type: "function_call_output",
            call_id: "call_test",
            output: " M packages/core/src/adapters/codex.ts\n",
          },
        }),
        JSON.stringify({
          type: "response_item",
          timestamp: "2026-06-03T00:00:06.000Z",
          payload: { type: "reasoning", summary: [{ text: "Need parse payload type." }] },
        }),
        JSON.stringify({
          type: "event_msg",
          timestamp: "2026-06-03T00:00:07.000Z",
          payload: { type: "token_count", info: { total_token_usage: { input_tokens: 10 } } },
        }),
      ].join("\n"),
    );
    const batch = await buildIngestBatch({
      providers: ["codex"],
      roots: { codex: root },
      machine,
    });
    expect(batch.sessions).toHaveLength(1);
    const session = batch.sessions[0]!;
    expect(session.events).toHaveLength(8);
    expect(session.events.map((event) => event.kind)).toEqual([
      "system",
      "message",
      "message",
      "preamble",
      "tool_call",
      "tool_result",
      "reasoning",
      "usage",
    ]);
    expect(session.events[1]?.role).toBe("developer");
    expect(session.toolCalls).toHaveLength(1);
    expect(session.toolCalls[0]).toMatchObject({
      toolName: "exec_command",
      status: "completed",
      input: { cmd: "git status --short" },
      output: " M packages/core/src/adapters/codex.ts\n",
      startedAt: "2026-06-03T00:00:04.000Z",
      completedAt: "2026-06-03T00:00:05.000Z",
    });
    expect(session.events[4]?.toolCallId).toBe(session.toolCalls[0]?.id);
    expect(session.events[5]?.toolCallId).toBe(session.toolCalls[0]?.id);
    expect(session.events.flatMap((event) => event.contentBlocks).length).toBeGreaterThan(0);
    expect(session.sessionEdges.filter((edge) => edge.kind === "tool_result_for")).toHaveLength(1);
    expect(session.usageRecords[0]?.inputTokens).toBe(10);
    expect(session.events[0]?.id).toContain("codex:event:machine:test:");
    expect(session.events[0]?.contentBlocks[0]?.id).toContain("codex:block:machine:test:");
  });

  test("reads graph fixtures for all ten local adapters", async () => {
    const fixtures = await makeAllAdapterFixtures();
    for (const provider of localProviders) {
      const batch = await buildIngestBatch({
        providers: [provider],
        roots: { [provider]: fixtures[provider] } as Partial<Record<Provider, string>>,
        machine,
      });
      const diagnostic = batch.diagnostics.find((item) => item.provider === provider);
      expect(diagnostic?.parserConfidence, provider).toBeDefined();
      expect(batch.sessions.length, provider).toBeGreaterThan(0);
      const session = batch.sessions[0]!;
      expect(session.events.length, provider).toBeGreaterThan(0);
      expect(session.events.flatMap((event) => event.contentBlocks).length, provider).toBeGreaterThan(0);
      expect(session.sessionEdges.some((edge) => edge.kind === "next"), provider).toBe(true);
    }

    const codex = await providerSession("codex", fixtures.codex);
    expect(codex.toolCalls[0]?.toolName).toBe("exec_command");

    const claude = await providerSession("claude", fixtures.claude);
    expect(claude.toolCalls[0]).toMatchObject({ toolName: "Read", status: "completed" });
    expect(claude.sessionEdges.some((edge) => edge.kind === "parent")).toBe(true);
    expect(claude.usageRecords[0]?.inputTokens).toBe(3);
    expect(claude.events[1]?.contentBlocks.map((block) => block.kind)).toEqual(
      expect.arrayContaining(["text", "image", "file", "json"]),
    );

    const opencode = await providerSession("opencode", fixtures.opencode);
    expect(opencode.toolCalls[0]).toMatchObject({ toolName: "bash", status: "completed" });
    expect(opencode.usageRecords[0]?.totalTokens).toBe(12);

    const grok = await providerSession("grok", fixtures.grok);
    expect(grok.artifacts[0]).toMatchObject({ kind: "edit_hunk" });

    const amp = await providerSession("amp", fixtures.amp);
    expect(amp.toolCalls[0]?.toolName).toBe("bash");
    expect(amp.sessionEdges.some((edge) => edge.kind === "parent")).toBe(true);
    expect(amp.usageRecords[0]?.totalTokens).toBe(3);

    const pi = await providerSession("pi", fixtures.pi);
    expect(pi.toolCalls[0]?.toolName).toBe("bash");
    expect(pi.sessionEdges.some((edge) => edge.kind === "parent")).toBe(true);
    expect(pi.usageRecords[0]?.totalTokens).toBe(3);

    const kimi = await providerSession("kimi", fixtures.kimi);
    expect(kimi.sessionEdges.some((edge) => edge.kind === "subagent_of")).toBe(true);
    expect(kimi.artifacts[0]).toMatchObject({ kind: "plan" });

    const droid = await providerSession("droid", fixtures.droid);
    expect(droid.toolCalls[0]?.toolName).toBe("bash");
    expect(droid.artifacts[0]?.kind).toBe("diff");

    const antigravity = await providerSession("antigravity", fixtures.antigravity);
    expect(antigravity.artifacts[0]).toMatchObject({ kind: "file" });

    const cursor = await providerSession("cursor", fixtures.cursor);
    expect(cursor.toolCalls[0]?.toolName).toBe("read_file");
    expect(cursor.artifacts[0]?.kind).toBe("diff");
  });

  test("scopes graph IDs by machine for the same native source path", async () => {
    const root = makeKimiFixture();
    const first = await providerSession("kimi", root, { machineId: "machine:a", hostname: "a", platform: "test" });
    const second = await providerSession("kimi", root, { machineId: "machine:b", hostname: "b", platform: "test" });

    const idFamilies = [
      ["events", first.events.map((event) => event.id), second.events.map((event) => event.id)],
      [
        "contentBlocks",
        first.events.flatMap((event) => event.contentBlocks.map((block) => block.id)),
        second.events.flatMap((event) => event.contentBlocks.map((block) => block.id)),
      ],
      ["sessionEdges", first.sessionEdges.map((edge) => edge.id), second.sessionEdges.map((edge) => edge.id)],
      ["toolCalls", first.toolCalls.map((toolCall) => toolCall.id), second.toolCalls.map((toolCall) => toolCall.id)],
      ["usageRecords", first.usageRecords.map((usageRecord) => usageRecord.id), second.usageRecords.map((usageRecord) => usageRecord.id)],
      ["artifacts", first.artifacts.map((artifact) => artifact.id), second.artifacts.map((artifact) => artifact.id)],
    ] as const;

    for (const [family, firstIds, secondIds] of idFamilies) {
      expect(firstIds.length, family).toBeGreaterThan(0);
      expect(secondIds.length, family).toBeGreaterThan(0);
      expect(firstIds.filter((id) => secondIds.includes(id)), family).toEqual([]);
    }
  });
});

const providerSession = async (provider: Provider, root: string, machineOverride = machine) => {
  const batch = await buildIngestBatch({
    providers: [provider],
    roots: { [provider]: root } as Partial<Record<Provider, string>>,
    machine: machineOverride,
  });
  return batch.sessions[0]!;
};

const makeAllAdapterFixtures = async (): Promise<Record<(typeof localProviders)[number], string>> => {
  const codex = mkdtempSync(join(tmpdir(), "quasar-all-codex-"));
  const codexSessionDir = join(codex, "sessions", "2026", "06", "04");
  mkdirSync(codexSessionDir, { recursive: true });
  writeJsonl(join(codexSessionDir, "rollout-2026-06-04T00-00-00-test.jsonl"), [
    { type: "session_meta", payload: { cwd: "/Users/a/Projects/quasar" } },
    { type: "response_item", payload: { type: "user_message", content: "hello" } },
    { type: "response_item", payload: { type: "function_call", call_id: "c1", name: "exec_command", arguments: "{\"cmd\":\"pwd\"}" } },
  ]);

  const claude = mkdtempSync(join(tmpdir(), "quasar-all-claude-"));
  const claudeProjectDir = join(claude, "projects", "-Users-a-Projects-quasar");
  mkdirSync(claudeProjectDir, { recursive: true });
  writeJsonl(join(claudeProjectDir, "claude-session.jsonl"), [
    { uuid: "u1", type: "user", message: { role: "user", content: "read package" }, cwd: "/Users/a/Projects/quasar" },
    {
      uuid: "u2",
      parentUuid: "u1",
      type: "assistant",
        timestamp: "2026-06-04T00:00:01.000Z",
        message: {
          role: "assistant",
          model: "claude-test",
          content: [
            { type: "text", text: "I will inspect the project." },
            { type: "image", media_type: "image/png", source: { type: "base64", data: "iVBORw0KGgo=" } },
            { type: "file", file_path: "notes.md", media_type: "text/markdown" },
            { type: "tool_use", id: "toolu_1", name: "Read", input: { file_path: "package.json" } },
          ],
          usage: { input_tokens: 3, output_tokens: 4 },
        },
      },
    {
      uuid: "u3",
      parentUuid: "u2",
      type: "user",
      message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "{}" }] },
    },
  ]);

  const opencode = await makeOpenCodeFixture();
  const grok = makeGrokFixture();
  const amp = makeAmpFixture();
  const pi = makePiFixture();
  const kimi = makeKimiFixture();
  const droid = makeDroidFixture();
  const antigravity = makeAntigravityFixture();
  const cursor = await makeCursorFixture();

  return {
    codex,
    claude,
    opencode,
    grok,
    amp,
    pi,
    kimi,
    droid,
    antigravity,
    cursor,
  };
};

const makeOpenCodeFixture = async () => {
  const root = mkdtempSync(join(tmpdir(), "quasar-all-opencode-"));
  const dbPath = join(root, "opencode.db");
  execFileSync("sqlite3", [
    dbPath,
    [
      "create table session (id text, title text, directory text, path text, time_created integer, time_updated integer);",
      "create table message (id text, session_id text, time_created integer, data text);",
      "create table part (id text, session_id text, message_id text, time_created integer, data text);",
      `insert into session values ('s1', 'OpenCode test', '/Users/a/Projects/quasar', '/Users/a/Projects/quasar', 1, 2);`,
      `insert into message values ('m1', 's1', 1, ${sql(JSON.stringify({ role: "assistant", tokens: { total: 12, input: 5, output: 7 }, modelID: "gpt-test", providerID: "openai" }))});`,
      `insert into message values ('m2', 's1', 2, ${sql(JSON.stringify({ parentID: "m1", role: "user", content: "thanks" }))});`,
      `insert into part values ('p1', 's1', 'm1', 1, ${sql(JSON.stringify({ type: "tool", tool: "bash", callID: "call1", state: { status: "completed", input: { command: "pwd" }, output: "/repo" } }))});`,
    ].join("\n"),
  ]);
  return root;
};

const makeGrokFixture = () => {
  const root = mkdtempSync(join(tmpdir(), "quasar-all-grok-"));
  const sessionDir = join(root, "sessions", "%2FUsers%2Fa%2FProjects%2Fquasar", "g1");
  mkdirSync(sessionDir, { recursive: true });
  writeFileSync(join(sessionDir, "summary.json"), JSON.stringify({ title: "Grok test" }));
  writeJsonl(join(sessionDir, "chat_history.jsonl"), [{ type: "user", content: "change file" }]);
  writeJsonl(join(sessionDir, "events.jsonl"), [
    { type: "tool", tool: "bash", callID: "gcall", state: { status: "completed", input: { command: "pwd" }, output: "/repo" } },
  ]);
  writeJsonl(join(sessionDir, "updates.jsonl"), [{ method: "session/update", params: { ok: true } }]);
  writeJsonl(join(sessionDir, "hunk_records.jsonl"), [
    { hunkId: "h1", filePath: "/Users/a/Projects/quasar/src/index.ts", hunkStart: 1, hunkEnd: 2, linesAdded: 1, linesRemoved: 0 },
  ]);
  return root;
};

const makeAmpFixture = () => {
  const root = mkdtempSync(join(tmpdir(), "quasar-all-amp-"));
  const threads = join(root, "threads");
  mkdirSync(threads, { recursive: true });
  writeFileSync(
    join(threads, "T-1.json"),
    JSON.stringify({
      id: "T-1",
      cwd: "/Users/a/Projects/quasar",
      messages: [
        { id: "a1", role: "user", content: "run pwd" },
        { id: "a2", parentId: "a1", role: "assistant", type: "tool", tool: "bash", input: { command: "pwd" }, output: "/repo", usage: { input: 1, output: 2 } },
      ],
    }),
  );
  writeJsonl(join(root, "history.jsonl"), [{ id: "h1", role: "user", content: "history entry" }]);
  return root;
};

const makePiFixture = () => {
  const root = mkdtempSync(join(tmpdir(), "quasar-all-pi-"));
  writeJsonl(join(root, "session.jsonl"), [
    { id: "p1", role: "user", content: "start", cwd: "/Users/a/Projects/quasar" },
    { id: "p2", parentId: "p1", type: "bash", command: "pwd", output: "/repo", tokens: { total: 3 } },
  ]);
  return root;
};

const makeKimiFixture = () => {
  const root = mkdtempSync(join(tmpdir(), "quasar-all-kimi-"));
  writeJsonl(join(root, "session_index.jsonl"), [{ id: "s1", cwd: "/Users/a/Projects/quasar", title: "Kimi test" }]);
  writeFileSync(join(root, "state.json"), JSON.stringify({ version: 1 }));
  const wireDir = join(root, "sessions", "s1", "agents", "agent-a");
  mkdirSync(wireDir, { recursive: true });
  writeJsonl(join(wireDir, "wire.jsonl"), [
    { id: "k1", role: "assistant", type: "plan", content: "plan work", parentAgentId: "root-agent" },
    { id: "k2", type: "tool", tool: "bash", input: { command: "pwd" }, output: "/repo", usage: { total: 4 } },
  ]);
  return root;
};

const makeDroidFixture = () => {
  const root = mkdtempSync(join(tmpdir(), "quasar-all-droid-"));
  const captures = join(root, "captures");
  mkdirSync(captures, { recursive: true });
  writeJsonl(join(captures, "stream.jsonl"), [
    { id: "d1", role: "user", content: "inspect" },
    { id: "d2", type: "tool", tool: "bash", input: { command: "pwd" }, output: "/repo" },
    { id: "d3", type: "diff", path: "/Users/a/Projects/quasar/a.ts", patch: "@@" },
  ]);
  return root;
};

const makeAntigravityFixture = () => {
  const root = mkdtempSync(join(tmpdir(), "quasar-all-antigravity-"));
  const sessionDir = join(root, "s1");
  const artifacts = join(sessionDir, "artifacts");
  mkdirSync(artifacts, { recursive: true });
  writeJsonl(join(sessionDir, "transcript.jsonl"), [
    { id: "ag1", role: "user", content: "hello", cwd: "/Users/a/Projects/quasar" },
    { id: "ag2", type: "tool", tool: "read_file", input: { path: "x" }, output: "x", usage: { total: 5 } },
  ]);
  writeFileSync(join(artifacts, "out.txt"), "artifact");
  return root;
};

const makeCursorFixture = async () => {
  const root = mkdtempSync(join(tmpdir(), "quasar-all-cursor-"));
  const storage = join(root, "globalStorage");
  mkdirSync(storage, { recursive: true });
  execFileSync("sqlite3", [
    join(storage, "state.vscdb"),
    [
      "create table ItemTable (key text, value text);",
      `insert into ItemTable values ('cursor.composerData', ${sql(JSON.stringify({
      messages: [
        { id: "c1", role: "user", content: "open file", workspacePath: "/Users/a/Projects/quasar" },
        { id: "c2", role: "assistant", type: "tool", toolName: "read_file", input: { path: "a.ts" }, output: "ok" },
        { id: "c3", role: "assistant", type: "diff", path: "/Users/a/Projects/quasar/a.ts", diff: "@@", tokens: { total: 6 } },
      ],
    }))});`,
    ].join("\n"),
  ]);
  return root;
};
