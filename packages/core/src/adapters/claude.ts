import { existsSync } from "node:fs";
import { join } from "node:path";

import { collectAdapterStream, type SessionAdapter } from "./types";
import type { SessionEdge, ToolCall, UsageRecord } from "../schemas";
import {
  buildSession,
  collectFiles,
  compactText,
  edgeIdFor,
  eventIdFor,
  homePath,
  kindFromNative,
  nativeSessionIdFromPath,
  numberValue,
  parentDirectoryName,
  readJsonLines,
  recordFrom,
  roleFrom,
  scopedId,
  sourceRoot,
  type NativeValue,
  usageIdFor,
} from "./common";

const projectPathFromClaudeKey = (key: string) =>
  key.startsWith("-") ? key.replace(/^-/, "/").replaceAll("-", "/") : key;

type AdapterOptions = Parameters<SessionAdapter["read"]>[0];
type ClaudeToolCallDraft = Omit<
  ToolCall,
  "sessionId" | "machineId" | "provider" | "agentName" | "projectIdentityKey"
>;
type ClaudeUsageDraft = Omit<
  UsageRecord,
  "sessionId" | "machineId" | "provider" | "agentName" | "projectIdentityKey"
>;
type ClaudeEdgeDraft = Omit<
  SessionEdge,
  "sessionId" | "machineId" | "provider" | "agentName" | "projectIdentityKey"
>;

const contentArray = (message: Record<string, unknown> | undefined) =>
  Array.isArray(message?.content) ? (message.content as unknown[]) : [];

const claudeStructuredContentProjection = (value: unknown): NativeValue => {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    return value.flatMap((item) => {
      const block = recordFrom(item);
      const type = typeof block.type === "string" ? block.type : undefined;
      if (type === "text" && typeof block.text === "string") {
        return [{ type, text: block.text } as NativeValue];
      }
      if (type === "thinking" && typeof block.thinking === "string") {
        return [{ type, thinking: block.thinking } as NativeValue];
      }
      if (type === "document") {
        return [
          {
            type,
            ...(typeof block.title === "string" ? { title: block.title } : {}),
            ...(typeof block.media_type === "string" ? { media_type: block.media_type } : {}),
            ...(block.content !== undefined
              ? { content: claudeStructuredContentProjection(block.content) }
              : {}),
          } as NativeValue,
        ];
      }
      if (type === "image") {
        return [
          {
            type,
            ...(typeof block.media_type === "string" ? { media_type: block.media_type } : {}),
          } as NativeValue,
        ];
      }
      if (type === "file") {
        return [
          {
            type,
            ...(typeof block.file_path === "string" ? { file_path: block.file_path } : {}),
            ...(typeof block.media_type === "string" ? { media_type: block.media_type } : {}),
          } as NativeValue,
        ];
      }
      if (Object.keys(block).length > 0) {
        return [{ type: type ?? "json", value: block } as NativeValue];
      }
      return [];
    });
  }
  if (value !== undefined && value !== null) return value as NativeValue;
  return {};
};

const claudeContentProjection = (
  message: Record<string, unknown> | undefined,
  record: Record<string, unknown>,
): NativeValue => {
  if (typeof message?.content === "string") return message.content;
  const blocks = contentArray(message);
  if (blocks.length > 0) {
    return blocks.flatMap((blockValue) => {
      const block = recordFrom(blockValue);
      const type = typeof block.type === "string" ? block.type : undefined;
      if (type === "text" && typeof block.text === "string") {
        return [{ type, text: block.text } as NativeValue];
      }
      if (type === "thinking" && typeof block.thinking === "string") {
        return [{ type, thinking: block.thinking } as NativeValue];
      }
      if (type === "tool_use") {
        return [
          {
            type,
            ...(typeof block.id === "string" ? { id: block.id } : {}),
            ...(typeof block.name === "string" ? { name: block.name } : {}),
            ...(block.input !== undefined ? { input: block.input as NativeValue } : {}),
          } as NativeValue,
        ];
      }
      if (type === "tool_result") {
        return [
          {
            type,
            ...(typeof block.tool_use_id === "string" ? { tool_use_id: block.tool_use_id } : {}),
            ...(block.content !== undefined
              ? { content: claudeStructuredContentProjection(block.content) }
              : {}),
          } as NativeValue,
        ];
      }
      if (type === "image") {
        return [
          {
            type,
            ...(typeof block.media_type === "string" ? { media_type: block.media_type } : {}),
          } as NativeValue,
        ];
      }
      if (type === "file") {
        return [
          {
            type,
            ...(typeof block.file_path === "string" ? { file_path: block.file_path } : {}),
            ...(typeof block.media_type === "string" ? { media_type: block.media_type } : {}),
          } as NativeValue,
        ];
      }
      return [];
    });
  }
  return record.content as NativeValue | undefined ?? {};
};

const toolCallIdFor = (machineId: string, sourcePath: string, nativeToolId: string) =>
  scopedId("claude", machineId, sourcePath, "tool", nativeToolId);

const upsertClaudeToolCalls = (
  toolCallsById: Map<string, ClaudeToolCallDraft>,
  machineId: string,
  sourcePath: string,
  eventId: string,
  timestamp: string | undefined,
  blocks: readonly unknown[],
) => {
  let eventToolCallId: string | undefined;
  for (const blockValue of blocks) {
    const block = recordFrom(blockValue);
    const type = typeof block.type === "string" ? block.type : undefined;
    if (type === "tool_use" && typeof block.id === "string") {
      const id = toolCallIdFor(machineId, sourcePath, block.id);
      const existing = toolCallsById.get(id);
      toolCallsById.set(id, {
        ...existing,
        id,
        eventId: existing?.eventId ?? eventId,
        toolName: typeof block.name === "string" ? block.name : existing?.toolName ?? "claude_tool",
        status: existing?.status === "completed" ? "completed" : "started",
        input: block.input,
        ...(existing?.output !== undefined ? { output: existing.output } : {}),
        ...(timestamp !== undefined ? { startedAt: timestamp } : {}),
        ...(existing?.completedAt !== undefined ? { completedAt: existing.completedAt } : {}),
      });
      eventToolCallId = id;
      continue;
    }
    if (type === "tool_result" && typeof block.tool_use_id === "string") {
      const id = toolCallIdFor(machineId, sourcePath, block.tool_use_id);
      const existing = toolCallsById.get(id);
      toolCallsById.set(id, {
        id,
        eventId: existing?.eventId ?? eventId,
        toolName: existing?.toolName ?? "claude_tool",
        status: "completed",
        ...(existing?.input !== undefined ? { input: existing.input } : {}),
        output: block.content,
        ...(existing?.startedAt !== undefined ? { startedAt: existing.startedAt } : {}),
        ...(timestamp !== undefined ? { completedAt: timestamp } : {}),
      });
      eventToolCallId = id;
    }
  }
  return eventToolCallId;
};

const claudeKindFrom = (type: string, blocks: readonly unknown[]) => {
  if (blocks.some((block) => recordFrom(block).type === "tool_result")) return "tool_result" as const;
  if (blocks.some((block) => recordFrom(block).type === "tool_use")) return "tool_call" as const;
  if (type === "file-history-snapshot") return "snapshot" as const;
  if (type === "permission-mode") return "system" as const;
  return kindFromNative(type);
};

const claudeUsageRecord = (
  machineId: string,
  sourcePath: string,
  nativeSessionId: string,
  eventId: string,
  sequence: number,
  timestamp: string | undefined,
  message: Record<string, unknown> | undefined,
): ClaudeUsageDraft | undefined => {
  const usage = recordFrom(message?.usage);
  if (Object.keys(usage).length === 0) return undefined;
  const inputTokens =
    numberValue(usage.input_tokens) ?? numberValue(usage.inputTokens);
  const outputTokens =
    numberValue(usage.output_tokens) ?? numberValue(usage.outputTokens);
  const cacheCreationInputTokens =
    numberValue(usage.cache_creation_input_tokens) ??
    numberValue(usage.cacheCreationInputTokens);
  const cacheReadInputTokens =
    numberValue(usage.cache_read_input_tokens) ?? numberValue(usage.cacheReadInputTokens);
  return {
    id: usageIdFor("claude", machineId, sourcePath, nativeSessionId, eventId, sequence),
    eventId,
    ...(timestamp !== undefined ? { timestamp } : {}),
    model: typeof message?.model === "string" ? message.model : undefined,
    modelProvider: "anthropic",
    inputTokens,
    outputTokens,
    cacheCreationInputTokens,
    cacheReadInputTokens,
    totalTokens: sumNumbers([inputTokens, outputTokens, cacheCreationInputTokens, cacheReadInputTokens]),
  };
};

const sumNumbers = (values: readonly (number | undefined)[]) => {
  const present = values.filter((value): value is number => value !== undefined);
  return present.length === 0
    ? undefined
    : present.reduce((sum, value) => sum + value, 0);
};

const buildClaudeSessionFromFile = (
  path: string,
  projectsRoot: string,
  options: AdapterOptions,
) => {
  const lines = readJsonLines(path);
  const projectKey = parentDirectoryName(path);
  const firstRecord = lines[0]?.value as Record<string, unknown> | undefined;
  const projectPath =
    typeof firstRecord?.cwd === "string"
      ? firstRecord.cwd
      : projectPathFromClaudeKey(projectKey);
  const toolCallsById = new Map<string, ClaudeToolCallDraft>();
  const usageRecords: ClaudeUsageDraft[] = [];
  const nativeUuidToEventId = new Map<string, string>();
  const parentEdges: ClaudeEdgeDraft[] = [];
  const events = lines.map(({ value, lineNumber }, index) => {
    const record =
      typeof value === "object" && value !== null
        ? (value as Record<string, unknown>)
        : {};
    const type = typeof record.type === "string" ? record.type : "unknown";
    const message =
      record.message !== null && typeof record.message === "object"
        ? (record.message as Record<string, unknown>)
        : undefined;
    const content = claudeContentProjection(message, record);
    const nativeEventId = typeof record.uuid === "string" ? record.uuid : undefined;
    const eventId = eventIdFor("claude", options.machine.machineId, path, index, nativeEventId ?? lineNumber);
    if (nativeEventId !== undefined) nativeUuidToEventId.set(nativeEventId, eventId);
    const parentUuid = typeof record.parentUuid === "string" ? record.parentUuid : undefined;
    if (parentUuid !== undefined) {
      const parentEventId = nativeUuidToEventId.get(parentUuid);
      parentEdges.push({
        id: edgeIdFor("claude", options.machine.machineId, path, "parent", parentUuid, nativeEventId ?? eventId),
        kind: "parent",
        ...(parentEventId !== undefined ? { fromEventId: parentEventId } : { fromId: parentUuid }),
        toEventId: eventId,
        rawReference: { sourcePath: path, line: lineNumber, nativeType: "parentUuid" },
      });
    }
    const timestamp =
      typeof record.timestamp === "string" ? record.timestamp : undefined;
    const blocks = contentArray(message);
    const toolCallId = upsertClaudeToolCalls(
      toolCallsById,
      options.machine.machineId,
      path,
      eventId,
      timestamp,
      blocks,
    );
    const usageRecord = claudeUsageRecord(
      options.machine.machineId,
      path,
      nativeSessionIdFromPath(path),
      eventId,
      index,
      timestamp,
      message,
    );
    if (usageRecord !== undefined) usageRecords.push(usageRecord);
    return {
      id: eventId,
      nativeEventId,
      parentEventId:
        parentUuid === undefined ? undefined : nativeUuidToEventId.get(parentUuid) ?? parentUuid,
      sequence: index,
      timestamp,
      role: roleFrom(
        typeof message?.role === "string" ? message.role : type,
      ),
      kind: claudeKindFrom(type, blocks),
      contentText: compactText(content),
      contentSource: content,
      ...(toolCallId !== undefined ? { toolCallId } : {}),
      rawReference: { sourcePath: path, line: lineNumber, nativeType: type },
    };
  });
  return buildSession({
    provider: "claude",
    agentName: "claude-code",
    machine: options.machine,
    nativeSessionId: nativeSessionIdFromPath(path),
    nativeProjectKey: projectKey,
    sourceRoot: projectsRoot,
    sourcePath: path,
    projectPath,
    events,
    toolCalls: [...toolCallsById.values()],
    sessionEdges: parentEdges,
    usageRecords,
  });
};

async function* streamClaude(options: AdapterOptions) {
  const root = options.roots?.claude ?? claudeAdapter.defaultRoot();
  if (root === undefined || !existsSync(root)) {
    yield {
      type: "diagnostic" as const,
      diagnostic: {
        adapterId: claudeAdapter.id,
        provider: "claude" as const,
        status: "no_data_found" as const,
        parserConfidence: "observed" as const,
        message: "Claude root was not found.",
        ...(root !== undefined ? { rootPath: root } : {}),
      },
    };
    return;
  }
  const projectsRoot = join(root, "projects");
  const files = collectFiles(projectsRoot, (path) => path.endsWith(".jsonl"), options.limit);
  yield {
    type: "sourceRoot" as const,
    sourceRoot: sourceRoot("claude", claudeAdapter.id, projectsRoot, options.machine, options.now),
  };
  let sessionCount = 0;
  for (const path of files) {
    sessionCount += 1;
    yield {
      type: "session" as const,
      session: buildClaudeSessionFromFile(path, projectsRoot, options),
    };
  }
  yield {
    type: "diagnostic" as const,
    diagnostic: {
      adapterId: claudeAdapter.id,
      provider: "claude" as const,
      status: sessionCount > 0 ? ("available" as const) : ("no_data_found" as const),
      parserConfidence: "observed" as const,
      rootPath: projectsRoot,
      message: `Discovered ${sessionCount} Claude session(s).`,
    },
  };
}

export const claudeAdapter: SessionAdapter = {
  id: "claude-code-project-jsonl",
  provider: "claude",
  displayName: "Claude Code project JSONL",
  stable: true,
  defaultRoot: () => process.env.CLAUDE_CONFIG_DIR ?? homePath(".claude"),
  read: async (options) => collectAdapterStream(streamClaude(options)),
  stream: streamClaude,
};
