import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import { codexAdapter } from "../src/adapters/codex";
import { classifyCodexRecord } from "../src/adapters/codex-schema";

const timestamp = "2026-06-11T00:00:00.000Z";
const completed = (item: unknown) => ({
  type: "event_msg", timestamp, payload: { type: "item_completed", item },
});
const response = (payload: unknown) => ({ type: "response_item", timestamp, payload });
const mcp = (id: string, output: object = { result: { content: [{ type: "text", text: "fabricated success" }] } }) => ({
  type: "McpToolCall", id, server: "qsr-fab-server", tool: "lookup",
  arguments: { query: "fabricated query" }, status: "completed", ...output,
});
const read = async (records: unknown[]) => {
  const root = mkdtempSync(join(tmpdir(), "quasar-codex-completed-"));
  try {
    mkdirSync(join(root, "sessions"));
    const id = "0fab0000-fab0-7fab-8fab-000000000099";
    writeFileSync(join(root, "sessions", `rollout-2026-06-11T00-00-00-${id}.jsonl`), [
      { type: "session_meta", timestamp, payload: { id, cwd: "/qsr/fab/proj", timestamp } },
      ...records,
    ].map(record => JSON.stringify(record)).join("\n"));
    const result = await codexAdapter.read({
      machine: { machineId: "machine:test", hostname: "qsr-fab-host", platform: "darwin" },
      now: timestamp, roots: { codex: root },
    });
    expect(result.sessions).toHaveLength(1);
    return result.sessions[0]!;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
};

test("completed MCP items preserve sole-carrier errors, successes and distinct native IDs", async () => {
  const error = { message: "fabricated transport failure" };
  const session = await read([
    completed(mcp("qsr-fab-error", { status: "failed", error })),
    completed(mcp("qsr-fab-success")),
    completed(mcp("qsr-fab-success-2")),
  ]);
  expect(session.toolCalls).toHaveLength(3);
  expect(session.toolCalls[0]).toMatchObject({
    toolName: "mcp__qsr-fab-server__lookup", status: "failed",
    input: { query: "fabricated query" }, output: error,
  });
  expect(session.toolCalls[1]?.output).toEqual({ content: [{ type: "text", text: "fabricated success" }] });
  const events = session.events.filter(event => event.kind === "tool_result");
  expect(events.map(event => event.sequence)).toEqual([1, 2, 3]);
  expect(events.every(event => event.rawReference?.nativeType === "event_msg.item_completed")).toBe(true);
  expect(events.map(event => event.toolCallId)).toEqual(session.toolCalls.map(tool => tool.id));
  expect(events.every(event => event.contentText === undefined)).toBe(true);
});

test.each([false, true])("mirrored MCP results merge by native ID in either record order (item first=%s)", async (itemFirst) => {
  const id = "qsr-fab-mirror";
  const item = completed(mcp(id));
  const call = response({ type: "function_call", call_id: id, name: "mcp__qsr-fab-server__lookup", arguments: '{"query":"fabricated query"}' });
  const result = response({ type: "function_call_output", call_id: id, output: "fabricated canonical output" });
  const session = await read(itemFirst ? [item, call, result] : [call, result, item]);
  expect(session.toolCalls).toHaveLength(1);
  const tool = session.toolCalls[0]!;
  expect(tool.output).toEqual({
    response: "fabricated canonical output",
    itemCompleted: { content: [{ type: "text", text: "fabricated success" }] },
  });
  expect(tool.status).toBe("completed");
  const callEvent = session.events.find(event => event.kind === "tool_call")!;
  expect(tool.eventId).toBe(callEvent.id);
  expect(session.sessionEdges?.some(edge => edge.kind === "tool_result_for" && edge.fromEventId === callEvent.id)).toBe(true);
});

test.each([false, true])("sole completed error links to its response call in either order (item first=%s)", async (itemFirst) => {
  const id = "qsr-fab-error-mirror";
  const item = completed(mcp(id, { status: "failed", error: { message: "fabricated error" } }));
  const call = response({ type: "function_call", call_id: id, name: "qsr-fab-tool", arguments: "{}" });
  const session = await read(itemFirst ? [item, call] : [call, item]);
  expect(session.toolCalls).toHaveLength(1);
  const tool = session.toolCalls[0]!;
  const callEvent = session.events.find(event => event.kind === "tool_call")!;
  const resultEvent = session.events.find(event => event.kind === "tool_result")!;
  expect(tool).toMatchObject({ eventId: callEvent.id, status: "failed", output: { message: "fabricated error" } });
  expect(session.sessionEdges?.filter(edge => edge.kind === "tool_result_for")).toEqual([
    expect.objectContaining({ fromEventId: callEvent.id, toEventId: resultEvent.id }),
  ]);
  expect(callEvent.sequence < resultEvent.sequence).toBe(!itemFirst);
});

test("completed patch and web items retain product; web mirrors use response item IDs", async () => {
  const changes = { "fabricated.txt": { type: "update", unified_diff: "-old\n+fabricated file", move_path: null } };
  const action = { type: "search", queries: ["fabricated query"] };
  const results = [{ type: "search_result", title: "fabricated result", snippet: "fabricated snippet" }];
  const session = await read([
    completed({ type: "FileChange", id: "qsr-fab-patch", changes, status: "failed", stderr: "fabricated patch error" }),
    response({ type: "web_search_call", id: "qsr-fab-web", action, status: "completed" }),
    completed({ type: "WebSearch", id: "qsr-fab-web", query: "fabricated query", action, results }),
  ]);
  expect(session.toolCalls).toHaveLength(2);
  expect(session.toolCalls[0]).toMatchObject({ toolName: "apply_patch", input: changes, output: { stderr: "fabricated patch error" }, status: "failed" });
  expect(session.toolCalls[1]).toMatchObject({
    toolName: "web_search",
    input: { response: action, itemCompleted: { query: "fabricated query", action } },
    output: results,
  });
});

const commandInput = {
  command: ["sh", "-c", "printf 'fabricated output'"], cwd: "/qsr/fab/proj",
  parsed_cmd: [{ type: "unknown", cmd: "fabricated command" }], source: "unified_exec",
};
const commandOutput = {
  process_id: "qsr-fab-process", aggregated_output: "fabricated aggregate\n",
  stdout: "fabricated stdout\n", stderr: "fabricated stderr\n",
  formatted_output: "fabricated formatted\n", exit_code: 7, duration: { secs: 2, nanos: 350 },
};
const completedCases: readonly {
  name: string; item: Record<string, unknown>; input?: unknown; output: unknown;
}[] = [
  {
    name: "CommandExecution",
    item: { type: "CommandExecution", id: "qsr-fab-command", status: "failed", ...commandInput, ...commandOutput },
    input: commandInput, output: commandOutput,
  },
  {
    name: "web.search",
    item: {
      type: "Extension", kind: "web.search", id: "qsr-fab-extension-web", query: "fabricated search",
      action: { type: "search", queries: ["fabricated search", "fabricated alternate"] },
      results: [{ title: "fabricated page", snippet: "fabricated result" }],
    },
    input: { query: "fabricated search", action: { type: "search", queries: ["fabricated search", "fabricated alternate"] } },
    output: [{ title: "fabricated page", snippet: "fabricated result" }],
  },
  {
    name: "image_gen.generation",
    item: {
      type: "Extension", kind: "image_gen.generation", id: "qsr-fab-extension-image", status: "completed",
      revisedPrompt: "fabricated revised prompt", transparentBackground: false,
      result: "fabricated image result", failure: null, savedPath: "/qsr/fab/image.png",
    },
    input: { revisedPrompt: "fabricated revised prompt", transparentBackground: false },
    output: { result: "fabricated image result", failure: null, savedPath: "/qsr/fab/image.png" },
  },
  {
    name: "clock.sleep",
    item: { type: "Extension", kind: "clock.sleep", id: "qsr-fab-extension-sleep", durationMs: 0 },
    output: { durationMs: 0 },
  },
];

for (const { name, item, input, output } of completedCases) {
  test(`${name} keeps sole-carrier fields without fabricated inputs or duplicate tool IDs`, async () => {
    const session = await read([completed(item), completed(item)]);
    expect(session.toolCalls).toHaveLength(1);
    expect(session.toolCalls[0]).toMatchObject({ toolName: name, output });
    expect(session.toolCalls[0]?.input).toEqual(input);
    const toolEvents = session.events.filter(event => event.kind === "tool_result");
    expect(toolEvents).toHaveLength(2);
    expect(toolEvents.every(event => event.contentText === undefined && event.contentBlocks.length === 0)).toBe(true);
  });

  test.each([false, true])(`${name} merges equal mirrored values without wrapping (item first=%s)`, async (itemFirst) => {
    const nativeInput = input ?? { requested_ms: 11 };
    const call = response({ type: "function_call", call_id: item.id, name: "qsr_fab_actual_tool_name", arguments: JSON.stringify(nativeInput) });
    const result = response({ type: "function_call_output", call_id: item.id, output });
    const session = await read(itemFirst ? [completed(item), call, result] : [call, result, completed(item)]);
    expect(session.toolCalls).toHaveLength(1);
    const tool = session.toolCalls[0]!;
    expect(tool).toMatchObject({ toolName: "qsr_fab_actual_tool_name", input: nativeInput, output });
    const callEvent = session.events.find(event => event.kind === "tool_call")!;
    const itemEvent = session.events.find(event => event.rawReference?.nativeType === "event_msg.item_completed")!;
    expect(tool.eventId).toBe(callEvent.id);
    expect(session.sessionEdges).toContainEqual(expect.objectContaining({ fromEventId: callEvent.id, toEventId: itemEvent.id }));
  });

  test.each([false, true])(`${name} retains conflicting response and completion product (item first=%s)`, async (itemFirst) => {
    const responseInput = { request: "fabricated different input" };
    const responseOutput = "fabricated successful response";
    const call = response({ type: "function_call", call_id: item.id, name: "qsr_fab_actual_tool_name", arguments: JSON.stringify(responseInput) });
    const result = response({ type: "function_call_output", call_id: item.id, output: responseOutput });
    const session = await read(itemFirst ? [completed(item), call, result] : [call, result, completed(item)]);
    expect(session.toolCalls).toHaveLength(1);
    expect(session.toolCalls[0]).toMatchObject({
      toolName: "qsr_fab_actual_tool_name",
      input: input === undefined ? responseInput : { response: responseInput, itemCompleted: input },
      output: { response: responseOutput, itemCompleted: output },
      status: item.status ?? "completed",
    });
  });

  test.each([false, true])(`${name} result-only mirrors retain the native name (item first=%s)`, async (itemFirst) => {
    const result = response({ type: "function_call_output", call_id: item.id, output });
    const records = itemFirst ? [completed(item), result] : [result, completed(item)];
    const session = await read(records.map(({ timestamp: _timestamp, ...record }) => record));
    expect(session.toolCalls).toHaveLength(1);
    expect(session.toolCalls[0]).toMatchObject({ toolName: name, output, status: item.status ?? "completed" });
    expect(session.toolCalls[0]?.input).toEqual(input);
  });
}

test.each([false, true])("successful response cannot erase completed MCP failure details without timestamps (item first=%s)", async (itemFirst) => {
  const id = "qsr-fab-conflicting-status";
  const item = completed(mcp(id, { status: "failed", error: { message: "fabricated failure detail" } }));
  const call = response({ type: "function_call", call_id: id, name: "qsr_fab_actual_mcp_name", arguments: '{"query":"fabricated query"}' });
  const result = response({ type: "function_call_output", call_id: id, output: { success: "fabricated response" } });
  const records = itemFirst ? [item, call, result] : [call, result, item];
  const session = await read(records.map(({ timestamp: _timestamp, ...record }) => record));
  expect(session.toolCalls).toHaveLength(1);
  expect(session.toolCalls[0]).toMatchObject({
    status: "failed", toolName: "qsr_fab_actual_mcp_name", input: { query: "fabricated query" },
    output: { response: { success: "fabricated response" }, itemCompleted: { message: "fabricated failure detail" } },
  });
});

test("identical carrier objects deduplicate independently of JSON property order", async () => {
  const id = "qsr-fab-key-order";
  const session = await read([
    completed(mcp(id, { result: { beta: 2, alpha: 1 } })),
    response({ type: "function_call_output", call_id: id, output: { alpha: 1, beta: 2 } }),
  ]);
  expect(session.toolCalls).toHaveLength(1);
  expect(session.toolCalls[0]?.output).toEqual({ alpha: 1, beta: 2 });
});

test("bookkeeping stays dropped and malformed known tool items fail closed", () => {
  for (const item of [null, { type: "ContextCompaction", id: "qsr-fab-context" }, { type: "AgentMessage", id: "qsr-fab-message", content: [] }]) {
    expect(classifyCodexRecord(completed(item))._tag).toBe("drop");
  }
  const diagnostics: { name: string; message: string }[] = [];
  expect(classifyCodexRecord(completed({ type: "McpToolCall", id: 42 }), diagnostics)._tag).toBe("drop");
  expect(diagnostics[0]?.name).toBe("codex.event_msg.item_completed.decode_failed");
});

test("new completion variants reject malformed measured fields and unmodeled extensions", () => {
  for (const item of [
    { ...completedCases[0]!.item, command: "not an argv array" },
    { ...completedCases[1]!.item, results: {} },
    { ...completedCases[2]!.item, transparentBackground: "false" },
    { ...completedCases[3]!.item, durationMs: "0" },
    { type: "Extension", kind: "qsr_fab_unmodeled", id: "qsr-fab-unknown" },
  ]) {
    const diagnostics: { name: string; message: string }[] = [];
    expect(classifyCodexRecord(completed(item), diagnostics)._tag).toBe("drop");
    expect(diagnostics[0]?.name).toBe("codex.event_msg.item_completed.decode_failed");
  }
});
