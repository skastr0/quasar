import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { describe, expect, test } from "vitest";

import { codexAdapter } from "../src/adapters/codex";
import {
  projectSessionNativeValue,
  projectToolPayloadNativeValue,
} from "../src/adapters/common";
import type { AdapterDiscoverOptions, AdapterStreamItem } from "../src/adapters/types";
import { buildIngestBatch, streamIngestBatches, summarizeIngestBatches } from "../src/ingest";
import {
  CONVEX_SAFE_INGEST_BUDGETS,
  assertConvexSafeSessionIntelligenceBatch,
  jsonByteLength,
} from "../src/session-intelligence";
import type { IngestBatch, NormalizedSession, Provider } from "../src/schemas";

const machine = {
  machineId: "machine:test",
  hostname: "test-host",
  platform: "test",
};

const writeJsonl = (path: string, records: readonly unknown[]) =>
  writeFileSync(path, records.map((record) => JSON.stringify(record)).join("\n"));

const sql = (value: string) => `'${value.replaceAll("'", "''")}'`;

const writeOpenCodeDb = (
  dbPath: string,
  input: {
    readonly sessionId: string;
    readonly title: string;
    readonly content: string;
    readonly part?: { readonly id: string; readonly data: unknown };
  },
) => {
  execFileSync("sqlite3", [
    dbPath,
    [
      "create table session (id text, title text, directory text, path text, time_created integer, time_updated integer);",
      "create table message (id text, session_id text, time_created integer, data text);",
      "create table part (id text, session_id text, message_id text, time_created integer, data text);",
      `insert into session values (${sql(input.sessionId)}, ${sql(input.title)}, '/Users/a/Projects/quasar', '/Users/a/Projects/quasar', 1, 2);`,
      `insert into message values ('m1', ${sql(input.sessionId)}, 1, ${sql(JSON.stringify({ role: "user", content: input.content }))});`,
      ...(input.part === undefined
        ? []
        : [
            `insert into part values (${sql(input.part.id)}, ${sql(input.sessionId)}, 'm1', 1, ${sql(JSON.stringify(input.part.data))});`,
          ]),
    ].join("\n"),
  ]);
};

const writeOpenCodeLocalSchemaDb = (
  dbPath: string,
  sessions: readonly {
    readonly sessionId: string;
    readonly title: string;
    readonly content: string;
    readonly timeUpdated: number;
  }[],
) => {
  execFileSync("sqlite3", [
    dbPath,
    [
      "create table session (id text, title text, directory text, time_created integer, time_updated integer);",
      "create table message (id text, session_id text, time_created integer, data text);",
      "create table part (id text, session_id text, message_id text, time_created integer, data text);",
      ...sessions.flatMap((session, index) => [
        `insert into session values (${sql(session.sessionId)}, ${sql(session.title)}, '/Users/a/Projects/quasar', ${index + 1}, ${session.timeUpdated});`,
        `insert into message values (${sql(`m-${index}`)}, ${sql(session.sessionId)}, ${index + 1}, ${sql(JSON.stringify({ role: "user", content: session.content }))});`,
      ]),
    ].join("\n"),
  ]);
};

const localProviders = [
  "codex",
  "claude",
  "opencode",
  "grok",
  "amp",
  "pi",
  "kimi",
  "droid",
  "hermes",
  "antigravity",
  "cursor",
] as const;

describe("adapter ingestion", () => {
  test("projects provider metadata while preserving real tool patch and diff payloads", () => {
    const sessionProjection = projectSessionNativeValue({
      type: "diff",
      patch: "@@ real event patch",
      diff: "@@ real event diff",
      summary: {
        diffs: ["provider summary diff trash"],
        cache: { state: "provider summary cache trash" },
      },
      workspace: {
        diff: "provider workspace diff trash",
        patch: "provider workspace patch trash",
        patches: ["provider workspace patches trash"],
      },
      providerUi: "provider event ui trash",
    });
    const toolProjection = projectToolPayloadNativeValue({
      patch: "@@ real tool patch",
      diff: "@@ real tool diff",
      patches: ["@@ real tool patch list"],
      summary: { diffs: ["provider tool summary diff trash"] },
      viewState: "provider tool view trash",
      providerUi: "provider tool ui trash",
    });
    const sessionEncoded = JSON.stringify(sessionProjection);
    const toolEncoded = JSON.stringify(toolProjection);

    expect(sessionEncoded).toContain("@@ real event patch");
    expect(sessionEncoded).toContain("@@ real event diff");
    expect(sessionEncoded).not.toContain("provider summary diff trash");
    expect(sessionEncoded).not.toContain("provider summary cache trash");
    expect(sessionEncoded).not.toContain("provider workspace diff trash");
    expect(sessionEncoded).not.toContain("provider workspace patch trash");
    expect(sessionEncoded).not.toContain("provider workspace patches trash");
    expect(sessionEncoded).not.toContain("provider event ui trash");
    expect(toolEncoded).toContain("@@ real tool patch");
    expect(toolEncoded).toContain("@@ real tool diff");
    expect(toolEncoded).toContain("@@ real tool patch list");
    expect(toolEncoded).not.toContain("provider tool summary diff trash");
    expect(toolEncoded).not.toContain("provider tool view trash");
    expect(toolEncoded).not.toContain("provider tool ui trash");
  });

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

  test("applies deterministic skip windows to file-backed adapters", async () => {
    const root = mkdtempSync(join(tmpdir(), "quasar-codex-window-"));
    const sessionDir = join(root, "sessions", "2026", "06", "03");
    mkdirSync(sessionDir, { recursive: true });
    for (const name of ["a", "b", "c"]) {
      writeJsonl(join(sessionDir, `rollout-2026-06-03T00-00-00-${name}.jsonl`), [
        { type: "session_meta", payload: { cwd: "/Users/a/Projects/quasar" } },
        { type: "response_item", payload: { type: "user_message", content: `hello ${name}` } },
      ]);
    }

    const firstWindow = await buildIngestBatch({
      providers: ["codex"],
      roots: { codex: root },
      machine,
      limit: 1,
    });
    const secondWindow = await buildIngestBatch({
      providers: ["codex"],
      roots: { codex: root },
      machine,
      limit: 1,
      skip: 1,
    });

    expect(firstWindow.sessions).toHaveLength(1);
    expect(secondWindow.sessions).toHaveLength(1);
    expect(firstWindow.sessions[0]?.nativeSessionId).toContain("-a");
    expect(secondWindow.sessions[0]?.nativeSessionId).toContain("-b");
  });

  test("applies deterministic skip windows to sqlite-backed adapters", async () => {
    const root = makeOpenCodeWindowFixture();
    const firstWindow = await buildIngestBatch({
      providers: ["opencode"],
      roots: { opencode: root },
      machine,
      limit: 1,
    });
    const secondWindow = await buildIngestBatch({
      providers: ["opencode"],
      roots: { opencode: root },
      machine,
      limit: 1,
      skip: 1,
    });

    expect(firstWindow.sessions.map((session) => session.nativeSessionId)).toEqual(["s-new"]);
    expect(secondWindow.sessions.map((session) => session.nativeSessionId)).toEqual(["s-mid"]);
  }, 15_000);

  test("summarizes streamed ingest batches without requiring aggregate session storage", async () => {
    const root = mkdtempSync(join(tmpdir(), "quasar-codex-stream-summary-"));
    const sessionDir = join(root, "sessions", "2026", "06", "03");
    mkdirSync(sessionDir, { recursive: true });
    for (const name of ["a", "b", "c"]) {
      writeJsonl(join(sessionDir, `rollout-2026-06-03T00-00-00-${name}.jsonl`), [
        { type: "session_meta", payload: { cwd: "/Users/a/Projects/quasar" } },
        { type: "response_item", payload: { type: "user_message", content: `hello ${name}` } },
      ]);
    }

    const summary = await summarizeIngestBatches({
      providers: ["codex"],
      roots: { codex: root },
      machine,
      limit: 2,
      skip: 1,
      generatedAt: "2026-06-03T00:00:00.000Z",
    });

    expect(summary.sourceRootCount).toBe(1);
    expect(summary.sessionCount).toBe(2);
    expect(summary.eventCount).toBe(4);
    expect(summary.contentBlockCount).toBeGreaterThanOrEqual(2);
    expect(summary.diagnostics[0]?.message).toBe("Discovered 2 Codex session(s).");
  });

  test("reads graph fixtures for all local adapters", async () => {
    const fixtures = await makeAllAdapterFixtures();
    const sessionsByProvider = new Map<Provider, NormalizedSession>();
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
      assertAdapterContract(batch, provider);
      expect(session.events.length, provider).toBeGreaterThan(0);
      expect(session.events.flatMap((event) => event.contentBlocks).length, provider).toBeGreaterThan(0);
      expect(session.sessionEdges.some((edge) => edge.kind === "next"), provider).toBe(true);
      sessionsByProvider.set(provider, session);
    }

    const codex = sessionsByProvider.get("codex")!;
    expect(codex.toolCalls[0]?.toolName).toBe("exec_command");
    expect(JSON.stringify(codex)).toContain("@@ real codex tool patch");

    const claude = sessionsByProvider.get("claude")!;
    expect(claude.toolCalls[0]).toMatchObject({ toolName: "Read", status: "completed" });
    expect(JSON.stringify(claude.toolCalls[0]?.output)).toContain("quasar");
    expect(JSON.stringify(claude)).toContain("@@ real claude tool patch");
    expect(JSON.stringify(claude.events[2]?.contentBlocks)).toContain("quasar");
    expect(claude.sessionEdges.some((edge) => edge.kind === "parent")).toBe(true);
    expect(claude.usageRecords[0]?.inputTokens).toBe(3);
    expect(claude.events[1]?.contentBlocks.map((block) => block.kind)).toEqual(
      expect.arrayContaining(["text", "image", "file"]),
    );
    expect(JSON.stringify(claude)).not.toContain("iVBORw0KGgo=");

    const opencode = sessionsByProvider.get("opencode")!;
    expect(opencode.toolCalls[0]).toMatchObject({ toolName: "bash", status: "completed" });
    expect(JSON.stringify(opencode)).toContain("@@ real opencode tool patch");
    expect(JSON.stringify(opencode)).toContain("@@ real opencode output patch");
    expect(opencode.usageRecords[0]?.totalTokens).toBe(12);
    expect(JSON.stringify(opencode)).not.toContain("opencode-native-diff-trash");
    expect(JSON.stringify(opencode)).not.toContain("opencode-provider-cache-trash");
    expect(JSON.stringify(opencode)).not.toContain("opencode-provider-state-trash");

    const grok = sessionsByProvider.get("grok")!;
    expect(grok.artifacts[0]).toMatchObject({ kind: "edit_hunk" });
    expect(JSON.stringify(grok)).toContain("nested grok answer");
    expect(JSON.stringify(grok)).not.toContain("grok-provider-update-trash");

    const amp = sessionsByProvider.get("amp")!;
    expect(amp.toolCalls[0]?.toolName).toBe("bash");
    expect(JSON.stringify(amp.toolCalls[0]?.input)).toContain("@@ amp real patch");
    expect(amp.sessionEdges.some((edge) => edge.kind === "parent")).toBe(true);
    expect(amp.usageRecords[0]?.totalTokens).toBe(3);

    const pi = sessionsByProvider.get("pi")!;
    expect(pi.toolCalls[0]?.toolName).toBe("bash");
    expect(pi.sessionEdges.some((edge) => edge.kind === "parent")).toBe(true);
    expect(pi.usageRecords[0]?.totalTokens).toBe(3);

    const kimi = sessionsByProvider.get("kimi")!;
    expect(kimi.sessionEdges.some((edge) => edge.kind === "subagent_of")).toBe(true);
    expect(kimi.artifacts[0]).toMatchObject({ kind: "plan" });

    const droid = sessionsByProvider.get("droid")!;
    expect(droid.toolCalls[0]?.toolName).toBe("bash");
    expect(droid.artifacts[0]?.kind).toBe("diff");

    const hermes = sessionsByProvider.get("hermes")!;
    expect(hermes.toolCalls[0]).toMatchObject({
      toolName: "terminal",
      status: "completed",
      input: { command: "pwd" },
      output: "/Users/a/Projects/quasar",
    });
    expect(JSON.stringify(hermes)).toContain("@@ real hermes parameter patch");
    expect(hermes.sessionEdges.some((edge) => edge.kind === "parent" && edge.fromId === "h0")).toBe(true);
    expect(hermes.sessionEdges.some((edge) => edge.kind === "tool_result_for")).toBe(true);
    expect(hermes.usageRecords.some((usage) => usage.inputTokens === 10 && usage.cost === 0.02)).toBe(true);
    expect(hermes.events[1]?.contentBlocks.map((block) => block.kind)).toEqual(
      expect.arrayContaining(["text", "thinking"]),
    );
    expect(hasOwn(hermes, "rawMetadata")).toBe(false);

    const antigravity = sessionsByProvider.get("antigravity")!;
    expect(antigravity.artifacts[0]).toMatchObject({ kind: "file" });

    const cursor = sessionsByProvider.get("cursor")!;
    expect(cursor.toolCalls[0]?.toolName).toBe("read_file");
    expect(cursor.artifacts[0]?.kind).toBe("diff");
  }, 15_000);

  test("streams converted adapter sessions as bounded batches", async () => {
    const fixtures = await makeAllAdapterFixtures();
    const roots = {
      codex: fixtures.codex,
      claude: fixtures.claude,
      opencode: fixtures.opencode,
      hermes: fixtures.hermes,
    };
    const streamed = [];
    for await (const batch of streamIngestBatches({
      providers: ["codex", "claude", "opencode", "hermes"],
      roots,
      machine,
    })) {
      assertConvexSafeSessionIntelligenceBatch(batch);
      streamed.push(batch);
    }
    const sessionBatches = streamed.filter((batch) => batch.sessions.length > 0);
    const aggregate = await buildIngestBatch({
      providers: ["codex", "claude", "opencode", "hermes"],
      roots,
      machine,
    });

    expect(sessionBatches).toHaveLength(aggregate.sessions.length);
    expect(sessionBatches.every((batch) => batch.sessions.length === 1)).toBe(true);
    expect(
      sessionBatches.every(
        (batch) => batch.sourceRoots.length === 0 && batch.diagnostics.length === 0,
      ),
    ).toBe(true);
    expect(
      streamed.every(
        (batch) =>
          batch.sessions.length > 0 ||
          batch.sourceRoots.length > 0 ||
          batch.diagnostics.length > 0,
      ),
    ).toBe(true);
    expect(sessionBatches.map((batch) => batch.sessions[0]?.provider)).toEqual(
      aggregate.sessions.map((session) => session.provider),
    );
    expect(streamed.flatMap((batch) => batch.sourceRoots).map((root) => root.provider)).toEqual([
      "codex",
      "claude",
      "opencode",
      "hermes",
    ]);
    expect(streamed.flatMap((batch) => batch.diagnostics).map((diagnostic) => diagnostic.provider)).toEqual([
      "codex",
      "claude",
      "opencode",
      "hermes",
    ]);
  }, 15_000);

  test("prefers the larger local OpenCode corpus database and supports the no-path schema", async () => {
    const root = mkdtempSync(join(tmpdir(), "quasar-opencode-db-choice-"));
    writeOpenCodeDb(join(root, "opencode.db"), {
      sessionId: "tiny-db-session",
      title: "Tiny OpenCode DB",
      content: "tiny db content",
    });
    writeOpenCodeLocalSchemaDb(join(root, "opencode-local.db"), [
      {
        sessionId: "local-db-old-session",
        title: "Old Local OpenCode DB",
        content: "old local db content",
        timeUpdated: 2,
      },
      {
        sessionId: "local-db-new-session",
        title: "New Local OpenCode DB",
        content: "new local db content",
        timeUpdated: 3,
      },
    ]);

    const batch = await buildIngestBatch({
      providers: ["opencode"],
      roots: { opencode: root },
      machine,
      limit: 1,
    });

    expect(batch.sessions).toHaveLength(1);
    expect(batch.sessions[0]?.nativeSessionId).toBe("local-db-new-session");
    expect(batch.sessions[0]?.nativeProjectKey).toBe("/Users/a/Projects/quasar");
    expect(batch.sessions[0]?.sourcePath).toContain("opencode-local.db");
    expect(JSON.stringify(batch)).toContain("new local db content");
    expect(JSON.stringify(batch)).not.toContain("tiny db content");
  });

  test("omits huge OpenCode message and part rows before normalized batch materialization", async () => {
    const root = mkdtempSync(join(tmpdir(), "quasar-opencode-huge-"));
    const dbPath = join(root, "opencode-local.db");
    const hugeMessageTrash = "opencode-huge-message-trash".repeat(16_000);
    const hugePartTrash = "opencode-huge-part-trash".repeat(8_000);
    execFileSync("sqlite3", [
      dbPath,
      [
        "create table session (id text, title text, directory text, path text, time_created integer, time_updated integer);",
        "create table message (id text, session_id text, time_created integer, data text);",
        "create table part (id text, session_id text, message_id text, time_created integer, data text);",
        `insert into session values ('huge-session', 'Huge OpenCode DB', '/Users/a/Projects/quasar', '/Users/a/Projects/quasar', 1, 2);`,
        `insert into message values ('m-huge', 'huge-session', 1, ${sql(JSON.stringify({ role: "user", content: hugeMessageTrash }))});`,
        `insert into message values ('m-part', 'huge-session', 2, ${sql(JSON.stringify({ role: "assistant", content: "small message with huge part" }))});`,
        `insert into part values ('p-huge', 'huge-session', 'm-part', 2, ${sql(JSON.stringify({
          type: "text",
          text: hugePartTrash,
          providerUi: "opencode-huge-part-ui-trash",
          summary: { diffs: ["opencode-huge-part-diff-trash"] },
        }))});`,
      ].join("\n"),
    ]);

    const batch = await buildIngestBatch({
      providers: ["opencode"],
      roots: { opencode: root },
      machine,
      limit: 1,
    });
    const encoded = JSON.stringify(batch);

    assertAdapterContract(batch, "opencode");
    expect(encoded).toContain("[omitted:large_opencode_message bytes=");
    expect(encoded).not.toContain("opencode-huge-message-trash");
    expect(encoded).not.toContain("opencode-huge-part-trash");
    expect(encoded).not.toContain("opencode-huge-part-ui-trash");
    expect(encoded).not.toContain("opencode-huge-part-diff-trash");
  });

  test("surfaces an omitted marker for huge OpenCode part rows", async () => {
    const root = mkdtempSync(join(tmpdir(), "quasar-opencode-huge-part-"));
    const hugePartTrash = "opencode-huge-part-trash".repeat(8_000);
    writeOpenCodeDb(join(root, "opencode-local.db"), {
      sessionId: "huge-part-session",
      title: "Huge OpenCode Part DB",
      content: "",
      part: {
        id: "p-huge",
        data: {
          type: "text",
          text: hugePartTrash,
          providerUi: "opencode-huge-part-ui-trash",
          summary: { diffs: ["opencode-huge-part-diff-trash"] },
        },
      },
    });

    const batch = await buildIngestBatch({
      providers: ["opencode"],
      roots: { opencode: root },
      machine,
      limit: 1,
    });
    const encoded = JSON.stringify(batch);

    assertAdapterContract(batch, "opencode");
    expect(encoded).toContain("[omitted:large_opencode_part bytes=");
    expect(encoded).not.toContain("opencode-huge-part-trash");
    expect(encoded).not.toContain("opencode-huge-part-ui-trash");
    expect(encoded).not.toContain("opencode-huge-part-diff-trash");
  });

  test("does not materialize unused Kimi state provider data", async () => {
    const root = makeKimiFixture();
    writeFileSync(
      join(root, "state.json"),
      JSON.stringify({
        workspaceSnapshot: "kimi-state-workspace-trash",
        providerUi: "kimi-state-provider-trash",
        summary: { diffs: ["kimi-state-diff-trash"] },
      }),
    );

    const batch = await buildIngestBatch({
      providers: ["kimi"],
      roots: { kimi: root },
      machine,
    });
    const encoded = JSON.stringify(batch);

    assertAdapterContract(batch, "kimi");
    expect(encoded).not.toContain("kimi-state-workspace-trash");
    expect(encoded).not.toContain("kimi-state-provider-trash");
    expect(encoded).not.toContain("kimi-state-diff-trash");
  });

  test("caps broad Cursor SQLite cells before parsing allowed rows", async () => {
    const root = mkdtempSync(join(tmpdir(), "quasar-cursor-huge-"));
    const storage = join(root, "globalStorage");
    mkdirSync(storage, { recursive: true });
    const hugeCursorTrash = "cursor-huge-cell-trash".repeat(8_000);
    execFileSync("sqlite3", [
      join(storage, "state.vscdb"),
      [
        "create table ItemTable (key text, value text);",
        `insert into ItemTable values ('cursor.composerData', ${sql(JSON.stringify({
          messages: [
            { id: "c1", role: "user", content: "small cursor message", workspacePath: "/Users/a/Projects/quasar" },
          ],
        }))});`,
        `insert into ItemTable values ('cursor.composerHuge', ${sql(JSON.stringify({
          messages: [
            {
              id: "huge",
              role: "assistant",
              content: hugeCursorTrash,
              displayOnly: "cursor-huge-display-trash",
              providerUi: "cursor-huge-provider-trash",
            },
          ],
        }))});`,
      ].join("\n"),
    ]);

    const batch = await buildIngestBatch({
      providers: ["cursor"],
      roots: { cursor: root },
      machine,
    });
    const encoded = JSON.stringify(batch);

    assertAdapterContract(batch, "cursor");
    expect(encoded).toContain("small cursor message");
    expect(encoded).not.toContain("cursor-huge-cell-trash");
    expect(encoded).not.toContain("cursor-huge-display-trash");
    expect(encoded).not.toContain("cursor-huge-provider-trash");
  });

  test("caps broad Hermes message JSON fields before adapter parsing", async () => {
    const root = makeHermesHugeFixture();
    const batch = await buildIngestBatch({
      providers: ["hermes"],
      roots: { hermes: root },
      machine,
    });
    const encoded = JSON.stringify(batch);

    assertAdapterContract(batch, "hermes");
    expect(encoded).toContain("[omitted:large_hermes_content bytes=");
    expect(encoded).toContain("large_hermes_tool_calls");
    expect(encoded).toContain("large_hermes_reasoning_details");
    expect(encoded).not.toContain("hermes-huge-content-trash");
    expect(encoded).not.toContain("hermes-huge-tool-trash");
    expect(encoded).not.toContain("hermes-huge-reasoning-trash");
  });

  test("flushes streamed sessions before later adapter failures", async () => {
    const originalStream = codexAdapter.stream;
    const adapter = codexAdapter as {
      stream?: (options: AdapterDiscoverOptions) => AsyncIterable<AdapterStreamItem>;
    };
    const session: NormalizedSession = {
      id: "codex:session:stream-test",
      nativeSessionId: "stream-test",
      provider: "codex",
      agentName: "codex",
      machineId: machine.machineId,
      projectIdentity: {
        projectIdentityKey: "project:stream-test",
        displayName: "stream-test",
        confidence: "low",
        signals: [],
      },
      sourceRoot: "/tmp/quasar-stream-test",
      sourcePath: "/tmp/quasar-stream-test/session.jsonl",
      events: [],
      toolCalls: [],
      sessionEdges: [],
      usageRecords: [],
      artifacts: [],
    };

    adapter.stream = async function* (options) {
      yield {
        type: "sourceRoot",
        sourceRoot: {
          provider: "codex",
          adapterId: codexAdapter.id,
          rootPath: session.sourceRoot,
          machineId: options.machine.machineId,
          discoveredAt: options.now,
        },
      };
      yield { type: "session", session };
      throw new Error("adapter failure after yielded session");
    };

    try {
      const iterator = streamIngestBatches({
        providers: ["codex"],
        machine,
        generatedAt: "2026-06-09T00:00:00.000Z",
      })[Symbol.asyncIterator]();

      const rootBatch = await iterator.next();
      expect(rootBatch.done).toBe(false);
      expect(rootBatch.value.sourceRoots).toHaveLength(1);

      const sessionBatch = await iterator.next();
      expect(sessionBatch.done).toBe(false);
      expect(sessionBatch.value.sessions.map((item: NormalizedSession) => item.id)).toEqual([session.id]);

      await expect(iterator.next()).rejects.toThrow("adapter failure after yielded session");
    } finally {
      adapter.stream = originalStream;
    }
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

const hasOwn = (value: object, key: string) => Object.prototype.hasOwnProperty.call(value, key);

const assertAdapterContract = (batch: IngestBatch, provider: Provider) => {
  assertConvexSafeSessionIntelligenceBatch(batch);
  const encoded = JSON.stringify(batch);
  expect(encoded, provider).not.toMatch(/data:[^"\\]*base64/i);
  expect(encoded, provider).not.toContain("iVBORw0KGgo=");
  expect(encoded, provider).not.toContain("encrypted_content");
  expect(encoded, provider).not.toContain("ciphertext");
  for (const trash of [
    "opencode-native-diff-trash",
    "opencode-provider-cache-trash",
    "opencode-provider-state-trash",
    "opencode-tool-ui-trash",
    "codex-tool-ui-trash",
    "codex-provider-diff-trash",
    "claude-tool-ui-trash",
    "claude-provider-diff-trash",
    "grok-provider-update-trash",
    "grok-tool-ui-trash",
    "amp-provider-ui-trash",
    "amp-display-trash",
    "amp-provider-diff-trash",
    "pi-tool-ui-trash",
    "kimi-ui-trash",
    "droid-tool-ui-trash",
    "droid-diff-ui-trash",
    "droid-diff-ui-trash",
    "hermes-tool-ui-trash",
    "hermes-parameter-ui-trash",
    "hermes-reasoning-ui-trash",
    "hermes-summary-cache-trash",
    "antigravity-ui-trash",
    "cursor-ui-trash",
    "cursor-tool-ui-trash",
  ]) {
    expect(encoded, provider).not.toContain(trash);
  }
  expect(encoded, provider).not.toContain('"raw":');

  for (const session of batch.sessions) {
    expect(hasOwn(session, "rawMetadata"), `${provider} session ${session.id}`).toBe(false);
    expect(
      jsonByteLength({
        ...session,
        events: undefined,
        toolCalls: undefined,
        sessionEdges: undefined,
        usageRecords: undefined,
        artifacts: undefined,
      }),
      provider,
    ).toBeLessThanOrEqual(CONVEX_SAFE_INGEST_BUDGETS.eventRecordBytes);
    for (const event of session.events) {
      expect(hasOwn(event, "raw"), `${provider} event ${event.id}`).toBe(false);
      expect(jsonByteLength({ ...event, contentBlocks: undefined }), `${provider} event ${event.id}`).toBeLessThanOrEqual(
        CONVEX_SAFE_INGEST_BUDGETS.eventRecordBytes,
      );
      for (const block of event.contentBlocks) {
        expect(block.uri ?? "", `${provider} block ${block.id}`).not.toMatch(/^data:/i);
        expect(jsonByteLength(block), `${provider} block ${block.id}`).toBeLessThanOrEqual(
          CONVEX_SAFE_INGEST_BUDGETS.contentBlockRecordBytes,
        );
      }
    }
    for (const toolCall of session.toolCalls) {
      expect(hasOwn(toolCall, "raw"), `${provider} tool ${toolCall.id}`).toBe(false);
      expect(jsonByteLength(toolCall), `${provider} tool ${toolCall.id}`).toBeLessThanOrEqual(
        CONVEX_SAFE_INGEST_BUDGETS.toolCallRecordBytes,
      );
    }
    for (const usageRecord of session.usageRecords) {
      expect(hasOwn(usageRecord, "raw"), `${provider} usage ${usageRecord.id}`).toBe(false);
      expect(jsonByteLength(usageRecord), `${provider} usage ${usageRecord.id}`).toBeLessThanOrEqual(
        CONVEX_SAFE_INGEST_BUDGETS.usageRecordBytes,
      );
    }
    for (const artifact of session.artifacts) {
      expect(hasOwn(artifact, "raw"), `${provider} artifact ${artifact.id}`).toBe(false);
      expect(jsonByteLength(artifact), `${provider} artifact ${artifact.id}`).toBeLessThanOrEqual(
        CONVEX_SAFE_INGEST_BUDGETS.artifactRecordBytes,
      );
    }
  }
};

const makeAllAdapterFixtures = async (): Promise<Record<(typeof localProviders)[number], string>> => {
  const codex = mkdtempSync(join(tmpdir(), "quasar-all-codex-"));
  const codexSessionDir = join(codex, "sessions", "2026", "06", "04");
  mkdirSync(codexSessionDir, { recursive: true });
  writeJsonl(join(codexSessionDir, "rollout-2026-06-04T00-00-00-test.jsonl"), [
    { type: "session_meta", payload: { cwd: "/Users/a/Projects/quasar" } },
    { type: "response_item", payload: { type: "user_message", content: "hello" } },
    {
      type: "response_item",
      payload: {
        type: "function_call",
        call_id: "c1",
        name: "exec_command",
        arguments: JSON.stringify({
          cmd: "pwd",
          patch: "@@ real codex tool patch",
          providerUi: "codex-tool-ui-trash",
          summary: { diffs: ["codex-provider-diff-trash"] },
        }),
      },
    },
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
            {
              type: "tool_use",
              id: "toolu_1",
              name: "Read",
              input: {
                file_path: "package.json",
                patch: "@@ real claude tool patch",
                providerUi: "claude-tool-ui-trash",
                summary: { diffs: ["claude-provider-diff-trash"] },
              },
            },
          ],
          usage: { input_tokens: 3, output_tokens: 4 },
        },
      },
    {
      uuid: "u3",
      parentUuid: "u2",
      type: "user",
      message: {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "toolu_1",
            content: [{ type: "text", text: "{\"name\":\"quasar\"}" }],
          },
        ],
      },
    },
  ]);

  const opencode = await makeOpenCodeFixture();
  const grok = makeGrokFixture();
  const amp = makeAmpFixture();
  const pi = makePiFixture();
  const kimi = makeKimiFixture();
  const droid = makeDroidFixture();
  const hermes = await makeHermesFixture();
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
    hermes,
    antigravity,
    cursor,
  };
};

const makeOpenCodeFixture = async () => {
  const root = mkdtempSync(join(tmpdir(), "quasar-all-opencode-"));
  const dbPath = join(root, "opencode.db");
  const nativeDiffTrash = "opencode-native-diff-trash".repeat(128);
  execFileSync("sqlite3", [
    dbPath,
    [
      "create table session (id text, title text, directory text, path text, time_created integer, time_updated integer);",
      "create table message (id text, session_id text, time_created integer, data text);",
      "create table part (id text, session_id text, message_id text, time_created integer, data text);",
      `insert into session values ('s1', 'OpenCode test', '/Users/a/Projects/quasar', '/Users/a/Projects/quasar', 1, 2);`,
      `insert into message values ('m1', 's1', 1, ${sql(JSON.stringify({ role: "assistant", tokens: { total: 12, input: 5, output: 7 }, modelID: "gpt-test", providerID: "openai" }))});`,
      `insert into message values ('m2', 's1', 2, ${sql(JSON.stringify({ parentID: "m1", role: "user", content: "thanks", summary: { cache: { state: "opencode-provider-cache-trash" }, state: { view: "opencode-provider-state-trash" }, diffs: [{ file: "node_modules/typescript/lib/typescript.js", after: nativeDiffTrash }] } }))});`,
      `insert into part values ('p1', 's1', 'm1', 1, ${sql(JSON.stringify({ type: "tool", tool: "bash", callID: "call1", state: { status: "completed", input: { command: "pwd", patch: "@@ real opencode tool patch", providerUi: "opencode-tool-ui-trash" }, output: { text: "/repo", patch: "@@ real opencode output patch", providerUi: "opencode-tool-ui-trash" } } }))});`,
    ].join("\n"),
  ]);
  return root;
};

const makeOpenCodeWindowFixture = () => {
  const root = mkdtempSync(join(tmpdir(), "quasar-window-opencode-"));
  const dbPath = join(root, "opencode.db");
  execFileSync("sqlite3", [
    dbPath,
    [
      "create table session (id text, title text, directory text, path text, time_created integer, time_updated integer);",
      "create table message (id text, session_id text, time_created integer, data text);",
      "create table part (id text, session_id text, message_id text, time_created integer, data text);",
      `insert into session values ('s-old', 'old', '/Users/a/Projects/quasar', '/Users/a/Projects/quasar', 1, 10);`,
      `insert into session values ('s-mid', 'mid', '/Users/a/Projects/quasar', '/Users/a/Projects/quasar', 2, 20);`,
      `insert into session values ('s-new', 'new', '/Users/a/Projects/quasar', '/Users/a/Projects/quasar', 3, 30);`,
      `insert into message values ('m-old', 's-old', 1, ${sql(JSON.stringify({ role: "user", content: "old" }))});`,
      `insert into message values ('m-mid', 's-mid', 2, ${sql(JSON.stringify({ role: "user", content: "mid" }))});`,
      `insert into message values ('m-new', 's-new', 3, ${sql(JSON.stringify({ role: "user", content: "new" }))});`,
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
    {
      type: "tool",
      tool: "bash",
      callID: "gcall",
      state: {
        status: "completed",
        input: { command: "pwd" },
        output: { result: "/repo", providerUi: { panel: "grok-tool-ui-trash" } },
      },
    },
    { type: "assistant_delta", params: { content: "nested grok answer" } },
  ]);
  writeJsonl(join(sessionDir, "updates.jsonl"), [
    { method: "session/update", params: { displayOnly: "grok-provider-update-trash" } },
  ]);
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
        {
          id: "a2",
          parentId: "a1",
          role: "assistant",
          type: "tool",
          tool: "bash",
          content: { text: "tool ran", displayOnly: "amp-display-trash" },
          input: { command: "pwd", patch: "@@ amp real patch", summary: { diffs: ["amp-provider-diff-trash"] } },
          output: "/repo",
          providerUi: "amp-provider-ui-trash",
          usage: { input: 1, output: 2 },
        },
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
    { id: "p2", parentId: "p1", type: "bash", command: "pwd", output: { text: "/repo", displayOnly: "pi-tool-ui-trash" }, tokens: { total: 3 } },
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
    { id: "k1", role: "assistant", type: "plan", content: { text: "plan work", providerUi: "kimi-ui-trash" }, parentAgentId: "root-agent" },
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
    { id: "d2", type: "tool", tool: "bash", input: { command: "pwd" }, output: { text: "/repo", providerUi: "droid-tool-ui-trash" } },
    { id: "d3", type: "diff", path: "/Users/a/Projects/quasar/a.ts", content: { type: "diff", patch: "@@ real droid event patch", providerUi: "droid-diff-ui-trash" }, patch: "@@" },
  ]);
  return root;
};

const makeHermesFixture = async () => {
  const root = mkdtempSync(join(tmpdir(), "quasar-all-hermes-"));
  const routingDir = join(root, "sessions");
  mkdirSync(routingDir, { recursive: true });
  writeFileSync(
    join(routingDir, "sessions.json"),
    JSON.stringify({
      "agent:main:telegram:dm:123": {
        session_id: "h1",
        source: "telegram",
        origin: { chat_id: "123" },
      },
    }),
  );
  const dbPath = join(root, "state.db");
  execFileSync("sqlite3", [
    dbPath,
    [
      [
        "create table sessions (",
        "id text primary key,",
        "source text not null,",
        "user_id text,",
        "model text,",
        "model_config text,",
        "system_prompt text,",
        "parent_session_id text,",
        "started_at real not null,",
        "ended_at real,",
        "end_reason text,",
        "message_count integer default 0,",
        "tool_call_count integer default 0,",
        "input_tokens integer default 0,",
        "output_tokens integer default 0,",
        "cache_read_tokens integer default 0,",
        "cache_write_tokens integer default 0,",
        "reasoning_tokens integer default 0,",
        "cwd text,",
        "billing_provider text,",
        "billing_base_url text,",
        "billing_mode text,",
        "estimated_cost_usd real,",
        "actual_cost_usd real,",
        "cost_status text,",
        "cost_source text,",
        "pricing_version text,",
        "title text,",
        "api_call_count integer default 0",
        ");",
      ].join(" "),
      [
        "create table messages (",
        "id integer primary key autoincrement,",
        "session_id text not null references sessions(id),",
        "role text not null,",
        "content text,",
        "tool_call_id text,",
        "tool_calls text,",
        "tool_name text,",
        "timestamp real not null,",
        "token_count integer,",
        "finish_reason text,",
        "reasoning text,",
        "reasoning_content text,",
        "reasoning_details text,",
        "codex_reasoning_items text,",
        "codex_message_items text,",
        "platform_message_id text,",
        "observed integer default 0,",
        "active integer not null default 1",
        ");",
      ].join(" "),
      `insert into sessions (id, source, user_id, model, model_config, system_prompt, started_at, title) values ('h0', 'cli', 'u1', 'openai/gpt-test', '{}', 'system', 1760000000, 'Hermes parent');`,
      [
        "insert into sessions (id, source, user_id, model, model_config, system_prompt, parent_session_id, started_at, ended_at, end_reason, message_count, tool_call_count, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, reasoning_tokens, cwd, billing_provider, estimated_cost_usd, actual_cost_usd, title, api_call_count) values",
        `('h1', 'cli', 'u1', 'openai/gpt-test', ${sql(JSON.stringify({ temperature: 0.2 }))}, 'system prompt', 'h0', 1760000100, 1760000110, 'user_exit', 3, 1, 10, 20, 3, 4, 5, '/Users/a/Projects/quasar', 'openai', 0.01, 0.02, 'Hermes test', 1);`,
      ].join(" "),
      `insert into messages (session_id, role, content, timestamp, token_count) values ('h1', 'user', 'run pwd', 1760000101, 2);`,
      [
        "insert into messages (session_id, role, content, tool_calls, timestamp, token_count, finish_reason, reasoning_content, reasoning_details) values",
        `('h1', 'assistant', 'I will run terminal.', ${sql(JSON.stringify([
          { id: "call_1", function: { name: "terminal", arguments: JSON.stringify({ command: "pwd" }) }, providerUi: "hermes-tool-ui-trash" },
          { id: "call_2", function: { name: "apply_patch", parameters: { patch: "@@ real hermes parameter patch", providerUi: "hermes-parameter-ui-trash" } } },
        ]))}, 1760000102, 3, 'tool_calls', 'Need the working directory.', ${sql(JSON.stringify({ effort: "low", displayOnly: "hermes-reasoning-ui-trash", summary: { cache: { state: "hermes-summary-cache-trash" } } }))});`,
      ].join(" "),
      `insert into messages (session_id, role, content, tool_call_id, tool_name, timestamp, token_count) values ('h1', 'tool', '/Users/a/Projects/quasar', 'call_1', 'terminal', 1760000103, 1);`,
    ].join("\n"),
  ]);
  return root;
};

const makeHermesHugeFixture = () => {
  const root = mkdtempSync(join(tmpdir(), "quasar-hermes-huge-"));
  const dbPath = join(root, "state.db");
  const hugeContentTrash = "hermes-huge-content-trash".repeat(8_000);
  const hugeToolTrash = "hermes-huge-tool-trash".repeat(8_000);
  const hugeReasoningTrash = "hermes-huge-reasoning-trash".repeat(8_000);
  execFileSync("sqlite3", [
    dbPath,
    [
      [
        "create table sessions (",
        "id text primary key,",
        "model text,",
        "parent_session_id text,",
        "started_at real not null,",
        "ended_at real,",
        "input_tokens integer default 0,",
        "output_tokens integer default 0,",
        "cache_read_tokens integer default 0,",
        "cache_write_tokens integer default 0,",
        "reasoning_tokens integer default 0,",
        "billing_provider text,",
        "estimated_cost_usd real,",
        "actual_cost_usd real,",
        "title text,",
        "cwd text",
        ");",
      ].join(" "),
      [
        "create table messages (",
        "id integer primary key autoincrement,",
        "session_id text not null references sessions(id),",
        "role text not null,",
        "content text,",
        "tool_call_id text,",
        "tool_calls text,",
        "tool_name text,",
        "timestamp real not null,",
        "token_count integer,",
        "finish_reason text,",
        "reasoning text,",
        "reasoning_content text,",
        "reasoning_details text,",
        "codex_reasoning_items text,",
        "codex_message_items text,",
        "platform_message_id text",
        ");",
      ].join(" "),
      `insert into sessions (id, model, started_at, title, cwd) values ('h-huge', 'openai/gpt-test', 1760000200, 'Hermes huge test', '/Users/a/Projects/quasar');`,
      [
        "insert into messages (session_id, role, content, tool_calls, timestamp, token_count, reasoning_details) values",
        `('h-huge', 'assistant', ${sql(hugeContentTrash)}, ${sql(JSON.stringify([
          { id: "call_huge", function: { name: "terminal", arguments: JSON.stringify({ command: hugeToolTrash }) } },
        ]))}, 1760000201, 1, ${sql(JSON.stringify({ text: hugeReasoningTrash }))});`,
      ].join(" "),
    ].join("\n"),
  ]);
  return root;
};

const makeAntigravityFixture = () => {
  const root = mkdtempSync(join(tmpdir(), "quasar-all-antigravity-"));
  const sessionDir = join(root, "s1");
  const artifacts = join(sessionDir, "artifacts");
  mkdirSync(artifacts, { recursive: true });
  writeJsonl(join(sessionDir, "transcript.jsonl"), [
    { id: "ag1", role: "user", content: { text: "hello", uiState: "antigravity-ui-trash" }, cwd: "/Users/a/Projects/quasar" },
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
        { id: "c1", role: "user", content: { text: "open file", displayOnly: "cursor-ui-trash" }, workspacePath: "/Users/a/Projects/quasar" },
        { id: "c2", role: "assistant", type: "tool", toolName: "read_file", input: { path: "a.ts" }, output: { text: "ok", providerUi: "cursor-tool-ui-trash" } },
        { id: "c3", role: "assistant", type: "diff", path: "/Users/a/Projects/quasar/a.ts", diff: "@@", tokens: { total: 6 } },
      ],
    }))});`,
    ].join("\n"),
  ]);
  return root;
};
