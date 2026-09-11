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
  expect(tool.output).toBe("fabricated canonical output");
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
  expect(session.toolCalls[1]).toMatchObject({ toolName: "web_search", input: action, output: results });
});

test("bookkeeping stays dropped and malformed known tool items fail closed", () => {
  for (const item of [null, { type: "ContextCompaction", id: "qsr-fab-context" }, { type: "AgentMessage", id: "qsr-fab-message", content: [] }]) {
    expect(classifyCodexRecord(completed(item))._tag).toBe("drop");
  }
  const diagnostics: { name: string; message: string }[] = [];
  expect(classifyCodexRecord(completed({ type: "McpToolCall", id: 42 }), diagnostics)._tag).toBe("drop");
  expect(diagnostics[0]?.name).toBe("codex.event_msg.item_completed.decode_failed");
});
