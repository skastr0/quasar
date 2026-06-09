import { existsSync } from "node:fs";
import { join } from "node:path";

import type { SessionAdapter } from "./types";
import type { SessionEdge, ToolCall, UsageRecord } from "../schemas";
import {
  bestEffortToolCall,
  contentFromRecord,
  kindFromRecord,
  nativeIdFromRecord,
  roleFromRecord,
  timestampFromRecord,
  usageFromRecord,
} from "./best-effort";
import {
  buildSession,
  collectFiles,
  compactText,
  edgeIdFor,
  eventIdFor,
  homePath,
  readJsonFile,
  readJsonLines,
  recordFrom,
  sourceRoot,
  type NativeValue,
} from "./common";

type AmpToolCallDraft = Omit<
  ToolCall,
  "sessionId" | "machineId" | "provider" | "agentName" | "projectIdentityKey"
>;
type AmpUsageDraft = Omit<
  UsageRecord,
  "sessionId" | "machineId" | "provider" | "agentName" | "projectIdentityKey"
>;
type AmpEdgeDraft = Omit<
  SessionEdge,
  "sessionId" | "machineId" | "provider" | "agentName" | "projectIdentityKey"
>;

const threadMessages = (thread: Record<string, unknown>) =>
  Array.isArray(thread.messages) ? (thread.messages as unknown[]) : [];

const buildAmpSessionFromRecords = (
  sourcePath: string,
  sourceRootPath: string,
  options: Parameters<SessionAdapter["read"]>[0],
  nativeSessionId: string,
  nativeProjectKey: string | undefined,
  title: string | undefined,
  records: readonly unknown[],
) => {
  const toolCallsById = new Map<string, AmpToolCallDraft>();
  const usageRecords: AmpUsageDraft[] = [];
  const sessionEdges: AmpEdgeDraft[] = [];
  const nativeIdToEventId = new Map<string, string>();
  const events = records.map((value, index) => {
    const record = recordFrom(value);
    const nativeEventId = nativeIdFromRecord(record, index);
    const eventId = eventIdFor("amp", options.machine.machineId, sourcePath, index, nativeEventId);
    nativeIdToEventId.set(nativeEventId, eventId);
    const parentId =
      typeof record.parentId === "string"
        ? record.parentId
        : typeof record.parentID === "string"
          ? record.parentID
          : undefined;
    if (parentId !== undefined) {
      sessionEdges.push({
        id: edgeIdFor("amp", options.machine.machineId, sourcePath, "parent", parentId, nativeEventId),
        kind: "parent",
        ...(nativeIdToEventId.has(parentId)
          ? { fromEventId: nativeIdToEventId.get(parentId)! }
          : { fromId: parentId }),
        toEventId: eventId,
      });
    }
    const toolCall = bestEffortToolCall(
      "amp",
      options.machine.machineId,
      sourcePath,
      nativeSessionId,
      eventId,
      record,
      nativeEventId,
    );
    if (toolCall !== undefined) toolCallsById.set(toolCall.id, toolCall);
    for (const nestedTool of nestedToolRecords(record)) {
      const nested = bestEffortToolCall(
        "amp",
        options.machine.machineId,
        sourcePath,
        nativeSessionId,
        eventId,
        nestedTool,
        `${nativeEventId}:${toolCallsById.size}`,
      );
      if (nested !== undefined) toolCallsById.set(nested.id, nested);
    }
    const usageRecord = usageFromRecord(
      "amp",
      options.machine.machineId,
      sourcePath,
      nativeSessionId,
      eventId,
      index,
      record,
      undefined,
    );
    if (usageRecord !== undefined) usageRecords.push(usageRecord);
    const content = contentFromRecord(record) as NativeValue;
    return {
      id: eventId,
      nativeEventId,
      sequence: index,
      timestamp: timestampFromRecord(record),
      role: roleFromRecord(record),
      kind: kindFromRecord(record),
      contentText: compactText(content),
      contentSource: content,
      ...(toolCall !== undefined ? { toolCallId: toolCall.id } : {}),
      rawReference: { sourcePath, nativeType: String(record.type ?? "message") },
    };
  });
  return buildSession({
    provider: "amp",
    agentName: "amp",
    machine: options.machine,
    nativeSessionId,
    nativeProjectKey,
    title,
    sourceRoot: sourceRootPath,
    sourcePath,
    projectPath: nativeProjectKey,
    events,
    toolCalls: [...toolCallsById.values()],
    sessionEdges,
    usageRecords,
  });
};

const nestedToolRecords = (record: Record<string, unknown>) => {
  const values = [
    record.toolCalls,
    record.tool_calls,
    record.tools,
    record.parts,
    record.content,
  ];
  return values.flatMap((value) =>
    Array.isArray(value)
      ? value.map(recordFrom).filter((item) => Object.keys(item).length > 0)
      : [],
  );
};

export const ampAdapter: SessionAdapter = {
  id: "amp-local-threads",
  provider: "amp",
  displayName: "Amp local threads",
  stable: true,
  defaultRoot: () => homePath(".local/share/amp"),
  read: async (options) => {
    const root = options.roots?.amp ?? ampAdapter.defaultRoot();
    if (root === undefined || !existsSync(root)) {
      return {
        sourceRoots: [],
        sessions: [],
        diagnostics: [
          {
            adapterId: ampAdapter.id,
            provider: "amp",
            status: "no_data_found",
            parserConfidence: "brittle",
            message: "Amp root was not found.",
            ...(root !== undefined ? { rootPath: root } : {}),
          },
        ],
      };
    }

    const threadRoot = join(root, "threads");
    const threadFiles = collectFiles(threadRoot, (path) => path.endsWith(".json"), options.limit);
    const threadSessions = threadFiles.flatMap((path) => {
      if (/secrets|auth|token|credential/i.test(path)) return [];
      const thread = recordFrom(readJsonFile(path));
      const messages = threadMessages(thread);
      if (messages.length === 0) return [];
      const nativeSessionId = String(thread.id ?? thread.threadId ?? path);
      return [
        buildAmpSessionFromRecords(
          path,
          root,
          options,
          nativeSessionId,
          typeof thread.cwd === "string" ? thread.cwd : undefined,
          typeof thread.title === "string" ? thread.title : undefined,
          messages,
        ),
      ];
    });

    const historyPath = join(root, "history.jsonl");
    const historyLines = existsSync(historyPath) ? readJsonLines(historyPath) : [];
    const historySession =
      historyLines.length === 0
        ? []
        : [
            buildAmpSessionFromRecords(
              historyPath,
              root,
              options,
              "history",
              undefined,
              "Amp history",
              historyLines.map((line) => line.value),
            ),
          ];
    const sessions = [...threadSessions, ...historySession];

    return {
      sourceRoots: [sourceRoot("amp", ampAdapter.id, root, options.machine, options.now)],
      sessions,
      diagnostics: [
        {
          adapterId: ampAdapter.id,
          provider: "amp",
          status: sessions.length > 0 ? "available" : "no_data_found",
          parserConfidence: "brittle",
          rootPath: root,
          message: `Discovered ${sessions.length} Amp session(s).`,
          details: { skippedSecretFiles: ["secrets.json"] },
        },
      ],
    };
  },
};
