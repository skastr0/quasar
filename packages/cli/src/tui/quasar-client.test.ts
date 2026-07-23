import { expect, test } from "bun:test";

import { messagesQuery, searchQuery, toolCallsQuery } from "../query-spec";
import { parseMessages, parseProjects, parseSearch, parseToolCalls, QuasarClient } from "./quasar-client";

const page = { returned: 1 } as const;

test("parseSearch strictly maps the typed query response", () => {
  const spec = searchQuery({ text: "vector index", mode: "lexical" });
  const output = parseSearch({
    protocolVersion: "quasar.query/v1",
    kind: "search",
    projection: spec.projection,
    page,
    items: [{
      sessionId: "kimi:7a43b7c9",
      projectKey: "git:github.com/skastr0/quasar",
      provider: "kimi",
      title: null,
      role: "reasoning",
      text: "The code should create vector index.",
      score: 14.163,
    }],
  }, spec);

  expect(output.ok).toBe(true);
  if (!output.ok) return;
  expect(output.value[0]).toMatchObject({
    sessionId: "kimi:7a43b7c9",
    role: "reasoning",
    provider: "kimi",
    score: 14.163,
  });
});

test("parseSearch preserves typed server failures", () => {
  const output = parseSearch({
    ok: false,
    error: {
      type: "ServiceUnavailable",
      code: "SearchIndexNotReady",
      message: "structural index divergence",
    },
  });
  expect(output).toEqual({ ok: false, code: "SearchIndexNotReady", message: "structural index divergence" });
});

test("parseSearch rejects projection drift and excess response fields", () => {
  const spec = searchQuery({ text: "vector", mode: "lexical", projection: { fields: ["sessionId", "text"] } });
  const output = parseSearch({
    protocolVersion: "quasar.query/v1",
    kind: "search",
    projection: spec.projection,
    page,
    items: [{ sessionId: "codex:s1", text: "vector", score: 1 }],
  }, spec);
  expect(output.ok).toBe(false);
  if (output.ok) return;
  expect(output.code).toBe("Protocol");
});

test("identity-bearing search projection keeps same-session hits distinct", () => {
  const spec = searchQuery({
    text: "vector",
    mode: "lexical",
    projection: {
      detail: "detail",
      fields: ["messageId", "sessionId", "sequence", "projectKey", "provider", "role", "text", "score"],
    },
  });
  const output = parseSearch({
    protocolVersion: "quasar.query/v1",
    kind: "search",
    projection: spec.projection,
    page: { returned: 2 },
    items: [
      {
        messageId: "m1",
        sessionId: "codex:s1",
        sequence: 3,
        projectKey: "quasar",
        provider: "codex",
        role: "assistant",
        text: "vector one",
        score: 2,
      },
      {
        messageId: "m2",
        sessionId: "codex:s1",
        sequence: 7,
        projectKey: "quasar",
        provider: "codex",
        role: "assistant",
        text: "vector two",
        score: 1,
      },
    ],
  }, spec);

  expect(output.ok).toBe(true);
  if (!output.ok) return;
  expect(output.value.map((item) => item.key)).toEqual(["m1", "m2"]);
  expect(output.value.map((item) => item.seq)).toEqual([3, 7]);
});

test("parseMessages maps summary rows", () => {
  const spec = messagesQuery({ sessionId: "codex:s1" });
  const output = parseMessages({
    protocolVersion: "quasar.query/v1",
    kind: "messages",
    projection: spec.projection,
    page,
    items: [{
      messageId: "m1",
      sessionId: "codex:s1",
      sequence: 8,
      role: "assistant",
      text: "done",
      timestamp: null,
    }],
  }, spec);
  expect(output.ok).toBe(true);
  if (!output.ok) return;
  expect(output.value).toEqual([{ seq: 8, role: "assistant", text: "done", ts: null }]);
});

test("tool summary stays body-free while retaining byte sizes", () => {
  const spec = toolCallsQuery();
  const item = {
    toolCallId: "call-1",
    sessionId: "codex:s1",
    projectKey: "quasar",
    provider: "codex",
    sequence: 3,
    toolName: "exec_command",
    timestamp: null,
    status: "completed",
    startedAt: null,
    completedAt: null,
    inputBytes: 128,
    outputBytes: 521_363,
    agentName: null,
    model: "gpt-5.6-sol",
    modelProvider: "openai",
  };
  const output = parseToolCalls({
    protocolVersion: "quasar.query/v1",
    kind: "toolCalls",
    projection: spec.projection,
    page,
    items: [item],
  }, spec);
  expect(JSON.stringify(item)).not.toContain("outputText");
  expect(output.ok).toBe(true);
  if (!output.ok) return;
  expect(output.value[0]).toMatchObject({ inputText: "", outputText: "", inputBytes: 128, outputBytes: 521_363 });
});

test("tool detail decodes full structured input and output on demand", () => {
  const spec = toolCallsQuery({
    filters: { toolCallId: "call-1" },
    projection: { detail: "detail", limit: 1 },
  });
  const output = parseToolCalls({
    protocolVersion: "quasar.query/v1",
    kind: "toolCalls",
    projection: spec.projection,
    page,
    items: [{
      toolCallId: "call-1",
      sessionId: "codex:s1",
      projectKey: "quasar",
      provider: "codex",
      sequence: 3,
      toolName: "exec_command",
      timestamp: null,
      status: "completed",
      startedAt: null,
      completedAt: null,
      inputBytes: 10,
      outputBytes: 2,
      agentName: null,
      model: "gpt-5.6-sol",
      modelProvider: "openai",
      agentRole: "builder",
      input: { cmd: "pwd" },
      output: "ok",
      error: null,
    }],
  }, spec);
  expect(output.ok).toBe(true);
  if (!output.ok) return;
  expect(output.value[0]?.inputText).toContain('"cmd": "pwd"');
  expect(output.value[0]?.outputText).toBe("ok");
});

test("parseProjects keeps the distinct project endpoint contract", () => {
  const output = parseProjects({
    ok: true,
    data: { rows: [{ projectKey: "git:github.com/agentjido/jido", displayName: "jido", rawPath: "/x/jido" }] },
  });
  expect(output.ok).toBe(true);
  if (!output.ok) return;
  expect(output.value[0]).toMatchObject({ displayName: "jido", projectKey: "git:github.com/agentjido/jido" });
});

test("QuasarClient paginates TUI transcript reads through bounded GET resource pages", async () => {
  const requests: URL[] = [];
  const server = Bun.serve({
    port: 0,
    fetch: (request) => {
      const url = new URL(request.url);
      requests.push(url);
      if (url.pathname !== "/messages") return new Response("wrong resource", { status: 400 });
      const start = Number(url.searchParams.get("offset"));
      const limit = Number(url.searchParams.get("limit"));
      const count = start === 0 ? 200 : 1;
      const rows = Array.from({ length: count }, (_, offset) => ({
        messageId: `m${start + offset}`,
        sessionId: "codex:s1",
        sequence: start + offset,
        role: "assistant",
        text: `message ${start + offset}`,
        timestamp: null,
      }));
      return Response.json({
        ok: true,
        command: "messages",
        data: {
          rows,
          page: {
            limit,
            offset: start,
            nextOffset: start === 0 ? 200 : null,
          },
        },
      });
    },
  });
  try {
    const client = new QuasarClient(`http://127.0.0.1:${server.port}`);
    const output = await client.messages("codex:s1", { limit: 201 });

    expect(output.ok).toBe(true);
    if (!output.ok) return;
    expect(output.value).toHaveLength(201);
    expect(requests).toHaveLength(2);
    expect(requests[0]?.pathname).toBe("/messages");
    expect(requests[0]?.searchParams.get("limit")).toBe("200");
    expect(requests[0]?.searchParams.get("offset")).toBe("0");
    expect(requests[1]?.searchParams.get("limit")).toBe("200");
    expect(requests[1]?.searchParams.get("offset")).toBe("200");
  } finally {
    server.stop(true);
  }
}, 15_000);

test("QuasarClient search preserves bounded resource excerpts and stable message identity", async () => {
  let requested: URL | undefined;
  let requestedMethod: string | undefined;
  const server = Bun.serve({
    port: 0,
    fetch: (request) => {
      requested = new URL(request.url);
      requestedMethod = request.method;
      return Response.json({
        ok: true,
        command: "search/lexical",
        data: {
          matches: [{
            key: "m7",
            score: 1.5,
            row: {
              messageId: "m7",
              sessionId: "codex:s1",
              sequence: 7,
              projectKey: "quasar",
              provider: "codex",
              role: "assistant",
              text: "bounded excerpt",
              textTruncated: true,
              textBytes: 1_200_000,
            },
          }],
          page: { limit: 50, offset: 0, nextOffset: null },
          receipt: {},
          degraded: false,
        },
      });
    },
  });
  try {
    const client = new QuasarClient(`http://127.0.0.1:${server.port}`);
    const output = await client.search("vector", "lexical");

    expect(output.ok).toBe(true);
    if (!output.ok) return;
    expect(output.value).toEqual([
      expect.objectContaining({ key: "m7", seq: 7, text: "bounded excerpt" }),
    ]);
    expect(requestedMethod).toBe("GET");
    expect(requested?.pathname).toBe("/search/lexical");
    expect(requested?.searchParams.get("q")).toBe("vector");
  } finally {
    server.stop(true);
  }
}, 15_000);
