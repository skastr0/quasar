import { existsSync } from "node:fs";
import { join } from "node:path";

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
type AdapterOptions = Parameters<SessionAdapter["read"]>[0];
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

async function* streamAmp(options: AdapterOptions): AsyncGenerator<AdapterStreamItem> {
  const root = options.roots?.amp ?? ampAdapter.defaultRoot();
  if (root === undefined || !existsSync(root)) {
    yield {
      type: "diagnostic",
      diagnostic: {
        adapterId: ampAdapter.id,
        provider: "amp",
        status: "no_data_found",
        parserConfidence: "brittle",
        message: "Amp root was not found.",
        ...(root !== undefined ? { rootPath: root } : {}),
      },
    };
    return;
  }

  yield {
    type: "sourceRoot",
    sourceRoot: sourceRoot("amp", ampAdapter.id, root, options.machine, options.now),
  };
  let sessionCount = 0;
  const threadRoot = join(root, "threads");
  const threadFiles = collectFiles(
    threadRoot,
    (path) => path.endsWith(".json"),
    options.limit,
    options.skip,
  );
  for (const path of threadFiles) {
    if (/secrets|auth|token|credential/i.test(path)) continue;
    const thread = recordFrom(readJsonFile(path));
    const messages = threadMessages(thread).map(recordFrom).filter(bestEffortEventRecordLike);
    if (messages.length === 0) continue;
    const nativeSessionId = String(thread.id ?? thread.threadId ?? path);
    const session = buildAmpSessionFromRecords(
      path,
      root,
      options,
      nativeSessionId,
      typeof thread.cwd === "string" ? thread.cwd : undefined,
      typeof thread.title === "string" ? thread.title : undefined,
      messages,
    );
    yield {
      type: "session",
      session,
      sourceUnit: {
        provider: "amp",
        adapterId: ampAdapter.id,
        rootPath: root,
        sourcePath: session.sourcePath,
        physicalPath: path,
      },
    };
    sessionCount += 1;
  }

  const historyPath = join(root, "history.jsonl");
  const historyLines = existsSync(historyPath)
    ? readJsonLines(historyPath).map((line) => recordFrom(line.value)).filter(bestEffortEventRecordLike)
    : [];
  if (historyLines.length > 0) {
    const session = buildAmpSessionFromRecords(
      historyPath,
      root,
      options,
      "history",
      undefined,
      "Amp history",
      historyLines,
    );
    yield {
      type: "session",
      session,
      sourceUnit: {
        provider: "amp",
        adapterId: ampAdapter.id,
        rootPath: root,
        sourcePath: session.sourcePath,
        physicalPath: historyPath,
      },
    };
    sessionCount += 1;
  }

  yield {
    type: "diagnostic",
    diagnostic: {
      adapterId: ampAdapter.id,
      provider: "amp",
      status: sessionCount > 0 ? "available" : "no_data_found",
      parserConfidence: "brittle",
      rootPath: root,
      message: `Discovered ${sessionCount} Amp session(s).`,
      details: { skippedSecretFiles: ["secrets.json"] },
    },
  };
}

export const ampAdapter: SessionAdapter = {
  id: "amp-local-threads",
  provider: "amp",
  displayName: "Amp local threads",
  stable: true,
  defaultRoot: () => homePath(".local/share/amp"),
  read: async (options) => collectAdapterStream(streamAmp(options)),
  stream: streamAmp,
};
