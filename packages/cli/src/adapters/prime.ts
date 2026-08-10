import {
  existsSync,
  readFileSync,
  realpathSync,
  readdirSync,
  statSync,
  type Stats,
} from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";

import { PrimeSessionId, type SessionId } from "../core/identity";
import type {
  AgentAssignment,
  ContentBlock,
  ExecutionContextRecord,
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
  classifyPrimeRecord,
  type PrimeAgentMessage,
  type PrimeAssistantMessage,
  type PrimeSessionEntry,
  type PrimeSessionHeader,
  type PrimeToolResultMessage,
} from "./prime-schema";
import {
  collectAdapterStream,
  type AdapterDiscoverOptions,
  type AdapterStreamItem,
  type SessionAdapter,
} from "./types";

type PrimeEventDraft = Omit<
  SessionEvent,
  "sessionId" | "machineId" | "provider" | "agentName" | "projectIdentityKey" | "contentBlocks"
> & { readonly contentBlocks?: readonly ContentBlock[]; readonly contentSource?: NativeValue };
type PrimeToolDraft = Omit<ToolCall, "sessionId" | "machineId" | "provider" | "agentName" | "projectIdentityKey">;
type PrimeUsageDraft = Omit<UsageRecord, "sessionId" | "machineId" | "provider" | "agentName" | "projectIdentityKey">;
type PrimeContextDraft = Omit<ExecutionContextRecord, "sessionId" | "machineId" | "provider" | "agentName" | "projectIdentityKey">;
type PrimeEdgeDraft = Omit<SessionEdge, "sessionId" | "machineId" | "provider" | "agentName" | "projectIdentityKey">;

type ParsedLine = {
  readonly value: unknown;
  readonly lineNumber: number;
  readonly rawBytes: number;
};

type PrimeFileProbe = {
  readonly path: string;
  readonly physicalRoot: string;
  readonly logicalRoot: string;
  readonly sourcePath: string;
  readonly stats: Stats;
  readonly text: string;
  readonly header: PrimeSessionHeader;
  readonly headerLine: number;
  readonly version: 2 | 3;
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
    adapterId: primeAdapter.id,
    provider: "prime",
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
    name: "prime.timestamp.invalid",
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
        name: "prime.line.invalid_json",
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

const configuredAgentDirectory = (defaultDir: string | undefined): string | undefined => {
  const agentDir = expandHome(process.env.PRIME_AGENT_DIR ?? defaultDir ?? "~/.prime/agent");
  return agentDir;
};

const candidateRoots = (options: AdapterDiscoverOptions): string[] => {
  if (options.roots?.prime !== undefined) return [options.roots.prime];
  const defaultDir = homePath(".prime/agent");
  const agentDir = configuredAgentDirectory(defaultDir);
  return [agentDir].filter((value): value is string => value !== undefined && value.trim().length > 0);
};

/**
 * Probe the first parseable record of a session file. Fatal outcomes carry a
 * named diagnostic and the file is skipped; a valid v2/v3 header yields the
 * probe. v1-era files (the pre-fork Pi format) are rejected with a named
 * diagnostic — the Pi adapter owns that format lineage.
 */
const probeHeader = (
  sourcePath: string,
  text: string,
): { readonly header?: PrimeSessionHeader; readonly headerLine?: number; readonly version?: 2 | 3; readonly diagnostics: DecodeDiagnostic[]; readonly fatal?: { readonly name: string; readonly message: string } } => {
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
          name: "prime.header.not_first_valid_record",
          message: `First parseable record at ${sourcePath}:${index + 1} is not a Prime Agent session header`,
        },
      };
    }
    const classified = classifyPrimeRecord(value, { header: true, diagnostics });
    if (!isSignal(classified)) {
      return {
        diagnostics,
        fatal: { name: "prime.header.decode_failed", message: `Invalid Prime Agent header at ${sourcePath}:${index + 1}` },
      };
    }
    const header = classified.value as PrimeSessionHeader;
    const rawVersion = header.version ?? 1;
    if (!Number.isInteger(rawVersion) || rawVersion < 2 || rawVersion > 3) {
      return {
        diagnostics,
        fatal: {
          name: "prime.header.unsupported_version",
          message: `Unsupported Prime Agent session version ${String(rawVersion)} at ${sourcePath}:${index + 1}`,
        },
      };
    }
    if (header.id.trim().length === 0) {
      return {
        diagnostics,
        fatal: { name: "prime.header.decode_failed", message: `Prime Agent header id is empty at ${sourcePath}:${index + 1}` },
      };
    }
    return { header, headerLine: index + 1, version: rawVersion as 2 | 3, diagnostics };
  }
  return {
    diagnostics,
    fatal: {
      name: sawNonEmpty ? "prime.header.missing" : "prime.file.empty",
      message: sawNonEmpty ? `No parseable Prime Agent header in ${sourcePath}` : `Prime Agent session file is empty: ${sourcePath}`,
    },
  };
};

const contentMetadata = (entry: PrimeSessionEntry): NativeValue | undefined => {
  if (entry.type === "model_change") return { provider: entry.provider, modelId: entry.modelId };
  if (entry.type === "thinking_level_change") return { thinkingLevel: entry.thinkingLevel };
  if (entry.type === "service_tier_change") return { serviceTier: entry.serviceTier };
  if (entry.type === "custom") return projectSessionNativeValue({ customType: entry.customType, data: sanitizeOpaque(entry.data) });
  if (entry.type === "label") return { targetId: entry.targetId, ...(entry.label !== undefined ? { label: entry.label } : {}) };
  if (entry.type === "session_info") return entry.name === undefined ? {} : { name: entry.name };
  if (entry.type === "session_state") return { status: entry.state.status };
  if (entry.type === "git_state") {
    return {
      ...(entry.git.repoUrl !== undefined ? { repoUrl: entry.git.repoUrl } : {}),
      ...(entry.git.commit !== undefined ? { commit: entry.git.commit } : {}),
      ...(entry.git.branch !== undefined ? { branch: entry.git.branch } : {}),
    };
  }
  if (entry.type === "child_usage_attributed") {
    return projectSessionNativeValue({
      targetId: entry.targetId,
      ...(entry.origin !== undefined ? { origin: entry.origin } : {}),
      childUsage: sanitizeOpaque(entry.childUsage),
      aggregateUsage: sanitizeOpaque(entry.aggregateUsage),
    });
  }
  return undefined;
};

/**
 * Normalize one prime-agent session file into a NormalizedSession.
 *
 * `nativeIdByPath` maps every session file path (resolved + realpath) to its
 * header native id, built over the WHOLE root before any windowing, so
 * `parentSession` lineage resolves even when the parent falls outside the
 * skip/limit window or the parse gate.
 */
const normalizeFile = (
  probe: PrimeFileProbe,
  options: AdapterDiscoverOptions,
  nativeIdByPath: ReadonlyMap<string, string>,
  diagnostics: DecodeDiagnostic[],
) => {
  const nativeSessionId = probe.header.id;
  const sessionId = sessionIdFor("prime", PrimeSessionId(nativeSessionId));
  const parsed = parseLines(probe.text, probe.sourcePath, diagnostics);
  const rawEntries = parsed.filter((line) => line.lineNumber !== probe.headerLine);
  const decodedEntries: { entry: PrimeSessionEntry; line: ParsedLine }[] = [];
  /** id -> parentId for dropped agent_status entries (append-only status ticks). */
  const droppedAgentStatus = new Map<string, string | null>();

  for (const line of rawEntries) {
    let value = line.value;
    const record = typeof value === "object" && value !== null && !Array.isArray(value)
      ? value as Record<string, unknown>
      : undefined;
    if (record?.type === "session") {
      diagnostics.push({ name: "prime.header.duplicate", message: `Duplicate header at ${probe.sourcePath}:${line.lineNumber}` });
      continue;
    }
    if (probe.version === 2 && record?.type === "message") {
      const message = typeof record.message === "object" && record.message !== null && !Array.isArray(record.message)
        ? record.message as Record<string, unknown>
        : undefined;
      if (message?.role === "hookMessage") value = { ...record, message: { ...message, role: "custom" } };
    }
    const classified = classifyPrimeRecord(value, { version: probe.version, diagnostics });
    if (isSignal(classified)) decodedEntries.push({ entry: classified.value as PrimeSessionEntry, line });
    // agent_status and other named drops are silent: expected machinery noise,
    // not provider garbage. Only decode failures raise diagnostics. Dropped
    // agent_status ids are still recorded so entry-tree parents that chain
    // THROUGH a status tick can be rewired to the nearest kept ancestor.
    if (record?.type === "agent_status" && typeof record.id === "string") {
      droppedAgentStatus.set(record.id, typeof record.parentId === "string" ? record.parentId : null);
    }
  }

  const uniqueEntries: { entry: PrimeSessionEntry; line: ParsedLine }[] = [];
  const entryById = new Map<string, PrimeSessionEntry>();
  for (const item of decodedEntries) {
    if (entryById.has(item.entry.id)) {
      diagnostics.push({ name: "prime.entry.duplicate_id", message: `Duplicate entry id ${item.entry.id} at ${probe.sourcePath}:${item.line.lineNumber}` });
      continue;
    }
    entryById.set(item.entry.id, item.entry);
    uniqueEntries.push(item);
  }

  const events: PrimeEventDraft[] = [];
  const tools = new Map<string, MutableTool>();
  const usageRecords: PrimeUsageDraft[] = [];
  const executionContexts: PrimeContextDraft[] = [];
  const edges: PrimeEdgeDraft[] = [];
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

  // Turn-scoped model/thinking/service context from lifecycle entries, so
  // assistant events carry the reasoning effort and tier in force at the time.
  let currentThinkingLevel: string | undefined;
  let currentServiceTier: string | undefined;

  const appendEvent = (
    entry: PrimeSessionEntry,
    line: ParsedLine,
    partIndex: number,
    fields: Omit<PrimeEventDraft, "id" | "nativeEventId" | "sequence" | "rawReference">,
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
    if (entryTimestamp === undefined) diagnostics.push({ name: "prime.timestamp.invalid", message: `Invalid entry timestamp at ${probe.sourcePath}:${line.lineNumber}` });
    if (entry.type === "session_info") {
      title = entry.name?.trim() || undefined;
    }
    if (entry.type === "label" && !entryById.has(entry.targetId)) {
      diagnostics.push({ name: "prime.label.target_missing", message: `Missing label target ${entry.targetId} at ${probe.sourcePath}:${line.lineNumber}` });
    }
    if (entry.type === "compaction" && !entryById.has(entry.firstKeptEntryId)) {
      diagnostics.push({ name: "prime.compaction.first_kept_missing", message: `Missing compaction first-kept entry ${entry.firstKeptEntryId} at ${probe.sourcePath}:${line.lineNumber}` });
    }

    if (entry.type === "thinking_level_change") currentThinkingLevel = entry.thinkingLevel;
    if (entry.type === "service_tier_change") currentServiceTier = entry.serviceTier;

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

    const message = entry.message as PrimeAgentMessage;
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
      const assistant = message as PrimeAssistantMessage;
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
      executionContexts.push({
        id: scopedId(sessionId, "execution-context", firstEventId),
        sequence,
        scope: "turn",
        turnId: firstEventId,
        ...(messageTimestamp !== undefined ? { timestamp: messageTimestamp } : {}),
        model: assistant.model,
        modelProvider: assistant.provider,
        ...(currentThinkingLevel !== undefined ? { reasoningEffort: currentThinkingLevel } : {}),
        ...(currentServiceTier !== undefined ? { serviceTier: currentServiceTier } : {}),
      });
      continue;
    }
    if (message.role === "toolResult") {
      const result = message as PrimeToolResultMessage;
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
        diagnostics.push({ name: "prime.tool_call.missing", message: `Tool result without call ${result.toolCallId} at ${probe.sourcePath}:${line.lineNumber}` });
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
      diagnostics.push({ name: "prime.parent.self_reference", message: `Self-parent entry ${entry.id} at ${probe.sourcePath}:${line.lineNumber}` });
      continue;
    }
    // The entry tree chains THROUGH append-only agent_status ticks (dropped as
    // machinery). Walk the dropped chain to the nearest kept ancestor so the
    // parent edge reflects the real message lineage, not the status tick.
    let resolvedParentId: string | null | undefined = parentId;
    const rewired = new Set<string>();
    while (
      resolvedParentId !== null
      && resolvedParentId !== undefined
      && !entryById.has(resolvedParentId)
      && droppedAgentStatus.has(resolvedParentId)
      && !rewired.has(resolvedParentId)
    ) {
      rewired.add(resolvedParentId);
      resolvedParentId = droppedAgentStatus.get(resolvedParentId) ?? null;
    }
    const parent = resolvedParentId === null || resolvedParentId === undefined
      ? undefined
      : entryById.get(resolvedParentId);
    if (parent === undefined) {
      diagnostics.push({ name: "prime.parent.missing", message: `Missing parent ${parentId} for ${entry.id} at ${probe.sourcePath}:${line.lineNumber}` });
      continue;
    }
    let cursor: PrimeSessionEntry | undefined = parent;
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
      diagnostics.push({ name: "prime.parent.cycle", message: `Parent cycle closed by ${entry.id} at ${probe.sourcePath}:${line.lineNumber}` });
      continue;
    }
    const parentEventId = resolvedParentId === null || resolvedParentId === undefined
      ? undefined
      : eventsByEntry.get(resolvedParentId)?.at(-1);
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

  // Cross-session lineage. Prime-agent subagent sessions (RLM children) carry
  // the parent session FILE in the header and an explicit rlmDepth >= 1; forks
  // and branches carry a parentSession with the source depth. rlmDepth >= 1 is
  // the canonical `subagent_of` signal (projected onto SessionRow.parentSessionId
  // by mapSession); depth-0 parents emit `forked_from`, exactly like the Pi
  // adapter's parentSession handling.
  let parentSessionId: string | undefined;
  let parentPath: string | undefined;
  if (probe.header.parentSession !== undefined && probe.header.parentSession !== null) {
    parentPath = isAbsolute(probe.header.parentSession)
      ? resolve(probe.header.parentSession)
      : resolve(dirname(probe.path), probe.header.parentSession);
    let parentRealPath: string | undefined;
    try {
      parentRealPath = realpathSync(parentPath);
    } catch {
      // Unreadable parent (e.g. chmod 0): the resolved-path key is
      // authoritative; lineage falls back to unresolved, never throws.
    }
    const parentNativeId = nativeIdByPath.get(parentPath)
      ?? (parentRealPath !== undefined ? nativeIdByPath.get(parentRealPath) : undefined);
    if (parentNativeId === undefined) {
      diagnostics.push({ name: "prime.parent_session.unresolved", message: `Unresolved parentSession ${probe.header.parentSession} for ${probe.sourcePath}` });
    } else {
      parentSessionId = sessionIdFor("prime", PrimeSessionId(parentNativeId));
    }
  }
  const rlmDepth = probe.header.rlmDepth;
  const isSubagent = Number.isInteger(rlmDepth) && (rlmDepth as number) >= 1;
  if (parentSessionId !== undefined && parentPath !== undefined) {
    const kind = isSubagent ? "subagent_of" : "forked_from";
    edges.push({
      id: edgeIdFor(sessionId, kind, parentSessionId, sessionId),
      kind,
      fromId: parentSessionId,
      toId: sessionId,
      rawReference: { sourcePath: parentPath, nativeType: "parentSession" },
    });
  }

  const headerTimestamp = validIso(probe.header.timestamp);
  if (headerTimestamp === undefined) diagnostics.push({ name: "prime.header.timestamp_invalid", message: `Invalid header timestamp in ${probe.sourcePath}` });
  if (probe.header.cwd === undefined || probe.header.cwd.trim().length === 0) {
    diagnostics.push({ name: "prime.header.cwd_missing", message: `Prime Agent header cwd is missing in ${probe.sourcePath}` });
  }
  const fallbackTime = new Date(probe.stats.mtimeMs).toISOString();
  const updatedAt = updatedAtMilliseconds !== undefined
    ? new Date(updatedAtMilliseconds).toISOString()
    : headerTimestamp ?? fallbackTime;
  const toolCalls: PrimeToolDraft[] = [...tools.values()].map((tool) => ({ ...tool }));

  const assignment: AgentAssignment | undefined = Number.isInteger(rlmDepth)
    ? { depth: rlmDepth as number }
    : undefined;

  return buildSession({
    provider: "prime",
    // Subagent sessions are labelled by their session_info name (e.g. the RLM
    // child name), so `--agent` filters and agent-scoped queries distinguish
    // them from the root agent sessions.
    agentName: isSubagent && title !== undefined ? title : "prime-agent",
    ...(assignment !== undefined ? { assignment } : {}),
    machine: options.machine,
    sessionId,
    nativeSessionId,
    nativeProjectKey: probe.header.cwd?.trim() || probe.path,
    ...(title !== undefined ? { title } : {}),
    startedAt: headerTimestamp ?? fallbackTime,
    updatedAt,
    sourceRoot: probe.logicalRoot,
    sourcePath: probe.sourcePath,
    ...(probe.header.cwd !== undefined && probe.header.cwd.trim().length > 0 ? { projectPath: probe.header.cwd } : {}),
    ...(probe.header.git?.repoUrl !== undefined && probe.header.git.repoUrl.trim().length > 0 ? { gitRemote: probe.header.git.repoUrl } : {}),
    events,
    toolCalls,
    sessionEdges: edges,
    executionContexts,
    usageRecords,
  });
};

const isPrimeSessionFile = (path: string): boolean =>
  path.endsWith(".jsonl") && basename(path) !== "rlm-subagents.jsonl";

const collectSessionFiles = (agentRoot: string): { path: string; stats: Stats }[] => {
  const files: { path: string; stats: Stats }[] = [];
  const sessionsDir = join(agentRoot, "sessions");
  if (existsSync(sessionsDir)) {
    for (const entry of readdirSync(sessionsDir).sort()) {
      if (!entry.endsWith(".jsonl")) continue;
      const path = join(sessionsDir, entry);
      try {
        files.push({ path, stats: statSync(path) });
      } catch {
        // unreadable stat: the probe loop emits the named diagnostic
      }
    }
  }
  const artifactsDir = join(agentRoot, "session-artifacts");
  if (existsSync(artifactsDir)) {
    for (const file of walkFilesWithStats(artifactsDir, isPrimeSessionFile)) {
      files.push(file);
    }
  }
  return files;
};

async function* streamPrime(options: AdapterDiscoverOptions): AsyncGenerator<AdapterStreamItem> {
  const roots = candidateRoots(options);
  const existingRoots = roots.filter((root) => existsSync(root));
  if (existingRoots.length === 0) {
    const root = roots[0] ?? primeAdapter.defaultRoot();
    yield diagnosticItem(root ?? "", undefined, "prime.root.not_found", "Prime Agent session root was not found.", "error");
    return;
  }

  const physicalRoot = existingRoots[0]!;
  const logicalRoot = options.roots?.prime !== undefined && options.logicalRoots?.prime !== undefined
    ? options.logicalRoots.prime
    : physicalRoot;
  yield { type: "sourceRoot", sourceRoot: sourceRoot("prime", primeAdapter.id, logicalRoot, options.machine, options.now) };

  // Whole-root lineage pass: read ONLY the first line of every session file to
  // map resolved path -> header native id. Subagent children reference their
  // parent by FILE PATH, so this map must cover the entire root even when the
  // parent falls outside the skip/limit window or fails the parse gate.
  const allFiles = collectSessionFiles(physicalRoot);
  allFiles.sort((left, right) => left.path.localeCompare(right.path));
  const nativeIdByPath = new Map<string, string>();
  const probes = new Map<string, PrimeFileProbe>();
  const pendingDiagnostics: AdapterStreamItem[] = [];
  const skippedById = new Set<string>();

  const skip = options.skip !== undefined && options.skip > 0 ? Math.floor(options.skip) : 0;
  const limit = options.limit === undefined || !Number.isFinite(options.limit)
    ? Number.POSITIVE_INFINITY
    : Math.max(0, Math.floor(options.limit));

  let matched = 0;
  let selected = 0;
  for (const file of allFiles) {
    const windowed = matched >= skip && selected < limit;
    if (matched >= skip) selected += 1;
    matched += 1;

    if (options.shouldReadFile !== undefined && !options.shouldReadFile(file.path, file.stats)) continue;
    const sourcePath = logicalPathFor(file.path, physicalRoot, logicalRoot);
    let text: string;
    try {
      text = readFileSync(file.path, "utf8");
    } catch (error) {
      pendingDiagnostics.push(diagnosticItem(logicalRoot, sourcePath, "prime.line.unreadable", `Unable to read ${sourcePath}: ${error instanceof Error ? error.message : String(error)}`, "error"));
      continue;
    }
    const headerProbe = probeHeader(sourcePath, text);
    for (const diagnostic of headerProbe.diagnostics) {
      pendingDiagnostics.push(diagnosticItem(logicalRoot, sourcePath, diagnostic.name, diagnostic.message, "error"));
    }
    if (headerProbe.fatal !== undefined || headerProbe.header === undefined || headerProbe.headerLine === undefined || headerProbe.version === undefined) {
      const fatal = headerProbe.fatal ?? { name: "prime.header.missing", message: `Missing Prime Agent header in ${sourcePath}` };
      pendingDiagnostics.push(diagnosticItem(logicalRoot, sourcePath, fatal.name, fatal.message, "error"));
      continue;
    }
    // Whole-root lineage: every file's header id is registered even when the
    // file falls outside the skip/limit window, so subagent parentSession
    // references resolve for windowed children whose parents are not windowed.
    nativeIdByPath.set(resolve(file.path), headerProbe.header.id);
    try {
      nativeIdByPath.set(realpathSync(file.path), headerProbe.header.id);
    } catch {
      // best-effort realpath; the resolved path key is authoritative
    }
    if (!windowed) continue;
    if (skippedById.has(headerProbe.header.id)) {
      pendingDiagnostics.push(diagnosticItem(logicalRoot, sourcePath, "prime.session.duplicate_id", `Duplicate session id ${headerProbe.header.id} at ${sourcePath}`, "error"));
      continue;
    }
    skippedById.add(headerProbe.header.id);
    const sessionId = sessionIdFor("prime", PrimeSessionId(headerProbe.header.id));
    if (options.shouldParseSession !== undefined && !(await options.shouldParseSession({ sessionId, sourceFingerprint: sourceFingerprintFor(file.stats) }))) {
      continue;
    }
    probes.set(file.path, {
      ...file,
      physicalRoot,
      logicalRoot,
      sourcePath,
      text,
      header: headerProbe.header,
      headerLine: headerProbe.headerLine,
      version: headerProbe.version,
    });
  }
  for (const diagnostic of pendingDiagnostics) yield diagnostic;

  let sessionCount = 0;
  for (const probe of [...probes.values()].sort((left, right) => left.path.localeCompare(right.path))) {
    const diagnostics: DecodeDiagnostic[] = [];
    const session = normalizeFile(probe, options, nativeIdByPath, diagnostics);
    sessionCount += 1;
    yield {
      type: "session",
      session,
      sourceUnit: {
        provider: "prime",
        adapterId: primeAdapter.id,
        rootPath: logicalRoot,
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
      adapterId: primeAdapter.id,
      provider: "prime",
      status: sessionCount > 0 ? "available" : "no_data_found",
      parserConfidence: "documented",
      rootPath: logicalRoot,
      message: `Discovered ${sessionCount} Prime Agent session(s).`,
    },
  };
}

export const primeAdapter: SessionAdapter = {
  id: "prime-agent-local-jsonl",
  provider: "prime",
  displayName: "Prime Agent local JSONL",
  stable: true,
  defaultRoot: () => homePath(".prime/agent"),
  read: async (options) => collectAdapterStream(streamPrime(options)),
  stream: streamPrime,
};
