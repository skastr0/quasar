import {
  existsSync,
  readFileSync,
  realpathSync,
  type Stats,
} from "node:fs";
import { isAbsolute, join, resolve } from "node:path";

import { PiSessionId, type SessionId } from "../core/identity";
import type {
  ContentBlock,
  SessionEdge,
  SessionEvent,
  ToolCall,
  UsageRecord,
} from "../core/schemas";
import {
  buildSession,
  contentBlockIdFor,
  edgeIdFor,
  eventIdFor,
  homePath,
  jsonBlock,
  logicalPathFor,
  projectSessionNativeValue,
  projectToolPayloadNativeValue,
  scopedId,
  sessionIdFor,
  sourceFingerprintFor,
  sourceRoot,
  textBlock,
  usageIdFor,
  walkFilesWithStats,
  type NativeValue,
} from "./common";
import { isSignal, type DecodeDiagnostic } from "./harness-schema";
import {
  classifyPiRecord,
  type PiAgentMessage,
  type PiAssistantMessage,
  type PiLegacyV1Entry,
  type PiSessionEntry,
  type PiSessionHeader,
  type PiToolResultMessage,
} from "./pi-schema";
import {
  collectAdapterStream,
  type AdapterDiscoverOptions,
  type AdapterStreamItem,
  type SessionAdapter,
} from "./types";

type PiEventDraft = Omit<
  SessionEvent,
  "sessionId" | "machineId" | "provider" | "agentName" | "projectIdentityKey" | "contentBlocks"
> & { readonly contentBlocks?: readonly ContentBlock[]; readonly contentSource?: NativeValue };
type PiToolDraft = Omit<ToolCall, "sessionId" | "machineId" | "provider" | "agentName" | "projectIdentityKey">;
type PiUsageDraft = Omit<UsageRecord, "sessionId" | "machineId" | "provider" | "agentName" | "projectIdentityKey">;
type PiEdgeDraft = Omit<SessionEdge, "sessionId" | "machineId" | "provider" | "agentName" | "projectIdentityKey">;

type ParsedLine = {
  readonly value: unknown;
  readonly lineNumber: number;
  readonly rawBytes: number;
};

type PiFileProbe = {
  readonly path: string;
  readonly physicalRoot: string;
  readonly logicalRoot: string;
  readonly sourcePath: string;
  readonly stats: Stats;
  readonly text: string;
  readonly header: PiSessionHeader;
  readonly headerLine: number;
  readonly version: 1 | 2 | 3;
};

type MutableTool = {
  id: string;
  eventId: string;
  toolName: string;
  status?: string;
  input?: unknown;
  output?: unknown;
  startedAt?: string;
  completedAt?: string;
};

const diagnosticItem = (
  rootPath: string,
  sourcePath: string | undefined,
  name: string,
  message: string,
  status: "error" | "unsupported" = "unsupported",
): AdapterStreamItem => ({
  type: "diagnostic",
  diagnostic: {
    adapterId: piAdapter.id,
    provider: "pi",
    status,
    parserConfidence: "documented",
    rootPath,
    message,
    details: {
      diagnostic: name,
      ...(sourcePath !== undefined ? { sourcePath } : {}),
    },
  },
});

const validIso = (value: string): string | undefined => {
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) ? new Date(milliseconds).toISOString() : undefined;
};

const timestampFromMessage = (
  timestamp: number,
  fallback: string | undefined,
  diagnostics: DecodeDiagnostic[],
  sourcePath: string,
  lineNumber: number,
): string | undefined => {
  const date = new Date(timestamp);
  if (Number.isFinite(date.getTime())) return date.toISOString();
  diagnostics.push({
    name: "pi.timestamp.invalid",
    message: `Invalid nested message timestamp at ${sourcePath}:${lineNumber}`,
  });
  return fallback;
};

const likelyBase64 = (value: string): boolean =>
  value.length >= 16 && value.length % 4 === 0 && /^[A-Za-z0-9+/]+={0,2}$/.test(value);

const sanitizeOpaque = (value: unknown, key?: string): unknown => {
  if (value === null || value === undefined) return value;
  if (typeof value === "string") {
    if (key === "data" && likelyBase64(value)) return undefined;
    return value;
  }
  if (typeof value !== "object") return value;
  if (Array.isArray(value)) {
    return value.flatMap((item) => {
      const sanitized = sanitizeOpaque(item);
      return sanitized === undefined ? [] : [sanitized];
    });
  }
  const entries = Object.entries(value as Record<string, unknown>).flatMap(([childKey, child]) => {
    if (/signature/i.test(childKey)) return [];
    const sanitized = sanitizeOpaque(child, childKey);
    return sanitized === undefined ? [] : [[childKey, sanitized] as const];
  });
  return Object.fromEntries(entries);
};

const imageBlock = (
  sessionId: SessionId,
  eventId: string,
  sequence: number,
  image: { readonly data: string; readonly mimeType: string },
): ContentBlock => ({
  id: contentBlockIdFor(sessionId, eventId, sequence),
  sequence,
  kind: "image",
  mediaType: image.mimeType,
  metadata: {
    embedded: true,
    dataBytes: Buffer.byteLength(image.data, "base64"),
  },
});

const messageBlocks = (
  sessionId: SessionId,
  eventId: string,
  content: string | readonly ({ readonly type: string; readonly text?: string; readonly data?: string; readonly mimeType?: string })[],
): ContentBlock[] => {
  if (typeof content === "string") return textBlock(sessionId, eventId, 0, content);
  const blocks: ContentBlock[] = [];
  for (const part of content) {
    if (part.type === "text" && part.text !== undefined) {
      blocks.push(...textBlock(sessionId, eventId, blocks.length, part.text));
    } else if (part.type === "image" && part.data !== undefined && part.mimeType !== undefined) {
      blocks.push(imageBlock(sessionId, eventId, blocks.length, { data: part.data, mimeType: part.mimeType }));
    }
  }
  return blocks;
};

const semanticText = (
  content: string | readonly ({ readonly type: string; readonly text?: string })[],
): string | undefined => {
  if (typeof content === "string") return content.trim().length > 0 ? content : undefined;
  const text = content.flatMap((part) => part.type === "text" && part.text !== undefined ? [part.text] : []).join("\n");
  return text.trim().length > 0 ? text : undefined;
};

const parseLines = (
  text: string,
  sourcePath: string,
  diagnostics: DecodeDiagnostic[],
): ParsedLine[] => {
  const result: ParsedLine[] = [];
  const lines = text.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const raw = lines[index]!;
    if (raw.trim().length === 0) continue;
    try {
      result.push({
        value: JSON.parse(raw) as unknown,
        lineNumber: index + 1,
        rawBytes: Buffer.byteLength(raw, "utf8"),
      });
    } catch (error) {
      diagnostics.push({
        name: "pi.line.invalid_json",
        message: `Invalid JSON at ${sourcePath}:${index + 1}: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  }
  return result;
};

const expandHome = (path: string): string => {
  if (path === "~") return process.env.HOME ?? path;
  if (path.startsWith("~/")) return join(process.env.HOME ?? "~", path.slice(2));
  return resolve(path);
};

const configuredSessionDirectory = (agentDir: string): string | undefined => {
  const settingsPath = join(agentDir, "settings.json");
  if (!existsSync(settingsPath)) return undefined;
  try {
    const settings = JSON.parse(readFileSync(settingsPath, "utf8")) as unknown;
    if (typeof settings !== "object" || settings === null || Array.isArray(settings) || !("sessionDir" in settings)) return undefined;
    const value = settings.sessionDir;
    return typeof value === "string" && value.trim().length > 0 ? expandHome(value) : undefined;
  } catch {
    return undefined;
  }
};

const candidateRoots = (options: AdapterDiscoverOptions): string[] => {
  if (options.roots?.pi !== undefined) return [options.roots.pi];
  const defaultAgentDir = homePath(".pi/agent");
  const agentDir = expandHome(process.env.PI_CODING_AGENT_DIR ?? defaultAgentDir ?? ".pi/agent");
  const candidates = [
    process.env.PI_CODING_AGENT_SESSION_DIR,
    configuredSessionDirectory(agentDir),
    join(agentDir, "sessions"),
    defaultAgentDir === undefined ? undefined : join(defaultAgentDir, "sessions"),
  ].filter((value): value is string => value !== undefined && value.trim().length > 0);
  const seen: Record<string, true> = {};
  return candidates.flatMap((candidate) => {
    const normalized = existsSync(candidate) ? realpathSync(candidate) : resolve(candidate);
    if (seen[normalized] === true) return [];
    seen[normalized] = true;
    return [normalized];
  });
};

const probeHeader = (
  sourcePath: string,
  text: string,
): { readonly header?: PiSessionHeader; readonly headerLine?: number; readonly version?: 1 | 2 | 3; readonly diagnostics: DecodeDiagnostic[]; readonly fatal?: { readonly name: string; readonly message: string } } => {
  const diagnostics: DecodeDiagnostic[] = [];
  const physicalLines = text.split(/\r?\n/);
  let sawNonEmpty = false;
  for (let index = 0; index < physicalLines.length; index += 1) {
    const raw = physicalLines[index]!;
    if (raw.trim().length === 0) continue;
    sawNonEmpty = true;
    let value: unknown;
    try {
      value = JSON.parse(raw) as unknown;
    } catch {
      continue;
    }
    const record = typeof value === "object" && value !== null && !Array.isArray(value)
      ? value as Record<string, unknown>
      : undefined;
    if (record?.type !== "session") {
      return {
        diagnostics,
        fatal: {
          name: "pi.header.not_first_valid_record",
          message: `First parseable record at ${sourcePath}:${index + 1} is not a Pi session header`,
        },
      };
    }
    const classified = classifyPiRecord(value, { header: true, diagnostics });
    if (!isSignal(classified)) {
      return {
        diagnostics,
        fatal: { name: "pi.header.decode_failed", message: `Invalid Pi header at ${sourcePath}:${index + 1}` },
      };
    }
    const header = classified.value as PiSessionHeader;
    const rawVersion = header.version ?? 1;
    if (!Number.isInteger(rawVersion) || rawVersion < 1 || rawVersion > 3) {
      return {
        diagnostics,
        fatal: {
          name: "pi.header.unsupported_version",
          message: `Unsupported Pi session version ${String(rawVersion)} at ${sourcePath}:${index + 1}`,
        },
      };
    }
    if (header.id.trim().length === 0) {
      return {
        diagnostics,
        fatal: { name: "pi.header.decode_failed", message: `Pi header id is empty at ${sourcePath}:${index + 1}` },
      };
    }
    return { header, headerLine: index + 1, version: rawVersion as 1 | 2 | 3, diagnostics };
  }
  return {
    diagnostics,
    fatal: {
      name: sawNonEmpty ? "pi.header.missing" : "pi.file.empty",
      message: sawNonEmpty ? `No parseable Pi header in ${sourcePath}` : `Pi session file is empty: ${sourcePath}`,
    },
  };
};

const migrateEntry = (
  entry: PiLegacyV1Entry,
  index: number,
  generatedIds: readonly string[],
): PiSessionEntry | undefined => {
  const id = generatedIds[index]!;
  const parentId = index === 0 ? null : generatedIds[index - 1]!;
  if (entry.type === "compaction") {
    const firstKeptEntryId = Number.isInteger(entry.firstKeptEntryIndex)
      ? generatedIds[entry.firstKeptEntryIndex]
      : undefined;
    if (firstKeptEntryId === undefined) return undefined;
    const { firstKeptEntryIndex: _firstKeptEntryIndex, ...rest } = entry;
    return { ...rest, id, parentId, firstKeptEntryId } as PiSessionEntry;
  }
  return { ...entry, id, parentId } as PiSessionEntry;
};

const contentMetadata = (entry: PiSessionEntry): NativeValue | undefined => {
  if (entry.type === "model_change") return { provider: entry.provider, modelId: entry.modelId };
  if (entry.type === "thinking_level_change") return { thinkingLevel: entry.thinkingLevel };
  if (entry.type === "custom") return projectSessionNativeValue({ customType: entry.customType, data: sanitizeOpaque(entry.data) });
  if (entry.type === "label") return { targetId: entry.targetId, ...(entry.label !== undefined ? { label: entry.label } : {}) };
  if (entry.type === "session_info") return entry.name === undefined ? {} : { name: entry.name };
  return undefined;
};

const normalizeFile = (
  probe: PiFileProbe,
  options: AdapterDiscoverOptions,
  nativeIdByPath: ReadonlyMap<string, string>,
  diagnostics: DecodeDiagnostic[],
) => {
  const nativeSessionId = probe.header.id;
  const sessionId = sessionIdFor("pi", PiSessionId(nativeSessionId));
  const parsed = parseLines(probe.text, probe.sourcePath, diagnostics);
  const rawEntries = parsed.filter((line) => line.lineNumber !== probe.headerLine);
  const decodedEntries: { entry: PiSessionEntry; line: ParsedLine }[] = [];

  if (probe.version === 1) {
    diagnostics.push({ name: "pi.session.legacy_v1", message: `Read-only v1 migration for ${probe.sourcePath}` });
    const legacy: { entry: PiLegacyV1Entry; line: ParsedLine }[] = [];
    for (const line of rawEntries) {
      const record = typeof line.value === "object" && line.value !== null && !Array.isArray(line.value)
        ? line.value as Record<string, unknown>
        : undefined;
      if (record?.type === "session") {
        diagnostics.push({ name: "pi.header.duplicate", message: `Duplicate header at ${probe.sourcePath}:${line.lineNumber}` });
        continue;
      }
      const classified = classifyPiRecord(line.value, { version: 1, diagnostics });
      if (isSignal(classified)) legacy.push({ entry: classified.value as PiLegacyV1Entry, line });
    }
    const generatedIds = legacy.map(({ entry, line }) => scopedId(sessionId, "pi-v1-entry", line.lineNumber, sanitizeOpaque(entry)));
    for (let index = 0; index < legacy.length; index += 1) {
      const migrated = migrateEntry(legacy[index]!.entry, index, generatedIds);
      if (migrated === undefined) {
        diagnostics.push({ name: "pi.compaction.first_kept_missing", message: `Invalid v1 firstKeptEntryIndex at ${probe.sourcePath}:${legacy[index]!.line.lineNumber}` });
      } else {
        decodedEntries.push({ entry: migrated, line: legacy[index]!.line });
      }
    }
  } else {
    if (probe.version === 2) diagnostics.push({ name: "pi.session.legacy_v2", message: `Read-only v2 migration for ${probe.sourcePath}` });
    for (const line of rawEntries) {
      let value = line.value;
      const record = typeof value === "object" && value !== null && !Array.isArray(value)
        ? value as Record<string, unknown>
        : undefined;
      if (record?.type === "session") {
        diagnostics.push({ name: "pi.header.duplicate", message: `Duplicate header at ${probe.sourcePath}:${line.lineNumber}` });
        continue;
      }
      if (probe.version === 2 && record?.type === "message") {
        const message = typeof record.message === "object" && record.message !== null && !Array.isArray(record.message)
          ? record.message as Record<string, unknown>
          : undefined;
        if (message?.role === "hookMessage") value = { ...record, message: { ...message, role: "custom" } };
      }
      const classified = classifyPiRecord(value, { version: probe.version, diagnostics });
      if (isSignal(classified)) decodedEntries.push({ entry: classified.value as PiSessionEntry, line });
    }
  }

  const uniqueEntries: { entry: PiSessionEntry; line: ParsedLine }[] = [];
  const entryById = new Map<string, PiSessionEntry>();
  for (const item of decodedEntries) {
    if (entryById.has(item.entry.id)) {
      diagnostics.push({ name: "pi.entry.duplicate_id", message: `Duplicate entry id ${item.entry.id} at ${probe.sourcePath}:${item.line.lineNumber}` });
      continue;
    }
    entryById.set(item.entry.id, item.entry);
    uniqueEntries.push(item);
  }

  const events: PiEventDraft[] = [];
  const tools = new Map<string, MutableTool>();
  const usageRecords: PiUsageDraft[] = [];
  const edges: PiEdgeDraft[] = [];
  const eventsByEntry = new Map<string, string[]>();
  let sequence = 0;
  let title: string | undefined;
  let updatedAtMilliseconds: number | undefined;
  const advanceUpdatedAt = (timestamp: string | undefined): void => {
    if (timestamp === undefined) return;
    const milliseconds = Date.parse(timestamp);
    if (!Number.isFinite(milliseconds) || !Number.isFinite(new Date(milliseconds).getTime())) return;
    updatedAtMilliseconds = Math.max(
      updatedAtMilliseconds ?? Number.NEGATIVE_INFINITY,
      milliseconds,
    );
  };

  const appendEvent = (
    entry: PiSessionEntry,
    line: ParsedLine,
    partIndex: number,
    fields: Omit<PiEventDraft, "id" | "nativeEventId" | "sequence" | "rawReference">,
  ): string => {
    const nativeEventId = `${entry.id}:${partIndex}`;
    const id = eventIdFor(sessionId, sequence, nativeEventId);
    events.push({
      id,
      nativeEventId,
      sequence,
      ...fields,
      rawReference: {
        sourcePath: probe.sourcePath,
        line: line.lineNumber,
        nativeType: entry.type,
        rawBytes: line.rawBytes,
      },
    });
    advanceUpdatedAt(fields.timestamp);
    sequence += 1;
    const entryEvents = eventsByEntry.get(entry.id) ?? [];
    entryEvents.push(id);
    eventsByEntry.set(entry.id, entryEvents);
    return id;
  };

  for (const { entry, line } of uniqueEntries) {
    const entryTimestamp = validIso(entry.timestamp);
    if (entryTimestamp === undefined) diagnostics.push({ name: "pi.timestamp.invalid", message: `Invalid entry timestamp at ${probe.sourcePath}:${line.lineNumber}` });
    if (entry.type === "session_info") {
      title = entry.name?.trim() || undefined;
    }
    if (entry.type === "label" && !entryById.has(entry.targetId)) {
      diagnostics.push({ name: "pi.label.target_missing", message: `Missing label target ${entry.targetId} at ${probe.sourcePath}:${line.lineNumber}` });
    }
    if (entry.type === "compaction" && !entryById.has(entry.firstKeptEntryId)) {
      diagnostics.push({ name: "pi.compaction.first_kept_missing", message: `Missing compaction first-kept entry ${entry.firstKeptEntryId} at ${probe.sourcePath}:${line.lineNumber}` });
    }

    if (entry.type !== "message") {
      if (entry.type === "compaction" || entry.type === "branch_summary") {
        const eventId = appendEvent(entry, line, 0, {
          role: "assistant",
          kind: "summary",
          timestamp: entryTimestamp,
          contentText: entry.summary,
          contentSource: projectSessionNativeValue({
            summary: entry.summary,
            ...(entry.type === "compaction"
              ? { firstKeptEntryId: entry.firstKeptEntryId, tokensBefore: entry.tokensBefore }
              : { fromId: entry.fromId }),
            ...((entry.details !== undefined) ? { details: sanitizeOpaque(entry.details) } : {}),
            ...((entry.fromHook !== undefined) ? { fromHook: entry.fromHook } : {}),
          }),
        });
        if (entry.type === "compaction") {
          const target = eventsByEntry.get(entry.firstKeptEntryId)?.at(-1);
          if (target !== undefined) {
            edges.push({
              id: edgeIdFor(sessionId, "compacted_into", target, eventId),
              kind: "compacted_into",
              fromEventId: target,
              toEventId: eventId,
            });
          }
        }
      } else if (entry.type === "custom_message") {
        const id = appendEvent(entry, line, 0, {
          role: "system",
          kind: "preamble",
          timestamp: entryTimestamp,
          contentText: semanticText(entry.content),
        });
        const index = events.findIndex((event) => event.id === id);
        events[index] = { ...events[index]!, contentBlocks: messageBlocks(sessionId, id, entry.content) };
      } else {
        appendEvent(entry, line, 0, {
          role: "system",
          kind: "lifecycle",
          timestamp: entryTimestamp,
          contentSource: contentMetadata(entry),
        });
      }
      continue;
    }

    const message = entry.message as PiAgentMessage;
    const messageTimestamp = timestampFromMessage(message.timestamp, entryTimestamp, diagnostics, probe.sourcePath, line.lineNumber);
    if (message.role === "user") {
      const id = appendEvent(entry, line, 0, {
        role: "user",
        kind: "message",
        timestamp: messageTimestamp,
        contentText: semanticText(message.content),
      });
      const index = events.findIndex((event) => event.id === id);
      events[index] = { ...events[index]!, contentBlocks: messageBlocks(sessionId, id, message.content) };
      continue;
    }
    if (message.role === "assistant") {
      const assistant = message as PiAssistantMessage;
      let firstEventId: string | undefined;
      for (let partIndex = 0; partIndex < assistant.content.length; partIndex += 1) {
        const part = assistant.content[partIndex]!;
        if (part.type === "text") {
          const id = appendEvent(entry, line, partIndex, {
            role: "assistant",
            kind: "message",
            timestamp: messageTimestamp,
            contentText: part.text,
            contentBlocks: textBlock(sessionId, eventIdFor(sessionId, sequence, `${entry.id}:${partIndex}`), 0, part.text),
          });
          firstEventId ??= id;
        } else if (part.type === "thinking") {
          const id = appendEvent(entry, line, partIndex, {
            role: "thinking",
            kind: "reasoning",
            timestamp: messageTimestamp,
            contentText: part.thinking,
            contentBlocks: [{
              id: contentBlockIdFor(sessionId, eventIdFor(sessionId, sequence, `${entry.id}:${partIndex}`), 0),
              sequence: 0,
              kind: "thinking",
              thinking: part.thinking,
              metadata: { redacted: part.redacted === true },
            }],
          });
          firstEventId ??= id;
        } else {
          const toolId = scopedId(sessionId, "tool", part.id);
          const id = appendEvent(entry, line, partIndex, {
            role: "assistant",
            kind: "tool_call",
            timestamp: messageTimestamp,
            toolCallId: toolId,
            contentBlocks: [jsonBlock(sessionId, eventIdFor(sessionId, sequence, `${entry.id}:${partIndex}`), 0, {
              name: part.name,
              arguments: projectToolPayloadNativeValue(sanitizeOpaque(part.arguments)),
            })],
          });
          firstEventId ??= id;
          tools.set(part.id, {
            id: toolId,
            eventId: id,
            toolName: part.name,
            status: assistant.stopReason === "error" || assistant.stopReason === "aborted" ? "error" : "pending",
            input: projectToolPayloadNativeValue(sanitizeOpaque(part.arguments)),
            startedAt: messageTimestamp,
          });
        }
      }
      if (firstEventId === undefined) {
        firstEventId = appendEvent(entry, line, 0, {
          role: "assistant",
          kind: "lifecycle",
          timestamp: messageTimestamp,
          contentSource: projectSessionNativeValue({ stopReason: assistant.stopReason }),
        });
      }
      usageRecords.push({
        id: usageIdFor(sessionId, firstEventId, usageRecords.length),
        eventId: firstEventId,
        timestamp: messageTimestamp,
        model: assistant.model,
        modelProvider: assistant.provider,
        inputTokens: assistant.usage.input,
        outputTokens: assistant.usage.output,
        cacheReadInputTokens: assistant.usage.cacheRead,
        cacheCreationInputTokens: assistant.usage.cacheWrite,
        totalTokens: assistant.usage.totalTokens,
        cost: assistant.usage.cost.total,
        currency: "USD",
      });
      continue;
    }
    if (message.role === "toolResult") {
      const result = message as PiToolResultMessage;
      const toolId = scopedId(sessionId, "tool", result.toolCallId);
      const eventId = appendEvent(entry, line, 0, {
        role: "tool",
        kind: "tool_result",
        timestamp: messageTimestamp,
        toolCallId: toolId,
        contentBlocks: messageBlocks(sessionId, eventIdFor(sessionId, sequence, `${entry.id}:0`), result.content),
      });
      const output = projectToolPayloadNativeValue(sanitizeOpaque({
        content: result.content.map((part) => part.type === "image"
          ? { type: "image", mimeType: part.mimeType, embedded: true, dataBytes: Buffer.byteLength(part.data, "base64") }
          : { type: "text", text: part.text }),
        ...(result.details !== undefined ? { details: result.details } : {}),
      }));
      const existing = tools.get(result.toolCallId);
      if (existing === undefined) {
        diagnostics.push({ name: "pi.tool_call.missing", message: `Tool result without call ${result.toolCallId} at ${probe.sourcePath}:${line.lineNumber}` });
        tools.set(result.toolCallId, {
          id: toolId,
          eventId,
          toolName: result.toolName,
          status: result.isError ? "error" : "completed",
          output,
          completedAt: messageTimestamp,
        });
      } else {
        existing.output = output;
        existing.completedAt = messageTimestamp;
        existing.status = result.isError ? "error" : "completed";
      }
      continue;
    }
    if (message.role === "bashExecution") {
      const toolId = scopedId(sessionId, "tool", entry.id);
      const eventId = appendEvent(entry, line, 0, {
        role: "assistant",
        kind: "tool_call",
        timestamp: messageTimestamp,
        toolCallId: toolId,
        contentBlocks: [jsonBlock(sessionId, eventIdFor(sessionId, sequence, `${entry.id}:0`), 0, { command: message.command })],
      });
      tools.set(entry.id, {
        id: toolId,
        eventId,
        toolName: "bashExecution",
        status: message.cancelled || (message.exitCode ?? 0) !== 0 ? "error" : "completed",
        input: projectToolPayloadNativeValue({ command: message.command }),
        output: projectToolPayloadNativeValue({ output: message.output, truncated: message.truncated }),
        startedAt: messageTimestamp,
        completedAt: messageTimestamp,
      });
      continue;
    }
    const summary = "summary" in message ? message.summary : undefined;
    const content = "content" in message ? message.content : summary;
    const kind = message.role === "branchSummary" || message.role === "compactionSummary" ? "summary" : "preamble";
    const role = kind === "summary" ? "assistant" : "system";
    const id = appendEvent(entry, line, 0, {
      role,
      kind,
      timestamp: messageTimestamp,
      contentText: content === undefined ? undefined : semanticText(content as string | readonly { readonly type: string; readonly text?: string }[]),
    });
    if (content !== undefined) {
      const index = events.findIndex((event) => event.id === id);
      events[index] = { ...events[index]!, contentBlocks: messageBlocks(sessionId, id, content as string | readonly { readonly type: string; readonly text?: string; readonly data?: string; readonly mimeType?: string }[]) };
    }
  }

  for (const { entry, line } of uniqueEntries) {
    const childEvents = eventsByEntry.get(entry.id);
    if (childEvents === undefined || childEvents.length === 0) continue;
    for (let index = 1; index < childEvents.length; index += 1) {
      edges.push({
        id: edgeIdFor(sessionId, "next", childEvents[index - 1]!, childEvents[index]!),
        kind: "next",
        fromEventId: childEvents[index - 1]!,
        toEventId: childEvents[index]!,
      });
    }
    const parentId = entry.parentId;
    if (parentId === null) continue;
    if (parentId === entry.id) {
      diagnostics.push({ name: "pi.parent.self_reference", message: `Self-parent entry ${entry.id} at ${probe.sourcePath}:${line.lineNumber}` });
      continue;
    }
    const parent = entryById.get(parentId);
    if (parent === undefined) {
      diagnostics.push({ name: "pi.parent.missing", message: `Missing parent ${parentId} for ${entry.id} at ${probe.sourcePath}:${line.lineNumber}` });
      continue;
    }
    let cursor: PiSessionEntry | undefined = parent;
    const walked = new Set<string>();
    let cycle = false;
    while (cursor !== undefined && cursor.parentId !== null && !walked.has(cursor.id)) {
      if (cursor.id === entry.id) {
        cycle = true;
        break;
      }
      walked.add(cursor.id);
      cursor = entryById.get(cursor.parentId);
    }
    if (cycle) {
      diagnostics.push({ name: "pi.parent.cycle", message: `Parent cycle closed by ${entry.id} at ${probe.sourcePath}:${line.lineNumber}` });
      continue;
    }
    const parentEventId = eventsByEntry.get(parentId)?.at(-1);
    if (parentEventId === undefined) continue;
    const childEventId = childEvents[0]!;
    edges.push({
      id: edgeIdFor(sessionId, "parent", parentEventId, childEventId),
      kind: "parent",
      fromEventId: parentEventId,
      toEventId: childEventId,
      rawReference: { sourcePath: probe.sourcePath, line: line.lineNumber, nativeType: entry.type },
    });
    edges.push({
      id: edgeIdFor(sessionId, "next", parentEventId, childEventId),
      kind: "next",
      fromEventId: parentEventId,
      toEventId: childEventId,
    });
  }

  if (probe.header.parentSession !== undefined && probe.header.parentSession !== null) {
    const parentPath = isAbsolute(probe.header.parentSession)
      ? resolve(probe.header.parentSession)
      : resolve(probe.physicalRoot, probe.header.parentSession);
    const parentNativeId = nativeIdByPath.get(parentPath) ?? (existsSync(parentPath) ? nativeIdByPath.get(realpathSync(parentPath)) : undefined);
    if (parentNativeId === undefined) {
      diagnostics.push({ name: "pi.parent_session.unresolved", message: `Unresolved parentSession ${probe.header.parentSession} for ${probe.sourcePath}` });
    } else {
      const parentSessionId = sessionIdFor("pi", PiSessionId(parentNativeId));
      edges.push({
        id: edgeIdFor(sessionId, "forked_from", parentSessionId, sessionId),
        kind: "forked_from",
        fromId: parentSessionId,
        toId: sessionId,
        rawReference: { sourcePath: probe.sourcePath, nativeType: "parentSession" },
      });
    }
  }

  const headerTimestamp = validIso(probe.header.timestamp);
  if (headerTimestamp === undefined) diagnostics.push({ name: "pi.header.timestamp_invalid", message: `Invalid header timestamp in ${probe.sourcePath}` });
  if (probe.header.cwd === undefined || probe.header.cwd.trim().length === 0) {
    diagnostics.push({ name: "pi.header.cwd_missing", message: `Pi header cwd is missing in ${probe.sourcePath}` });
  }
  const fallbackTime = new Date(probe.stats.mtimeMs).toISOString();
  const updatedAt = updatedAtMilliseconds !== undefined
    ? new Date(updatedAtMilliseconds).toISOString()
    : headerTimestamp ?? fallbackTime;
  const toolCalls: PiToolDraft[] = [...tools.values()].map((tool) => ({ ...tool }));

  return buildSession({
    provider: "pi",
    agentName: "Pi CLI",
    machine: options.machine,
    sessionId,
    nativeSessionId,
    nativeProjectKey: probe.header.cwd?.trim() || probe.physicalRoot,
    ...(title !== undefined ? { title } : {}),
    startedAt: headerTimestamp ?? fallbackTime,
    updatedAt,
    sourceRoot: probe.logicalRoot,
    sourcePath: probe.sourcePath,
    ...(probe.header.cwd !== undefined && probe.header.cwd.trim().length > 0 ? { projectPath: probe.header.cwd } : {}),
    events,
    toolCalls,
    sessionEdges: edges,
    usageRecords,
  });
};

async function* streamPi(options: AdapterDiscoverOptions): AsyncGenerator<AdapterStreamItem> {
  const roots = candidateRoots(options);
  const existingRoots = roots.filter((root) => existsSync(root));
  if (existingRoots.length === 0) {
    const root = roots[0] ?? piAdapter.defaultRoot();
    yield diagnosticItem(root ?? "", undefined, "pi.root.not_found", "Pi session root was not found.", "error");
    return;
  }

  const files: { path: string; stats: Stats; physicalRoot: string; logicalRoot: string }[] = [];
  for (const physicalRoot of existingRoots) {
    const logicalRoot = options.roots?.pi !== undefined && options.logicalRoots?.pi !== undefined
      ? options.logicalRoots.pi
      : physicalRoot;
    yield { type: "sourceRoot", sourceRoot: sourceRoot("pi", piAdapter.id, logicalRoot, options.machine, options.now) };
    for (const file of walkFilesWithStats(physicalRoot, (path) => path.endsWith(".jsonl"))) {
      files.push({ ...file, physicalRoot, logicalRoot });
    }
  }
  files.sort((left, right) => left.path.localeCompare(right.path));
  const skip = options.skip !== undefined && options.skip > 0 ? Math.floor(options.skip) : 0;
  const limit = options.limit === undefined || !Number.isFinite(options.limit)
    ? Number.POSITIVE_INFINITY
    : Math.max(0, Math.floor(options.limit));
  const selected = files.slice(skip, limit === Number.POSITIVE_INFINITY ? undefined : skip + limit);
  const probes: PiFileProbe[] = [];
  const pendingDiagnostics: AdapterStreamItem[] = [];
  const nativeIdByPath = new Map<string, string>();

  for (const file of selected) {
    if (options.shouldReadFile !== undefined && !options.shouldReadFile(file.path, file.stats)) continue;
    const sourcePath = logicalPathFor(file.path, file.physicalRoot, file.logicalRoot);
    let text: string;
    try {
      text = readFileSync(file.path, "utf8");
    } catch (error) {
      pendingDiagnostics.push(diagnosticItem(file.logicalRoot, sourcePath, "pi.line.unreadable", `Unable to read ${sourcePath}: ${error instanceof Error ? error.message : String(error)}`, "error"));
      continue;
    }
    const headerProbe = probeHeader(sourcePath, text);
    for (const diagnostic of headerProbe.diagnostics) {
      pendingDiagnostics.push(diagnosticItem(file.logicalRoot, sourcePath, diagnostic.name, diagnostic.message, "error"));
    }
    if (headerProbe.fatal !== undefined || headerProbe.header === undefined || headerProbe.headerLine === undefined || headerProbe.version === undefined) {
      const fatal = headerProbe.fatal ?? { name: "pi.header.missing", message: `Missing Pi header in ${sourcePath}` };
      pendingDiagnostics.push(diagnosticItem(file.logicalRoot, sourcePath, fatal.name, fatal.message, "error"));
      continue;
    }
    nativeIdByPath.set(resolve(file.path), headerProbe.header.id);
    nativeIdByPath.set(realpathSync(file.path), headerProbe.header.id);
    const sessionId = sessionIdFor("pi", PiSessionId(headerProbe.header.id));
    if (options.shouldParseSession !== undefined && !(await options.shouldParseSession({ sessionId, sourceFingerprint: sourceFingerprintFor(file.stats) }))) {
      continue;
    }
    probes.push({
      ...file,
      sourcePath,
      text,
      header: headerProbe.header,
      headerLine: headerProbe.headerLine,
      version: headerProbe.version,
    });
  }
  for (const diagnostic of pendingDiagnostics) yield diagnostic;


  let sessionCount = 0;
  for (const probe of probes) {
    const diagnostics: DecodeDiagnostic[] = [];
    const session = normalizeFile(probe, options, nativeIdByPath, diagnostics);
    sessionCount += 1;
    yield {
      type: "session",
      session,
      sourceUnit: {
        provider: "pi",
        adapterId: piAdapter.id,
        rootPath: probe.logicalRoot,
        sourcePath: probe.sourcePath,
        physicalPath: probe.path,
      },
      fingerprint: { size: probe.stats.size, mtimeMs: probe.stats.mtimeMs },
    };
    for (const diagnostic of diagnostics) {
      yield diagnosticItem(probe.logicalRoot, probe.sourcePath, diagnostic.name, diagnostic.message);
    }
  }

  yield {
    type: "diagnostic",
    diagnostic: {
      adapterId: piAdapter.id,
      provider: "pi",
      status: sessionCount > 0 ? "available" : "no_data_found",
      parserConfidence: "documented",
      rootPath: existingRoots[0]!,
      message: `Discovered ${sessionCount} Pi session(s).`,
    },
  };
}

export const piAdapter: SessionAdapter = {
  id: "pi-local-jsonl",
  provider: "pi",
  displayName: "Pi CLI local JSONL",
  stable: true,
  defaultRoot: () => {
    if (process.env.PI_CODING_AGENT_SESSION_DIR !== undefined) return expandHome(process.env.PI_CODING_AGENT_SESSION_DIR);
    if (process.env.PI_CODING_AGENT_DIR !== undefined) return join(expandHome(process.env.PI_CODING_AGENT_DIR), "sessions");
    return homePath(".pi/agent/sessions");
  },
  read: async (options) => collectAdapterStream(streamPi(options)),
  stream: streamPi,
};
