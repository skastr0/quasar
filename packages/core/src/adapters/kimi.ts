import { existsSync } from "node:fs";
import { basename, dirname, join } from "node:path";

import type { SessionAdapter } from "./types";
import type { Artifact, SessionEdge, ToolCall, UsageRecord } from "../schemas";
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
  artifactIdFor,
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

type KimiToolCallDraft = Omit<
  ToolCall,
  "sessionId" | "machineId" | "provider" | "agentName" | "projectIdentityKey"
>;
type KimiUsageDraft = Omit<
  UsageRecord,
  "sessionId" | "machineId" | "provider" | "agentName" | "projectIdentityKey"
>;
type KimiEdgeDraft = Omit<
  SessionEdge,
  "sessionId" | "machineId" | "provider" | "agentName" | "projectIdentityKey"
>;
type KimiArtifactDraft = Omit<
  Artifact,
  "sessionId" | "machineId" | "provider" | "agentName" | "projectIdentityKey"
>;

const indexEntries = (root: string) => {
  const path = join(root, "session_index.jsonl");
  if (!existsSync(path)) return new Map<string, Record<string, unknown>>();
  return new Map(
    readJsonLines(path).map(({ value }) => {
      const record = recordFrom(value);
      return [String(record.id ?? record.sessionId ?? record.session_id ?? ""), record] as const;
    }),
  );
};

const agentIdFromWirePath = (path: string) => basename(dirname(path));

const sessionIdFromWirePath = (path: string) => {
  const parts = path.split(/[\\/]/);
  const agentsIndex = parts.lastIndexOf("agents");
  if (agentsIndex > 0) return parts[agentsIndex - 1] ?? basename(dirname(path));
  return basename(dirname(path));
};

const artifactFromRecord = (
  machineId: string,
  sourcePath: string,
  nativeSessionId: string,
  eventId: string,
  record: Record<string, unknown>,
  index: number,
): KimiArtifactDraft[] => {
  const type = String(record.type ?? record.kind ?? "").toLowerCase();
  const path = typeof record.path === "string" ? record.path : undefined;
  if (!type.includes("artifact") && !type.includes("plan") && path === undefined) return [];
  return [
    {
      id: artifactIdFor("kimi", machineId, sourcePath, nativeSessionId, [eventId, index, path, type]),
      eventId,
      kind: type.includes("plan") ? "plan" : type || "artifact",
      ...(path !== undefined ? { path } : {}),
      sourcePath,
      sourceRef: { eventId, index },
      metadata: { title: record.title, status: record.status },
      raw: record as NativeValue,
    },
  ];
};

const buildKimiSession = (
  wirePath: string,
  root: string,
  options: Parameters<SessionAdapter["read"]>[0],
  indexById: Map<string, Record<string, unknown>>,
  state: unknown,
) => {
  const records = readJsonLines(wirePath).map((line) => line.value);
  const nativeSessionId = sessionIdFromWirePath(wirePath);
  const indexRecord = indexById.get(nativeSessionId) ?? {};
  const agentId = agentIdFromWirePath(wirePath);
  const toolCallsById = new Map<string, KimiToolCallDraft>();
  const usageRecords: KimiUsageDraft[] = [];
  const sessionEdges: KimiEdgeDraft[] = [];
  const artifacts: KimiArtifactDraft[] = [];
  if (wirePath.split(/[\\/]/).includes("agents")) {
    sessionEdges.push({
      id: edgeIdFor("kimi", options.machine.machineId, wirePath, "subagent_of", nativeSessionId, agentId),
      kind: "subagent_of",
      fromId: agentId,
      toId: nativeSessionId,
    });
  }
  const events = records.map((value, index) => {
    const record = recordFrom(value);
    const nativeEventId = nativeIdFromRecord(record, index);
    const eventId = eventIdFor("kimi", options.machine.machineId, wirePath, index, nativeEventId);
    const parentAgentId =
      typeof record.parentAgentId === "string" ? record.parentAgentId : undefined;
    if (parentAgentId !== undefined) {
      sessionEdges.push({
        id: edgeIdFor("kimi", options.machine.machineId, wirePath, "subagent_of", parentAgentId, agentId),
        kind: "subagent_of",
        fromId: agentId,
        toId: parentAgentId,
        rawReference: { sourcePath: wirePath, nativeType: "parentAgentId" },
      });
    }
    const toolCall = bestEffortToolCall(
      "kimi",
      options.machine.machineId,
      wirePath,
      nativeSessionId,
      eventId,
      record,
      nativeEventId,
    );
    if (toolCall !== undefined) toolCallsById.set(toolCall.id, toolCall);
    const usageRecord = usageFromRecord(
      "kimi",
      options.machine.machineId,
      wirePath,
      nativeSessionId,
      eventId,
      index,
      record,
      undefined,
    );
    if (usageRecord !== undefined) usageRecords.push(usageRecord);
    artifacts.push(...artifactFromRecord(options.machine.machineId, wirePath, nativeSessionId, eventId, record, index));
    const content = contentFromRecord(record) as NativeValue;
    return {
      id: eventId,
      nativeEventId,
      sequence: index,
      timestamp: timestampFromRecord(record),
      role: roleFromRecord(record),
      kind: kindFromRecord(record),
      contentText: compactText(content),
      content,
      ...(toolCall !== undefined ? { toolCallId: toolCall.id } : {}),
      rawReference: { sourcePath: wirePath, line: index + 1, nativeType: String(record.type ?? "wire") },
      raw: value,
    };
  });
  const projectPath =
    typeof indexRecord.cwd === "string"
      ? indexRecord.cwd
      : typeof indexRecord.projectPath === "string"
        ? indexRecord.projectPath
        : undefined;
  return buildSession({
    provider: "kimi",
    agentName: "kimi-code",
    machine: options.machine,
    nativeSessionId,
    nativeProjectKey: projectPath,
    title: typeof indexRecord.title === "string" ? indexRecord.title : undefined,
    sourceRoot: root,
    sourcePath: wirePath,
    projectPath,
    rawMetadata: { indexRecord, state } as NativeValue,
    events,
    toolCalls: [...toolCallsById.values()],
    sessionEdges,
    usageRecords,
    artifacts,
  });
};

export const kimiAdapter: SessionAdapter = {
  id: "kimi-local-wire",
  provider: "kimi",
  displayName: "Kimi Code local wire logs",
  stable: true,
  defaultRoot: () => process.env.KIMI_CODE_HOME ?? homePath(".kimi-code"),
  read: async (options) => {
    const root = options.roots?.kimi ?? kimiAdapter.defaultRoot();
    if (root === undefined || !existsSync(root)) {
      return {
        sourceRoots: [],
        sessions: [],
        diagnostics: [
          {
            adapterId: kimiAdapter.id,
            provider: "kimi",
            status: "no_data_found",
            parserConfidence: "brittle",
            message: "Kimi root was not found.",
            ...(root !== undefined ? { rootPath: root } : {}),
          },
        ],
      };
    }
    const indexById = indexEntries(root);
    const state = readJsonFile(join(root, "state.json"));
    const wireFiles = collectFiles(root, (path) => path.endsWith("wire.jsonl"), options.limit);
    const sessions = wireFiles.map((path) => buildKimiSession(path, root, options, indexById, state));
    return {
      sourceRoots: [sourceRoot("kimi", kimiAdapter.id, root, options.machine, options.now)],
      sessions,
      diagnostics: [
        {
          adapterId: kimiAdapter.id,
          provider: "kimi",
          status: sessions.length > 0 ? "available" : "no_data_found",
          parserConfidence: "brittle",
          rootPath: root,
          message: `Discovered ${sessions.length} Kimi session(s).`,
        },
      ],
    };
  },
};
