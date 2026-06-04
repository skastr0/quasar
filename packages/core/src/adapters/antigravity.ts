import { existsSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";

import type { SessionAdapter } from "./types";
import type { Artifact, ToolCall, UsageRecord } from "../schemas";
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
  eventIdFor,
  homePath,
  nativeSessionIdFromPath,
  readJsonLines,
  recordFrom,
  sourceRoot,
  type NativeValue,
} from "./common";

type AntigravityToolCallDraft = Omit<
  ToolCall,
  "sessionId" | "machineId" | "provider" | "agentName" | "projectIdentityKey"
>;
type AntigravityUsageDraft = Omit<
  UsageRecord,
  "sessionId" | "machineId" | "provider" | "agentName" | "projectIdentityKey"
>;
type AntigravityArtifactDraft = Omit<
  Artifact,
  "sessionId" | "machineId" | "provider" | "agentName" | "projectIdentityKey"
>;

const transcriptLike = (path: string) => {
  const name = basename(path).toLowerCase();
  return (
    name.endsWith(".jsonl") &&
    (name.includes("transcript") ||
      name.includes("hook") ||
      name === "events.jsonl" ||
      name === "history.jsonl")
  );
};

const artifactFilesForTranscript = (path: string, limit: number | undefined) => {
  const sessionDir = dirname(path);
  const roots = ["artifacts", "artifact", "outputs", "output"].map((name) => join(sessionDir, name));
  return roots.flatMap((root) =>
    existsSync(root)
      ? collectFiles(root, (candidate) => {
          try {
            return statSync(candidate).isFile();
          } catch {
            return false;
          }
        }, limit)
      : [],
  );
};

const buildAntigravitySession = (
  path: string,
  root: string,
  options: Parameters<SessionAdapter["read"]>[0],
) => {
  const lines = readJsonLines(path);
  const nativeSessionId = nativeSessionIdFromPath(path);
  const toolCallsById = new Map<string, AntigravityToolCallDraft>();
  const usageRecords: AntigravityUsageDraft[] = [];
  const events = lines.map(({ value, lineNumber }, index) => {
    const record = recordFrom(value);
    const nativeEventId = nativeIdFromRecord(record, lineNumber);
    const eventId = eventIdFor("antigravity", options.machine.machineId, path, index, nativeEventId);
    const toolCall = bestEffortToolCall(
      "antigravity",
      options.machine.machineId,
      path,
      nativeSessionId,
      eventId,
      record,
      nativeEventId,
    );
    if (toolCall !== undefined) toolCallsById.set(toolCall.id, toolCall);
    const usageRecord = usageFromRecord(
      "antigravity",
      options.machine.machineId,
      path,
      nativeSessionId,
      eventId,
      index,
      record,
      "google",
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
      content,
      ...(toolCall !== undefined ? { toolCallId: toolCall.id } : {}),
      rawReference: { sourcePath: path, line: lineNumber, nativeType: String(record.type ?? "transcript") },
      raw: value,
    };
  });
  const artifacts: AntigravityArtifactDraft[] = artifactFilesForTranscript(path, options.limit).map((artifactPath, index) => ({
    id: artifactIdFor("antigravity", options.machine.machineId, path, nativeSessionId, ["file", artifactPath, index]),
    kind: "file",
    path: artifactPath,
    sourcePath: artifactPath,
    sourceRef: { transcriptPath: path },
  }));
  return buildSession({
    provider: "antigravity",
    agentName: "antigravity",
    machine: options.machine,
    nativeSessionId,
    nativeProjectKey: projectPathFromLines(lines.map((line) => line.value)),
    sourceRoot: root,
    sourcePath: path,
    projectPath: projectPathFromLines(lines.map((line) => line.value)),
    rawMetadata: { transcriptPath: path },
    events,
    toolCalls: [...toolCallsById.values()],
    usageRecords,
    artifacts,
  });
};

const projectPathFromLines = (records: readonly unknown[]) => {
  for (const value of records) {
    const record = recordFrom(value);
    if (typeof record.cwd === "string") return record.cwd;
    if (typeof record.projectPath === "string") return record.projectPath;
  }
  return undefined;
};

export const antigravityAdapter: SessionAdapter = {
  id: "antigravity-local-transcripts",
  provider: "antigravity",
  displayName: "Antigravity local transcripts",
  stable: true,
  defaultRoot: () => process.env.ANTIGRAVITY_HOME ?? homePath(".gemini/antigravity"),
  read: async (options) => {
    const root = options.roots?.antigravity ?? antigravityAdapter.defaultRoot();
    if (root === undefined || !existsSync(root)) {
      return {
        sourceRoots: [],
        sessions: [],
        diagnostics: [
          {
            adapterId: antigravityAdapter.id,
            provider: "antigravity",
            status: "no_data_found",
            parserConfidence: "brittle",
            message: "Antigravity root was not found.",
            ...(root !== undefined ? { rootPath: root } : {}),
          },
        ],
      };
    }
    const files = statSync(root).isFile() ? [root] : collectFiles(root, transcriptLike, options.limit);
    const sessions = files.flatMap((path) => (readJsonLines(path).length === 0 ? [] : [buildAntigravitySession(path, root, options)]));
    return {
      sourceRoots: [sourceRoot("antigravity", antigravityAdapter.id, root, options.machine, options.now)],
      sessions,
      diagnostics: [
        {
          adapterId: antigravityAdapter.id,
          provider: "antigravity",
          status: sessions.length > 0 ? "available" : "no_data_found",
          parserConfidence: "brittle",
          rootPath: root,
          message: `Discovered ${sessions.length} Antigravity transcript(s).`,
        },
      ],
    };
  },
};
