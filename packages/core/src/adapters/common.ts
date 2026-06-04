import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";

import { stableJsonHash, stableWideHash } from "../hash";
import { resolveProjectIdentity } from "../project-normalization";
import { redactSensitive } from "../redaction";
import type {
  Artifact,
  ContentBlock,
  MachineIdentity,
  NormalizedSession,
  Provider,
  SessionEdge,
  SessionEvent,
  SessionEventKind,
  SessionRole,
  SourceRoot,
  ToolCall,
  UsageRecord,
} from "../schemas";

export type NativeValue =
  | string
  | number
  | boolean
  | null
  | readonly NativeValue[]
  | { readonly [key: string]: NativeValue | undefined };

type BuildSessionArgs = {
  readonly provider: Provider;
  readonly agentName: string;
  readonly machine: MachineIdentity;
  readonly nativeSessionId: string;
  readonly nativeProjectKey?: string;
  readonly title?: string;
  readonly sourceRoot: string;
  readonly sourcePath: string;
  readonly projectPath?: string;
  readonly gitRemote?: string;
  readonly packageName?: string;
  readonly rawMetadata?: NativeValue;
  readonly events: (Omit<
    SessionEvent,
    "sessionId" | "machineId" | "provider" | "agentName" | "projectIdentityKey" | "contentBlocks"
  > & { readonly contentBlocks?: readonly ContentBlock[] })[];
  readonly toolCalls?: Omit<
    ToolCall,
    "sessionId" | "machineId" | "provider" | "agentName" | "projectIdentityKey"
  >[];
  readonly sessionEdges?: Omit<
    SessionEdge,
    "sessionId" | "machineId" | "provider" | "agentName" | "projectIdentityKey"
  >[];
  readonly usageRecords?: Omit<
    UsageRecord,
    "sessionId" | "machineId" | "provider" | "agentName" | "projectIdentityKey"
  >[];
  readonly artifacts?: Omit<
    Artifact,
    "sessionId" | "machineId" | "provider" | "agentName" | "projectIdentityKey"
  >[];
};

export const homePath = (relative: string) => {
  const home = process.env.HOME;
  return home === undefined ? undefined : join(home, relative);
};

export const readJsonLines = (path: string) => {
  const contents = readFileSync(path, "utf8");
  return contents
    .split(/\r?\n/)
    .map((line, index) => ({ line, lineNumber: index + 1 }))
    .filter(({ line }) => line.trim().length > 0)
    .flatMap(({ line, lineNumber }) => {
      try {
        return [{ value: JSON.parse(line) as unknown, lineNumber }];
      } catch {
        return [];
      }
    });
};

export const readJsonFile = (path: string) => {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as unknown;
  } catch {
    return undefined;
  }
};

const NON_INDEXABLE_KEY = /(encrypted[_-]?content|cipher[_-]?text)/i;
const CONTROL_CHARS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;
const ESCAPED_CONTROL_CHARS = /\\u00(?:0[0-9a-f]|1[0-9a-f]|7f)/gi;
const REPLACEMENT_CHAR = /\ufffd/g;

const compactString = (value: string) => {
  const controlCount =
    (value.match(CONTROL_CHARS)?.length ?? 0) +
    (value.match(ESCAPED_CONTROL_CHARS)?.length ?? 0) +
    (value.match(REPLACEMENT_CHAR)?.length ?? 0);
  if (value.length > 200 && controlCount > 20 && controlCount / value.length > 0.02) {
    return "[binary output omitted]";
  }
  const text = value.replace(CONTROL_CHARS, " ").replace(/\s+/g, " ").trim();
  return text.length === 0 ? undefined : text;
};

const stripNonIndexable = (value: unknown, depth = 0): unknown => {
  if (depth > 8 || value === null || value === undefined) return value;
  if (typeof value !== "object") return value;
  if (Array.isArray(value)) {
    return value.map((item) => stripNonIndexable(item, depth + 1));
  }
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([key]) => !NON_INDEXABLE_KEY.test(key))
      .map(([key, item]) => [key, stripNonIndexable(item, depth + 1)]),
  );
};

export const collectFiles = (
  root: string,
  predicate: (path: string) => boolean,
  limit = Number.POSITIVE_INFINITY,
) => {
  const input = parseCollectFilesInput(root, limit);
  if (input === undefined) return [];
  const files: string[] = [];
  const visit = (path: string) => {
    if (files.length >= input.limit) return;
    let stat;
    try {
      stat = statSync(path);
    } catch {
      return;
    }
    if (stat.isDirectory()) {
      for (const entry of readdirSync(path)) visit(join(path, entry));
      return;
    }
    if (predicate(path)) files.push(path);
  };
  if (existsSync(input.root)) visit(input.root);
  return files.sort();
};

export const compactText = (value: NativeValue | undefined): string | undefined => {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "string") {
    const text = compactString(value);
    return text === undefined ? undefined : (redactSensitive(text) as string);
  }
  if (Array.isArray(value)) {
    const text = value.map(compactText).filter(Boolean).join(" ").trim();
    return text.length === 0 ? undefined : text;
  }
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (typeof record.text === "string") return compactText(record.text);
    if (typeof record.content === "string") return compactText(record.content);
    try {
      return JSON.stringify(stripNonIndexable(redactSensitive(value))).slice(0, 4_000);
    } catch {
      return undefined;
    }
  }
  return String(value);
};

export const recordFrom = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

export const stringValue = (value: unknown) =>
  typeof value === "string" && value.length > 0 ? value : undefined;

export const numberValue = (value: unknown) =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;

export const parseJsonString = (value: unknown): unknown => {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
};

export const scopedId = (
  provider: Provider,
  machineId: string,
  sourcePath: string,
  kind: string,
  ...parts: readonly unknown[]
) => `${provider}:${kind}:${machineId}:${stableJsonHash([sourcePath, ...parts])}`;

export const contentBlockIdFor = (
  provider: Provider,
  machineId: string,
  sourcePath: string,
  eventId: string,
  sequence: number,
) => `${provider}:block:${machineId}:${stableJsonHash([sourcePath, eventId, sequence])}`;

export const textBlock = (
  provider: Provider,
  machineId: string,
  sourcePath: string,
  eventId: string,
  sequence: number,
  text: string | undefined,
): ContentBlock[] =>
  text === undefined || text.trim().length === 0
    ? []
    : [
        {
          id: contentBlockIdFor(provider, machineId, sourcePath, eventId, sequence),
          sequence,
          kind: "text",
          text,
        },
      ];

export const jsonBlock = (
  provider: Provider,
  machineId: string,
  sourcePath: string,
  eventId: string,
  sequence: number,
  value: unknown,
): ContentBlock => ({
  id: contentBlockIdFor(provider, machineId, sourcePath, eventId, sequence),
  sequence,
  kind: "json",
  value,
});

export const contentBlocksFromNative = (
  provider: Provider,
  machineId: string,
  sourcePath: string,
  eventId: string,
  value: unknown,
): ContentBlock[] => {
  const blocks: ContentBlock[] = [];
  const pushBlock = (block: Omit<ContentBlock, "id" | "sequence">) => {
    const sequence = blocks.length;
    blocks.push({
      id: contentBlockIdFor(provider, machineId, sourcePath, eventId, sequence),
      sequence,
      ...block,
    });
  };
  const pushText = (kind: "text" | "markdown" | "thinking", text: string, metadata?: unknown) => {
    pushBlock({
      kind,
      ...(kind === "text" ? { text } : {}),
      ...(kind === "markdown" ? { markdown: text } : {}),
      ...(kind === "thinking" ? { thinking: text } : {}),
      ...(metadata !== undefined ? { metadata } : {}),
    });
  };
  const pushMediaOrFile = (record: Record<string, unknown>, type: string | undefined) => {
    const lowerType = type?.toLowerCase();
    const path =
      stringValue(record.path) ??
      stringValue(record.file_path) ??
      stringValue(record.filePath) ??
      stringValue(record.filename);
    const uri =
      stringValue(record.uri) ??
      stringValue(record.url) ??
      stringValue(record.image_url) ??
      stringValue(record.imageUrl);
    const mediaType =
      stringValue(record.mediaType) ??
      stringValue(record.media_type) ??
      stringValue(record.mimeType) ??
      stringValue(record.mime_type);
    if (
      lowerType?.includes("image") === true ||
      record.image !== undefined ||
      record.image_url !== undefined ||
      record.imageUrl !== undefined
    ) {
      pushBlock({
        kind: "image",
        ...(path !== undefined ? { path } : {}),
        ...(uri !== undefined ? { uri } : {}),
        ...(mediaType !== undefined ? { mediaType } : {}),
        value: record.image ?? record.data ?? record.source,
        metadata: record,
      });
      return true;
    }
    if (
      lowerType?.includes("file") === true ||
      record.file !== undefined ||
      record.file_path !== undefined ||
      record.filePath !== undefined
    ) {
      pushBlock({
        kind: "file",
        ...(path !== undefined ? { path } : {}),
        ...(uri !== undefined ? { uri } : {}),
        ...(mediaType !== undefined ? { mediaType } : {}),
        value: record.file ?? record.data ?? record.content,
        metadata: record,
      });
      return true;
    }
    return false;
  };
  const visit = (item: unknown) => {
    if (item === undefined || item === null) return;
    if (typeof item === "string") {
      const text = compactText(item as NativeValue);
      if (text !== undefined) pushText("text", text);
      return;
    }
    if (Array.isArray(item)) {
      for (const child of item) visit(child);
      return;
    }
    if (typeof item !== "object") return;
    const record = item as Record<string, unknown>;
    const type = typeof record.type === "string" ? record.type : undefined;
    const before = blocks.length;
    const pushedMediaOrFile = pushMediaOrFile(record, type);
    const text =
      stringValue(record.text) ??
      stringValue(record.content) ??
      stringValue(record.message) ??
      stringValue(record.thinking) ??
      stringValue(record.markdown);
    if (text !== undefined) {
      if (type === "thinking" || record.thinking !== undefined) pushText("thinking", text, record);
      else if (type === "markdown" || record.markdown !== undefined) pushText("markdown", text, record);
      else pushText("text", text, record);
      if (pushedMediaOrFile || record.value !== undefined || record.json !== undefined) {
        pushBlock({ kind: "json", value: record, metadata: { nativeType: type } });
      }
      return;
    }
    if (record.content !== undefined) visit(record.content);
    if (record.parts !== undefined) visit(record.parts);
    if (record.message !== undefined) visit(record.message);
    if (blocks.length === before && !pushedMediaOrFile) {
      pushBlock({ kind: "json", value: record, metadata: type !== undefined ? { nativeType: type } : undefined });
    }
  };
  visit(value);
  if (blocks.length > 0) return blocks;
  const text = compactText(value as NativeValue | undefined);
  return textBlock(provider, machineId, sourcePath, eventId, 0, text);
};

export const edgeIdFor = (
  provider: Provider,
  machineId: string,
  sourcePath: string,
  kind: string,
  from: unknown,
  to: unknown,
) => `${provider}:edge:${machineId}:${stableJsonHash([sourcePath, kind, from, to])}`;

export const usageIdFor = (
  provider: Provider,
  machineId: string,
  sourcePath: string,
  sessionId: string,
  eventId: string | undefined,
  sequence: number,
) => `${provider}:usage:${machineId}:${stableJsonHash([sourcePath, sessionId, eventId, sequence])}`;

export const artifactIdFor = (
  provider: Provider,
  machineId: string,
  sourcePath: string,
  sessionId: string,
  stableKey: unknown,
) => `${provider}:artifact:${machineId}:${stableJsonHash([sourcePath, sessionId, stableKey])}`;

const defaultEdgesForEvents = (
  provider: Provider,
  machineId: string,
  sourcePath: string,
  events: readonly Pick<SessionEvent, "id" | "kind" | "toolCallId">[],
): Omit<
  SessionEdge,
  "sessionId" | "machineId" | "provider" | "agentName" | "projectIdentityKey"
>[] => {
  const edges: Omit<
    SessionEdge,
    "sessionId" | "machineId" | "provider" | "agentName" | "projectIdentityKey"
  >[] = [];
  for (let index = 1; index < events.length; index += 1) {
    const previous = events[index - 1];
    const current = events[index];
    edges.push({
      id: edgeIdFor(provider, machineId, sourcePath, "next", previous.id, current.id),
      kind: "next",
      fromEventId: previous.id,
      toEventId: current.id,
    });
  }

  const toolCallEventByToolId = new Map<string, string>();
  for (const event of events) {
    if (event.toolCallId === undefined) continue;
    if (event.kind === "tool_call") {
      toolCallEventByToolId.set(event.toolCallId, event.id);
      continue;
    }
    if (event.kind !== "tool_result") continue;
    const callEventId = toolCallEventByToolId.get(event.toolCallId);
    if (callEventId === undefined) continue;
    edges.push({
      id: edgeIdFor(provider, machineId, sourcePath, "tool_result_for", callEventId, event.id),
      kind: "tool_result_for",
      fromEventId: callEventId,
      toEventId: event.id,
    });
  }
  return edges;
};

const dedupeById = <
  A extends {
    readonly id: string;
  },
>(
  rows: readonly A[],
) => {
  const seen = new Set<string>();
  const result: A[] = [];
  for (const row of rows) {
    if (seen.has(row.id)) continue;
    seen.add(row.id);
    result.push(row);
  }
  return result;
};

export const roleFrom = (value: string | undefined): SessionRole => {
  if (
    value === "user" ||
    value === "assistant" ||
    value === "developer" ||
    value === "system" ||
    value === "tool" ||
    value === "thinking"
  ) {
    return value;
  }
  return "unknown";
};

export const kindFromNative = (type: string | undefined): SessionEventKind => {
  if (type === undefined) return "unknown";
  if (type.includes("tool") && type.includes("result")) return "tool_result";
  if (type.includes("tool")) return "tool_call";
  if (type.includes("thinking") || type.includes("reasoning")) return "reasoning";
  if (type.includes("preamble")) return "preamble";
  if (type.includes("summary") || type === "compacted") return "summary";
  if (type === "usage" || type.includes("token_count")) return "usage";
  if (type.includes("snapshot") || type.includes("diff")) return "snapshot";
  if (type === "user" || type === "assistant" || type === "message") {
    return "message";
  }
  if (type === "system" || type === "session_meta") return "system";
  if (type.includes("phase") || type.includes("turn") || type.includes("loop")) {
    return "lifecycle";
  }
  return "unknown";
};

export const sourceRoot = (
  provider: Provider,
  adapterId: string,
  rootPath: string,
  machine: MachineIdentity,
  now: string,
): SourceRoot => ({
  provider,
  adapterId,
  rootPath,
  machineId: machine.machineId,
  discoveredAt: now,
});

export const buildSession = (input: BuildSessionArgs): NormalizedSession => {
  const args = parseBuildSessionArgs(input);
  const projectIdentity = resolveProjectIdentity({
    machineId: args.machine.machineId,
    rawPath: args.projectPath ?? args.nativeProjectKey,
    gitRemote: args.gitRemote,
    packageName: args.packageName,
  });
  const id = `${args.provider}:${args.machine.machineId}:${stableWideHash(
    `${args.nativeSessionId}:${args.sourcePath}`,
  )}`;
  const events = args.events.map((event) => ({
    ...event,
    sessionId: id,
    machineId: args.machine.machineId,
    provider: args.provider,
    agentName: args.agentName,
    projectIdentityKey: projectIdentity.projectIdentityKey,
    contentBlocks: [
      ...(event.contentBlocks ??
        contentBlocksFromNative(
          args.provider,
          args.machine.machineId,
          args.sourcePath,
          event.id,
          event.content ?? event.contentText,
        )),
    ],
  }));
  const toolCalls = (args.toolCalls ?? []).map((toolCall) => ({
    ...toolCall,
    sessionId: id,
    machineId: args.machine.machineId,
    provider: args.provider,
    agentName: args.agentName,
    projectIdentityKey: projectIdentity.projectIdentityKey,
  }));
  const sessionEdges = dedupeById([
    ...defaultEdgesForEvents(args.provider, args.machine.machineId, args.sourcePath, events),
    ...(args.sessionEdges ?? []),
  ]).map((edge) => ({
      ...edge,
      sessionId: id,
      machineId: args.machine.machineId,
      provider: args.provider,
      agentName: args.agentName,
      projectIdentityKey: projectIdentity.projectIdentityKey,
    }));
  const usageRecords = (args.usageRecords ?? []).map((usageRecord) => ({
    ...usageRecord,
    sessionId: id,
    machineId: args.machine.machineId,
    provider: args.provider,
    agentName: args.agentName,
    projectIdentityKey: projectIdentity.projectIdentityKey,
  }));
  const artifacts = (args.artifacts ?? []).map((artifact) => ({
    ...artifact,
    sessionId: id,
    machineId: args.machine.machineId,
    provider: args.provider,
    agentName: args.agentName,
    projectIdentityKey: projectIdentity.projectIdentityKey,
  }));

  return {
    id,
    nativeSessionId: args.nativeSessionId,
    provider: args.provider,
    agentName: args.agentName,
    machineId: args.machine.machineId,
    projectIdentity,
    ...(args.nativeProjectKey !== undefined
      ? { nativeProjectKey: args.nativeProjectKey }
      : {}),
    ...(args.title !== undefined ? { title: args.title } : {}),
    sourceRoot: args.sourceRoot,
    sourcePath: args.sourcePath,
    ...(args.rawMetadata !== undefined ? { rawMetadata: args.rawMetadata } : {}),
    events,
    toolCalls,
    sessionEdges,
    usageRecords,
    artifacts,
  };
};

export const eventIdFor = (
  provider: Provider,
  machineId: string,
  sourcePath: string,
  sequence: number,
  stableKey: string | number,
) => `${provider}:event:${machineId}:${stableJsonHash([sourcePath, sequence, stableKey])}`;

export const nativeSessionIdFromPath = (path: string) =>
  basename(path).replace(/\.(jsonl|json|db)$/i, "");

export const parentDirectoryName = (path: string) => basename(dirname(path));

const parseCollectFilesInput = (root: string, limit: number) => {
  const trimmedRoot = root.trim();
  if (trimmedRoot.length === 0 || limit <= 0) return undefined;
  return {
    root: trimmedRoot,
    limit: Number.isFinite(limit) ? Math.floor(limit) : Number.POSITIVE_INFINITY,
  };
};

const parseBuildSessionArgs = (args: BuildSessionArgs) => {
  if (args.nativeSessionId.trim().length === 0) {
    throw new Error("Native session ID cannot be empty.");
  }
  if (args.sourceRoot.trim().length === 0 || args.sourcePath.trim().length === 0) {
    throw new Error("Session source paths cannot be empty.");
  }
  return args;
};
