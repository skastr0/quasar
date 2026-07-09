import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join, relative } from "node:path";

import { Option, Schema } from "effect";

import { stableJsonHash, stableWideHash } from "../core/hash";
import { IDENTITY_SCHEME_VERSION } from "../core/identity";
import type { NativeSessionId, SessionId } from "../core/identity";
import { gitRemoteForPath } from "../core/git-identity";
import { resolveProjectIdentity } from "../core/project-normalization";
import { redactSensitive } from "../core/redaction";
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
} from "../core/schemas";
import type { AdapterDiscoverOptions } from "./types";

export type NativeValue =
  | string
  | number
  | boolean
  | null
  | readonly NativeValue[]
  | { readonly [key: string]: NativeValue | undefined };

type NativeProjectionInput =
  | NativeValue
  | undefined
  | readonly NativeProjectionInput[]
  | { readonly [key: string]: NativeProjectionInput };

const NativeProjectionInputSchema: Schema.Schema<NativeProjectionInput> = Schema.suspend(
  () =>
    Schema.Union(
      Schema.String,
      Schema.Number,
      Schema.Boolean,
      Schema.Null,
      Schema.Undefined,
      Schema.Array(NativeProjectionInputSchema),
      Schema.Record({ key: Schema.String, value: NativeProjectionInputSchema }),
    ),
);
const UnknownRecordSchema = Schema.Record({ key: Schema.String, value: Schema.Unknown });
const DROPPED_NATIVE_KEYS = new Set([
  "diff",
  "diffs",
  "patch",
  "patches",
  "snapshot",
  "snapshots",
  "fullDiff",
  "fileDiff",
  "displayDiff",
  "displayPatch",
  "uiState",
  "viewState",
  "providerUi",
  "provider_ui",
  "displayOnly",
  "display_only",
  "cache",
  "cached",
  "state",
  "raw",
  "rawContent",
  "encrypted_content",
  "encryptedContent",
  "ciphertext",
  "cipherText",
]);

type BuildSessionArgs = {
  readonly provider: Provider;
  readonly agentName: string;
  readonly machine: MachineIdentity;
  /**
   * The canonical, machine- and path-INDEPENDENT session id. The adapter
   * constructs it via `sessionIdFor` from its own branded native id and threads
   * the SAME value into every child-id helper, so the whole tree keys off one
   * machine-independent identity.
   */
  readonly sessionId: SessionId;
  readonly nativeSessionId: string;
  readonly nativeProjectKey?: string;
  readonly title?: string;
  readonly startedAt?: string;
  readonly updatedAt?: string;
  readonly sourceRoot: string;
  readonly sourcePath: string;
  readonly projectPath?: string;
  readonly gitRemote?: string;
  readonly packageName?: string;
  readonly explicitProjectKey?: string;
  readonly events: (Omit<
    SessionEvent,
    "sessionId" | "machineId" | "provider" | "agentName" | "projectIdentityKey" | "contentBlocks"
  > & { readonly contentBlocks?: readonly ContentBlock[]; readonly contentSource?: NativeValue })[];
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

type JsonReadDiagnostic = {
  readonly name: string;
  readonly message: string;
};

type JsonReadDiagnosticSink = {
  readonly push: (diagnostic: JsonReadDiagnostic) => void;
};

type JsonReadOptions = {
  readonly diagnosticName?: string;
  readonly diagnostics?: JsonReadDiagnosticSink;
  readonly sourcePath?: string;
};

const pushJsonReadDiagnostic = (
  options: JsonReadOptions | undefined,
  message: string,
) => {
  const diagnosticName = options?.diagnosticName;
  if (diagnosticName === undefined || options?.diagnostics === undefined) return;
  options.diagnostics.push({ name: diagnosticName, message });
};

export const readJsonLines = (path: string, options?: JsonReadOptions) => {
  let contents: string;
  try {
    contents = readFileSync(path, "utf8");
  } catch (error) {
    const sourcePath = options?.sourcePath ?? path;
    pushJsonReadDiagnostic(
      options,
      `${options?.diagnosticName ?? "json.line.unreadable"} at ${sourcePath}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return [];
  }
  return contents
    .split(/\r?\n/)
    .map((line, index) => ({ line, lineNumber: index + 1 }))
    .filter(({ line }) => line.trim().length > 0)
    .flatMap(({ line, lineNumber }) => {
      try {
        return [{ value: JSON.parse(line) as unknown, lineNumber }];
      } catch (error) {
        const sourcePath = options?.sourcePath ?? path;
        pushJsonReadDiagnostic(
          options,
          `${options?.diagnosticName ?? "json.line.invalid"} at ${sourcePath}:${lineNumber}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
        return [];
      }
    });
};

export const readJsonFile = (path: string, options?: JsonReadOptions) => {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as unknown;
  } catch (error) {
    const sourcePath = options?.sourcePath ?? path;
    pushJsonReadDiagnostic(
      options,
      `${options?.diagnosticName ?? "json.file.invalid"} at ${sourcePath}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return undefined;
  }
};

const CONTROL_CHARS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;

/**
 * Normalizes a string for compact rendering: control characters become
 * spaces and whitespace runs collapse. No content is ever discarded by a
 * heuristic — the ingest boundary is the only line at which provider garbage
 * is rejected with a named diagnostic.
 */
const compactString = (value: string) => {
  const text = value.replace(CONTROL_CHARS, " ").replace(/\s+/g, " ").trim();
  return text.length === 0 ? undefined : text;
};

export const projectSessionNativeValue = (value: unknown): NativeValue | undefined => {
  const decoded = Option.getOrElse(
    Schema.decodeUnknownOption(NativeProjectionInputSchema)(value),
    () => value,
  );
  const projected = projectNativeValue(decoded);
  return projected === undefined ? undefined : (projected as NativeValue);
};

export const projectSessionPatchNativeValue = (value: unknown): NativeValue | undefined => {
  const decoded = Option.getOrElse(
    Schema.decodeUnknownOption(NativeProjectionInputSchema)(value),
    () => value,
  );
  const projected = projectNativeValue(decoded);
  return projected === undefined ? undefined : (projected as NativeValue);
};

/**
 * Tool payloads are stored in full. The ingest layer rejects provider garbage
 * with a named diagnostic. The adapter only redacts and prunes provider
 * machinery keys; it never truncates.
 */
export const projectToolPayloadNativeValue = (value: unknown): NativeValue | undefined => {
  const decoded = Option.getOrElse(
    Schema.decodeUnknownOption(NativeProjectionInputSchema)(value),
    () => value,
  );
  return projectNativeValue(decoded);
};

const shouldDropNativeKey = (key: string) =>
  DROPPED_NATIVE_KEYS.has(key) ||
  /(?:^|_)(diff|patch|snapshot|ciphertext)(?:$|_)/i.test(key) ||
  /encrypted[_-]?content/i.test(key);

const projectNativeValue = (value: unknown): NativeValue | undefined => {
  const redacted = redactSensitive(value);
  if (redacted === undefined) return undefined;
  if (redacted === null) return null;
  if (typeof redacted === "string") return compactString(redacted);
  if (typeof redacted === "number" || typeof redacted === "boolean") return redacted;
  if (Array.isArray(redacted)) {
    const items = redacted.flatMap((item) => {
      const projected = projectNativeValue(item);
      return projected === undefined ? [] : [projected];
    });
    return items.length === 0 ? undefined : items;
  }
  if (typeof redacted !== "object") return undefined;

  const entries = Object.entries(redacted as Record<string, unknown>).flatMap(([key, item]) => {
    if (shouldDropNativeKey(key)) return [];
    const projected = projectNativeValue(item);
    return projected === undefined ? [] : [[key, projected] as const];
  });
  return entries.length === 0 ? undefined : Object.fromEntries(entries);
};

export const collectFiles = (
  root: string,
  predicate: (path: string) => boolean,
  limit: number = Number.POSITIVE_INFINITY,
  skip: number = 0,
) => {
  const input = parseCollectFilesInput(root, limit, skip);
  if (input === undefined) return [];
  const files: string[] = [];
  let matched = 0;
  const visit = (path: string) => {
    if (files.length >= input.limit) return;
    let stat;
    try {
      stat = statSync(path);
    } catch {
      return;
    }
    if (stat.isDirectory()) {
      for (const entry of readdirSync(path).sort()) visit(join(path, entry));
      return;
    }
    if (!predicate(path)) return;
    if (matched >= input.skip) files.push(path);
    matched += 1;
  };
  if (existsSync(input.root)) visit(input.root);
  return files;
};

/** Detects machinery-only envelopes: objects that project to only having a
 * `type` field or similar machinery metadata. These should not appear on the
 * search surface as JSON dumps. */
const isMachineryOnlyEnvelope = (projected: NativeValue): boolean => {
  if (typeof projected !== "object" || projected === null || Array.isArray(projected)) {
    return false;
  }
  const record = projected as Record<string, unknown>;
  const keys = Object.keys(record);
  // Only a type field (or no fields at all) = machinery envelope with no content
  return keys.length <= 1 && (keys.length === 0 || keys[0] === "type");
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
    const projected = projectNativeValue(value);
    if (projected === undefined) return undefined;
    // Machinery-only envelopes (e.g. {"type":"reasoning"}) should not surface
    // as JSON dumps on the search surface.
    if (isMachineryOnlyEnvelope(projected)) return undefined;
    try {
      return compactString(JSON.stringify(projected));
    } catch {
      return undefined;
    }
  }
  return String(value);
};

export const recordFrom = (value: unknown): Record<string, unknown> => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return {};
  return Option.getOrElse(Schema.decodeUnknownOption(UnknownRecordSchema)(value), () => ({}));
};

export const stringValue = (value: unknown) => {
  const decoded = Option.getOrElse(
    Schema.decodeUnknownOption(Schema.String)(value),
    () => undefined as string | undefined,
  );
  return decoded !== undefined && decoded.length > 0 ? decoded : undefined;
};

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
  sessionId: SessionId,
  kind: string,
  ...parts: readonly unknown[]
) => `${sessionId}:${kind}:${stableJsonHash([...parts])}`;

export const contentBlockIdFor = (
  sessionId: SessionId,
  eventId: string,
  sequence: number,
) => `${sessionId}:block:${stableJsonHash([eventId, sequence])}`;

export const textBlock = (
  sessionId: SessionId,
  eventId: string,
  sequence: number,
  text: string | undefined,
): ContentBlock[] =>
  text === undefined || text.trim().length === 0
    ? []
    : [
        {
          id: contentBlockIdFor(sessionId, eventId, sequence),
          sequence,
          kind: "text",
          text,
        },
      ];

export const jsonBlock = (
  sessionId: SessionId,
  eventId: string,
  sequence: number,
  value: unknown,
): ContentBlock => ({
  id: contentBlockIdFor(sessionId, eventId, sequence),
  sequence,
  kind: "json",
  value,
});

export const contentBlocksFromNative = (
  sessionId: SessionId,
  eventId: string,
  value: unknown,
): ContentBlock[] => {
  const blocks: ContentBlock[] = [];
  const pushBlock = (block: Omit<ContentBlock, "id" | "sequence">) => {
    const sequence = blocks.length;
    blocks.push({
      id: contentBlockIdFor(sessionId, eventId, sequence),
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
  const metadataFor = (record: Record<string, unknown>, type: string | undefined) => ({
    ...(type !== undefined ? { nativeType: type } : {}),
    ...(typeof record.id === "string" ? { nativeId: record.id } : {}),
    ...(typeof record.name === "string" ? { name: record.name } : {}),
    ...(typeof record.tool === "string" ? { toolName: record.tool } : {}),
    ...(typeof record.toolName === "string" ? { toolName: record.toolName } : {}),
    ...(typeof record.callID === "string" ? { callId: record.callID } : {}),
    ...(typeof record.call_id === "string" ? { callId: record.call_id } : {}),
  });
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
        metadata: metadataFor(record, type),
      });
      return true;
    }
    if (
      lowerType?.includes("file") === true ||
      record.file !== undefined
    ) {
      pushBlock({
        kind: "file",
        ...(path !== undefined ? { path } : {}),
        ...(uri !== undefined ? { uri } : {}),
        ...(mediaType !== undefined ? { mediaType } : {}),
        metadata: metadataFor(record, type),
      });
      return true;
    }
    return false;
  };
  const providerMetadataOnly = (record: Record<string, unknown>) => {
    const hasLocator =
      record.path !== undefined ||
      record.file_path !== undefined ||
      record.filePath !== undefined ||
      record.filename !== undefined ||
      record.uri !== undefined ||
      record.url !== undefined;
    const hasProviderDisplay =
      record.displayOnly !== undefined ||
      record.display_only !== undefined ||
      record.providerUi !== undefined ||
      record.provider_ui !== undefined ||
      record.uiState !== undefined ||
      record.viewState !== undefined;
    const hasSemanticText =
      typeof record.text === "string" ||
      typeof record.content === "string" ||
      typeof record.message === "string" ||
      typeof record.thinking === "string" ||
      typeof record.markdown === "string";
    return hasLocator && hasProviderDisplay && !hasSemanticText;
  };
  // Children of a tool block ARE tool payload: they inherit the parent's
  // nativeType so downstream surfaces can exclude them no matter how deeply a
  // provider nests tool_result content (arrays of text blocks, references, …).
  const toolContextOf = (type: string | undefined): string | undefined => {
    if (type === undefined) return undefined;
    const lower = type.toLowerCase();
    if (lower.includes("tool") && lower.includes("result")) return "tool_result";
    if (lower.includes("tool")) return "tool_use";
    return undefined;
  };
  const visit = (item: unknown, toolContext?: string) => {
    if (item === undefined || item === null) return;
    if (typeof item === "string") {
      const text = compactText(item as NativeValue);
      if (text !== undefined) {
        pushText(
          "text",
          text,
          toolContext !== undefined ? { nativeType: toolContext } : undefined,
        );
      }
      return;
    }
    if (Array.isArray(item)) {
      for (const child of item) visit(child, toolContext);
      return;
    }
    if (typeof item !== "object") return;
    const record = item as Record<string, unknown>;
    const type = typeof record.type === "string" ? record.type : undefined;
    const childContext = toolContextOf(type) ?? toolContext;
    const metadataWithContext = () =>
      childContext !== undefined
        ? { ...metadataFor(record, type), nativeType: childContext }
        : metadataFor(record, type);
    const before = blocks.length;
    const pushedMediaOrFile = pushMediaOrFile(record, type);
    const text =
      stringValue(record.text) ??
      stringValue(record.content) ??
      stringValue(record.message) ??
      stringValue(record.thinking) ??
      stringValue(record.markdown);
    if (text !== undefined) {
      const metadata = metadataWithContext();
      if (type === "thinking" || record.thinking !== undefined) pushText("thinking", text, metadata);
      else if (type === "markdown" || record.markdown !== undefined) pushText("markdown", text, metadata);
      else pushText("text", text, metadata);
      return;
    }
    if (record.content !== undefined) visit(record.content, childContext);
    if (record.parts !== undefined) visit(record.parts, childContext);
    if (record.message !== undefined) visit(record.message, childContext);
    if (blocks.length === before && !pushedMediaOrFile && !providerMetadataOnly(record)) {
      const text = compactText(record as NativeValue);
      if (text !== undefined) pushText("text", text, metadataWithContext());
    }
  };
  visit(value);
  if (
    blocks.length === 0 &&
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    providerMetadataOnly(value as Record<string, unknown>)
  ) {
    return [];
  }
  if (blocks.length > 0) return blocks;
  const text = compactText(value as NativeValue | undefined);
  return textBlock(sessionId, eventId, 0, text);
};

export const edgeIdFor = (
  sessionId: SessionId,
  kind: string,
  from: unknown,
  to: unknown,
) => `${sessionId}:edge:${stableJsonHash([kind, from, to])}`;

export const usageIdFor = (
  sessionId: SessionId,
  eventId: string | undefined,
  sequence: number,
) => `${sessionId}:usage:${stableJsonHash([eventId, sequence])}`;

export const artifactIdFor = (
  sessionId: SessionId,
  stableKey: unknown,
) => `${sessionId}:artifact:${stableJsonHash([stableKey])}`;

const defaultEdgesForEvents = (
  sessionId: SessionId,
  events: readonly Pick<SessionEvent, "id" | "kind" | "toolCallId">[],
): Omit<
  SessionEdge,
  "sessionId" | "machineId" | "provider" | "agentName" | "projectIdentityKey"
>[] => {
  const edges: Omit<
    SessionEdge,
    "sessionId" | "machineId" | "provider" | "agentName" | "projectIdentityKey"
  >[] = [];

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
      id: edgeIdFor(sessionId, "tool_result_for", callEventId, event.id),
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
  items: readonly A[],
) => {
  const seen = new Set<string>();
  const result: A[] = [];
  for (const item of items) {
    if (seen.has(item.id)) continue;
    seen.add(item.id);
    result.push(item);
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

export const logicalRootFor = (
  provider: Provider,
  physicalRoot: string,
  options: Pick<AdapterDiscoverOptions, "logicalRoots">,
) => options.logicalRoots?.[provider] ?? physicalRoot;

export const logicalPathFor = (
  physicalPath: string,
  physicalRoot: string,
  logicalRoot: string,
) => (physicalRoot === logicalRoot ? physicalPath : join(logicalRoot, relative(physicalRoot, physicalPath)));

const contentBlocksForEvent = (
  sessionId: SessionId,
  eventId: string,
  contentText: string | undefined,
  contentBlocks: readonly ContentBlock[] | undefined,
  contentSource: NativeValue | undefined,
) => {
  if (contentBlocks !== undefined) return [...contentBlocks];
  if (contentSource === undefined) return [];
  if (typeof contentSource === "string" && compactText(contentSource) === contentText) return [];
  return contentBlocksFromNative(sessionId, eventId, contentSource);
};

export const buildSession = (input: BuildSessionArgs): NormalizedSession => {
  const args = parseBuildSessionArgs(input);
  // Identity ladder: an adapter-supplied remote wins; otherwise the recorded
  // working directory is resolved against the local clone enclosing it, so
  // sessions from every provider that ran in the same repository unify on one
  // `git:` projectKey (cross-provider project unity).
  const projectIdentity = resolveProjectIdentity({
    machineId: args.machine.machineId,
    rawPath: args.projectPath ?? args.nativeProjectKey,
    gitRemote: args.gitRemote ?? gitRemoteForPath(args.projectPath),
    packageName: args.packageName,
    explicitProjectKey: args.explicitProjectKey,
  });
  const id = args.sessionId;
  const events = args.events.map(({ contentBlocks, contentSource, ...event }) => ({
    ...event,
    sessionId: id,
    machineId: args.machine.machineId,
    provider: args.provider,
    agentName: args.agentName,
    projectIdentityKey: projectIdentity.projectIdentityKey,
    contentBlocks: contentBlocksForEvent(
      id,
      event.id,
      event.contentText,
      contentBlocks,
      contentSource,
    ),
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
    ...defaultEdgesForEvents(id, events),
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
    host: args.machine.hostname ?? "",
    identitySchemeVersion: IDENTITY_SCHEME_VERSION,
    projectIdentity,
    ...(args.nativeProjectKey !== undefined
      ? { nativeProjectKey: args.nativeProjectKey }
      : {}),
    ...(args.title !== undefined ? { title: args.title } : {}),
    ...(args.startedAt !== undefined ? { startedAt: args.startedAt } : {}),
    ...(args.updatedAt !== undefined ? { updatedAt: args.updatedAt } : {}),
    sourceRoot: args.sourceRoot,
    sourcePath: args.sourcePath,
    events,
    toolCalls,
    sessionEdges,
    usageRecords,
    artifacts,
  };
};

export const eventIdFor = (
  sessionId: SessionId,
  sequence: number,
  stableKey: string | number,
) => `${sessionId}:event:${stableJsonHash([sequence, stableKey])}`;

/**
 * The canonical source fingerprint string for a stat. Adapter pre-parse
 * probes and the ingest engine's statSync path MUST both route through this so
 * the probe's `sourceFingerprint` is byte-identical to what the engine derives
 * (`JSON.stringify({ size, mtimeMs })`, exact key order).
 */
export const sourceFingerprintFor = (stat: { size: number; mtimeMs: number }): string =>
  JSON.stringify({ size: stat.size, mtimeMs: stat.mtimeMs });

/**
 * The canonical Quasar session id. Machine- and path-INDEPENDENT: derived from
 * (provider, nativeSessionId) ALONE so the same session ingested from a host
 * and from a container converges on one id and the upsert dedups it. This is
 * the SOLE constructor of `SessionId`; it accepts only a branded
 * `NativeSessionId`, so a bare string does not type-check.
 */
export const sessionIdFor = (
  provider: Provider,
  nativeSessionId: NativeSessionId,
): SessionId => `${provider}:${stableWideHash(nativeSessionId)}` as SessionId;

export const parentDirectoryName = (path: string) => basename(dirname(path));

const parseCollectFilesInput = (root: string, limit: number, skip: number) => {
  const trimmedRoot = root.trim();
  if (trimmedRoot.length === 0 || limit <= 0) return undefined;
  return {
    root: trimmedRoot,
    limit: Number.isFinite(limit) ? Math.floor(limit) : Number.POSITIVE_INFINITY,
    skip: Number.isFinite(skip) && skip > 0 ? Math.floor(skip) : 0,
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
