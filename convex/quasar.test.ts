/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { expect, test, vi } from "vitest";
import { api } from "./_generated/api";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");

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

test("upsertSession skips when sourceFingerprint is unchanged", async () => {
  const t = convexTest(schema, modules);

  const first = await t.mutation(api.quasar.upsertSession, sessionArgs);
  expect(first).toEqual({ skipped: false });

  const second = await t.mutation(api.quasar.upsertSession, sessionArgs);
  expect(second).toEqual({ skipped: true });

  const changed = await t.mutation(api.quasar.upsertSession, {
    ...sessionArgs,
    sourceFingerprint: JSON.stringify({ size: 2048, mtimeMs: 1781151599999 }),
    messageCount: 4,
  });
  expect(changed).toEqual({ skipped: false });

  const page = await t.query(api.quasar.listSessions, {
    projectKey: sessionArgs.projectKey,
    paginationOpts: { numItems: 10, cursor: null },
  });
  expect(page.page).toHaveLength(1);
  expect(page.page[0].messageCount).toBe(4);
});

test("insertMessages + readSession paginates in seq ascending order", async () => {
  const t = convexTest(schema, modules);
  const sessionId = "s-read";
  // Insert deliberately out of order; the index walk must return seq ascending.
  await t.mutation(api.quasar.insertMessages, {
    messages: [4, 1, 3, 0, 2].map((seq) => ({
      sessionId,
      seq,
      role: seq % 2 === 0 ? ("user" as const) : ("assistant" as const),
      text: `message ${seq}`,
      projectKey: "p1",
    })),
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
  const t = convexTest(schema, modules);
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
  const t = convexTest(schema, modules);
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
  });

  const page = await t.query(api.quasar.toolCallsByName, {
    projectKey: "proj-alpha",
    toolName: "Bash",
    paginationOpts: { numItems: 10, cursor: null },
  });
  expect(page.page).toHaveLength(1);
  expect(page.page[0].sessionId).toBe("s-tools");
  expect(page.page[0].toolName).toBe("Bash");
  expect(page.isDone).toBe(true);
});

test("deleteSessionTurns cleans messages and toolCalls across chunks", async () => {
  vi.useFakeTimers();
  try {
    const t = convexTest(schema, modules);
    const sessionId = "s-delete";
    // 450 messages + 30 toolCalls: forces multiple 200-row batches plus
    // a mixed messages/toolCalls batch and a rescheduled continuation.
    for (let start = 0; start < 450; start += 150) {
      await t.mutation(api.quasar.insertMessages, {
        messages: Array.from({ length: 150 }, (_, i) => ({
          sessionId,
          seq: start + i,
          role: "user" as const,
          text: `m${start + i}`,
          projectKey: "p1",
        })),
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
    });

    await t.mutation(api.quasar.deleteSessionTurns, { sessionId });
    await t.finishAllScheduledFunctions(vi.runAllTimers);

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
  } finally {
    vi.useRealTimers();
  }
});
