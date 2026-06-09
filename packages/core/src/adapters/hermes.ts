import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import type { Artifact, SessionEdge, SessionEventKind, ToolCall, UsageRecord } from "../schemas";
import {
  buildSession,
  compactText,
  contentBlocksFromNative,
  edgeIdFor,
  eventIdFor,
  homePath,
  logicalRootFor,
  numberValue,
  parseJsonString,
  projectSessionNativeValue,
  projectToolPayloadNativeValue,
  recordFrom,
  roleFrom,
  scopedId,
  sourceRoot,
  stringValue,
  type NativeValue,
  usageIdFor,
} from "./common";
import { collectAdapterStream, type AdapterStreamItem, type SessionAdapter } from "./types";

type AdapterOptions = Parameters<SessionAdapter["read"]>[0];
type HermesDatabase = NonNullable<Awaited<ReturnType<typeof maybeDatabase>>>;
type HermesRow = Record<string, unknown>;
type HermesSessionRow = HermesRow & { id?: unknown; source?: unknown; started_at?: unknown };
type HermesMessageRow = HermesRow & {
  id?: unknown;
  session_id?: unknown;
  role?: unknown;
  content?: unknown;
  tool_call_id?: unknown;
  tool_calls?: unknown;
  tool_name?: unknown;
  timestamp?: unknown;
};
type HermesToolCallDraft = Omit<
  ToolCall,
  "sessionId" | "machineId" | "provider" | "agentName" | "projectIdentityKey"
>;
type HermesUsageDraft = Omit<
  UsageRecord,
  "sessionId" | "machineId" | "provider" | "agentName" | "projectIdentityKey"
>;
type HermesEdgeDraft = Omit<
  SessionEdge,
  "sessionId" | "machineId" | "provider" | "agentName" | "projectIdentityKey"
>;
type HermesArtifactDraft = Omit<
  Artifact,
  "sessionId" | "machineId" | "provider" | "agentName" | "projectIdentityKey"
>;

const maybeDatabase = async (path: string) => {
  try {
    const { Database } = await import("bun:sqlite");
    return new Database(path);
  } catch {
    return undefined;
  }
};

const sql = (value: string) => `'${value.replaceAll("'", "''")}'`;

const sqliteJson = <A>(dbPath: string, query: string): A[] => {
  try {
    const output = execFileSync("sqlite3", ["-json", dbPath, query], { encoding: "utf8" });
    return output.trim().length === 0 ? [] : (JSON.parse(output) as A[]);
  } catch {
    return [];
  }
};

const copyDatabaseForRead = (dbPath: string) => {
  const tempDir = mkdtempSync(join(tmpdir(), "quasar-hermes-"));
  const tempDbPath = join(tempDir, basename(dbPath));
  copyFileSync(dbPath, tempDbPath);
  for (const suffix of ["-wal", "-shm"]) {
    const source = `${dbPath}${suffix}`;
    if (existsSync(source)) copyFileSync(source, `${tempDbPath}${suffix}`);
  }
  return {
    path: tempDbPath,
    cleanup: () => rmSync(tempDir, { recursive: true, force: true }),
  };
};

const hermesDbPath = (root: string | undefined) => {
  if (root === undefined) return undefined;
  try {
    return statSync(root).isFile() ? root : join(root, "state.db");
  } catch {
    return join(root, "state.db");
  }
};

const sessionWindowLimit = (limit: number | undefined) => Math.max(1, Math.floor(limit ?? 500));
const sessionWindowSkip = (skip: number | undefined) => Math.max(0, Math.floor(skip ?? 0));

const readSessionRows = (
  db: HermesDatabase,
  limit: number | undefined,
  skip: number | undefined,
) =>
  db
    .query("select * from sessions order by started_at desc, id desc limit ? offset ?")
    .all(sessionWindowLimit(limit), sessionWindowSkip(skip)) as HermesSessionRow[];

const readMessageRows = (db: HermesDatabase, sessionId: string) =>
  db
    .query("select * from messages where session_id = ? order by timestamp, id")
    .all(sessionId) as HermesMessageRow[];

const readSessionRowsCli = (
  dbPath: string,
  limit: number | undefined,
  skip: number | undefined,
) =>
  sqliteJson<HermesSessionRow>(
    dbPath,
    `select * from sessions order by started_at desc, id desc limit ${sessionWindowLimit(limit)} offset ${sessionWindowSkip(skip)}`,
  );

const readMessageRowsCli = (dbPath: string, sessionId: string) =>
  sqliteJson<HermesMessageRow>(
    dbPath,
    `select * from messages where session_id = ${sql(sessionId)} order by timestamp, id`,
  );

const isoFromEpoch = (value: unknown) => {
  const numeric = numberValue(value);
  if (numeric === undefined) return stringValue(value);
  return new Date(numeric > 10_000_000_000 ? numeric : numeric * 1000).toISOString();
};

const parsedJsonField = (value: unknown): NativeValue | undefined => {
  const parsed = parseJsonString(value);
  if (parsed === undefined || parsed === null || parsed === "") return undefined;
  return parsed as NativeValue;
};

const parsedReasoningFields = (message: HermesMessageRow) => ({
  reasoningDetails: parsedJsonField(message.reasoning_details),
  codexReasoningItems: parsedJsonField(message.codex_reasoning_items),
  codexMessageItems: parsedJsonField(message.codex_message_items),
});

const toolCallRecords = (value: unknown) => {
  const parsed = parseJsonString(value);
  if (Array.isArray(parsed)) return parsed.map(recordFrom).filter((record) => Object.keys(record).length > 0);
  const record = recordFrom(parsed);
  return Object.keys(record).length === 0 ? [] : [record];
};

const toolNameFromCall = (call: Record<string, unknown>) => {
  const functionRecord = recordFrom(call.function);
  return (
    stringValue(functionRecord.name) ??
    stringValue(call.name) ??
    stringValue(call.tool_name) ??
    stringValue(call.toolName) ??
    "hermes_tool"
  );
};

const toolInputFromCall = (call: Record<string, unknown>) => {
  const functionRecord = recordFrom(call.function);
  return projectToolPayloadNativeValue(
    parseJsonString(functionRecord.arguments) ??
    parseJsonString(call.arguments) ??
    functionRecord.input ??
    functionRecord.parameters ??
    call.args ??
    call.input ??
    call.params ??
    call.parameters,
  );
};

const nativeToolIdFromCall = (call: Record<string, unknown>, fallback: unknown) =>
  stringValue(call.id) ??
  stringValue(call.call_id) ??
  stringValue(call.tool_call_id) ??
  stringValue(call.toolCallId) ??
  String(fallback);

const statusFromFinishReason = (finishReason: unknown) => {
  const value = stringValue(finishReason);
  if (value === undefined) return undefined;
  return value.includes("tool") ? "started" : value;
};

const messageKind = (
  message: HermesMessageRow,
  calls: readonly Record<string, unknown>[],
): SessionEventKind => {
  if (message.tool_call_id !== undefined || stringValue(message.role) === "tool") return "tool_result";
  if (calls.length > 0) return "tool_call";
  if (
    stringValue(message.reasoning) !== undefined ||
    stringValue(message.reasoning_content) !== undefined ||
    message.reasoning_details !== undefined
  ) {
    return stringValue(message.content) === undefined ? "reasoning" : "message";
  }
  return "message";
};

const messageContent = (
  message: HermesMessageRow,
  calls: readonly Record<string, unknown>[],
): NativeValue => {
  const reasoning = parsedReasoningFields(message);
  const reasoningDetails = projectSessionNativeValue(reasoning.reasoningDetails);
  const codexReasoningItems = projectSessionNativeValue(reasoning.codexReasoningItems);
  const codexMessageItems = projectSessionNativeValue(reasoning.codexMessageItems);
  const projectedCalls = projectSessionNativeValue(calls);
  return {
    content: stringValue(message.content),
    reasoning: stringValue(message.reasoning),
    reasoning_content: stringValue(message.reasoning_content),
    ...(reasoningDetails !== undefined ? { reasoning_details: reasoningDetails } : {}),
    ...(codexReasoningItems !== undefined ? { codex_reasoning_items: codexReasoningItems } : {}),
    ...(codexMessageItems !== undefined ? { codex_message_items: codexMessageItems } : {}),
    ...(projectedCalls !== undefined ? { tool_calls: projectedCalls } : {}),
    finish_reason: stringValue(message.finish_reason),
    platform_message_id: stringValue(message.platform_message_id),
  };
};

const messageBlocks = (
  machineId: string,
  dbPath: string,
  eventId: string,
  message: HermesMessageRow,
  calls: readonly Record<string, unknown>[],
) => {
  const reasoning = parsedReasoningFields(message);
  const blockInputs: NativeValue[] = [];
  const content = stringValue(message.content);
  if (content !== undefined) blockInputs.push({ type: "text", text: content });
  const thinking = stringValue(message.reasoning_content) ?? stringValue(message.reasoning);
  if (thinking !== undefined) blockInputs.push({ type: "thinking", thinking });
  const reasoningDetails = projectSessionNativeValue(reasoning.reasoningDetails);
  if (reasoningDetails !== undefined) {
    blockInputs.push({ type: "json", value: reasoningDetails, label: "reasoning_details" });
  }
  const codexReasoningItems = projectSessionNativeValue(reasoning.codexReasoningItems);
  if (codexReasoningItems !== undefined) {
    blockInputs.push({ type: "json", value: codexReasoningItems, label: "codex_reasoning_items" });
  }
  const codexMessageItems = projectSessionNativeValue(reasoning.codexMessageItems);
  if (codexMessageItems !== undefined) {
    blockInputs.push({ type: "json", value: codexMessageItems, label: "codex_message_items" });
  }
  const projectedCalls = projectSessionNativeValue(calls);
  if (projectedCalls !== undefined) blockInputs.push({ type: "json", value: projectedCalls, label: "tool_calls" });
  return contentBlocksFromNative("hermes", machineId, dbPath, eventId, blockInputs);
};

const messageUsage = (
  dbPath: string,
  machineId: string,
  nativeSessionId: string,
  eventId: string,
  message: HermesMessageRow,
  index: number,
  session: HermesSessionRow,
): HermesUsageDraft | undefined => {
  const totalTokens = numberValue(message.token_count);
  if (totalTokens === undefined) return undefined;
  return {
    id: usageIdFor("hermes", machineId, dbPath, nativeSessionId, eventId, index),
    eventId,
    timestamp: isoFromEpoch(message.timestamp),
    model: stringValue(session.model),
    modelProvider: stringValue(session.billing_provider),
    totalTokens,
  };
};

const sessionUsage = (
  dbPath: string,
  machineId: string,
  session: HermesSessionRow,
): HermesUsageDraft | undefined => {
  const nativeSessionId = String(session.id ?? "");
  const inputTokens = numberValue(session.input_tokens);
  const outputTokens = numberValue(session.output_tokens);
  const cacheReadInputTokens = numberValue(session.cache_read_tokens);
  const cacheCreationInputTokens = numberValue(session.cache_write_tokens);
  const reasoningTokens = numberValue(session.reasoning_tokens);
  const totalTokens = sumNumbers([
    inputTokens,
    outputTokens,
    cacheReadInputTokens,
    cacheCreationInputTokens,
    reasoningTokens,
  ]);
  const cost = numberValue(session.actual_cost_usd) ?? numberValue(session.estimated_cost_usd);
  if (totalTokens === undefined && cost === undefined) return undefined;
  return {
    id: usageIdFor("hermes", machineId, dbPath, nativeSessionId, undefined, -1),
    timestamp: isoFromEpoch(session.ended_at) ?? isoFromEpoch(session.started_at),
    model: stringValue(session.model),
    modelProvider: stringValue(session.billing_provider),
    inputTokens,
    outputTokens,
    cacheCreationInputTokens,
    cacheReadInputTokens,
    reasoningTokens,
    totalTokens,
    cost,
    currency: cost === undefined ? undefined : "USD",
  };
};

const sumNumbers = (values: readonly (number | undefined)[]) => {
  const present = values.filter((value): value is number => value !== undefined);
  return present.length === 0
    ? undefined
    : present.reduce((sum, value) => sum + value, 0);
};

const buildHermesSessionFromRows = (
  dbPath: string,
  root: string,
  options: AdapterOptions,
  session: HermesSessionRow,
  messages: readonly HermesMessageRow[],
) => {
  const nativeSessionId = String(session.id ?? "");
  const machineId = options.machine.machineId;
  const toolCallsByNativeId = new Map<string, HermesToolCallDraft>();
  const toolEventByNativeId = new Map<string, string>();
  const usageRecords: HermesUsageDraft[] = [];
  const sessionEdges: HermesEdgeDraft[] = [];
  const artifacts: HermesArtifactDraft[] = [];
  const sessionLevelUsage = sessionUsage(dbPath, machineId, session);
  if (sessionLevelUsage !== undefined) usageRecords.push(sessionLevelUsage);
  const parentSessionId = stringValue(session.parent_session_id);
  if (parentSessionId !== undefined) {
    sessionEdges.push({
      id: edgeIdFor("hermes", machineId, dbPath, "parent", parentSessionId, nativeSessionId),
      kind: "parent",
      fromId: parentSessionId,
      toId: nativeSessionId,
      rawReference: { sourcePath: dbPath, table: "sessions", rowId: nativeSessionId, nativeType: "parent_session_id" },
    });
  }

  const events = messages.map((message, index) => {
    const nativeEventId = String(message.id ?? index);
    const eventId = eventIdFor("hermes", machineId, dbPath, index, nativeEventId);
    const calls = toolCallRecords(message.tool_calls);
    let eventToolCallId: string | undefined;
    for (const [callIndex, call] of calls.entries()) {
      const nativeToolId = nativeToolIdFromCall(call, `${nativeEventId}:${callIndex}`);
      const input = toolInputFromCall(call);
      const toolCall: HermesToolCallDraft = {
        id: scopedId("hermes", machineId, dbPath, "tool", nativeSessionId, nativeToolId),
        eventId,
        toolName: toolNameFromCall(call),
        status: statusFromFinishReason(message.finish_reason),
        ...(input !== undefined ? { input } : {}),
        startedAt: isoFromEpoch(message.timestamp),
      };
      toolCallsByNativeId.set(nativeToolId, toolCall);
      toolEventByNativeId.set(nativeToolId, eventId);
      eventToolCallId ??= toolCall.id;
    }

    const resultNativeToolId = stringValue(message.tool_call_id);
    if (resultNativeToolId !== undefined) {
      const existing = toolCallsByNativeId.get(resultNativeToolId);
      const resultToolCall =
        existing ??
        ({
          id: scopedId("hermes", machineId, dbPath, "tool", nativeSessionId, resultNativeToolId),
          eventId,
          toolName: stringValue(message.tool_name) ?? "hermes_tool",
        } satisfies HermesToolCallDraft);
      const output = projectToolPayloadNativeValue(stringValue(message.content) ?? message.content);
      const completed = {
        ...resultToolCall,
        status: "completed",
        ...(output !== undefined ? { output } : {}),
        completedAt: isoFromEpoch(message.timestamp),
      };
      toolCallsByNativeId.set(resultNativeToolId, completed);
      eventToolCallId = completed.id;
      const callEventId = toolEventByNativeId.get(resultNativeToolId);
      if (callEventId !== undefined) {
        sessionEdges.push({
          id: edgeIdFor("hermes", machineId, dbPath, "tool_result_for", callEventId, eventId),
          kind: "tool_result_for",
          fromEventId: callEventId,
          toEventId: eventId,
        });
      }
    }

    const usage = messageUsage(dbPath, machineId, nativeSessionId, eventId, message, index, session);
    if (usage !== undefined) usageRecords.push(usage);
    const content = messageContent(message, calls);
    return {
      id: eventId,
      nativeEventId,
      sequence: index,
      timestamp: isoFromEpoch(message.timestamp),
      role: roleFrom(stringValue(message.role)),
      kind: messageKind(message, calls),
      contentText: compactText(content),
      contentSource: content,
      contentBlocks: messageBlocks(machineId, dbPath, eventId, message, calls),
      ...(eventToolCallId !== undefined ? { toolCallId: eventToolCallId } : {}),
      rawReference: { sourcePath: dbPath, table: "messages", rowId: nativeEventId, nativeType: "message" },
    };
  });

  return buildSession({
    provider: "hermes",
    agentName: "hermes",
    machine: options.machine,
    nativeSessionId,
    nativeProjectKey: stringValue(session.cwd),
    title: stringValue(session.title),
    startedAt: isoFromEpoch(session.started_at),
    updatedAt: isoFromEpoch(session.ended_at),
    sourceRoot: root,
    sourcePath: dbPath,
    projectPath: stringValue(session.cwd),
    events,
    toolCalls: [...toolCallsByNativeId.values()],
    sessionEdges,
    usageRecords,
    artifacts,
  });
};

const missingDatabaseResult = (root: string | undefined) => ({
  sourceRoots: [],
  sessions: [],
  diagnostics: [
    {
      adapterId: hermesAdapter.id,
      provider: "hermes" as const,
      status: "no_data_found" as const,
      parserConfidence: "documented" as const,
      message: "Hermes state.db was not found.",
      ...(root !== undefined ? { rootPath: root } : {}),
    },
  ],
});

async function* streamHermes(options: AdapterOptions): AsyncGenerator<AdapterStreamItem> {
  const root = options.roots?.hermes ?? hermesAdapter.defaultRoot();
  const dbPath = hermesDbPath(root);
  const logicalRoot = root === undefined ? undefined : logicalRootFor("hermes", root, options);
  const logicalDbPath = hermesDbPath(logicalRoot);
  if (root === undefined || dbPath === undefined || !existsSync(dbPath)) {
    for (const diagnostic of missingDatabaseResult(logicalRoot ?? root).diagnostics) {
      yield { type: "diagnostic", diagnostic };
    }
    return;
  }
  const tempDb = copyDatabaseForRead(dbPath);
  const db = await maybeDatabase(tempDb.path);
  let usedFallback = false;
  let sessionCount = 0;
  try {
    yield {
      type: "sourceRoot",
      sourceRoot: sourceRoot("hermes", hermesAdapter.id, logicalRoot ?? root, options.machine, options.now),
    };
    if (db === undefined) {
      usedFallback = true;
      for (const session of readSessionRowsCli(tempDb.path, options.limit, options.skip)) {
        yield {
          type: "session",
          session: buildHermesSessionFromRows(
            logicalDbPath ?? dbPath,
            logicalRoot ?? root,
            options,
            session,
            readMessageRowsCli(tempDb.path, String(session.id ?? "")),
          ),
        };
        sessionCount += 1;
      }
    } else {
      for (const session of readSessionRows(db, options.limit, options.skip)) {
        yield {
          type: "session",
          session: buildHermesSessionFromRows(
            logicalDbPath ?? dbPath,
            logicalRoot ?? root,
            options,
            session,
            readMessageRows(db, String(session.id ?? "")),
          ),
        };
        sessionCount += 1;
      }
    }
    yield {
      type: "diagnostic",
      diagnostic: {
        adapterId: hermesAdapter.id,
        provider: "hermes" as const,
        status: sessionCount > 0 ? ("available" as const) : ("no_data_found" as const),
        parserConfidence: "documented" as const,
        rootPath: logicalDbPath ?? dbPath,
        message: `Discovered ${sessionCount} Hermes session(s)${usedFallback ? " via sqlite3 fallback" : ""}.`,
      },
    };
  } catch (error) {
    yield {
      type: "diagnostic",
      diagnostic: {
        adapterId: hermesAdapter.id,
        provider: "hermes" as const,
        status: "unsupported" as const,
        parserConfidence: "documented" as const,
        rootPath: logicalDbPath ?? dbPath,
        message: "Hermes state.db did not match the documented sessions/messages schema.",
        details: { error: error instanceof Error ? error.message : String(error) },
      },
    };
  } finally {
    db?.close();
    tempDb.cleanup();
  }
}

export const hermesAdapter: SessionAdapter = {
  id: "hermes-state-sqlite",
  provider: "hermes",
  displayName: "Hermes state.db SQLite",
  stable: true,
  defaultRoot: () => process.env.HERMES_HOME ?? homePath(".hermes"),
  read: async (options) => collectAdapterStream(streamHermes(options)),
  stream: streamHermes,
};
