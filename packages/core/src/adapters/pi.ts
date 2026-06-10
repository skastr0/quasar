import { existsSync } from "node:fs";
import { basename } from "node:path";

import { collectAdapterStream, type AdapterStreamItem, type SessionAdapter } from "./types";
import type { SessionEdge, ToolCall, UsageRecord } from "../schemas";
import {
  bestEffortEventRecordLike,
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
type AdapterOptions = Parameters<SessionAdapter["read"]>[0];
type PiEdgeDraft = Omit<
  SessionEdge,
  "sessionId" | "machineId" | "provider" | "agentName" | "projectIdentityKey"
>;

const piSessionLikeFile = (path: string) => {
  const name = basename(path).toLowerCase();
  if (!/\.(jsonl|json)$/.test(name)) return false;
  if (/^(state|cache|config|settings|index|metadata)\.json$/i.test(name)) return false;
  if (/[\\/](cache|state|config|settings|metadata)([\\/]|$)/i.test(path)) return false;
  if (name.endsWith(".jsonl")) return true;
  return (
    /^(session|transcript|history|messages|events|turns)[\w.-]*\.(jsonl|json)$/i.test(name) ||
    /[\\/](sessions|session|transcripts|history|histories|messages|events|turns|conversations)([\\/]|$)/i.test(path)
  );
};

const recordsFromFile = (path: string) => {
  const raw = (() => {
    if (path.endsWith(".jsonl")) return readJsonLines(path).map((line) => line.value);
    const value = readJsonFile(path);
    if (Array.isArray(value)) return value;
    const record = recordFrom(value);
    for (const key of ["events", "messages", "nodes", "turns", "items"]) {
      if (Array.isArray(record[key])) return record[key] as unknown[];
    }
    return Object.keys(record).length === 0 ? [] : [record];
  })();
  return raw.map(recordFrom).filter(bestEffortEventRecordLike);
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

async function* streamPi(options: AdapterOptions): AsyncGenerator<AdapterStreamItem> {
  const root = options.roots?.pi ?? piAdapter.defaultRoot();
  if (root === undefined || !existsSync(root)) {
    yield {
      type: "diagnostic",
      diagnostic: {
        adapterId: piAdapter.id,
        provider: "pi",
        status: "no_data_found",
        parserConfidence: "brittle",
        message: "Pi root was not found.",
        ...(root !== undefined ? { rootPath: root } : {}),
      },
    };
    return;
  }
  const files = collectFiles(root, piSessionLikeFile, options.limit, options.skip);
  yield {
    type: "sourceRoot",
    sourceRoot: sourceRoot("pi", piAdapter.id, root, options.machine, options.now),
  };
  let sessionCount = 0;
  for (const path of files) {
    if (recordsFromFile(path).length === 0) continue;
    const session = buildPiSession(path, root, options);
    yield {
      type: "session",
      session,
      sourceUnit: {
        provider: "pi",
        adapterId: piAdapter.id,
        rootPath: root,
        sourcePath: session.sourcePath,
        physicalPath: path,
      },
    };
    sessionCount += 1;
  }
  yield {
    type: "diagnostic",
    diagnostic: {
      adapterId: piAdapter.id,
      provider: "pi",
      status: sessionCount > 0 ? "available" : "no_data_found",
      parserConfidence: "brittle",
      rootPath: root,
      message: `Discovered ${sessionCount} Pi session(s).`,
    },
  };
}

export const piAdapter: SessionAdapter = {
  id: "pi-local-json-tree",
  provider: "pi",
  displayName: "Pi local JSON tree",
  stable: true,
  defaultRoot: () => homePath(".pi/agent/sessions"),
  read: async (options) => collectAdapterStream(streamPi(options)),
  stream: streamPi,
};
