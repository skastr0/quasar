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
    mutableEvent.contentText = "Bearer should-not-leak AIzaSySecretSecretSecretSecretSecret";
    mutableEvent.content = "Bearer should-not-leak AIzaSySecretSecretSecretSecretSecret";

    await t.mutation(internal.quasar.ingestBatchInternal, { batch });

    const session = await t.query(internal.quasar.readSessionInternal, {
      sessionId: "codex:machine:a:session",
    });
    const event = session?.events[0];
    expect(event?.contentText).toContain("Bearer [redacted]");
    expect(JSON.stringify(event)).not.toContain("should-not-leak");
    expect(JSON.stringify(event)).not.toContain("AIzaSySecret");

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
