import { existsSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";

import { collectAdapterStream, type AdapterStreamItem, type SessionAdapter } from "./types";
import { GrokSessionId, type SessionId } from "../core/identity";
import type { Artifact, SessionEvent, ToolCall } from "../core/schemas";
import {
  artifactIdFor,
  buildSession,
  collectFiles,
  compactText,
  eventIdFor,
  homePath,
  kindFromNative,
  parseJsonString,
  projectSessionNativeValue,
  projectToolPayloadNativeValue,
  recordFrom,
  readJsonFile,
  readJsonLines,
  roleFrom,
  scopedId,
  sessionIdFor,
  sourceFingerprintFor,
  sourceRoot,
  stringValue,
  type NativeValue,
} from "./common";

const decodeProjectPath = (encoded: string) => {
  try {
    return decodeURIComponent(encoded);
  } catch {
    return encoded;
  }
};

type GrokToolCallDraft = Omit<
  ToolCall,
  "sessionId" | "machineId" | "provider" | "agentName" | "projectIdentityKey"
>;
type GrokArtifactDraft = Omit<
  Artifact,
  "sessionId" | "machineId" | "provider" | "agentName" | "projectIdentityKey"
>;
type GrokEventDraft = Omit<
  SessionEvent,
  "sessionId" | "machineId" | "provider" | "agentName" | "projectIdentityKey" | "contentBlocks"
> & { readonly contentBlocks?: readonly import("../core/schemas").ContentBlock[]; readonly contentSource?: NativeValue };
type AdapterOptions = Parameters<SessionAdapter["read"]>[0];

const grokSessionFingerprint = (sessionDir: string) => {
  let size = 0;
  let mtimeMs = 0;
  for (const fileName of ["chat_history.jsonl", "events.jsonl", "updates.jsonl"]) {
    const path = join(sessionDir, fileName);
    if (!existsSync(path)) continue;
    const stat = statSync(path);
    size += stat.size;
    mtimeMs = Math.max(mtimeMs, stat.mtimeMs);
  }
  return { size, mtimeMs };
};

const grokTime = (record: Record<string, unknown>) => {
  if (typeof record.timestamp === "string") return record.timestamp;
  if (typeof record.ts === "string") return record.ts;
  if (typeof record.timestamp === "number") return new Date(record.timestamp * 1000).toISOString();
  if (typeof record.ts === "number") return new Date(record.ts * 1000).toISOString();
  return undefined;
};

const grokToolName = (record: Record<string, unknown>) => {
  if (typeof record.toolName === "string") return record.toolName;
  if (typeof record.tool === "string") return record.tool;
  // tool_calls array entries have `name` directly (no `type` wrapping)
  if (typeof record.name === "string" && record.type === undefined) return record.name;
  if (typeof record.name === "string" && String(record.type ?? "").includes("tool")) return record.name;
  const state = recordFrom(record.state);
  if (typeof state.tool === "string") return state.tool;
  const params = recordFrom(record.params);
  if (typeof params.tool === "string") return params.tool;
  return undefined;
};

const stringContent = (record: Record<string, unknown>) =>
  typeof record.content === "string"
    ? record.content
    : typeof record.text === "string"
      ? record.text
      : typeof record.message === "string"
        ? record.message
        : undefined;

const CONTENT_KEYS = ["content", "text", "message", "delta", "response", "output", "result"] as const;

const grokNestedContent = (record: Record<string, unknown>): NativeValue | undefined => {
  const direct = contentFields(record);
  if (direct !== undefined) return direct;
  for (const key of ["params", "state", "delta"] as const) {
    const nested = contentFields(recordFrom(record[key]));
    if (nested !== undefined) return nested;
  }
  return undefined;
};

const contentFields = (record: Record<string, unknown>): NativeValue | undefined => {
  const text = stringContent(record);
  if (text !== undefined) return text;
  const entries = CONTENT_KEYS.flatMap((key) => {
    const value = record[key];
    return value === undefined ? [] : [[key, value] as const];
  });
  return entries.length === 0 ? undefined : projectSessionNativeValue(Object.fromEntries(entries));
};

const grokToolCall = (
  sessionId: SessionId,
  eventId: string,
  record: Record<string, unknown>,
): GrokToolCallDraft | undefined => {
  const toolName = grokToolName(record);
  if (toolName === undefined) return undefined;
  const state = recordFrom(record.state);
  const nativeToolId =
    typeof record.callID === "string"
      ? record.callID
      : typeof record.call_id === "string"
        ? record.call_id
        : typeof record.toolCallId === "string"
          ? record.toolCallId
          : typeof record.id === "string"
            ? record.id
            : eventId;
  const timestamp = grokTime(record);
  const status =
    typeof state.status === "string"
      ? state.status
      : typeof record.status === "string"
        ? record.status
        : undefined;
  const input = projectToolPayloadNativeValue(state.input ?? record.input ?? record.args ?? record.params);
  const output = projectToolPayloadNativeValue(state.output ?? record.output ?? record.result);
  return {
    id: scopedId(sessionId, "tool", nativeToolId),
    eventId,
    toolName,
    status,
    ...(input !== undefined ? { input } : {}),
    ...(output !== undefined ? { output } : {}),
    ...(timestamp !== undefined ? { startedAt: timestamp } : {}),
    ...(status === "completed" && timestamp !== undefined ? { completedAt: timestamp } : {}),
  };
};

const grokKind = (record: Record<string, unknown>) => {
  if (grokToolName(record) !== undefined) {
    const status = String(recordFrom(record.state).status ?? record.status ?? "");
    return status === "completed" ? ("tool_result" as const) : ("tool_call" as const);
  }
  const type =
    typeof record.type === "string"
      ? record.type
      : typeof record.method === "string"
        ? record.method
        : undefined;
  if (type === undefined) {
    return stringContent(record) === undefined ? ("lifecycle" as const) : ("message" as const);
  }
  if (type === "assistant" || type === "user" || type === "system") return "message" as const;
  return kindFromNative(type);
};

const grokContentProjection = (record: Record<string, unknown>): NativeValue | undefined => {
  const content = grokNestedContent(record);
  if (content !== undefined) return content;
  const toolName = grokToolName(record);
  if (toolName === undefined) return undefined;
  const state = recordFrom(record.state);
  const status =
    typeof state.status === "string"
      ? state.status
      : typeof record.status === "string"
        ? record.status
        : undefined;
  return {
    type: "tool",
    toolName,
    ...(status !== undefined ? { status } : {}),
  };
};

const grokArtifacts = (
  sessionId: SessionId,
  sessionDir: string,
  hunkPath: string,
) =>
  readJsonLines(hunkPath).flatMap(({ value, lineNumber }) => {
    const record = recordFrom(value);
    if (Object.keys(record).length === 0) return [];
    const path = typeof record.filePath === "string" ? record.filePath : undefined;
    const id = artifactIdFor(sessionId, record.hunkId ?? lineNumber);
    return [
      {
        id,
        kind: "edit_hunk",
        ...(path !== undefined ? { path } : {}),
        sourcePath: hunkPath,
        sourceRef: {
          line: lineNumber,
          hunkId: record.hunkId,
          hunkStart: record.hunkStart,
          hunkEnd: record.hunkEnd,
        },
        metadata: {
          linesAdded: record.linesAdded,
          linesRemoved: record.linesRemoved,
          authorType: record.authorType,
          eventType: record.eventType,
          timestamp: record.timestamp,
          sessionDir,
        },
      } satisfies GrokArtifactDraft,
    ];
  });

const grokSummaryRecord = (summary: unknown): Record<string, unknown> =>
  summary !== null && typeof summary === "object" && !Array.isArray(summary)
    ? (summary as Record<string, unknown>)
    : {};

/** Extract plaintext reasoning text from an assistant record's `reasoning` field. */
const grokReasoningText = (record: Record<string, unknown>): string | undefined => {
  const reasoningField = record.reasoning;
  if (reasoningField === undefined || reasoningField === null) return undefined;
  const reasoningRecord =
    typeof reasoningField === "string"
      ? recordFrom(parseJsonString(reasoningField))
      : recordFrom(reasoningField);
  return stringValue(reasoningRecord.text);
};

/** Collect tool calls from the `tool_calls` array on an assistant event.
 *  Returns the first collected tool id for the event's `toolCallId` link. */
const collectAssistantToolCalls = (
  sessionId: SessionId,
  eventId: string,
  record: Record<string, unknown>,
  toolCallsById: Map<string, GrokToolCallDraft>,
): string | undefined => {
  const rawToolCalls = record.tool_calls;
  if (rawToolCalls === undefined || rawToolCalls === null) return undefined;
  const calls = Array.isArray(rawToolCalls)
    ? rawToolCalls
    : Array.isArray(parseJsonString(rawToolCalls))
      ? (parseJsonString(rawToolCalls) as unknown[])
      : [];
  let firstId: string | undefined;
  for (const call of calls) {
    const callRecord = recordFrom(call);
    const toolName = grokToolName(callRecord);
    if (toolName === undefined) continue;
    const nativeToolId = stringValue(callRecord.id) ?? eventId;
    const input = projectToolPayloadNativeValue(
      parseJsonString(callRecord.arguments) ?? callRecord.input ?? callRecord.params,
    );
    const timestamp = grokTime(record);
    const toolCall: GrokToolCallDraft = {
      id: scopedId(sessionId, "tool", nativeToolId),
      eventId,
      toolName,
      status: "started",
      ...(input !== undefined ? { input } : {}),
      ...(timestamp !== undefined ? { startedAt: timestamp } : {}),
    };
    toolCallsById.set(nativeToolId, toolCall);
    firstId ??= toolCall.id;
  }
  return firstId;
};

/** Merge a tool_result record's output into the matching ToolCall record. */
const mergeToolResult = (
  sessionId: SessionId,
  eventId: string,
  record: Record<string, unknown>,
  toolCallsById: Map<string, GrokToolCallDraft>,
): string | undefined => {
  const nativeToolId = stringValue(record.tool_call_id);
  if (nativeToolId === undefined) return undefined;
  const existing = toolCallsById.get(nativeToolId);
  const timestamp = grokTime(record);
  const output = projectToolPayloadNativeValue(
    stringValue(record.content) ?? record.content,
  );
  const merged: GrokToolCallDraft = {
    id: existing?.id ?? scopedId(sessionId, "tool", nativeToolId),
    eventId: existing?.eventId ?? eventId,
    toolName: existing?.toolName ?? "grok_tool",
    status: "completed",
    ...(existing?.input !== undefined ? { input: existing.input } : {}),
    ...(output !== undefined ? { output } : {}),
    ...(existing?.startedAt !== undefined ? { startedAt: existing.startedAt } : {}),
    ...(timestamp !== undefined ? { completedAt: timestamp } : {}),
  };
  toolCallsById.set(nativeToolId, merged);
  return merged.id;
};

const buildGrokSessionFromChatPath = (
  chatPath: string,
  sessionsRoot: string,
  options: AdapterOptions,
) => {
  const sessionDir = dirname(chatPath);
  const nativeSessionId = GrokSessionId(basename(sessionDir));
  const sessionId = sessionIdFor("grok", nativeSessionId);
  const projectKey = basename(dirname(sessionDir));
  const projectPath = decodeProjectPath(projectKey);
  const summary = grokSummaryRecord(readJsonFile(join(sessionDir, "summary.json")));
  const chatLines = readJsonLines(chatPath);
  const readOptionalLines = (path: string) => (existsSync(path) ? readJsonLines(path) : []);
  const eventLines = readOptionalLines(join(sessionDir, "events.jsonl"));
  const updateLines = readOptionalLines(join(sessionDir, "updates.jsonl"));
  const hunkPath = join(sessionDir, "hunk_records.jsonl");
  const toolCallsById = new Map<string, GrokToolCallDraft>();

  // Derive session metadata from summary.json.
  const generatedTitle = stringValue(summary.generated_title);
  const agentName =
    stringValue(summary.agent_name) ?? stringValue(summary.current_model_id) ?? "grok-build";
  const gitRemote = (() => {
    const remotes = summary.git_remotes;
    if (Array.isArray(remotes) && typeof remotes[0] === "string") return remotes[0] as string;
    return undefined;
  })();

  const collectTool = (
    eventId: string,
    record: Record<string, unknown>,
  ) => {
    const toolCall = grokToolCall(sessionId, eventId, record);
    if (toolCall !== undefined) toolCallsById.set(toolCall.id, toolCall);
    return toolCall?.id;
  };

  const events = [
    ...chatLines.flatMap(({ value, lineNumber }, index) => {
      const record =
        typeof value === "object" && value !== null
          ? (value as Record<string, unknown>)
          : {};
      const type = typeof record.type === "string" ? record.type : "message";
      const nativeEventId =
        typeof record.id === "string" ? record.id : undefined;
      const eventId = eventIdFor(sessionId, index, nativeEventId ?? lineNumber);

      const result: GrokEventDraft[] = [];

      if (type === "assistant") {
        // Emit a reasoning event ahead of the assistant reply when plaintext reasoning exists.
        const reasoningText = grokReasoningText(record);
        if (reasoningText !== undefined) {
          const reasoningEventId = `${eventId}:r`;
          result.push({
            id: reasoningEventId,
            nativeEventId: nativeEventId !== undefined ? `${nativeEventId}:r` : undefined,
            sequence: index,
            timestamp: grokTime(record),
            role: "thinking" as const,
            kind: "reasoning" as const,
            contentText: reasoningText,
            rawReference: { sourcePath: chatPath, line: lineNumber, nativeType: "reasoning" },
          });
        }

        // Collect tool calls from the tool_calls array.
        const toolCallId =
          collectAssistantToolCalls(
            sessionId,
            eventId,
            record,
            toolCallsById,
          ) ?? collectTool(eventId, record);

        const content = grokContentProjection(record);
        result.push({
          id: eventId,
          nativeEventId,
          sequence: index,
          timestamp: grokTime(record),
          role: roleFrom(type),
          kind: toolCallId !== undefined ? ("tool_call" as const) : ("message" as const),
          contentText: compactText(content),
          contentSource: content,
          ...(toolCallId !== undefined ? { toolCallId } : {}),
          rawReference: { sourcePath: chatPath, line: lineNumber, nativeType: type },
        });
      } else if (type === "tool_result") {
        // Merge content into the matching ToolCall record.
        const toolCallId = mergeToolResult(
          sessionId,
          eventId,
          record,
          toolCallsById,
        ) ?? collectTool(eventId, record);
        const content = grokContentProjection(record);
        result.push({
          id: eventId,
          nativeEventId,
          sequence: index,
          timestamp: grokTime(record),
          role: "unknown" as const,
          kind: "tool_result" as const,
          contentText: compactText(content),
          contentSource: content,
          ...(toolCallId !== undefined ? { toolCallId } : {}),
          rawReference: { sourcePath: chatPath, line: lineNumber, nativeType: type },
        });
      } else {
        const toolCallId = collectTool(eventId, record);
        const content = grokContentProjection(record);
        result.push({
          id: eventId,
          nativeEventId,
          sequence: index,
          timestamp: grokTime(record),
          role: roleFrom(type),
          kind: grokKind(record),
          contentText: compactText(content),
          contentSource: content,
          ...(toolCallId !== undefined ? { toolCallId } : {}),
          rawReference: { sourcePath: chatPath, line: lineNumber, nativeType: type },
        });
      }
      return result;
    }),
    ...eventLines.map(({ value, lineNumber }, index) => {
      const record =
        typeof value === "object" && value !== null
          ? (value as Record<string, unknown>)
          : {};
      const type = typeof record.type === "string" ? record.type : "event";
      const eventPath = join(sessionDir, "events.jsonl");
      const nativeEventId =
        typeof record.id === "string" ? record.id : undefined;
      const eventId = eventIdFor(sessionId, index, nativeEventId ?? `events:${lineNumber}`);
      const toolCallId = collectTool(eventId, record);
      const content = grokContentProjection(record);
      return {
        id: eventId,
        nativeEventId,
        sequence: chatLines.length + index,
        timestamp: grokTime(record),
        role: "unknown" as const,
        kind: grokKind(record),
        contentText: compactText(content),
        contentSource: content,
        ...(toolCallId !== undefined ? { toolCallId } : {}),
        rawReference: {
          sourcePath: eventPath,
          line: lineNumber,
          nativeType: type,
        },
      };
    }),
    ...updateLines.map(({ value, lineNumber }, index) => {
      const record = recordFrom(value);
      const updatePath = join(sessionDir, "updates.jsonl");
      const type =
        typeof record.method === "string"
          ? record.method
          : typeof record.type === "string"
            ? record.type
            : "update";
      const eventId = eventIdFor(sessionId, index, `updates:${lineNumber}`);
      const toolCallId = collectTool(eventId, record);
      const content = grokContentProjection(record);
      return {
        id: eventId,
        sequence: chatLines.length + eventLines.length + index,
        timestamp: grokTime(record),
        role: "system" as const,
        kind: grokKind(record),
        contentText: compactText(content),
        contentSource: content,
        ...(toolCallId !== undefined ? { toolCallId } : {}),
        rawReference: { sourcePath: updatePath, line: lineNumber, nativeType: type },
      };
    }),
  ];
  return buildSession({
    provider: "grok",
    agentName,
    machine: options.machine,
    sessionId,
    nativeSessionId,
    nativeProjectKey: projectKey,
    title: generatedTitle,
    sourceRoot: sessionsRoot,
    sourcePath: sessionDir,
    projectPath,
    gitRemote,
    events,
    toolCalls: [...toolCallsById.values()],
    artifacts: existsSync(hunkPath)
      ? grokArtifacts(sessionId, sessionDir, hunkPath)
      : [],
  });
};

async function* streamGrok(options: AdapterOptions): AsyncGenerator<AdapterStreamItem> {
  const root = options.roots?.grok ?? grokAdapter.defaultRoot();
  if (root === undefined || !existsSync(root)) {
    yield {
      type: "diagnostic",
      diagnostic: {
        adapterId: grokAdapter.id,
        provider: "grok",
        status: "no_data_found",
        parserConfidence: "observed",
        message: "Grok root was not found.",
        ...(root !== undefined ? { rootPath: root } : {}),
      },
    };
    return;
  }
  const sessionsRoot = join(root, "sessions");
  const files = collectFiles(
    sessionsRoot,
    (path) => path.endsWith("chat_history.jsonl"),
    options.limit,
    options.skip,
  );
  const rootRecord = sourceRoot("grok", grokAdapter.id, sessionsRoot, options.machine, options.now);
  yield { type: "sourceRoot", sourceRoot: rootRecord };
  let sessionCount = 0;
  for (const chatPath of files) {
    // Cheap pre-parse gate over the full session surface: chat is canonical,
    // while events/updates are optional sidecars whose late creation must
    // invalidate the prior ingest.
    const sessionDir = dirname(chatPath);
    const fingerprint = grokSessionFingerprint(sessionDir);
    if (options.shouldParseSession !== undefined) {
      const probe = {
        sessionId: sessionIdFor("grok", GrokSessionId(basename(sessionDir))),
        sourceFingerprint: sourceFingerprintFor(fingerprint),
      };
      if ((await options.shouldParseSession(probe)) === false) continue;
    }
    const session = buildGrokSessionFromChatPath(chatPath, sessionsRoot, options);
    yield {
      type: "session",
      session,
      sourceUnit: {
        provider: "grok",
        adapterId: grokAdapter.id,
        rootPath: sessionsRoot,
        sourcePath: session.sourcePath,
        physicalPath: chatPath,
      },
      fingerprint,
    };
    sessionCount += 1;
  }
  yield {
    type: "diagnostic",
    diagnostic: {
      adapterId: grokAdapter.id,
      provider: "grok",
      status: sessionCount > 0 ? "available" : "no_data_found",
      parserConfidence: "observed",
      rootPath: sessionsRoot,
      message: `Discovered ${sessionCount} Grok session(s).`,
    },
  };
}

export const grokAdapter: SessionAdapter = {
  id: "grok-session-folder",
  provider: "grok",
  displayName: "Grok session folder",
  stable: true,
  defaultRoot: () => homePath(".grok"),
  read: async (options) => collectAdapterStream(streamGrok(options)),
  stream: streamGrok,
};
