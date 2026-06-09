import { existsSync } from "node:fs";

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
  nativeSessionIdFromPath,
  readJsonFile,
  readJsonLines,
  recordFrom,
  sourceRoot,
  type NativeValue,
} from "./common";

type PiToolCallDraft = Omit<
  ToolCall,
  "sessionId" | "machineId" | "provider" | "agentName" | "projectIdentityKey"
>;
type PiUsageDraft = Omit<
  UsageRecord,
  "sessionId" | "machineId" | "provider" | "agentName" | "projectIdentityKey"
>;
type PiEdgeDraft = Omit<
  SessionEdge,
  "sessionId" | "machineId" | "provider" | "agentName" | "projectIdentityKey"
>;

const recordsFromFile = (path: string) => {
  if (path.endsWith(".jsonl")) return readJsonLines(path).map((line) => line.value);
  const value = readJsonFile(path);
  if (Array.isArray(value)) return value;
  const record = recordFrom(value);
  for (const key of ["events", "messages", "nodes", "turns", "items"]) {
    if (Array.isArray(record[key])) return record[key] as unknown[];
  }
  return Object.keys(record).length === 0 ? [] : [record];
};

const buildPiSession = (
  path: string,
  root: string,
  options: Parameters<SessionAdapter["read"]>[0],
) => {
  const records = recordsFromFile(path);
  const nativeSessionId = nativeSessionIdFromPath(path);
  const toolCallsById = new Map<string, PiToolCallDraft>();
  const usageRecords: PiUsageDraft[] = [];
  const sessionEdges: PiEdgeDraft[] = [];
  const nativeIdToEventId = new Map<string, string>();
  const events = records.map((value, index) => {
    const record = recordFrom(value);
    const nativeEventId = nativeIdFromRecord(record, index);
    const eventId = eventIdFor("pi", options.machine.machineId, path, index, nativeEventId);
    nativeIdToEventId.set(nativeEventId, eventId);
    const parentId =
      typeof record.parentId === "string"
        ? record.parentId
        : typeof record.parentID === "string"
          ? record.parentID
          : undefined;
    if (parentId !== undefined) {
      sessionEdges.push({
        id: edgeIdFor("pi", options.machine.machineId, path, "parent", parentId, nativeEventId),
        kind: "parent",
        ...(nativeIdToEventId.has(parentId)
          ? { fromEventId: nativeIdToEventId.get(parentId)! }
          : { fromId: parentId }),
        toEventId: eventId,
      });
    }
    const compactedInto =
      typeof record.compactedInto === "string" ? record.compactedInto : undefined;
    if (compactedInto !== undefined) {
      sessionEdges.push({
        id: edgeIdFor("pi", options.machine.machineId, path, "compacted_into", nativeEventId, compactedInto),
        kind: "compacted_into",
        fromEventId: eventId,
        toId: compactedInto,
      });
    }
    const toolCall = bestEffortToolCall(
      "pi",
      options.machine.machineId,
      path,
      nativeSessionId,
      eventId,
      record,
      nativeEventId,
    );
    if (toolCall !== undefined) toolCallsById.set(toolCall.id, toolCall);
    const usageRecord = usageFromRecord(
      "pi",
      options.machine.machineId,
      path,
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
      rawReference: { sourcePath: path, nativeType: String(record.type ?? "event") },
    };
  });
  return buildSession({
    provider: "pi",
    agentName: "pi",
    machine: options.machine,
    nativeSessionId,
    nativeProjectKey: projectPathFromRecords(records),
    sourceRoot: root,
    sourcePath: path,
    projectPath: projectPathFromRecords(records),
    events,
    toolCalls: [...toolCallsById.values()],
    sessionEdges,
    usageRecords,
  });
};

const projectPathFromRecords = (records: readonly unknown[]) => {
  for (const value of records) {
    const record = recordFrom(value);
    if (typeof record.cwd === "string") return record.cwd;
    if (typeof record.projectPath === "string") return record.projectPath;
  }
  return undefined;
};

export const piAdapter: SessionAdapter = {
  id: "pi-local-json-tree",
  provider: "pi",
  displayName: "Pi local JSON tree",
  stable: true,
  defaultRoot: () => homePath(".pi/agent/sessions"),
  read: async (options) => {
    const root = options.roots?.pi ?? piAdapter.defaultRoot();
    if (root === undefined || !existsSync(root)) {
      return {
        sourceRoots: [],
        sessions: [],
        diagnostics: [
          {
            adapterId: piAdapter.id,
            provider: "pi",
            status: "no_data_found",
            parserConfidence: "brittle",
            message: "Pi root was not found.",
            ...(root !== undefined ? { rootPath: root } : {}),
          },
        ],
      };
    }
    const files = collectFiles(root, (path) => /\.(jsonl|json)$/.test(path), options.limit);
    const sessions = files.flatMap((path) => (recordsFromFile(path).length === 0 ? [] : [buildPiSession(path, root, options)]));
    return {
      sourceRoots: [sourceRoot("pi", piAdapter.id, root, options.machine, options.now)],
      sessions,
      diagnostics: [
        {
          adapterId: piAdapter.id,
          provider: "pi",
          status: sessions.length > 0 ? "available" : "no_data_found",
          parserConfidence: "brittle",
          rootPath: root,
          message: `Discovered ${sessions.length} Pi session(s).`,
        },
      ],
    };
  },
};
