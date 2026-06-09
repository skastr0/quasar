import { existsSync, statSync } from "node:fs";
import { basename } from "node:path";

import type { SessionAdapter } from "./types";
import type { Artifact, ToolCall, UsageRecord } from "../schemas";
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
  artifactIdFor,
  buildSession,
  collectFiles,
  compactText,
  eventIdFor,
  homePath,
  nativeSessionIdFromPath,
  projectSessionNativeValue,
  readJsonFile,
  readJsonLines,
  recordFrom,
  sourceRoot,
  type NativeValue,
} from "./common";

type DroidToolCallDraft = Omit<
  ToolCall,
  "sessionId" | "machineId" | "provider" | "agentName" | "projectIdentityKey"
>;
type DroidUsageDraft = Omit<
  UsageRecord,
  "sessionId" | "machineId" | "provider" | "agentName" | "projectIdentityKey"
>;
type DroidArtifactDraft = Omit<
  Artifact,
  "sessionId" | "machineId" | "provider" | "agentName" | "projectIdentityKey"
>;

const skipFactoryConfigTree = (path: string) =>
  /[\\/]\.factory[\\/](skills|commands|droids|auth|secrets|credentials)([\\/]|$)/i.test(path);

const captureLike = (path: string) => {
  if (skipFactoryConfigTree(path)) return false;
  const name = basename(path).toLowerCase();
  return (
    /\.(jsonl|jsonrpc|json)$/.test(name) &&
    (/[\\/](sessions|session|history|histories|traces|captures|streams|transcripts)([\\/]|$)/i.test(path) ||
      /^history\.(jsonl|json)$/i.test(name) ||
      /^stream.*\.(jsonl|jsonrpc|json)$/i.test(name) ||
      /^transcript.*\.(jsonl|json)$/i.test(name))
  );
};

const recordsFromFile = (path: string) => {
  const raw = (() => {
    if (path.endsWith(".jsonl") || path.endsWith(".jsonrpc")) return readJsonLines(path).map((line) => line.value);
    const value = readJsonFile(path);
    if (Array.isArray(value)) return value;
    const record = recordFrom(value);
    for (const key of ["events", "messages", "stream", "result"]) {
      if (Array.isArray(record[key])) return record[key] as unknown[];
    }
    return Object.keys(record).length === 0 ? [] : [record];
  })();
  return raw.map(recordFrom).filter(bestEffortEventRecordLike);
};

const artifactFromRecord = (
  machineId: string,
  sourcePath: string,
  nativeSessionId: string,
  eventId: string,
  record: Record<string, unknown>,
  index: number,
): DroidArtifactDraft[] => {
  const type = String(record.type ?? record.kind ?? "").toLowerCase();
  const path = typeof record.path === "string" ? record.path : typeof record.filePath === "string" ? record.filePath : undefined;
  if (!type.includes("artifact") && !type.includes("diff") && !type.includes("patch")) return [];
  const metadata = projectSessionNativeValue(record.content ?? record.patch ?? record.diff);
  return [
    {
      id: artifactIdFor("droid", machineId, sourcePath, nativeSessionId, [eventId, index, type, path]),
      eventId,
      kind: type || "artifact",
      ...(path !== undefined ? { path } : {}),
      sourcePath,
      sourceRef: { eventId, index },
      ...(metadata !== undefined ? { metadata } : {}),
    },
  ];
};

const buildDroidSession = (
  path: string,
  root: string,
  options: Parameters<SessionAdapter["read"]>[0],
) => {
  const records = recordsFromFile(path);
  const nativeSessionId = nativeSessionIdFromPath(path);
  const toolCallsById = new Map<string, DroidToolCallDraft>();
  const usageRecords: DroidUsageDraft[] = [];
  const artifacts: DroidArtifactDraft[] = [];
  const events = records.map((value, index) => {
    const record = recordFrom(value);
    const nativeEventId = nativeIdFromRecord(record, index);
    const eventId = eventIdFor("droid", options.machine.machineId, path, index, nativeEventId);
    const toolCall = bestEffortToolCall(
      "droid",
      options.machine.machineId,
      path,
      nativeSessionId,
      eventId,
      record,
      nativeEventId,
    );
    if (toolCall !== undefined) toolCallsById.set(toolCall.id, toolCall);
    const usageRecord = usageFromRecord(
      "droid",
      options.machine.machineId,
      path,
      nativeSessionId,
      eventId,
      index,
      record,
      undefined,
    );
    if (usageRecord !== undefined) usageRecords.push(usageRecord);
    artifacts.push(...artifactFromRecord(options.machine.machineId, path, nativeSessionId, eventId, record, index));
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
      rawReference: { sourcePath: path, line: index + 1, nativeType: String(record.type ?? "jsonrpc") },
    };
  });
  return buildSession({
    provider: "droid",
    agentName: "factory-droid",
    machine: options.machine,
    nativeSessionId,
    nativeProjectKey: projectPathFromRecords(records),
    sourceRoot: root,
    sourcePath: path,
    projectPath: projectPathFromRecords(records),
    events,
    toolCalls: [...toolCallsById.values()],
    usageRecords,
    artifacts,
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

export const droidAdapter: SessionAdapter = {
  id: "factory-droid-local-captures",
  provider: "droid",
  displayName: "Factory Droid local captures",
  stable: true,
  defaultRoot: () => homePath(".factory"),
  read: async (options) => {
    const root = options.roots?.droid ?? droidAdapter.defaultRoot();
    if (root === undefined || !existsSync(root)) {
      return {
        sourceRoots: [],
        sessions: [],
        diagnostics: [
          {
            adapterId: droidAdapter.id,
            provider: "droid",
            status: "no_data_found",
            parserConfidence: "capture-file",
            message: "Factory/Droid root or capture file was not found.",
            ...(root !== undefined ? { rootPath: root } : {}),
          },
        ],
      };
    }
    const files = statSync(root).isFile()
      ? [root]
      : collectFiles(root, captureLike, options.limit, options.skip);
    const sessions = files.flatMap((path) => (recordsFromFile(path).length === 0 ? [] : [buildDroidSession(path, root, options)]));
    return {
      sourceRoots: [sourceRoot("droid", droidAdapter.id, root, options.machine, options.now)],
      sessions,
      diagnostics: [
        {
          adapterId: droidAdapter.id,
          provider: "droid",
          status: sessions.length > 0 ? "available" : "no_data_found",
          parserConfidence: "capture-file",
          rootPath: root,
          message: `Discovered ${sessions.length} Factory/Droid session capture(s).`,
          details: { searchedCaptureLikeFiles: files.length },
        },
      ],
    };
  },
};
