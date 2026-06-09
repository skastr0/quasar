import { existsSync } from "node:fs";
import { basename, dirname, join } from "node:path";

import type { SessionAdapter } from "./types";
import type { Artifact, ToolCall } from "../schemas";
import {
  artifactIdFor,
  buildSession,
  collectFiles,
  compactText,
  eventIdFor,
  homePath,
  kindFromNative,
  recordFrom,
  readJsonFile,
  readJsonLines,
  roleFrom,
  scopedId,
  sourceRoot,
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

const grokToolCall = (
  machineId: string,
  sourcePath: string,
  nativeSessionId: string,
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
  return {
    id: scopedId("grok", machineId, sourcePath, "tool", nativeSessionId, nativeToolId),
    eventId,
    toolName,
    status,
    input: state.input ?? record.input ?? record.args ?? record.params,
    output: state.output ?? record.output ?? record.result,
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
  const text = stringContent(record);
  if (text !== undefined) return text;
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
  machineId: string,
  sessionDir: string,
  sessionId: string,
  hunkPath: string,
) =>
  readJsonLines(hunkPath).flatMap(({ value, lineNumber }) => {
    const record = recordFrom(value);
    if (Object.keys(record).length === 0) return [];
    const path = typeof record.filePath === "string" ? record.filePath : undefined;
    const id = artifactIdFor("grok", machineId, hunkPath, sessionId, record.hunkId ?? lineNumber);
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

export const grokAdapter: SessionAdapter = {
  id: "grok-session-folder",
  provider: "grok",
  displayName: "Grok session folder",
  stable: true,
  defaultRoot: () => homePath(".grok"),
  read: async (options) => {
    const root = options.roots?.grok ?? grokAdapter.defaultRoot();
    if (root === undefined || !existsSync(root)) {
      return {
        sourceRoots: [],
        sessions: [],
        diagnostics: [
          {
            adapterId: grokAdapter.id,
            provider: "grok",
            status: "no_data_found",
            parserConfidence: "observed",
            message: "Grok root was not found.",
            ...(root !== undefined ? { rootPath: root } : {}),
          },
        ],
      };
    }
    const sessionsRoot = join(root, "sessions");
    const files = collectFiles(
      sessionsRoot,
      (path) => path.endsWith("chat_history.jsonl"),
      options.limit,
    );
    const rootRecord = sourceRoot("grok", grokAdapter.id, sessionsRoot, options.machine, options.now);
    const sessions = files.map((chatPath) => {
      const sessionDir = dirname(chatPath);
      const sessionId = basename(sessionDir);
      const projectKey = basename(dirname(sessionDir));
      const projectPath = decodeProjectPath(projectKey);
      const summary = readJsonFile(join(sessionDir, "summary.json"));
      const chatLines = readJsonLines(chatPath);
      const eventLines = readJsonLines(join(sessionDir, "events.jsonl"));
      const updateLines = readJsonLines(join(sessionDir, "updates.jsonl"));
      const hunkPath = join(sessionDir, "hunk_records.jsonl");
      const toolCallsById = new Map<string, GrokToolCallDraft>();
      const collectTool = (
        sourcePath: string,
        eventId: string,
        record: Record<string, unknown>,
      ) => {
        const toolCall = grokToolCall(
          options.machine.machineId,
          sourcePath,
          sessionId,
          eventId,
          record,
        );
        if (toolCall !== undefined) toolCallsById.set(toolCall.id, toolCall);
        return toolCall?.id;
      };
      const events = [
        ...chatLines.map(({ value, lineNumber }, index) => {
          const record =
            typeof value === "object" && value !== null
              ? (value as Record<string, unknown>)
              : {};
          const type = typeof record.type === "string" ? record.type : "message";
          const nativeEventId =
            typeof record.id === "string" ? record.id : undefined;
          const eventId = eventIdFor("grok", options.machine.machineId, chatPath, index, nativeEventId ?? lineNumber);
          const toolCallId = collectTool(chatPath, eventId, record);
          const content = grokContentProjection(record);
          return {
            id: eventId,
            nativeEventId,
            sequence: index,
            role: roleFrom(typeof record.type === "string" ? record.type : undefined),
            kind: grokKind(record),
            contentText: compactText(content),
            contentSource: content,
            ...(toolCallId !== undefined ? { toolCallId } : {}),
            rawReference: { sourcePath: chatPath, line: lineNumber, nativeType: type },
          };
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
          const eventId = eventIdFor("grok", options.machine.machineId, eventPath, index, nativeEventId ?? lineNumber);
          const toolCallId = collectTool(eventPath, eventId, record);
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
          const eventId = eventIdFor("grok", options.machine.machineId, updatePath, index, lineNumber);
          const toolCallId = collectTool(updatePath, eventId, record);
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
        agentName: "grok-build",
        machine: options.machine,
        nativeSessionId: sessionId,
        nativeProjectKey: projectKey,
        title:
          typeof (summary as Record<string, unknown> | undefined)?.title === "string"
            ? ((summary as Record<string, unknown>).title as string)
            : undefined,
        sourceRoot: sessionsRoot,
        sourcePath: sessionDir,
        projectPath,
        events,
        toolCalls: [...toolCallsById.values()],
        artifacts: existsSync(hunkPath)
          ? grokArtifacts(options.machine.machineId, sessionDir, sessionId, hunkPath)
          : [],
      });
    });

    return {
      sourceRoots: [rootRecord],
      sessions,
      diagnostics: [
        {
          adapterId: grokAdapter.id,
          provider: "grok",
          status: sessions.length > 0 ? "available" : "no_data_found",
          parserConfidence: "observed",
          rootPath: sessionsRoot,
          message: `Discovered ${sessions.length} Grok session(s).`,
        },
      ],
    };
  },
};
