/// <reference types="vite/client" />

import { convexTest } from "convex-test";
import ragSchema from "../node_modules/@convex-dev/rag/dist/component/schema.js";
import workpoolSchema from "../node_modules/@convex-dev/workpool/dist/component/schema.js";
import { describe, expect, test } from "vitest";

import schema from "./schema";
import { internal } from "./_generated/api";

const modules = import.meta.glob("./**/*.ts");
const ragModules = import.meta.glob(
  "../node_modules/@convex-dev/rag/dist/component/**/*.js",
);
const workpoolModules = import.meta.glob(
  "../node_modules/@convex-dev/workpool/dist/component/**/*.js",
);

const testBatch = (path: string, machineId: string) => ({
  protocolVersion: "quasar.ingest/v1",
  machine: { machineId, hostname: machineId, platform: "test" },
  sourceRoots: [
    {
      provider: "codex",
      adapterId: "codex-local-jsonl",
      rootPath: `${path}/.codex/sessions`,
      machineId,
      discoveredAt: "2026-06-03T00:00:00.000Z",
    },
  ],
  sessions: [
    {
      id: `codex:${machineId}:session`,
      nativeSessionId: "rollout-test",
      provider: "codex",
      agentName: "codex",
      machineId,
      projectIdentity: {
        projectIdentityKey: "git:github.com/skastr0/quasar",
        displayName: "quasar",
        confidence: "high",
        rawPath: path,
        normalizedPath: path,
        gitRemote: "git@github.com:skastr0/quasar.git",
        gitRemoteNormalized: "github.com/skastr0/quasar",
        signals: [{ kind: "git_remote", value: "github.com/skastr0/quasar", confidence: "high" }],
      },
      nativeProjectKey: path,
      sourceRoot: `${path}/.codex/sessions`,
      sourcePath: `${path}/.codex/sessions/rollout-test.jsonl`,
      events: [
        {
          id: `event:${machineId}:1`,
          sessionId: `codex:${machineId}:session`,
          sequence: 0,
          timestamp: "2026-06-03T00:00:00.000Z",
          machineId,
          provider: "codex",
          agentName: "codex",
          projectIdentityKey: "git:github.com/skastr0/quasar",
          role: "user",
          kind: "message",
          contentText: "Build a session repository with RAG search",
          rawReference: { sourcePath: `${path}/rollout.jsonl`, line: 1 },
        },
      ],
      toolCalls: [],
    },
  ],
  diagnostics: [],
  generatedAt: "2026-06-03T00:00:00.000Z",
});

const pathFallbackBatch = (path: string, machineId: string) => ({
  ...testBatch(path, machineId),
  sessions: [
    {
      ...testBatch(path, machineId).sessions[0],
      id: `codex:${machineId}:path-session`,
      projectIdentity: {
        projectIdentityKey: `path:${machineId}:${path}`,
        displayName: path.split("/").at(-1) ?? path,
        confidence: "low",
        rawPath: path,
        normalizedPath: path,
        signals: [{ kind: "path", value: path, confidence: "low" }],
      },
      events: [
        {
          ...testBatch(path, machineId).sessions[0].events[0],
          id: `event:${machineId}:path`,
          sessionId: `codex:${machineId}:path-session`,
          projectIdentityKey: `path:${machineId}:${path}`,
        },
      ],
    },
  ],
});

const emptySessionBatch = (path: string, machineId: string) => ({
  ...testBatch(path, machineId),
  sessions: [
    {
      ...testBatch(path, machineId).sessions[0],
      events: [],
      toolCalls: [],
    },
  ],
});

const toolPairBatch = (path: string, machineId: string) => ({
  ...testBatch(path, machineId),
  sessions: [
    {
      ...testBatch(path, machineId).sessions[0],
      events: [
        {
          ...testBatch(path, machineId).sessions[0].events[0],
          id: `event:${machineId}:tool-call`,
          sequence: 0,
          role: "assistant",
          kind: "tool_call",
          contentText: "Read file",
          content: { name: "read_file", path: "src/index.ts" },
        },
        {
          ...testBatch(path, machineId).sessions[0].events[0],
          id: `event:${machineId}:tool-result`,
          sequence: 1,
          role: "tool",
          kind: "tool_result",
          contentText: "Read file result",
          content: { name: "read_file", output: "done" },
        },
      ],
      toolCalls: [],
    },
  ],
});

const graphBatch = (path: string, machineId: string) => ({
  ...testBatch(path, machineId),
  sessions: [
    {
      ...testBatch(path, machineId).sessions[0],
      events: [
        {
          ...testBatch(path, machineId).sessions[0].events[0],
          id: `event:${machineId}:graph-1`,
          sequence: 0,
          contentText: "Graph block text",
          contentBlocks: [
            {
              id: `block:${machineId}:1`,
              sequence: 0,
              kind: "markdown",
              markdown: "Graph block text for semantic indexing",
            },
          ],
        },
        {
          ...testBatch(path, machineId).sessions[0].events[0],
          id: `event:${machineId}:graph-2`,
          sequence: 1,
          role: "assistant",
          kind: "tool_call",
          toolCallId: `tool:${machineId}:graph`,
          contentText: "Run graph tool",
          content: { name: "exec_command", cmd: "pwd" },
          contentBlocks: [
            {
              id: `block:${machineId}:2`,
              sequence: 0,
              kind: "json",
              value: { cmd: "pwd", note: "graph json block" },
            },
          ],
        },
      ],
      toolCalls: [
        {
          id: `tool:${machineId}:graph`,
          eventId: `event:${machineId}:graph-2`,
          toolName: "exec_command",
          status: "completed",
          input: { cmd: "pwd" },
          output: "/repo",
        },
      ],
      sessionEdges: [
        {
          id: `edge:${machineId}:parent`,
          kind: "parent",
          fromEventId: `event:${machineId}:graph-1`,
          toEventId: `event:${machineId}:graph-2`,
        },
      ],
      usageRecords: [
        {
          id: `usage:${machineId}:1`,
          eventId: `event:${machineId}:graph-2`,
          model: "gpt-test",
          modelProvider: "openai",
          inputTokens: 7,
          outputTokens: 11,
          totalTokens: 18,
        },
      ],
      artifacts: [
        {
          id: `artifact:${machineId}:1`,
          eventId: `event:${machineId}:graph-2`,
          kind: "diff",
          path: `${path}/src/index.ts`,
          contentHash: "hash:artifact",
          metadata: { label: "artifact diff searchable" },
        },
      ],
    },
  ],
});

const setup = () => {
  const t = convexTest(schema, modules);
  t.registerComponent("rag", ragSchema, ragModules);
  t.registerComponent("workpool", workpoolSchema, workpoolModules);
  return t;
};

describe("quasar ingestion and search", () => {
  test("reports semantic search as unavailable when embeddings are unconfigured", async () => {
    const keys = ["GOOGLE_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY", "GEMINI_API_KEY"] as const;
    const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
    for (const key of keys) delete process.env[key];
    try {
      const t = setup();
      const result = await t.action(internal.quasar.semanticSearchInternal, {
        query: "RAG search",
        limit: 10,
      });
      expect(result.diagnostics.semanticStatus).toBe("embedding_provider_unconfigured");
      expect(result.matches).toHaveLength(0);
    } finally {
      for (const key of keys) {
        const value = previous[key];
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  test("ingests two path variants under one git project identity", async () => {
    const t = setup();
    await t.mutation(internal.quasar.ingestBatchInternal, {
      batch: testBatch("/Users/a/Projects/quasar", "machine:a"),
    });
    await t.mutation(internal.quasar.ingestBatchInternal, {
      batch: testBatch("/home/b/work/quasar", "machine:b"),
    });

    const projects = await t.query(internal.quasar.listProjectsInternal, {});
    const project = (projects as Array<{ projectIdentityKey: string; sessionCount: number }>).find(
      (item) => item.projectIdentityKey === "git:github.com/skastr0/quasar",
    );
    expect(project?.sessionCount).toBe(2);

    const search = await t.query(internal.quasar.textSearchInternal, {
      query: "RAG search",
      projectIdentityKey: "git:github.com/skastr0/quasar",
      limit: 10,
    });
    expect(search.matches.length).toBeGreaterThan(0);

    const dateScopedSearch = await t.query(internal.quasar.textSearchInternal, {
      query: "RAG search",
      projectIdentityKey: "git:github.com/skastr0/quasar",
      from: "2026-06-04T00:00:00.000Z",
      limit: 10,
    });
    expect(dateScopedSearch.matches).toHaveLength(0);

    await expect(
      t.query(internal.quasar.textSearchInternal, {
        query: "RAG search",
        from: "not-a-date",
      }),
    ).rejects.toThrow(/from must be a valid/);
  });

  test("re-ingest removes stale session events and search documents", async () => {
    const t = setup();
    await t.mutation(internal.quasar.ingestBatchInternal, {
      batch: testBatch("/Users/a/Projects/quasar", "machine:a"),
    });
    await t.mutation(internal.quasar.ingestBatchInternal, {
      batch: emptySessionBatch("/Users/a/Projects/quasar", "machine:a"),
    });

    const session = await t.query(internal.quasar.readSessionInternal, {
      sessionId: "codex:machine:a:session",
    });
    expect(session?.events).toHaveLength(0);

    const search = await t.query(internal.quasar.textSearchInternal, {
      query: "RAG search",
      limit: 10,
    });
    expect(search.matches).toHaveLength(0);
  });

  test("redacts string contentText before session storage and search indexing", async () => {
    const t = setup();
    const batch = testBatch("/Users/a/Projects/quasar", "machine:a");
    const mutableEvent = batch.sessions[0]!.events[0]! as Record<string, unknown>;
    const googleKeyFixture = `AIza${"S".repeat(24)}`;
    const githubTokenFixture = `ghp_${"1234567890abcdef".repeat(2)}1234`;
    const passwordFixture = ["pass", "w0rd"].join("");
    const databaseUrlFixture = `DATABASE_URL=postgres://user:${passwordFixture}@example.com/db`;
    const secretText = [
      "Bearer should-not-leak",
      googleKeyFixture,
      githubTokenFixture,
      databaseUrlFixture,
    ].join(" ");
    mutableEvent.contentText = secretText;
    mutableEvent.content = secretText;

    await t.mutation(internal.quasar.ingestBatchInternal, { batch });

    const session = await t.query(internal.quasar.readSessionInternal, {
      sessionId: "codex:machine:a:session",
    });
    const event = session?.events[0];
    expect(event?.contentText).toContain("Bearer [redacted]");
    expect(JSON.stringify(event)).not.toContain("should-not-leak");
    expect(JSON.stringify(event)).not.toContain("AIza");
    expect(JSON.stringify(event)).not.toContain("ghp_");
    expect(JSON.stringify(event)).not.toContain(passwordFixture);

    const search = await t.query(internal.quasar.textSearchInternal, {
      query: "should-not-leak",
      limit: 10,
    });
    expect(JSON.stringify(search.matches)).not.toContain("should-not-leak");
    expect(search.matches).toHaveLength(0);
  });

  test("links tool call and result events into one tool-call row", async () => {
    const t = setup();
    await t.mutation(internal.quasar.ingestBatchInternal, {
      batch: toolPairBatch("/Users/a/Projects/quasar", "machine:a"),
    });

    const tools = await t.query(internal.quasar.listToolCallsInternal, {
      sessionId: "codex:machine:a:session",
      limit: 10,
    });
    expect(tools).toHaveLength(1);
    expect(tools[0]?.toolName).toBe("read_file");
    expect(tools[0]?.status).toBe("completed");
    expect(tools[0]?.input).toEqual({ name: "read_file", path: "src/index.ts" });
    expect(tools[0]?.output).toEqual({ name: "read_file", output: "done" });

    const filtered = await t.query(internal.quasar.listToolCallsInternal, {
      provider: "codex",
      toolName: "read_file",
      limit: 10,
    });
    expect(filtered).toHaveLength(1);

    const missing = await t.query(internal.quasar.listToolCallsInternal, {
      provider: "opencode",
      toolName: "read_file",
      limit: 10,
    });
    expect(missing).toHaveLength(0);
  });

  test("ingests graph rows and returns materialized session views", async () => {
    const t = setup();
    await t.mutation(internal.quasar.ingestBatchInternal, {
      batch: graphBatch("/Users/a/Projects/quasar", "machine:a"),
    });

    const session = await t.query(internal.quasar.readSessionInternal, {
      sessionId: "codex:machine:a:session",
      view: "tool-expanded",
    });
    expect(session?.contentBlocks).toHaveLength(2);
    expect(session?.sessionEdges.some((edge) => edge.kind === "parent")).toBe(true);
    expect(session?.usageRecords[0]?.totalTokens).toBe(18);
    expect(session?.artifacts[0]?.kind).toBe("diff");
    expect(session?.views.chronological[0]?.contentBlocks).toHaveLength(1);
    expect(session?.views.branch.map((event) => event.eventId)).toEqual([
      "event:machine:a:graph-1",
      "event:machine:a:graph-2",
    ]);
    expect(session?.views.toolExpanded[1]?.toolCall?.toolName).toBe("exec_command");

    const blockSearch = await t.query(internal.quasar.textSearchInternal, {
      query: "semantic indexing",
      limit: 10,
    });
    expect(blockSearch.matches.some((match) => match.family === "contentBlocks")).toBe(true);

    const artifactSearch = await t.query(internal.quasar.textSearchInternal, {
      query: "artifact diff searchable",
      limit: 10,
    });
    expect(artifactSearch.matches.some((match) => match.family === "artifacts")).toBe(true);
  });

  test("fusion search returns text graph matches when semantic search is unavailable", async () => {
    const keys = ["GOOGLE_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY", "GEMINI_API_KEY"] as const;
    const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
    for (const key of keys) delete process.env[key];
    try {
      const t = setup();
      await t.mutation(internal.quasar.ingestBatchInternal, {
        batch: graphBatch("/Users/a/Projects/quasar", "machine:a"),
      });

      const result = await t.action(internal.quasar.fusionSearchInternal, {
        query: "semantic indexing",
        limit: 10,
      });

      expect(result.mode).toBe("fusion");
      expect(result.diagnostics.semanticStatus).toBe("embedding_provider_unconfigured");
      expect(result.matches.some((match) => match.family === "contentBlocks")).toBe(true);
    } finally {
      for (const key of keys) {
        const value = previous[key];
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  test("re-ingest removes stale graph rows and graph search documents", async () => {
    const t = setup();
    await t.mutation(internal.quasar.ingestBatchInternal, {
      batch: graphBatch("/Users/a/Projects/quasar", "machine:a"),
    });
    await t.mutation(internal.quasar.ingestBatchInternal, {
      batch: testBatch("/Users/a/Projects/quasar", "machine:a"),
    });

    const session = await t.query(internal.quasar.readSessionInternal, {
      sessionId: "codex:machine:a:session",
    });
    expect(session?.contentBlocks).toHaveLength(0);
    expect(session?.sessionEdges).toHaveLength(0);
    expect(session?.usageRecords).toHaveLength(0);
    expect(session?.artifacts).toHaveLength(0);

    const search = await t.query(internal.quasar.textSearchInternal, {
      query: "semantic indexing",
      limit: 10,
    });
    expect(search.matches).toHaveLength(0);
  });

  test("keeps low-confidence path identities separate until manually aliased", async () => {
    const t = setup();
    await t.mutation(internal.quasar.ingestBatchInternal, {
      batch: pathFallbackBatch("/Users/a/Projects/quasar", "machine:a"),
    });
    await t.mutation(internal.quasar.ingestBatchInternal, {
      batch: pathFallbackBatch("/home/b/work/quasar", "machine:b"),
    });

    const before = await t.query(internal.quasar.listProjectsInternal, {});
    expect(before).toHaveLength(2);

    await t.mutation(internal.quasar.aliasProjectInternal, {
      sourceProjectIdentityKey: "path:machine:b:/home/b/work/quasar",
      targetProjectIdentityKey: "path:machine:a:/Users/a/Projects/quasar",
      reason: "same repository on different machines",
    });

    const after = await t.query(internal.quasar.listProjectsInternal, {});
    const canonical = after.find(
      (item: { projectIdentityKey: string; sessionCount: number }) =>
        item.projectIdentityKey === "path:machine:a:/Users/a/Projects/quasar",
    );
    expect(canonical?.sessionCount).toBe(2);

    const search = await t.query(internal.quasar.textSearchInternal, {
      query: "RAG search",
      projectIdentityKey: "path:machine:a:/Users/a/Projects/quasar",
      limit: 10,
    });
    expect(search.matches.length).toBeGreaterThan(0);
  });
});
