import { existsSync } from "node:fs";
import { join } from "node:path";

import type { SessionAdapter } from "./types";
import type { SessionEventKind, SessionRole, ToolCall, UsageRecord } from "../schemas";
import { stableWideHash } from "../hash";
import {
  buildSession,
  collectFiles,
  compactText,
  eventIdFor,
  homePath,
  kindFromNative,
  nativeSessionIdFromPath,
  numberValue,
  readJsonLines,
  recordFrom,
  roleFrom,
  sourceRoot,
  type NativeValue,
  usageIdFor,
} from "./common";

type CodexRecord = Record<string, unknown>;
type CodexToolCallDraft = Omit<
  ToolCall,
  "sessionId" | "machineId" | "provider" | "agentName" | "projectIdentityKey"
>;
type CodexUsageDraft = Omit<
  UsageRecord,
  "sessionId" | "machineId" | "provider" | "agentName" | "projectIdentityKey"
>;

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
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
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
    toolCallsById.set(id, {
      ...existing,
      id,
      eventId: existing?.eventId ?? eventId,
      toolName,
      status: existing?.status === "completed" ? "completed" : "started",
      input: parseToolInput(payload.arguments),
      ...(existing?.output !== undefined ? { output: existing.output } : {}),
      ...(timestamp !== undefined ? { startedAt: timestamp } : {}),
      ...(existing?.completedAt !== undefined ? { completedAt: existing.completedAt } : {}),
    });
    return id;
  }
  if (payloadType === "function_call_output") {
    const existing = toolCallsById.get(id);
    toolCallsById.set(id, {
      id,
      eventId: existing?.eventId ?? eventId,
      toolName: existing?.toolName ?? "codex_tool",
      status: "completed",
      ...(existing?.input !== undefined ? { input: existing.input } : {}),
      output: payload.output,
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

export const codexAdapter: SessionAdapter = {
  id: "codex-local-jsonl",
  provider: "codex",
  displayName: "Codex local JSONL",
  stable: true,
  defaultRoot: () => process.env.CODEX_HOME ?? homePath(".codex"),
  read: async (options) => {
    const root = options.roots?.codex ?? codexAdapter.defaultRoot();
    if (root === undefined || !existsSync(root)) {
      return {
        sourceRoots: [],
        sessions: [],
        diagnostics: [
          {
          adapterId: codexAdapter.id,
          provider: "codex",
          status: "no_data_found",
          parserConfidence: "documented",
          message: "Codex root was not found.",
            ...(root !== undefined ? { rootPath: root } : {}),
          },
        ],
      };
    }

    const sessionsRoot = join(root, "sessions");
    const files = collectFiles(
      sessionsRoot,
      (path) => /rollout-.*\.jsonl$/.test(path),
      options.limit,
    );
    const rootRecord = sourceRoot("codex", codexAdapter.id, sessionsRoot, options.machine, options.now);
    const sessions = files.map((path) => {
      const lines = readJsonLines(path);
      const nativeSessionId = nativeSessionIdFromPath(path);
      const sessionMeta = lines.find(
        ({ value }) =>
          typeof value === "object" &&
          value !== null &&
          (value as Record<string, unknown>).type === "session_meta",
      )?.value as Record<string, unknown> | undefined;
      const payload =
        sessionMeta?.payload !== null && typeof sessionMeta?.payload === "object"
          ? (sessionMeta.payload as Record<string, unknown>)
          : undefined;
      const projectPath =
        typeof payload?.cwd === "string"
          ? payload.cwd
            : typeof payload?.working_dir === "string"
              ? payload.working_dir
              : undefined;

      const toolCallsById = new Map<string, CodexToolCallDraft>();
      const usageRecords: CodexUsageDraft[] = [];
      const events = lines.map(({ value, lineNumber }, index) => {
        const record =
          typeof value === "object" && value !== null
            ? (value as Record<string, unknown>)
            : {};
        const nativeType = typeof record.type === "string" ? record.type : "unknown";
        const payloadValue = record.payload;
        const payloadRecord = payloadRecordFrom(payloadValue);
        const payloadType = payloadTypeFrom(payloadRecord);
        const role = codexRoleFrom(nativeType, payloadType, payloadRecord);
        const kind = codexKindFrom(nativeType, payloadType, payloadRecord);
        const payloadCallId = callIdFromPayload(payloadRecord);
        const nativeEventId =
          typeof payloadRecord.id === "string"
            ? payloadRecord.id
            : payloadCallId ?? (typeof record.id === "string" ? record.id : undefined);
        const eventId = eventIdFor("codex", options.machine.machineId, path, index, nativeEventId ?? lineNumber);
        const timestamp =
          typeof record.timestamp === "string" ? record.timestamp : undefined;
        const toolCallId = upsertCodexToolCall(
          toolCallsById,
          options.machine.machineId,
          nativeSessionId,
          path,
          eventId,
          timestamp,
          payloadRecord,
        );
        const usageRecord = codexUsageRecord(
          options.machine.machineId,
          path,
          nativeSessionId,
          eventId,
          index,
          timestamp,
          payloadRecord,
        );
        if (usageRecord !== undefined) usageRecords.push(usageRecord);
        return {
          id: eventId,
          nativeEventId,
          sequence: index,
          timestamp,
          role,
          kind,
          contentText: compactText(payloadValue as NativeValue | undefined),
          contentSource: payloadValue as NativeValue | undefined,
          ...(toolCallId !== undefined ? { toolCallId } : {}),
          rawReference: {
            sourcePath: path,
            line: lineNumber,
            nativeType: codexNativeType(nativeType, payloadType),
          },
        };
      });

      return buildSession({
        provider: "codex",
        agentName: "codex",
        machine: options.machine,
        nativeSessionId,
        nativeProjectKey: projectPath,
        sourceRoot: sessionsRoot,
        sourcePath: path,
        projectPath,
        events,
        toolCalls: [...toolCallsById.values()],
        usageRecords,
      });
    });

    return {
      sourceRoots: [rootRecord],
      sessions,
      diagnostics: [
        {
          adapterId: codexAdapter.id,
          provider: "codex",
          status: sessions.length > 0 ? "available" : "no_data_found",
          parserConfidence: "documented",
          rootPath: sessionsRoot,
          message: `Discovered ${sessions.length} Codex session(s).`,
        },
      ],
    };
  },
};
