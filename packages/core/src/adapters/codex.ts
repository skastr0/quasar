import { createReadStream, existsSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";

import { collectAdapterStream, type SessionAdapter } from "./types";
import type { NormalizedSession, SessionEventKind, SessionRole, ToolCall, UsageRecord } from "../schemas";
import { stableWideHash } from "../hash";
import {
  buildSession,
  collectFiles,
  compactText,
  edgeIdFor,
  eventIdFor,
  homePath,
  kindFromNative,
  logicalPathFor,
  logicalRootFor,
  nativeSessionIdFromPath,
  numberValue,
  projectSessionNativeValue,
  projectToolPayloadNativeValue,
  recordFrom,
  roleFrom,
  sourceRoot,
  usageIdFor,
} from "./common";

type CodexRecord = Record<string, unknown>;
type AdapterOptions = Parameters<SessionAdapter["read"]>[0];
type CodexToolCallDraft = Omit<
  ToolCall,
  "sessionId" | "machineId" | "provider" | "agentName" | "projectIdentityKey"
>;
type CodexUsageDraft = Omit<
  UsageRecord,
  "sessionId" | "machineId" | "provider" | "agentName" | "projectIdentityKey"
>;
type CodexEventDraft = Parameters<typeof buildSession>[0]["events"][number];
type CodexEdgeDraft = NonNullable<Parameters<typeof buildSession>[0]["sessionEdges"]>[number];

const payloadRecordFrom = (value: unknown): CodexRecord =>
  value !== null && typeof value === "object" ? (value as CodexRecord) : {};

const payloadTypeFrom = (payload: CodexRecord) =>
  typeof payload.type === "string" ? payload.type : undefined;

const codexNativeType = (recordType: string, payloadType: string | undefined) =>
  payloadType === undefined ? recordType : `${recordType}.${payloadType}`;

const codexKindFrom = (
  recordType: string,
  payloadType: string | undefined,
  payload: CodexRecord,
): SessionEventKind => {
  switch (payloadType) {
    case "message":
    case "user_message":
      return "message";
    case "agent_message":
      return payload.phase === "commentary" ? "preamble" : "message";
    case "function_call":
      return "tool_call";
    case "function_call_output":
      return "tool_result";
    case "reasoning":
      return "reasoning";
    case "token_count":
      return "usage";
    case "task_started":
    case "task_complete":
    case "turn_aborted":
      return "lifecycle";
    case "compacted":
      return "summary";
    default:
      return kindFromNative(payloadType ?? recordType);
  }
};

const codexRoleFrom = (
  recordType: string,
  payloadType: string | undefined,
  payload: CodexRecord,
): SessionRole => {
  const explicitRole = roleFrom(
    typeof payload.role === "string" ? payload.role : undefined,
  );
  if (explicitRole !== "unknown") return explicitRole;
  switch (payloadType) {
    case "function_call":
    case "agent_message":
      return "assistant";
    case "function_call_output":
      return "tool";
    case "reasoning":
      return "thinking";
    case "user_message":
      return "user";
    case "token_count":
    case "task_started":
    case "task_complete":
    case "turn_aborted":
      return "system";
    default:
      return roleFrom(recordType);
  }
};

const callIdFromPayload = (payload: CodexRecord) =>
  typeof payload.call_id === "string" && payload.call_id.length > 0
    ? payload.call_id
    : undefined;

const toolCallIdFor = (
  machineId: string,
  nativeSessionId: string,
  sourcePath: string,
  callId: string,
) => `codex:tool:${machineId}:${stableWideHash(`${nativeSessionId}:${sourcePath}`)}:${callId}`;

const parseToolInput = (value: unknown): unknown => {
  if (typeof value !== "string") return projectToolPayloadNativeValue(value);
  try {
    return projectToolPayloadNativeValue(JSON.parse(value) as unknown);
  } catch {
    return projectToolPayloadNativeValue(value);
  }
};

const upsertCodexToolCall = (
  toolCallsById: Map<string, CodexToolCallDraft>,
  machineId: string,
  nativeSessionId: string,
  sourcePath: string,
  eventId: string,
  timestamp: string | undefined,
  payload: CodexRecord,
) => {
  const payloadType = payloadTypeFrom(payload);
  const callId = callIdFromPayload(payload);
  if (callId === undefined) return undefined;
  const id = toolCallIdFor(machineId, nativeSessionId, sourcePath, callId);
  if (payloadType === "function_call") {
    const toolName =
      typeof payload.name === "string" && payload.name.length > 0
        ? payload.name
        : "codex_tool";
    const existing = toolCallsById.get(id);
    const input = parseToolInput(payload.arguments);
    toolCallsById.set(id, {
      ...existing,
      id,
      eventId: existing?.eventId ?? eventId,
      toolName,
      status: existing?.status === "completed" ? "completed" : "started",
      ...(input !== undefined ? { input } : {}),
      ...(existing?.output !== undefined ? { output: existing.output } : {}),
      ...(timestamp !== undefined ? { startedAt: timestamp } : {}),
      ...(existing?.completedAt !== undefined ? { completedAt: existing.completedAt } : {}),
    });
    return id;
  }
  if (payloadType === "function_call_output") {
    const existing = toolCallsById.get(id);
    const output = projectToolPayloadNativeValue(payload.output);
    toolCallsById.set(id, {
      id,
      eventId: existing?.eventId ?? eventId,
      toolName: existing?.toolName ?? "codex_tool",
      status: "completed",
      ...(existing?.input !== undefined ? { input: existing.input } : {}),
      ...(output !== undefined ? { output } : {}),
      ...(existing?.startedAt !== undefined ? { startedAt: existing.startedAt } : {}),
      ...(timestamp !== undefined ? { completedAt: timestamp } : {}),
    });
    return id;
  }
  return undefined;
};

const codexUsageRecord = (
  machineId: string,
  sourcePath: string,
  sessionId: string,
  eventId: string,
  sequence: number,
  timestamp: string | undefined,
  payload: CodexRecord,
): CodexUsageDraft | undefined => {
  if (payloadTypeFrom(payload) !== "token_count") return undefined;
  const info = recordFrom(payload.info);
  const nestedTotalUsage = recordFrom(info.total_token_usage);
  const usage =
    Object.keys(nestedTotalUsage).length > 0
      ? nestedTotalUsage
      : Object.keys(info).length > 0
        ? info
        : payload;
  const inputTokens =
    numberValue(usage.input_tokens) ??
    numberValue(usage.inputTokens) ??
    numberValue(usage.prompt_tokens) ??
    numberValue(usage.promptTokens);
  const outputTokens =
    numberValue(usage.output_tokens) ??
    numberValue(usage.outputTokens) ??
    numberValue(usage.completion_tokens) ??
    numberValue(usage.completionTokens);
  const reasoningTokens =
    numberValue(usage.reasoning_tokens) ?? numberValue(usage.reasoningTokens);
  const cacheCreationInputTokens =
    numberValue(usage.cache_creation_input_tokens) ??
    numberValue(usage.cacheCreationInputTokens);
  const cacheReadInputTokens =
    numberValue(usage.cache_read_input_tokens) ?? numberValue(usage.cacheReadInputTokens);
  const totalTokens =
    numberValue(usage.total_tokens) ??
    numberValue(usage.totalTokens) ??
    sumNumbers([
      inputTokens,
      outputTokens,
      reasoningTokens,
      cacheCreationInputTokens,
      cacheReadInputTokens,
    ]);
  return {
    id: usageIdFor("codex", machineId, sourcePath, sessionId, eventId, sequence),
    eventId,
    ...(timestamp !== undefined ? { timestamp } : {}),
    model:
      typeof usage.model === "string"
        ? usage.model
        : typeof payload.model === "string"
          ? payload.model
          : undefined,
    modelProvider: "openai",
    inputTokens,
    outputTokens,
    reasoningTokens,
    cacheCreationInputTokens,
    cacheReadInputTokens,
    totalTokens,
  };
};

const sumNumbers = (values: readonly (number | undefined)[]) => {
  const present = values.filter((value): value is number => value !== undefined);
  return present.length === 0
    ? undefined
    : present.reduce((sum, value) => sum + value, 0);
};

type CodexSessionSlice = {
  readonly events: CodexEventDraft[];
  readonly toolCallIds: Set<string>;
  readonly usageRecords: CodexUsageDraft[];
  readonly sessionEdges: CodexEdgeDraft[];
};

const emptyCodexSlice = (): CodexSessionSlice => ({
  events: [],
  toolCallIds: new Set<string>(),
  usageRecords: [],
  sessionEdges: [],
});

async function* readCodexJsonLines(path: string) {
  const lines = createInterface({
    input: createReadStream(path, { encoding: "utf8" }),
    crlfDelay: Infinity,
  });
  let lineNumber = 0;
  let recordIndex = 0;
  for await (const line of lines) {
    lineNumber += 1;
    if (line.trim().length === 0) continue;
    try {
      yield { value: JSON.parse(line) as unknown, lineNumber, recordIndex };
      recordIndex += 1;
    } catch {
      // Preserve best-effort behavior from readJsonLines.
    }
  }
}

const projectPathFromSessionMeta = (value: unknown) => {
  const record = recordFrom(value);
  if (record.type !== "session_meta") return undefined;
  const payload = recordFrom(record.payload);
  return typeof payload.cwd === "string"
    ? payload.cwd
    : typeof payload.working_dir === "string"
      ? payload.working_dir
      : undefined;
};

const codexSessionId = (
  machineId: string,
  nativeSessionId: string,
  sourcePath: string,
) => `codex:${machineId}:${stableWideHash(`${nativeSessionId}:${sourcePath}`)}`;

async function* streamCodexSessionFromFile(
  path: string,
  sourcePath: string,
  logicalSessionsRoot: string,
  options: AdapterOptions,
): AsyncGenerator<NormalizedSession> {
  const nativeSessionId = nativeSessionIdFromPath(sourcePath);
  const toolCallsById = new Map<string, CodexToolCallDraft>();
  const toolCallEventByToolId = new Map<string, string>();
  let projectPath: string | undefined;
  let slice = emptyCodexSlice();

  const buildCompleteSession = () => {
    if (slice.events.length === 0) return undefined;
    const session = buildSession({
      provider: "codex",
      agentName: "codex",
      machine: options.machine,
      nativeSessionId,
      nativeProjectKey: projectPath,
      sourceRoot: logicalSessionsRoot,
      sourcePath,
      projectPath,
      events: slice.events,
      toolCalls: [...slice.toolCallIds].flatMap((id) => {
        const toolCall = toolCallsById.get(id);
        return toolCall === undefined ? [] : [toolCall];
      }),
      usageRecords: slice.usageRecords,
      sessionEdges: slice.sessionEdges,
    });
    slice = emptyCodexSlice();

    return {
      ...session,
      eventCount: session.events.length,
      toolCallCount: session.toolCalls.length,
      contentBlockCount: session.events.reduce(
        (count, event) => count + event.contentBlocks.length,
        0,
      ),
      sessionEdgeCount: session.sessionEdges.length,
      usageRecordCount: session.usageRecords.length,
      artifactCount: session.artifacts.length,
    };
  };

  for await (const { value, lineNumber, recordIndex } of readCodexJsonLines(path)) {
    projectPath ??= projectPathFromSessionMeta(value);
    const record =
      typeof value === "object" && value !== null
        ? (value as Record<string, unknown>)
        : {};
    const nativeType = typeof record.type === "string" ? record.type : "unknown";
    const payloadValue = record.payload;
    const payloadRecord = payloadRecordFrom(payloadValue);
    const content = projectSessionNativeValue(payloadValue);
    const payloadType = payloadTypeFrom(payloadRecord);
    const role = codexRoleFrom(nativeType, payloadType, payloadRecord);
    const kind = codexKindFrom(nativeType, payloadType, payloadRecord);
    const payloadCallId = callIdFromPayload(payloadRecord);
    const nativeEventId =
      typeof payloadRecord.id === "string"
        ? payloadRecord.id
        : payloadCallId ?? (typeof record.id === "string" ? record.id : undefined);
    const eventId = eventIdFor(
      "codex",
      options.machine.machineId,
      sourcePath,
      recordIndex,
      nativeEventId ?? lineNumber,
    );
    const timestamp = typeof record.timestamp === "string" ? record.timestamp : undefined;
    const toolCallId = upsertCodexToolCall(
      toolCallsById,
      options.machine.machineId,
      nativeSessionId,
      sourcePath,
      eventId,
      timestamp,
      payloadRecord,
    );
    if (toolCallId !== undefined) {
      slice.toolCallIds.add(toolCallId);
      if (kind === "tool_call") toolCallEventByToolId.set(toolCallId, eventId);
      if (kind === "tool_result") {
        const callEventId = toolCallEventByToolId.get(toolCallId);
        if (callEventId !== undefined) {
          slice.sessionEdges.push({
            id: edgeIdFor("codex", options.machine.machineId, sourcePath, "tool_result_for", callEventId, eventId),
            kind: "tool_result_for",
            fromEventId: callEventId,
            toEventId: eventId,
          });
        }
      }
    }
    const usageRecord = codexUsageRecord(
      options.machine.machineId,
      sourcePath,
      nativeSessionId,
      eventId,
      recordIndex,
      timestamp,
      payloadRecord,
    );
    if (usageRecord !== undefined) slice.usageRecords.push(usageRecord);
    slice.events.push({
      id: eventId,
      nativeEventId,
      sequence: recordIndex,
      timestamp,
      role,
      kind,
      contentText: compactText(content),
      contentSource: content,
      ...(toolCallId !== undefined ? { toolCallId } : {}),
      rawReference: {
        sourcePath,
        line: lineNumber,
        nativeType: codexNativeType(nativeType, payloadType),
      },
    });
  }

  const final = buildCompleteSession();
  if (final !== undefined) yield final;
}

async function* streamCodex(options: AdapterOptions) {
  const root = options.roots?.codex ?? codexAdapter.defaultRoot();
  if (root === undefined || !existsSync(root)) {
    yield {
      type: "diagnostic" as const,
      diagnostic: {
        adapterId: codexAdapter.id,
        provider: "codex" as const,
        status: "no_data_found" as const,
        parserConfidence: "documented" as const,
        message: "Codex root was not found.",
        ...(root !== undefined ? { rootPath: root } : {}),
      },
    };
    return;
  }

  const sessionsRoot = join(root, "sessions");
  const logicalRoot = logicalRootFor("codex", root, options);
  const logicalSessionsRoot = join(logicalRoot, "sessions");
  const files = collectFiles(
    sessionsRoot,
    (path) => /rollout-.*\.jsonl$/.test(path),
    options.limit,
    options.skip,
  );
  yield {
    type: "sourceRoot" as const,
    sourceRoot: sourceRoot("codex", codexAdapter.id, logicalSessionsRoot, options.machine, options.now),
  };
  let sessionCount = 0;
  for (const path of files) {
    sessionCount += 1;
    for await (const session of streamCodexSessionFromFile(
        path,
        logicalPathFor(path, sessionsRoot, logicalSessionsRoot),
        logicalSessionsRoot,
        options,
    )) {
      yield {
        type: "session" as const,
        session,
      };
    }
  }
  yield {
    type: "diagnostic" as const,
    diagnostic: {
      adapterId: codexAdapter.id,
      provider: "codex" as const,
      status: sessionCount > 0 ? ("available" as const) : ("no_data_found" as const),
      parserConfidence: "documented" as const,
      rootPath: logicalSessionsRoot,
      message: `Discovered ${sessionCount} Codex session(s).`,
    },
  };
}

export const codexAdapter: SessionAdapter = {
  id: "codex-local-jsonl",
  provider: "codex",
  displayName: "Codex local JSONL",
  stable: true,
  defaultRoot: () => process.env.CODEX_HOME ?? homePath(".codex"),
  read: async (options) => collectAdapterStream(streamCodex(options)),
  stream: streamCodex,
};
