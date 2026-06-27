import { expect, test } from "bun:test";

import { parseProjects, parseSearch, parseSessions, parseToolCalls } from "./quasar-client";

// Fixtures below are trimmed copies of real server responses.

test("parseSearch lifts matches out of the envelope row", () => {
  const envelope = {
    ok: true,
    command: "search/lexical",
    data: {
      matches: [
        {
          key: "kimi:7a43b7c9:178:reasoning",
          score: 14.163,
          row: {
            key: "kimi:7a43b7c9:178:reasoning",
            sessionId: "kimi:7a43b7c9",
            seq: 178,
            role: "reasoning",
            projectKey: "git:github.com/skastr0/quasar",
            provider: "kimi",
            text: "The code should create vector index…",
          },
        },
      ],
    },
  };
  const out = parseSearch(envelope);
  expect(out.ok).toBe(true);
  if (!out.ok) return;
  expect(out.value).toHaveLength(1);
  expect(out.value[0]).toMatchObject({
    sessionId: "kimi:7a43b7c9",
    seq: 178,
    role: "reasoning",
    provider: "kimi",
    score: 14.163,
  });
});

test("parseSearch surfaces SearchIndexNotReady as a typed failure", () => {
  const envelope = {
    ok: false,
    route: "search/fusion",
    error: {
      type: "ServiceUnavailable",
      code: "SearchIndexNotReady",
      message: "structural index divergence (extra=1608, stale=0)",
    },
  };
  const out = parseSearch(envelope);
  expect(out.ok).toBe(false);
  if (out.ok) return;
  expect(out.code).toBe("SearchIndexNotReady");
  expect(out.message).toContain("divergence");
});

test("parseSearch tolerates an empty/malformed envelope", () => {
  expect(parseSearch({ ok: true, data: {} })).toEqual({ ok: true, value: [] });
  expect(parseSearch(null).ok).toBe(false);
});

test("parseSessions maps rows with null-safe fields", () => {
  const out = parseSessions({
    ok: true,
    command: "sessions",
    data: {
      rows: [
        {
          sessionId: "kimi:3f57",
          projectKey: "git:github.com/skastr0/quasar",
          provider: "kimi",
          agentName: "kimi-code",
          title: null,
          startedAt: "2026-06-27T10:03:09.305Z",
          updatedAt: "2026-06-27T10:06:56.218Z",
          messageCount: 8,
          toolCallCount: 12,
        },
      ],
    },
  });
  expect(out.ok).toBe(true);
  if (!out.ok) return;
  expect(out.value[0]).toMatchObject({ sessionId: "kimi:3f57", title: null, messageCount: 8, toolCallCount: 12 });
});

test("parseToolCalls maps forensic rows", () => {
  const out = parseToolCalls({
    ok: true,
    command: "tool-calls",
    data: {
      rows: [
        {
          id: "antigravity:0eff:tool:abdf",
          sessionId: "antigravity:0eff",
          seq: 0,
          toolName: "list_dir",
          status: "completed",
          inputText: '{"DirectoryPath":"/tmp"}',
          outputText: "Empty directory",
          projectKey: "path:machine:129e",
          provider: "antigravity",
        },
      ],
    },
  });
  expect(out.ok).toBe(true);
  if (!out.ok) return;
  expect(out.value[0]).toMatchObject({ toolName: "list_dir", status: "completed", provider: "antigravity" });
});

test("parseProjects maps the project list", () => {
  const out = parseProjects({
    ok: true,
    command: "projects",
    data: { rows: [{ projectKey: "git:github.com/agentjido/jido", displayName: "jido", rawPath: "/x/jido" }] },
  });
  expect(out.ok).toBe(true);
  if (!out.ok) return;
  expect(out.value[0]).toMatchObject({ displayName: "jido", projectKey: "git:github.com/agentjido/jido" });
});
