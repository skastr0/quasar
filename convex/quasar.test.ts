/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import workpoolTest from "@convex-dev/workpool/test";
import { expect, test } from "vitest";
import { api } from "./_generated/api";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");

process.env.GOOGLE_API_KEY = "";
process.env.GOOGLE_GENERATIVE_AI_API_KEY = "";

const testConvex = () => {
  const t = convexTest(schema, modules);
  workpoolTest.register(t, "embeddingWorkpool");
  return t;
};

const sessionArgs = {
  sessionId: "claude:machine-a:abc123",
  projectKey: "path:machine-a:proj1",
  provider: "claude",
  agentName: "claude-code",
  title: "test session",
  sourcePath: "/tmp/session.jsonl",
  sourceFingerprint: JSON.stringify({ size: 1024, mtimeMs: 1781151515498 }),
  messageCount: 2,
  toolCallCount: 1,
};

type Tester = ReturnType<typeof convexTest>;

/** Claims a session for a run so turn mutations can write under that claim. */
const claimSession = async (
  t: Tester,
  sessionId: string,
  projectKey: string,
  runId: string,
) =>
  t.mutation(api.quasar.beginSessionIngest, {
    ...sessionArgs,
    sessionId,
    projectKey,
    sourceFingerprint: `fp:${sessionId}`,
    runId,
  });

test("beginSessionIngest skips only committed sessions with an unchanged fingerprint", async () => {
  const t = testConvex();

  const first = await t.mutation(api.quasar.beginSessionIngest, {
    ...sessionArgs,
    runId: "run-1",
  });
  expect(first).toEqual({ skipped: false });

  // Same fingerprint but uncommitted (a crashed run): never skipped.
  const afterCrash = await t.mutation(api.quasar.beginSessionIngest, {
    ...sessionArgs,
    runId: "run-2",
  });
  expect(afterCrash).toEqual({ skipped: false });

  await t.mutation(api.quasar.commitSessionIngest, {
    sessionId: sessionArgs.sessionId,
    runId: "run-2",
  });

  // Committed and unchanged: skipped.
  const unchanged = await t.mutation(api.quasar.beginSessionIngest, {
    ...sessionArgs,
    runId: "run-3",
  });
  expect(unchanged).toEqual({ skipped: true });

  // Committed but changed fingerprint: re-ingested.
  const changed = await t.mutation(api.quasar.beginSessionIngest, {
    ...sessionArgs,
    sourceFingerprint: JSON.stringify({ size: 2048, mtimeMs: 1781151599999 }),
    messageCount: 4,
    runId: "run-4",
  });
  expect(changed).toEqual({ skipped: false });

  const page = await t.query(api.quasar.listSessions, {
    projectKey: sessionArgs.projectKey,
    paginationOpts: { numItems: 10, cursor: null },
  });
  expect(page.page).toHaveLength(1);
  expect(page.page[0].messageCount).toBe(4);
});

test("turn mutations reject a lost claim so concurrent runs cannot duplicate turns", async () => {
  const t = testConvex();
  const sessionId = "s-claim";

  await claimSession(t, sessionId, "p1", "run-a");
  await t.mutation(api.quasar.insertMessages, {
    messages: [
      { sessionId, seq: 0, role: "user" as const, text: "from run a", projectKey: "p1" },
    ],
    runId: "run-a",
  });

  // A second run re-claims the session; the first run's mutations now fail.
  await claimSession(t, sessionId, "p1", "run-b");
  await expect(
    t.mutation(api.quasar.insertMessages, {
      messages: [
        { sessionId, seq: 1, role: "user" as const, text: "stale run", projectKey: "p1" },
      ],
      runId: "run-a",
    }),
  ).rejects.toThrow(/Ingest claim lost/);
  await expect(
    t.mutation(api.quasar.deleteSessionTurns, { sessionId, runId: "run-a" }),
  ).rejects.toThrow(/Ingest claim lost/);
  await expect(
    t.mutation(api.quasar.commitSessionIngest, { sessionId, runId: "run-a" }),
  ).rejects.toThrow(/Ingest claim lost/);

  // The winning run proceeds normally.
  await t.mutation(api.quasar.deleteSessionTurns, { sessionId, runId: "run-b" });
  await t.mutation(api.quasar.insertMessages, {
    messages: [
      { sessionId, seq: 0, role: "user" as const, text: "from run b", projectKey: "p1" },
    ],
    runId: "run-b",
  });
  await t.mutation(api.quasar.commitSessionIngest, { sessionId, runId: "run-b" });

  const page = await t.query(api.quasar.readSession, {
    sessionId,
    paginationOpts: { numItems: 10, cursor: null },
  });
  expect(page.page.map((m) => m.text)).toEqual(["from run b"]);
});

test("insertMessages + readSession paginates in seq ascending order", async () => {
  const t = testConvex();
  const sessionId = "s-read";
  await claimSession(t, sessionId, "p1", "run-1");
  // Insert deliberately out of order; the index walk must return seq ascending.
  await t.mutation(api.quasar.insertMessages, {
    messages: [4, 1, 3, 0, 2].map((seq) => ({
      sessionId,
      seq,
      role: seq % 2 === 0 ? ("user" as const) : ("assistant" as const),
      text: `message ${seq}`,
      projectKey: "p1",
    })),
    runId: "run-1",
  });

  const page1 = await t.query(api.quasar.readSession, {
    sessionId,
    paginationOpts: { numItems: 3, cursor: null },
  });
  expect(page1.page.map((m) => m.seq)).toEqual([0, 1, 2]);
  expect(page1.isDone).toBe(false);

  const page2 = await t.query(api.quasar.readSession, {
    sessionId,
    paginationOpts: { numItems: 3, cursor: page1.continueCursor },
  });
  expect(page2.page.map((m) => m.seq)).toEqual([3, 4]);
  expect(page2.isDone).toBe(true);
});

test("searchMessages finds inserted text and respects projectKey filter", async () => {
  const t = testConvex();
  await claimSession(t, "s-search-1", "proj-alpha", "run-1");
  await claimSession(t, "s-search-2", "proj-beta", "run-1");
  await claimSession(t, "s-search-3", "proj-alpha", "run-1");
  await t.mutation(api.quasar.insertMessages, {
    messages: [
      {
        sessionId: "s-search-1",
        seq: 0,
        role: "user" as const,
        text: "how do we configure the tailscale serving layer",
        projectKey: "proj-alpha",
      },
      {
        sessionId: "s-search-2",
        seq: 0,
        role: "assistant" as const,
        text: "tailscale exposure is pinned in the platform directory",
        projectKey: "proj-beta",
      },
      {
        sessionId: "s-search-3",
        seq: 0,
        role: "user" as const,
        text: "unrelated message about embeddings",
        projectKey: "proj-alpha",
      },
    ],
    runId: "run-1",
  });

  const all = await t.query(api.quasar.searchMessages, { query: "tailscale" });
  expect(all.map((r) => r.sessionId).sort()).toEqual(["s-search-1", "s-search-2"]);
  expect(all[0]).toHaveProperty("text");
  expect(all[0]).toHaveProperty("seq");
  expect(all[0]).toHaveProperty("role");

  const alphaOnly = await t.query(api.quasar.searchMessages, {
    query: "tailscale",
    projectKey: "proj-alpha",
  });
  expect(alphaOnly.map((r) => r.sessionId)).toEqual(["s-search-1"]);
});

test("toolCallsByName walks the (projectKey, toolName) index", async () => {
  const t = testConvex();
  await claimSession(t, "s-tools", "proj-alpha", "run-1");
  await claimSession(t, "s-other", "proj-beta", "run-1");
  await t.mutation(api.quasar.insertToolCalls, {
    toolCalls: [
      {
        sessionId: "s-tools",
        seq: 1,
        toolName: "Bash",
        inputText: JSON.stringify({ command: "ls" }),
        outputText: "file.txt",
        projectKey: "proj-alpha",
        provider: "claude",
      },
      {
        sessionId: "s-tools",
        seq: 2,
        toolName: "Bash",
        inputText: JSON.stringify({ command: "cat package.json" }),
        outputText: "{}",
        projectKey: "proj-alpha",
        provider: "codex",
      },
      {
        sessionId: "s-tools",
        seq: 3,
        toolName: "Read",
        inputText: JSON.stringify({ file_path: "/tmp/x" }),
        outputText: "contents",
        projectKey: "proj-alpha",
        provider: "claude",
      },
      {
        sessionId: "s-other",
        seq: 1,
        toolName: "Bash",
        inputText: JSON.stringify({ command: "pwd" }),
        outputText: "/tmp",
        projectKey: "proj-beta",
        provider: "codex",
      },
    ],
    runId: "run-1",
  });

  const page = await t.query(api.quasar.toolCallsByName, {
    projectKey: "proj-alpha",
    toolName: "Bash",
    paginationOpts: { numItems: 10, cursor: null },
  });
  expect(page.page).toHaveLength(2);
  expect(page.page[0].sessionId).toBe("s-tools");
  expect(page.page[0].toolName).toBe("Bash");
  expect(page.page.map((row) => row.provider).sort()).toEqual(["claude", "codex"]);
  expect(page.isDone).toBe(true);

  const codexPage = await t.query(api.quasar.toolCallsByName, {
    projectKey: "proj-alpha",
    provider: "codex",
    paginationOpts: { numItems: 10, cursor: null },
  });
  expect(codexPage.page).toHaveLength(1);
  expect(codexPage.page[0].provider).toBe("codex");
  expect(codexPage.page[0].toolName).toBe("Bash");

  const codexBashPage = await t.query(api.quasar.toolCallsByName, {
    projectKey: "proj-alpha",
    provider: "codex",
    toolName: "Bash",
    paginationOpts: { numItems: 10, cursor: null },
  });
  expect(codexBashPage.page).toHaveLength(1);
  expect(codexBashPage.page[0].provider).toBe("codex");
});

test("deleteSessionTurns drains messages and toolCalls under caller-driven batches", async () => {
  const t = testConvex();
  const sessionId = "s-delete";
  await claimSession(t, sessionId, "p1", "run-1");
  await claimSession(t, "s-keep", "p1", "run-1");
  // 450 messages + 30 toolCalls: forces multiple 200-row batches plus
  // a mixed messages/toolCalls batch and a caller-driven continuation.
  for (let start = 0; start < 450; start += 150) {
    await t.mutation(api.quasar.insertMessages, {
      messages: Array.from({ length: 150 }, (_, i) => ({
        sessionId,
        seq: start + i,
        role: "user" as const,
        text: `m${start + i}`,
        projectKey: "p1",
      })),
      runId: "run-1",
    });
  }
  await t.mutation(api.quasar.insertToolCalls, {
    toolCalls: Array.from({ length: 30 }, (_, i) => ({
      sessionId,
      seq: i,
      toolName: "Bash",
      inputText: "{}",
      outputText: "ok",
      projectKey: "p1",
      provider: "claude",
    })),
    runId: "run-1",
  });
  // An adjacent session must survive the cleanup untouched.
  await t.mutation(api.quasar.insertMessages, {
    messages: [
      {
        sessionId: "s-keep",
        seq: 0,
        role: "user" as const,
        text: "keep me",
        projectKey: "p1",
      },
    ],
    runId: "run-1",
  });

  // The caller loops while a full batch was deleted — exactly what ingest does.
  let totalDeleted = 0;
  let calls = 0;
  let result: { deleted: number; batchSize: number };
  do {
    result = await t.mutation(api.quasar.deleteSessionTurns, {
      sessionId,
      runId: "run-1",
    });
    totalDeleted += result.deleted;
    calls += 1;
  } while (result.deleted === result.batchSize);
  expect(totalDeleted).toBe(480);
  expect(calls).toBe(3);

  const messages = await t.query(api.quasar.readSession, {
    sessionId,
    paginationOpts: { numItems: 1, cursor: null },
  });
  expect(messages.page).toHaveLength(0);

  const toolCalls = await t.query(api.quasar.sessionToolCalls, {
    sessionId,
    paginationOpts: { numItems: 1, cursor: null },
  });
  expect(toolCalls.page).toHaveLength(0);

  const kept = await t.query(api.quasar.readSession, {
    sessionId: "s-keep",
    paginationOpts: { numItems: 1, cursor: null },
  });
  expect(kept.page).toHaveLength(1);
});

test("pruneEmptyProjects deletes only project rows no session references", async () => {
  const t = testConvex();

  await t.mutation(api.quasar.upsertProject, {
    projectKey: "git:github.com/skastr0/quasar",
    displayName: "quasar",
    aliases: [],
    rawPaths: ["/Users/a/Projects/quasar"],
  });
  // Abandoned key from before a mapping change re-keyed its sessions.
  await t.mutation(api.quasar.upsertProject, {
    projectKey: "path:machine-a:stale",
    displayName: "quasar",
    aliases: [],
    rawPaths: ["/Users/a/Projects/quasar"],
  });
  await t.mutation(api.quasar.beginSessionIngest, {
    ...sessionArgs,
    projectKey: "git:github.com/skastr0/quasar",
    runId: "run-1",
  });

  const result = await t.mutation(api.quasar.pruneEmptyProjects, {});
  expect(result).toEqual({ deleted: 1 });

  const projects = await t.query(api.quasar.listProjects, {});
  expect(projects.map((project) => project.projectKey)).toEqual([
    "git:github.com/skastr0/quasar",
  ]);
});
