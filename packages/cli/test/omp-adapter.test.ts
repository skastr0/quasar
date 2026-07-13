import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, test } from "bun:test";
import { Option, Schema } from "effect";

import { sessionIdFor, sourceFingerprintFor } from "../src/adapters/common";
import { ompAdapter } from "../src/adapters/omp";
import {
  classifyOmpRecord,
  OmpEntrySchema,
  OmpMessageEntrySchema,
  OmpSessionHeaderSchema,
} from "../src/adapters/omp-schema";
import { OmpSessionId } from "../src/core/identity";

const MACHINE = {
  machineId: "machine:test",
  hostname: "test-host",
  platform: "darwin",
};
const NOW = "2026-07-13T12:00:00.000Z";
const MAIN_NATIVE_ID = "01900000-0000-7000-8000-00000000a001";
const CHILD_NATIVE_ID = "01900000-0000-7000-8000-00000000a002";
const INLINE_IMAGE = "c3ludGhldGljLWJhc2U2NC1pbWFnZS1ieXRlcw==";
const SIGNATURE = "synthetic-signature-must-not-index";
const PROVIDER_PAYLOAD = "synthetic-provider-payload-must-not-index";

const tempRoots: string[] = [];
afterAll(() => {
  for (const root of tempRoots) rmSync(root, { recursive: true, force: true });
});

const makeRoot = () => {
  const root = mkdtempSync(join(tmpdir(), "quasar-omp-test-"));
  tempRoots.push(root);
  return root;
};

const writeJsonl = (path: string, records: readonly unknown[], malformed?: string) => {
  const lines = records.map((record) => JSON.stringify(record));
  if (malformed !== undefined) lines.splice(lines.length - 2, 0, malformed);
  writeFileSync(path, `${lines.join("\n")}\n`, "utf8");
};

const title = {
  type: "title",
  v: 1,
  title: "Synthetic OMP title",
  source: "user",
  updatedAt: "2026-07-13T10:00:09.000Z",
  pad: " ".repeat(80),
};

const header = (id: string, extra: Readonly<Record<string, unknown>> = {}) => ({
  type: "session",
  version: 3,
  id,
  timestamp: "2026-07-13T10:00:00.000Z",
  cwd: "/synthetic/project",
  providerPromptCacheKey: "opaque-prompt-cache-key-must-not-index",
  ...extra,
});

const mainRecords = () => [
  title,
  header(MAIN_NATIVE_ID, { title: "Header title should lose" }),
  {
    type: "message",
    id: "user-1",
    parentId: null,
    timestamp: "2026-07-13T10:00:01.000Z",
    message: {
      role: "user",
      content: [
        { type: "text", text: "inspect the synthetic tree", textSignature: SIGNATURE },
        { type: "image", data: INLINE_IMAGE, mimeType: "image/png" },
      ],
      timestamp: Date.parse("2026-07-13T10:00:01.250Z"),
      providerPayload: { secret: PROVIDER_PAYLOAD },
    },
  },
  {
    type: "message",
    id: "assistant-1",
    parentId: "user-1",
    timestamp: "2026-07-13T10:00:02.000Z",
    message: {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "reason through the synthetic fixture", thinkingSignature: SIGNATURE },
        { type: "text", text: "I will run the synthetic tool. API_KEY=block-secret", textSignature: SIGNATURE },
        { type: "toolCall", id: "call-1", name: "synthetic_read", arguments: { path: "/synthetic/input", token: "secret-value" }, thoughtSignature: SIGNATURE },
        { type: "toolCall", id: "call-2", name: "synthetic_write", arguments: { path: "/synthetic/output" }, thoughtSignature: SIGNATURE },
      ],
      api: "synthetic-api",
      provider: "synthetic-provider",
      model: "synthetic-model",
      usage: {
        input: 11,
        output: 7,
        cacheRead: 5,
        cacheWrite: 3,
        totalTokens: 26,
        reasoningTokens: 2,
        cost: { input: 0.01, output: 0.02, cacheRead: 0.003, cacheWrite: 0.004, total: 0.037 },
      },
      stopReason: "toolUse",
      timestamp: Date.parse("2026-07-13T10:00:02.500Z"),
      responseId: "response-id-must-not-index",
      providerPayload: { encrypted_content: PROVIDER_PAYLOAD },
    },
  },
  {
    type: "message",
    id: "assistant-alternate",
    parentId: "user-1",
    timestamp: "2026-07-13T10:00:02.600Z",
    message: {
      role: "assistant",
      content: [{ type: "text", text: "alternate persisted branch" }],
      provider: "synthetic-provider",
      model: "synthetic-model",
      stopReason: "stop",
      timestamp: Date.parse("2026-07-13T10:00:02.600Z"),
    },
  },
  {
    type: "custom",
    customType: "tool_execution_start",
    data: {
      toolCallId: "call-1",
      toolName: "synthetic_read",
      startedAt: "2026-07-13T10:00:02.750Z",
      args: { path: "/synthetic/input", apiKey: "credential-must-not-index" },
      intent: "read synthetic input",
    },
    id: "start-1",
    parentId: "assistant-1",
    timestamp: "2026-07-13T10:00:02.750Z",
  },
  {
    type: "message",
    id: "result-1",
    parentId: "start-1",
    timestamp: "2026-07-13T10:00:03.000Z",
    message: {
      role: "toolResult",
      toolCallId: "call-2",
      toolName: "synthetic_write",
      content: [
        { type: "text", text: "synthetic tool output" },
        { type: "image", data: INLINE_IMAGE, mimeType: "image/png" },
      ],
      isError: false,
      timestamp: Date.parse("2026-07-13T10:00:03.250Z"),
    },
  },
  {
    type: "branch_summary",
    id: "summary-1",
    parentId: "result-1",
    timestamp: "2026-07-13T10:00:04.000Z",
    fromId: "user-1",
    summary: "Synthetic branch summary",
    details: { providerPayload: PROVIDER_PAYLOAD },
  },
  {
    type: "future_record_type",
    id: "unknown-1",
    parentId: "summary-1",
    timestamp: "2026-07-13T10:00:05.000Z",
    payload: "unknown-secret-body",
  },
  {
    type: "message",
    id: "malformed-1",
    parentId: "summary-1",
    timestamp: "2026-07-13T10:00:06.000Z",
    message: { role: "assistant", content: "wrong assistant content", secret: "malformed-secret-body" },
  },
];

const writeCorpus = (root: string) => {
  const projectDir = join(root, "-synthetic-project");
  mkdirSync(projectDir, { recursive: true });
  const mainPath = join(projectDir, "main.jsonl");
  writeJsonl(mainPath, mainRecords(), "{not valid json and never fatal");

  const childDir = join(projectDir, "main");
  mkdirSync(childDir, { recursive: true });
  const childPath = join(childDir, "worker.jsonl");
  writeJsonl(childPath, [
    header(CHILD_NATIVE_ID, { fork: MAIN_NATIVE_ID }),
    {
      type: "message",
      id: "child-user",
      parentId: null,
      timestamp: "2026-07-13T10:00:07.000Z",
      message: { role: "user", content: "nested synthetic request", timestamp: Date.parse("2026-07-13T10:00:07.000Z") },
    },
    {
      type: "message",
      id: "child-assistant",
      parentId: "child-user",
      timestamp: "2026-07-13T10:00:08.000Z",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "nested synthetic response" }],
        provider: "synthetic-provider",
        model: "synthetic-model",
        usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { total: 0 } },
        stopReason: "stop",
        timestamp: Date.parse("2026-07-13T10:00:08.000Z"),
      },
    },
  ]);

  writeJsonl(join(projectDir, "invalid-header.jsonl"), [
    { type: "session", version: 3, timestamp: NOW, cwd: "/synthetic/project" },
  ]);
  writeJsonl(join(projectDir, "missing-header.jsonl"), [
    {
      type: "message",
      id: "not-a-header",
      parentId: null,
      timestamp: NOW,
      message: { role: "user", content: "must not become a session", timestamp: Date.parse(NOW) },
    },
  ]);

  writeFileSync(join(childDir, "001.synthetic_read.log"), "artifact body must not be indexed", "utf8");
  return { mainPath, childPath };
};

describe("OMP schemas", () => {
  test("the modeled union is closed and classification is declarative", () => {
    const valid = Schema.decodeUnknownOption(OmpMessageEntrySchema)(mainRecords()[2]);
    expect(Option.isSome(valid)).toBe(true);
    const unknown = Schema.decodeUnknownOption(OmpEntrySchema)({ type: "future_record_type", id: "x", parentId: null, timestamp: NOW });
    expect(Option.isNone(unknown)).toBe(true);
    if (Option.isSome(valid)) expect(classifyOmpRecord(valid.value)).toEqual({ _tag: "signal", kind: "message" });
  });
});

describe("OMP adapter", () => {
  test("normalizes v3 title/header, all semantic message parts, usage, tree edges, nested lineage, artifacts, and named drops", async () => {
    const root = makeRoot();
    writeCorpus(root);

    const result = await ompAdapter.read({ machine: MACHINE, now: NOW, roots: { omp: root } });
    expect(result.sessions).toHaveLength(2);

    const mainId = sessionIdFor("omp", OmpSessionId(MAIN_NATIVE_ID));
    const childId = sessionIdFor("omp", OmpSessionId(CHILD_NATIVE_ID));
    const main = result.sessions.find((session) => session.id === mainId)!;
    const child = result.sessions.find((session) => session.id === childId)!;

    expect(main.title).toBe("Synthetic OMP title");
    expect(main.nativeSessionId).toBe(MAIN_NATIVE_ID);
    expect(main.startedAt).toBe("2026-07-13T10:00:00.000Z");
    expect(main.updatedAt).toBe("2026-07-13T10:00:09.000Z");
    expect(main.events.map((event) => event.sequence)).toEqual([0, 1, 2, 3, 4, 5]);
    expect(main.events.map((event) => event.kind)).toEqual(["message", "message", "message", "lifecycle", "tool_result", "summary"]);
    expect(main.events[1]?.contentBlocks.map((block) => block.kind)).toEqual(["thinking", "text", "json", "json"]);
    expect(main.events[1]?.contentText).toContain("reason through the synthetic fixture");
    expect(main.events[1]?.contentText).toContain("I will run the synthetic tool.");
    expect(main.events[2]?.contentText).toBe("alternate persisted branch");
    expect(main.events[4]?.contentText).toBe("synthetic tool output");

    expect(main.events[1]?.parentEventId).toBe(main.events[0]?.id);
    expect(main.events[2]?.parentEventId).toBe(main.events[0]?.id);
    expect(main.events[3]?.parentEventId).toBe(main.events[1]?.id);
    expect(main.sessionEdges.filter((edge) => edge.kind === "parent")).toHaveLength(5);
    expect(main.toolCalls).toHaveLength(2);
    const startedCall = main.toolCalls.find((toolCall) => toolCall.toolName === "synthetic_read")!;
    const completedCall = main.toolCalls.find((toolCall) => toolCall.toolName === "synthetic_write")!;
    expect(startedCall.status).toBe("started");
    expect(startedCall.input).toEqual({ path: "/synthetic/input", apiKey: "[redacted]" });
    expect(completedCall.status).toBe("completed");
    expect(completedCall.input).toEqual({ path: "/synthetic/output" });
    expect(completedCall.output).toEqual([
      { type: "text", text: "synthetic tool output" },
      { type: "image", mediaType: "image/png", storage: "inline", encodedChars: INLINE_IMAGE.length },
    ]);
    expect(main.sessionEdges.find((edge) =>
      edge.kind === "tool_result_for" && edge.toEventId === main.events[4]?.id
    )).toMatchObject({ fromEventId: completedCall.eventId });

    expect(main.usageRecords).toHaveLength(1);
    expect(main.usageRecords[0]).toMatchObject({
      model: "synthetic-model",
      modelProvider: "synthetic-provider",
      inputTokens: 11,
      outputTokens: 7,
      reasoningTokens: 2,
      cacheReadInputTokens: 5,
      cacheCreationInputTokens: 3,
      totalTokens: 26,
      cost: 0.037,
      currency: "USD",
    });

    expect(main.artifacts).toHaveLength(1);
    expect(main.artifacts[0]).toMatchObject({ kind: "text", metadata: { fileName: "001.synthetic_read.log", size: 33 } });
    expect(main.artifacts[0]?.sourceRef).toBeUndefined();

    expect(child.agentName).toBe("omp:worker");
    expect(child.sessionEdges.find((edge) => edge.kind === "subagent_of")).toMatchObject({
      fromId: mainId,
      toId: childId,
    });
    expect(child.events.map((event) => event.contentText)).toEqual(["nested synthetic request", "nested synthetic response"]);
    expect(child.sessionEdges.find((edge) => edge.kind === "forked_from")).toMatchObject({
      fromId: mainId,
      toId: childId,
    });

    const serialized = JSON.stringify(result.sessions);
    expect(serialized).not.toContain(INLINE_IMAGE);
    expect(serialized).not.toContain(SIGNATURE);
    expect(serialized).not.toContain(PROVIDER_PAYLOAD);
    expect(serialized).not.toContain("response-id-must-not-index");
    expect(serialized).not.toContain("opaque-prompt-cache-key-must-not-index");
    expect(serialized).not.toContain("artifact body must not be indexed");
    expect(serialized).not.toContain("block-secret");

    const diagnostics = JSON.stringify(result.diagnostics);
    expect(diagnostics).toContain("omp.line.invalid_json");
    expect(diagnostics).toContain("omp.record.unknown_type");
    expect(diagnostics).toContain("omp.record.invalid_shape");
    expect(diagnostics).toContain("omp.session.header_invalid");
    expect(diagnostics).toContain("omp.session.header_missing");
    expect(diagnostics).not.toContain("unknown-secret-body");
    expect(diagnostics).not.toContain("malformed-secret-body");
    expect(result.diagnostics.at(-1)?.status).toBe("available");
  });

  test("uses native header identity across physical and logical roots", async () => {
    const firstRoot = makeRoot();
    const secondRoot = makeRoot();
    writeCorpus(firstRoot);
    writeCorpus(secondRoot);

    const first = await ompAdapter.read({
      machine: MACHINE,
      now: NOW,
      roots: { omp: firstRoot },
      logicalRoots: { omp: "/logical/host/sessions" },
    });
    const second = await ompAdapter.read({
      machine: MACHINE,
      now: NOW,
      roots: { omp: secondRoot },
      logicalRoots: { omp: "/logical/container/sessions" },
    });

    const firstMain = first.sessions.find((session) => session.nativeSessionId === MAIN_NATIVE_ID)!;
    const secondMain = second.sessions.find((session) => session.nativeSessionId === MAIN_NATIVE_ID)!;
    expect(firstMain.id).toBe(secondMain.id);
    expect(firstMain.sourcePath).not.toBe(secondMain.sourcePath);
  });

  test("honors stat and parse gates before reading the full body", async () => {
    const root = makeRoot();
    const { mainPath } = writeCorpus(root);
    const readPaths: string[] = [];
    let parseCalls = 0;

    const statSkipped = await ompAdapter.read({
      machine: MACHINE,
      now: NOW,
      roots: { omp: root },
      shouldReadFile: (path) => {
        readPaths.push(path);
        return false;
      },
      shouldParseSession: () => {
        parseCalls += 1;
        return true;
      },
    });
    expect(statSkipped.sessions).toHaveLength(0);
    expect(readPaths).toContain(mainPath);
    expect(parseCalls).toBe(0);

    const probes: Array<{ readonly sessionId: string; readonly sourceFingerprint: string }> = [];
    const parseSkipped = await ompAdapter.read({
      machine: MACHINE,
      now: NOW,
      roots: { omp: root },
      shouldReadFile: () => true,
      shouldParseSession: (probe) => {
        probes.push(probe);
        return false;
      },
    });
    expect(parseSkipped.sessions).toHaveLength(0);
    expect(probes).toHaveLength(2);
    expect(probes.find((probe) => probe.sessionId === sessionIdFor("omp", OmpSessionId(MAIN_NATIVE_ID)))?.sourceFingerprint)
      .toBe(sourceFingerprintFor(statSync(mainPath)));
  });

  test("retains nested lineage when only the changed child passes the stat gate", async () => {
    const root = makeRoot();
    const { mainPath, childPath } = writeCorpus(root);

    const result = await ompAdapter.read({
      machine: MACHINE,
      now: NOW,
      roots: { omp: root },
      shouldReadFile: (path) => path === childPath,
    });

    expect(result.sessions).toHaveLength(1);
    expect(result.sessions[0]?.nativeSessionId).toBe(CHILD_NATIVE_ID);
    expect(result.sessions[0]?.sessionEdges.find((edge) => edge.kind === "subagent_of")).toMatchObject({
      fromId: sessionIdFor("omp", OmpSessionId(MAIN_NATIVE_ID)),
      toId: sessionIdFor("omp", OmpSessionId(CHILD_NATIVE_ID)),
      rawReference: { nativeType: "nested_transcript" },
    });
    expect(result.sessions[0]?.sourcePath).not.toBe(mainPath);
  });

  test("rejects a whitespace header id per file and continues to a later valid session", async () => {
    const root = makeRoot();
    const emptyPath = join(root, "a-empty-id.jsonl");
    writeJsonl(emptyPath, [header("   ")]);
    writeJsonl(join(root, "z-valid.jsonl"), [
      header(MAIN_NATIVE_ID),
      {
        type: "message",
        id: "valid-user",
        parentId: null,
        timestamp: NOW,
        message: { role: "user", content: "valid after empty id", timestamp: Date.parse(NOW) },
      },
    ]);

    expect(Option.isNone(Schema.decodeUnknownOption(OmpSessionHeaderSchema)(header("   ")))).toBe(true);
    const result = await ompAdapter.read({ machine: MACHINE, now: NOW, roots: { omp: root } });

    expect(result.sessions.map((session) => session.nativeSessionId)).toEqual([MAIN_NATIVE_ID]);
    const diagnostics = JSON.stringify(result.diagnostics);
    expect(diagnostics).toContain("omp.session.header_id_empty");
    expect(diagnostics).toContain("a-empty-id.jsonl");
  });

  test("redacts paired and direct execution outputs without flattening their payloads", async () => {
    const root = makeRoot();
    const pairedSecret = "paired-output-secret";
    const bashSecret = "bash-output-secret";
    const pythonSecret = "python-output-secret";
    writeJsonl(join(root, "outputs.jsonl"), [
      header(MAIN_NATIVE_ID),
      {
        type: "message",
        id: "assistant-call",
        parentId: null,
        timestamp: "2026-07-13T10:00:01.000Z",
        message: {
          role: "assistant",
          content: [{ type: "toolCall", id: "secret-call", name: "read_secret", arguments: {} }],
          provider: "synthetic-provider",
          model: "synthetic-model",
          stopReason: "toolUse",
          timestamp: Date.parse("2026-07-13T10:00:01.000Z"),
        },
      },
      {
        type: "message",
        id: "paired-result",
        parentId: "assistant-call",
        timestamp: "2026-07-13T10:00:02.000Z",
        message: {
          role: "toolResult",
          toolCallId: "secret-call",
          toolName: "read_secret",
          content: [{ type: "text", text: `API_KEY=${pairedSecret}` }],
          isError: false,
          timestamp: Date.parse("2026-07-13T10:00:02.000Z"),
        },
      },
      {
        type: "message",
        id: "bash-result",
        parentId: "paired-result",
        timestamp: "2026-07-13T10:00:03.000Z",
        message: {
          role: "bashExecution",
          command: "printenv API_KEY",
          output: `API_KEY=${bashSecret}`,
          exitCode: 0,
          cancelled: false,
          truncated: false,
          timestamp: Date.parse("2026-07-13T10:00:03.000Z"),
        },
      },
      {
        type: "message",
        id: "python-result",
        parentId: "bash-result",
        timestamp: "2026-07-13T10:00:04.000Z",
        message: {
          role: "pythonExecution",
          code: "print(secret)",
          output: `SECRET=${pythonSecret}`,
          exitCode: 0,
          cancelled: false,
          truncated: false,
          timestamp: Date.parse("2026-07-13T10:00:04.000Z"),
        },
      },
    ]);

    const result = await ompAdapter.read({ machine: MACHINE, now: NOW, roots: { omp: root } });
    expect(result.sessions).toHaveLength(1);
    expect(result.sessions[0]?.toolCalls).toHaveLength(3);

    const paired = result.sessions[0]?.toolCalls.find((toolCall) => toolCall.toolName === "read_secret");
    expect(paired?.output).toEqual([{ type: "text", text: "API_KEY=[redacted]" }]);
    const bash = result.sessions[0]?.toolCalls.find((toolCall) => toolCall.toolName === "bash");
    expect(bash?.output).toEqual({ text: "API_KEY=[redacted]", truncated: false, exitCode: 0 });
    const python = result.sessions[0]?.toolCalls.find((toolCall) => toolCall.toolName === "python");
    expect(python?.output).toEqual({ text: "SECRET=[redacted]", truncated: false, exitCode: 0 });

    const serialized = JSON.stringify(result.sessions);
    expect(serialized).not.toContain(pairedSecret);
    expect(serialized).not.toContain(bashSecret);
    expect(serialized).not.toContain(pythonSecret);
  });
});
