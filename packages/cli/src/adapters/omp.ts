import { existsSync, statSync, type Stats } from "node:fs";
import { basename, dirname, extname, join, relative, sep } from "node:path";

import { Option, Schema } from "effect";

import { OmpSessionId, type SessionId } from "../core/identity";
import type {
  Artifact,
  ContentBlock,
  SessionEdge,
  SessionEvent,
  ToolCall,
  UsageRecord,
} from "../core/schemas";
import {
  artifactIdFor,
  buildSession,
  compactText,
  contentBlockIdFor,
  edgeIdFor,
  eventIdFor,
  homePath,
  jsonBlock,
  logicalPathFor,
  logicalRootFor,
  projectSessionNativeValue,
  projectToolPayloadNativeValue,
  recordFrom,
  scopedId,
  sessionIdFor,
  sourceFingerprintFor,
  sourceRoot,
  stringValue,
  usageIdFor,
  walkFilesWithStats,
  streamJsonlRecords,
  type NativeValue,
} from "./common";
import {
  classifyOmpRecord,
  isOmpEntryType,
  OmpEntrySchema,
  OmpSessionHeaderSchema,
  OmpTitleEntrySchema,
  type OmpEntry,
  type OmpMessage,
  type OmpSessionHeader,
  type OmpTitleEntry,
} from "./omp-schema";
import { collectAdapterStream, type AdapterDiscoverOptions, type AdapterStreamItem, type SessionAdapter } from "./types";

const PROVIDER = "omp" as const;
const ADAPTER_ID = "omp-local-jsonl";
const AGENT_NAME = "oh-my-pi";
const BLOB_REF = /^blob:sha256:[a-f0-9]{64}$/i;

type NamedDiagnostic = { readonly name: string; readonly message: string };
type EventDraft = Omit<
  SessionEvent,
  "sessionId" | "machineId" | "provider" | "agentName" | "projectIdentityKey"
>;
type ToolCallDraft = Omit<
  ToolCall,
  "sessionId" | "machineId" | "provider" | "agentName" | "projectIdentityKey"
>;
type EdgeDraft = Omit<
  SessionEdge,
  "sessionId" | "machineId" | "provider" | "agentName" | "projectIdentityKey"
>;
type UsageDraft = Omit<
  UsageRecord,
  "sessionId" | "machineId" | "provider" | "agentName" | "projectIdentityKey"
>;
type ArtifactDraft = Omit<
  Artifact,
  "sessionId" | "machineId" | "provider" | "agentName" | "projectIdentityKey"
>;

type SourceInfo = {
  readonly path: string;
  readonly logicalPath: string;
  readonly stats: Stats;
  readonly header: OmpSessionHeader;
  readonly headerLine: number;
  readonly titleSlot?: OmpTitleEntry;
};

type DecodedEntry = {
  readonly entry: OmpEntry;
  readonly lineNumber: number;
  readonly nativeId: string;
  readonly nativeParentId?: string;
};

type MessageProjection = {
  readonly role: "user" | "assistant" | "developer" | "system" | "tool" | "thinking" | "unknown";
  readonly kind: "message" | "tool_call" | "tool_result" | "reasoning" | "preamble" | "summary" | "unknown";
  readonly contentText?: string;
  readonly contentBlocks: ContentBlock[];
};

const decoded = <A, I>(schema: Schema.Schema<A, I>, value: unknown): A | undefined =>
  Option.getOrUndefined(Schema.decodeUnknownOption(schema)(value));

const recordType = (value: unknown): string | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? stringValue((value as Record<string, unknown>).type)
    : undefined;

const pushDiagnostic = (
  diagnostics: NamedDiagnostic[],
  name: string,
  path: string,
  lineNumber: number | undefined,
  detail: string,
) => {
  diagnostics.push({
    name,
    message: `${name} at ${path}${lineNumber === undefined ? "" : `:${lineNumber}`}: ${detail}`,
  });
};

const isoTime = (
  value: unknown,
  diagnostics?: NamedDiagnostic[],
  path?: string,
  lineNumber?: number,
): string | undefined => {
  let milliseconds: number | undefined;
  if (typeof value === "number" && Number.isFinite(value)) milliseconds = value;
  else if (typeof value === "string" && value.length > 0) {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) milliseconds = parsed;
  }
  if (milliseconds !== undefined) {
    try {
      return new Date(milliseconds).toISOString();
    } catch {
      // Fall through to the named diagnostic.
    }
  }
  if (value !== undefined && diagnostics !== undefined && path !== undefined) {
    pushDiagnostic(diagnostics, "omp.timestamp.invalid", path, lineNumber, "invalid timestamp");
  }
  return undefined;
};

const nonNegativeInteger = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : undefined;

const nonNegativeNumber = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;

const makeBlock = (
  sessionId: SessionId,
  eventId: string,
  blocks: ContentBlock[],
  block: Omit<ContentBlock, "id" | "sequence">,
) => {
  const sequence = blocks.length;
  blocks.push({
    id: contentBlockIdFor(sessionId, eventId, sequence),
    sequence,
    ...block,
  });
};

const addImageBlock = (
  sessionId: SessionId,
  eventId: string,
  blocks: ContentBlock[],
  image: { readonly data: string; readonly mimeType: string; readonly detail?: string },
  extraMetadata?: Readonly<Record<string, unknown>>,
) => {
  const isBlob = BLOB_REF.test(image.data);
  makeBlock(sessionId, eventId, blocks, {
    kind: "image",
    mediaType: image.mimeType,
    ...(isBlob ? { uri: image.data } : {}),
    metadata: {
      storage: isBlob ? "blob" : "inline",
      encodedChars: image.data.length,
      ...(image.detail !== undefined ? { detail: image.detail } : {}),
      ...extraMetadata,
    },
  });
};

const addUserContent = (
  sessionId: SessionId,
  eventId: string,
  blocks: ContentBlock[],
  content: Extract<OmpMessage, { readonly role: "user" | "developer" | "custom" | "hookMessage" }>["content"],
): string[] => {
  const text: string[] = [];
  if (typeof content === "string") {
    if (content.length > 0) {
      text.push(content);
      makeBlock(sessionId, eventId, blocks, { kind: "text", text: content });
    }
    return text;
  }
  for (const part of content) {
    if (part.type === "text") {
      text.push(part.text);
      makeBlock(sessionId, eventId, blocks, {
        kind: "text",
        text: part.text,
        ...(part.textSignature !== undefined ? { metadata: { signaturePresent: true } } : {}),
      });
    } else {
      addImageBlock(sessionId, eventId, blocks, part);
    }
  }
  return text;
};

const projectMessage = (
  sessionId: SessionId,
  eventId: string,
  message: OmpMessage,
): MessageProjection => {
  const contentBlocks: ContentBlock[] = [];
  const text: string[] = [];

  switch (message.role) {
    case "user":
      text.push(...addUserContent(sessionId, eventId, contentBlocks, message.content));
      return { role: "user", kind: "message", contentText: compactText(text.join("\n")), contentBlocks };
    case "developer":
      text.push(...addUserContent(sessionId, eventId, contentBlocks, message.content));
      return { role: "developer", kind: "preamble", contentText: compactText(text.join("\n")), contentBlocks };
    case "assistant": {
      let visibleText = false;
      let reasoning = false;
      let toolCalls = false;
      for (const part of message.content) {
        switch (part.type) {
          case "text":
            visibleText = true;
            text.push(part.text);
            makeBlock(sessionId, eventId, contentBlocks, {
              kind: "text",
              text: part.text,
              ...(part.textSignature !== undefined ? { metadata: { signaturePresent: true } } : {}),
            });
            break;
          case "thinking":
            reasoning = true;
            text.push(part.thinking);
            makeBlock(sessionId, eventId, contentBlocks, {
              kind: "thinking",
              thinking: part.thinking,
              metadata: {
                signaturePresent: part.thinkingSignature !== undefined,
                itemIdPresent: part.itemId !== undefined,
              },
            });
            break;
          case "redactedThinking":
            reasoning = true;
            makeBlock(sessionId, eventId, contentBlocks, {
              kind: "json",
              value: { nativeType: "redactedThinking", encodedChars: part.data.length },
            });
            break;
          case "fallback":
            makeBlock(sessionId, eventId, contentBlocks, {
              kind: "json",
              value: { nativeType: "fallback", fromModel: part.from.model, toModel: part.to.model },
            });
            break;
          case "image":
            addImageBlock(sessionId, eventId, contentBlocks, part);
            break;
          case "toolCall": {
            toolCalls = true;
            const input = projectToolPayloadNativeValue(part.arguments);
            makeBlock(sessionId, eventId, contentBlocks, {
              kind: "json",
              value: {
                nativeType: "tool_call",
                callId: part.id,
                name: part.name,
                ...(input !== undefined ? { input } : {}),
              },
            });
            break;
          }
        }
      }
      const kind = visibleText
        ? "message"
        : reasoning
          ? "reasoning"
          : toolCalls
            ? "tool_call"
            : "unknown";
      return { role: "assistant", kind, contentText: compactText(text.join("\n")), contentBlocks };
    }
    case "toolResult":
      for (const part of message.content) {
        if (part.type === "text") {
          const projectedText = projectToolPayloadNativeValue(part.text);
          if (typeof projectedText !== "string") continue;
          text.push(projectedText);
          makeBlock(sessionId, eventId, contentBlocks, {
            kind: "text",
            text: projectedText,
            metadata: { nativeType: "tool_result" },
          });
        } else {
          addImageBlock(sessionId, eventId, contentBlocks, part, { nativeType: "tool_result" });
        }
      }
      return { role: "tool", kind: "tool_result", contentText: compactText(text.join("\n")), contentBlocks };
    case "bashExecution":
    case "pythonExecution": {
      const projectedOutput = projectToolPayloadNativeValue(message.output);
      if (typeof projectedOutput === "string") {
        text.push(projectedOutput);
        makeBlock(sessionId, eventId, contentBlocks, { kind: "text", text: projectedOutput });
      }
      return { role: "tool", kind: "tool_result", contentText: compactText(text.join("\n")), contentBlocks };
    }
    case "custom":
    case "hookMessage":
      text.push(...addUserContent(sessionId, eventId, contentBlocks, message.content));
      return {
        role: "system",
        kind: message.customType === "skill-prompt" ? "preamble" : "message",
        contentText: compactText(text.join("\n")),
        contentBlocks,
      };
    case "fileMention":
      for (const file of message.files) {
        text.push(file.content);
        makeBlock(sessionId, eventId, contentBlocks, {
          kind: "file",
          path: file.path,
          text: file.content,
          metadata: {
            ...(file.lineCount !== undefined ? { lineCount: file.lineCount } : {}),
            ...(file.byteSize !== undefined ? { byteSize: file.byteSize } : {}),
            ...(file.skippedReason !== undefined ? { skippedReason: file.skippedReason } : {}),
          },
        });
        if (file.image !== undefined) addImageBlock(sessionId, eventId, contentBlocks, file.image, { path: file.path });
      }
      return { role: "system", kind: "message", contentText: compactText(text.join("\n")), contentBlocks };
    case "branchSummary":
    case "compactionSummary":
      makeBlock(sessionId, eventId, contentBlocks, { kind: "text", text: message.summary });
      return { role: "system", kind: "summary", contentText: message.summary, contentBlocks };
  }
};

const toolResultOutput = (message: Extract<OmpMessage, { readonly role: "toolResult" }>): NativeValue =>
  message.content.map((part) =>
    part.type === "text"
      ? { type: "text", text: part.text }
      : {
          type: "image",
          mediaType: part.mimeType,
          storage: BLOB_REF.test(part.data) ? "blob" : "inline",
          encodedChars: part.data.length,
          ...(BLOB_REF.test(part.data) ? { uri: part.data } : {}),
        },
  );

const readPreamble = async (
  path: string,
  logicalPath: string,
  stats: Stats,
  diagnostics: NamedDiagnostic[],
): Promise<SourceInfo | undefined> => {
  let titleSlot: OmpTitleEntry | undefined;
  let firstParsed = true;
  try {
    for await (const record of streamJsonlRecords(path, {
      diagnosticName: "omp.line.invalid_json",
      diagnostics,
      sourcePath: logicalPath,
    })) {
      const type = recordType(record.value);
      if (firstParsed && type === "title") {
        firstParsed = false;
        titleSlot = decoded(OmpTitleEntrySchema, record.value);
        if (titleSlot === undefined) {
          pushDiagnostic(diagnostics, "omp.record.invalid_shape", logicalPath, record.lineNumber, "invalid title slot");
        }
        continue;
      }
      firstParsed = false;
      if (type !== "session") {
        pushDiagnostic(diagnostics, "omp.session.header_missing", logicalPath, record.lineNumber, "first logical record is not a session header");
        return undefined;
      }
      const rawHeader = recordFrom(record.value);
      if (typeof rawHeader?.id === "string" && rawHeader.id.trim().length === 0) {
        pushDiagnostic(diagnostics, "omp.session.header_id_empty", logicalPath, record.lineNumber, "session header id is empty");
        return undefined;
      }
      const header = decoded(OmpSessionHeaderSchema, record.value);
      if (header === undefined) {
        pushDiagnostic(diagnostics, "omp.session.header_invalid", logicalPath, record.lineNumber, "invalid session header");
        return undefined;
      }
      const version = header.version ?? 1;
      if (!Number.isInteger(version) || version < 1 || version > 3) {
        pushDiagnostic(diagnostics, "omp.session.version_unsupported", logicalPath, record.lineNumber, `unsupported version ${String(header.version)}`);
        return undefined;
      }
      return { path, logicalPath, stats, header, headerLine: record.lineNumber, ...(titleSlot !== undefined ? { titleSlot } : {}) };
    }
  } catch {
    pushDiagnostic(diagnostics, "omp.root.unreadable", logicalPath, undefined, "unable to read session file");
    return undefined;
  }
  pushDiagnostic(diagnostics, "omp.session.header_missing", logicalPath, undefined, "no session header found");
  return undefined;
};

const nestedParentPath = (path: string, root: string): string | undefined => {
  const parts = relative(root, path).split(sep);
  if (parts.length < 3) return undefined;
  const container = dirname(path);
  return join(dirname(container), `${basename(container)}.jsonl`);
};

const artifactKind = (path: string): string => {
  const extension = extname(path).toLowerCase();
  if (extension === ".png" || extension === ".jpg" || extension === ".jpeg" || extension === ".gif" || extension === ".webp") return "image";
  if (extension === ".md" || extension === ".txt" || extension === ".log" || extension === ".json") return "text";
  return "file";
};

const collectArtifacts = (
  info: SourceInfo,
  physicalRoot: string,
  logicalRoot: string,
  sessionId: SessionId,
): ArtifactDraft[] => {
  const sidecarRoot = join(dirname(info.path), basename(info.path, ".jsonl"));
  if (!existsSync(sidecarRoot)) return [];
  const artifacts: ArtifactDraft[] = [];
  for (const item of walkFilesWithStats(sidecarRoot, (path) => !path.endsWith(".jsonl"))) {
    if (!item.stats.isFile()) continue;
    const logicalPath = logicalPathFor(item.path, physicalRoot, logicalRoot);
    artifacts.push({
      id: artifactIdFor(sessionId, logicalPath),
      kind: artifactKind(item.path),
      path: logicalPath,
      sourcePath: info.logicalPath,
      metadata: { fileName: basename(item.path), size: item.stats.size },
    });
  }
  return artifacts;
};

const parseEntries = async (
  info: SourceInfo,
  diagnostics: NamedDiagnostic[],
): Promise<DecodedEntry[]> => {
  const entries: DecodedEntry[] = [];
  const seen = new Set<string>();
  let previousNativeId: string | undefined;
  try {
    for await (const record of streamJsonlRecords(info.path, {
      diagnosticName: "omp.line.invalid_json",
      diagnostics,
      sourcePath: info.logicalPath,
    })) {
      if (record.lineNumber <= info.headerLine) continue;
      const type = recordType(record.value);
      if (type === undefined || !isOmpEntryType(type)) {
        pushDiagnostic(diagnostics, "omp.record.unknown_type", info.logicalPath, record.lineNumber, "unknown record discriminator");
        continue;
      }
      const entry = decoded(OmpEntrySchema, record.value);
      if (entry === undefined || ((info.header.version ?? 1) >= 3 && entry.id === undefined)) {
        pushDiagnostic(diagnostics, "omp.record.invalid_shape", info.logicalPath, record.lineNumber, `invalid ${type} record`);
        continue;
      }
      const nativeId = entry.id ?? `legacy:${record.lineNumber}:${entry.type}`;
      if (seen.has(nativeId)) {
        pushDiagnostic(diagnostics, "omp.record.duplicate_id", info.logicalPath, record.lineNumber, "duplicate entry id");
        continue;
      }
      seen.add(nativeId);
      const nativeParentId = entry.parentId === null
        ? undefined
        : entry.parentId ?? previousNativeId;
      entries.push({ entry, lineNumber: record.lineNumber, nativeId, ...(nativeParentId !== undefined ? { nativeParentId } : {}) });
      previousNativeId = nativeId;
    }
  } catch {
    pushDiagnostic(diagnostics, "omp.root.unreadable", info.logicalPath, undefined, "unable to read session body");
  }
  return entries;
};

const buildOmpSession = async (
  info: SourceInfo,
  parentInfo: SourceInfo | undefined,
  physicalRoot: string,
  logicalRoot: string,
  options: AdapterDiscoverOptions,
  diagnostics: NamedDiagnostic[],
) => {
  const sessionId = sessionIdFor(PROVIDER, OmpSessionId(info.header.id));
  const decodedEntries = await parseEntries(info, diagnostics);
  const eventDrafts: EventDraft[] = [];
  const eventByNativeId = new Map<string, string>();
  const parentByNativeId = new Map<string, string | undefined>();
  const eventNativeId = new Map<string, string>();
  const toolCallsByNativeId = new Map<string, ToolCallDraft>();
  const toolStarts = new Map<string, { readonly startedAt?: string; readonly input?: NativeValue; readonly toolName?: string }>();
  const usageRecords: UsageDraft[] = [];
  let latestLegacyTitle: string | undefined;
  const semanticTimes: string[] = [];

  const headerTime = isoTime(info.header.timestamp, diagnostics, info.logicalPath, info.headerLine);
  if (headerTime !== undefined) semanticTimes.push(headerTime);
  const titleTime = isoTime(info.titleSlot?.updatedAt, diagnostics, info.logicalPath, 1);
  if (titleTime !== undefined) semanticTimes.push(titleTime);

  for (const decodedEntry of decodedEntries) {
    const { entry, lineNumber, nativeId, nativeParentId } = decodedEntry;
    parentByNativeId.set(nativeId, nativeParentId);
    const classification = classifyOmpRecord(entry);
    if (classification._tag === "drop") continue;
    const entryTime = isoTime(entry.timestamp, diagnostics, info.logicalPath, lineNumber);
    if (entryTime !== undefined) semanticTimes.push(entryTime);

    if (entry.type === "title_change") {
      latestLegacyTitle = entry.title;
      continue;
    }

    const sequence = eventDrafts.length;
    const eventId = eventIdFor(sessionId, lineNumber, nativeId);
    let event: EventDraft;

    if (entry.type === "message") {
      const messageTime = isoTime(entry.message.timestamp, diagnostics, info.logicalPath, lineNumber) ?? entryTime;
      if (messageTime !== undefined) semanticTimes.push(messageTime);
      const projection = projectMessage(sessionId, eventId, entry.message);
      let canonicalToolId: string | undefined;

      if (entry.message.role === "assistant") {
        for (const part of entry.message.content) {
          if (part.type !== "toolCall") continue;
          const toolId = scopedId(sessionId, "tool", part.id);
          canonicalToolId ??= toolId;
          if (toolCallsByNativeId.has(part.id)) {
            pushDiagnostic(diagnostics, "omp.tool_call.duplicate", info.logicalPath, lineNumber, "duplicate tool call id");
            continue;
          }
          const start = toolStarts.get(part.id);
          const input = start?.input ?? projectToolPayloadNativeValue(part.arguments);
          toolCallsByNativeId.set(part.id, {
            id: toolId,
            eventId,
            toolName: part.name,
            status: start === undefined ? "pending" : "started",
            ...(input !== undefined ? { input } : {}),
            ...(start?.startedAt ?? messageTime !== undefined ? { startedAt: start?.startedAt ?? messageTime } : {}),
          });
        }
        const usage = entry.message.usage;
        if (usage !== undefined) {
          usageRecords.push({
            id: usageIdFor(sessionId, eventId, usageRecords.length),
            eventId,
            ...(messageTime !== undefined ? { timestamp: messageTime } : {}),
            ...(entry.message.model !== undefined ? { model: entry.message.model } : {}),
            ...(entry.message.provider !== undefined ? { modelProvider: entry.message.provider } : {}),
            ...(nonNegativeInteger(usage.input) !== undefined ? { inputTokens: nonNegativeInteger(usage.input) } : {}),
            ...(nonNegativeInteger(usage.output) !== undefined ? { outputTokens: nonNegativeInteger(usage.output) } : {}),
            ...(nonNegativeInteger(usage.reasoningTokens) !== undefined ? { reasoningTokens: nonNegativeInteger(usage.reasoningTokens) } : {}),
            ...(nonNegativeInteger(usage.cacheWrite) !== undefined ? { cacheCreationInputTokens: nonNegativeInteger(usage.cacheWrite) } : {}),
            ...(nonNegativeInteger(usage.cacheRead) !== undefined ? { cacheReadInputTokens: nonNegativeInteger(usage.cacheRead) } : {}),
            ...(nonNegativeInteger(usage.totalTokens) !== undefined ? { totalTokens: nonNegativeInteger(usage.totalTokens) } : {}),
            ...(nonNegativeNumber(usage.cost?.total) !== undefined ? { cost: nonNegativeNumber(usage.cost?.total), currency: "USD" } : {}),
          });
        }
      } else if (entry.message.role === "toolResult") {
        const nativeToolId = entry.message.toolCallId;
        const canonicalId = scopedId(sessionId, "tool", nativeToolId);
        canonicalToolId = canonicalId;
        const existing = toolCallsByNativeId.get(nativeToolId);
        if (existing?.completedAt !== undefined) {
          pushDiagnostic(diagnostics, "omp.tool_result.duplicate", info.logicalPath, lineNumber, "duplicate tool result id");
        }
        if (existing === undefined) {
          pushDiagnostic(diagnostics, "omp.tool_result.orphan", info.logicalPath, lineNumber, "tool result has no invocation");
        }
        const output = projectToolPayloadNativeValue(toolResultOutput(entry.message));
        toolCallsByNativeId.set(nativeToolId, {
          id: existing?.id ?? canonicalId,
          eventId: existing?.eventId ?? eventId,
          toolName: existing?.toolName ?? entry.message.toolName,
          status: entry.message.isError ? "failed" : "completed",
          ...(existing?.input !== undefined ? { input: existing.input } : {}),
          ...(output !== undefined ? { output } : {}),
          ...(existing?.startedAt !== undefined ? { startedAt: existing.startedAt } : {}),
          ...(messageTime !== undefined ? { completedAt: messageTime } : {}),
        });
      } else if (entry.message.role === "bashExecution" || entry.message.role === "pythonExecution") {
        const nativeToolId = `execution:${nativeId}`;
        const canonicalId = scopedId(sessionId, "tool", nativeToolId);
        canonicalToolId = canonicalId;
        const toolName = entry.message.role === "bashExecution" ? "bash" : "python";
        const inputValue = entry.message.role === "bashExecution"
          ? { command: entry.message.command }
          : { code: entry.message.code };
        const output = projectToolPayloadNativeValue({
          text: entry.message.output,
          truncated: entry.message.truncated,
          exitCode: entry.message.exitCode ?? null,
        });
        toolCallsByNativeId.set(nativeToolId, {
          id: canonicalId,
          eventId,
          toolName,
          status: entry.message.cancelled ? "cancelled" : entry.message.exitCode === 0 ? "completed" : "failed",
          input: inputValue,
          ...(output !== undefined ? { output } : {}),
          ...(messageTime !== undefined ? { startedAt: messageTime, completedAt: messageTime } : {}),
        });
      }

      event = {
        id: eventId,
        nativeEventId: nativeId,
        sequence,
        ...(messageTime !== undefined ? { timestamp: messageTime } : {}),
        role: projection.role,
        kind: projection.kind,
        ...(projection.contentText !== undefined ? { contentText: projection.contentText } : {}),
        contentBlocks: projection.contentBlocks,
        ...(canonicalToolId !== undefined ? { toolCallId: canonicalToolId } : {}),
        rawReference: { sourcePath: info.logicalPath, line: lineNumber, nativeType: `message:${entry.message.role}` },
      };
    } else if (entry.type === "compaction" || entry.type === "branch_summary") {
      event = {
        id: eventId,
        nativeEventId: nativeId,
        sequence,
        ...(entryTime !== undefined ? { timestamp: entryTime } : {}),
        role: "system",
        kind: "summary",
        contentText: entry.summary,
        contentBlocks: [{
          id: contentBlockIdFor(sessionId, eventId, 0),
          sequence: 0,
          kind: "text",
          text: entry.summary,
          metadata: entry.type === "compaction"
            ? { firstKeptEntryId: entry.firstKeptEntryId, tokensBefore: entry.tokensBefore }
            : { fromId: entry.fromId },
        }],
        rawReference: { sourcePath: info.logicalPath, line: lineNumber, nativeType: entry.type },
      };
    } else if (entry.type === "custom_message") {
      const contentBlocks: ContentBlock[] = [];
      const contentText = compactText(addUserContent(sessionId, eventId, contentBlocks, entry.content).join("\n"));
      event = {
        id: eventId,
        nativeEventId: nativeId,
        sequence,
        ...(entryTime !== undefined ? { timestamp: entryTime } : {}),
        role: "system",
        kind: entry.customType === "skill-prompt" ? "preamble" : "message",
        ...(contentText !== undefined ? { contentText } : {}),
        contentBlocks,
        rawReference: { sourcePath: info.logicalPath, line: lineNumber, nativeType: `custom_message:${entry.customType}` },
      };
    } else {
      const projected = projectSessionNativeValue(entry) ?? { type: entry.type };
      event = {
        id: eventId,
        nativeEventId: nativeId,
        sequence,
        ...(entryTime !== undefined ? { timestamp: entryTime } : {}),
        role: "system",
        kind: "lifecycle",
        contentBlocks: [jsonBlock(sessionId, eventId, 0, projected)],
        rawReference: { sourcePath: info.logicalPath, line: lineNumber, nativeType: entry.type },
      };

      if (entry.type === "custom" && entry.customType === "tool_execution_start") {
        const data = recordFrom(entry.data);
        const nativeToolId = stringValue(data?.toolCallId);
        if (nativeToolId !== undefined) {
          const startedAt = isoTime(data?.startedAt, diagnostics, info.logicalPath, lineNumber) ?? entryTime;
          const input = projectToolPayloadNativeValue(data?.args);
          const toolName = stringValue(data?.toolName);
          toolStarts.set(nativeToolId, {
            ...(startedAt !== undefined ? { startedAt } : {}),
            ...(input !== undefined ? { input } : {}),
            ...(toolName !== undefined ? { toolName } : {}),
          });
          const existing = toolCallsByNativeId.get(nativeToolId);
          if (existing !== undefined) {
            toolCallsByNativeId.set(nativeToolId, {
              ...existing,
              status: "started",
              ...(input !== undefined ? { input } : {}),
              ...(startedAt !== undefined ? { startedAt } : {}),
            });
          }
        }
      }
    }

    eventDrafts.push(event);
    eventByNativeId.set(nativeId, event.id);
    eventNativeId.set(event.id, nativeId);
  }

  const cyclicNativeIds = new Set<string>();
  for (const start of parentByNativeId.keys()) {
    const chain: string[] = [];
    const indexByNativeId = new Map<string, number>();
    let cursor: string | undefined = start;
    while (cursor !== undefined && parentByNativeId.has(cursor)) {
      const cycleStart = indexByNativeId.get(cursor);
      if (cycleStart !== undefined) {
        for (const nativeId of chain.slice(cycleStart)) cyclicNativeIds.add(nativeId);
        break;
      }
      indexByNativeId.set(cursor, chain.length);
      chain.push(cursor);
      cursor = parentByNativeId.get(cursor);
    }
  }
  if (cyclicNativeIds.size > 0) {
    pushDiagnostic(diagnostics, "omp.parent.cycle", info.logicalPath, undefined, "entry parent cycle");
  }

  const edges: EdgeDraft[] = [];
  const events = eventDrafts.map((event) => {
    const nativeId = eventNativeId.get(event.id);
    if (nativeId !== undefined && cyclicNativeIds.has(nativeId)) return event;
    let cursor = nativeId === undefined ? undefined : parentByNativeId.get(nativeId);
    const visited = new Set<string>();
    let parentEventId: string | undefined;
    while (cursor !== undefined) {
      if (visited.has(cursor) || cyclicNativeIds.has(cursor)) {
        return event;
      }
      visited.add(cursor);
      parentEventId = eventByNativeId.get(cursor);
      if (parentEventId !== undefined) break;
      const next = parentByNativeId.get(cursor);
      if (next === undefined && !parentByNativeId.has(cursor)) {
        pushDiagnostic(diagnostics, "omp.parent.missing", info.logicalPath, event.rawReference.line, "entry parent is missing");
      }
      cursor = next;
    }
    if (parentEventId === undefined) return event;
    edges.push({
      id: edgeIdFor(sessionId, "parent", parentEventId, event.id),
      kind: "parent",
      fromEventId: parentEventId,
      toEventId: event.id,
    });
    return { ...event, parentEventId };
  });

  const resultEventByToolId = new Map<string, string>();
  for (const event of events) {
    if (event.kind === "tool_result" && event.toolCallId !== undefined) {
      resultEventByToolId.set(event.toolCallId, event.id);
    }
  }
  for (const toolCall of toolCallsByNativeId.values()) {
    const resultEventId = resultEventByToolId.get(toolCall.id);
    if (resultEventId === undefined) continue;
    edges.push({
      id: edgeIdFor(sessionId, "tool_result_for", toolCall.eventId, resultEventId),
      kind: "tool_result_for",
      fromEventId: toolCall.eventId,
      toEventId: resultEventId,
    });
  }

  const explicitParentNative = info.header.parentSession;
  if (explicitParentNative !== undefined) {
    const parentSessionId = sessionIdFor(PROVIDER, OmpSessionId(explicitParentNative));
    edges.push({
      id: edgeIdFor(sessionId, "subagent_of", parentSessionId, sessionId),
      kind: "subagent_of",
      fromId: parentSessionId,
      toId: sessionId,
      rawReference: { sourcePath: info.logicalPath, nativeType: "parentSession" },
    });
  } else if (parentInfo !== undefined) {
    const parentSessionId = sessionIdFor(PROVIDER, OmpSessionId(parentInfo.header.id));
    edges.push({
      id: edgeIdFor(sessionId, "subagent_of", parentSessionId, sessionId),
      kind: "subagent_of",
      fromId: parentSessionId,
      toId: sessionId,
      rawReference: { sourcePath: info.logicalPath, nativeType: "nested_transcript" },
    });
  } else if (nestedParentPath(info.path, physicalRoot) !== undefined) {
    pushDiagnostic(diagnostics, "omp.parent_session.missing", info.logicalPath, undefined, "nested transcript has no sibling main session");
  }

  if (info.header.fork !== undefined) {
    const forkSessionId = sessionIdFor(PROVIDER, OmpSessionId(info.header.fork));
    edges.push({
      id: edgeIdFor(sessionId, "forked_from", forkSessionId, sessionId),
      kind: "forked_from",
      fromId: forkSessionId,
      toId: sessionId,
      rawReference: { sourcePath: info.logicalPath, nativeType: "fork" },
    });
  }

  const title = info.titleSlot?.title ?? latestLegacyTitle ?? info.header.title;
  const fallbackTime = new Date(info.stats.mtimeMs).toISOString();
  const updatedAt = semanticTimes.length === 0
    ? fallbackTime
    : semanticTimes.reduce((latest, value) => value > latest ? value : latest);
  const isNested = nestedParentPath(info.path, physicalRoot) !== undefined;

  return buildSession({
    provider: PROVIDER,
    agentName: isNested ? `omp:${basename(info.path, ".jsonl")}` : AGENT_NAME,
    machine: options.machine,
    sessionId,
    nativeSessionId: info.header.id,
    nativeProjectKey: info.header.cwd,
    ...(title !== undefined && title.length > 0 ? { title } : {}),
    startedAt: headerTime ?? fallbackTime,
    updatedAt,
    sourceRoot: logicalRoot,
    sourcePath: info.logicalPath,
    projectPath: info.header.cwd,
    events,
    toolCalls: [...toolCallsByNativeId.values()],
    sessionEdges: edges,
    usageRecords,
    artifacts: collectArtifacts(info, physicalRoot, logicalRoot, sessionId),
  });
};

async function* streamOmp(options: AdapterDiscoverOptions): AsyncGenerator<AdapterStreamItem> {
  const physicalRoot = options.roots?.omp ?? ompAdapter.defaultRoot();
  if (physicalRoot === undefined || !existsSync(physicalRoot)) {
    yield {
      type: "diagnostic",
      diagnostic: {
        adapterId: ADAPTER_ID,
        provider: PROVIDER,
        status: "no_data_found",
        parserConfidence: "documented",
        ...(physicalRoot !== undefined ? { rootPath: physicalRoot } : {}),
        message: "OMP session root was not found.",
      },
    };
    return;
  }

  const logicalRoot = logicalRootFor(PROVIDER, physicalRoot, options);
  yield { type: "sourceRoot", sourceRoot: sourceRoot(PROVIDER, ADAPTER_ID, logicalRoot, options.machine, options.now) };

  const diagnostics: NamedDiagnostic[] = [];
  const sourceInfos: SourceInfo[] = [];
  const bodyPaths = new Set<string>();
  for (const item of walkFilesWithStats(physicalRoot, (path) => path.endsWith(".jsonl"))) {
    const logicalPath = logicalPathFor(item.path, physicalRoot, logicalRoot);
    const info = await readPreamble(item.path, logicalPath, item.stats, diagnostics);
    const shouldReadBody = options.shouldReadFile === undefined || options.shouldReadFile(item.path, item.stats);
    if (info === undefined) continue;
    sourceInfos.push(info);
    if (shouldReadBody) bodyPaths.add(item.path);
  }

  const byPath = new Map(sourceInfos.map((info) => [info.path, info] as const));
  let accepted = 0;
  let skipped = 0;
  for (const info of sourceInfos) {
    if (!bodyPaths.has(info.path)) continue;
    if (skipped < (options.skip ?? 0)) {
      skipped += 1;
      continue;
    }
    if (accepted >= (options.limit ?? Number.POSITIVE_INFINITY)) break;
    const sessionId = sessionIdFor(PROVIDER, OmpSessionId(info.header.id));
    if (options.shouldParseSession !== undefined) {
      const shouldParse = await options.shouldParseSession({
        sessionId,
        sourceFingerprint: sourceFingerprintFor(info.stats),
      });
      if (!shouldParse) continue;
    }
    const parentPath = nestedParentPath(info.path, physicalRoot);
    const session = await buildOmpSession(
      info,
      parentPath === undefined ? undefined : byPath.get(parentPath),
      physicalRoot,
      logicalRoot,
      options,
      diagnostics,
    );
    yield {
      type: "session",
      session,
      sourceUnit: {
        provider: PROVIDER,
        adapterId: ADAPTER_ID,
        rootPath: logicalRoot,
        sourcePath: info.logicalPath,
        physicalPath: info.path,
      },
      fingerprint: { size: info.stats.size, mtimeMs: info.stats.mtimeMs },
    };
    accepted += 1;
  }

  for (const diagnostic of diagnostics) {
    yield {
      type: "diagnostic",
      diagnostic: {
        adapterId: ADAPTER_ID,
        provider: PROVIDER,
        status: "unsupported",
        parserConfidence: "documented",
        rootPath: logicalRoot,
        message: `OMP source record dropped (${diagnostic.name}).`,
        details: { error: diagnostic.message },
      },
    };
  }

  yield {
    type: "diagnostic",
    diagnostic: {
      adapterId: ADAPTER_ID,
      provider: PROVIDER,
      status: accepted > 0 ? "available" : "no_data_found",
      parserConfidence: "documented",
      rootPath: logicalRoot,
      message: `Discovered ${accepted} OMP session(s).`,
    },
  };
}

export const ompAdapter: SessionAdapter = {
  id: ADAPTER_ID,
  provider: PROVIDER,
  displayName: "Oh My Pi local JSONL",
  stable: true,
  defaultRoot: () => homePath(".omp/agent/sessions"),
  read: async (options) => collectAdapterStream(streamOmp(options)),
  stream: streamOmp,
};
