import { basename, dirname, join } from "node:path";
import { existsSync, statSync } from "node:fs";

import { collectAdapterStream, type SessionAdapter } from "./types";
import { ClaudeSessionId, type SessionId } from "../core/identity";
import type { SessionEdge, ToolCall, UsageRecord } from "../core/schemas";
import {
  buildSession,
  collectFiles,
  compactText,
  edgeIdFor,
  eventIdFor,
  homePath,
  logicalPathFor,
  logicalRootFor,
  numberValue,
  parentDirectoryName,
  projectSessionNativeValue,
  projectToolPayloadNativeValue,
  readJsonLines,
  recordFrom,
  scopedId,
  sessionIdFor,
  sourceFingerprintFor,
  sourceRoot,
  type NativeValue,
  usageIdFor,
} from "./common";
import { type DecodeDiagnostic, isSignal } from "./harness-schema";
import { classifyClaudeRecord, type ClaudeKind } from "./claude-schema";
import type { SessionRole } from "../core/schemas";

const projectPathFromClaudeKey = (key: string) =>
  key.startsWith("-") ? key.replace(/^-/, "/").replaceAll("-", "/") : key;

/**
 * A Claude session file is identified POSITIVELY by its filename — the only two
 * shapes Claude Code writes:
 *   - main session `{project}/<uuid>.jsonl` (its own session uuid), and
 *   - subagent / workflow-agent `.../subagents/[workflows/wf_<run>/]agent-<id>.jsonl`.
 * Any other `.jsonl` found while recursing `projects/` is simply not matched and
 * never collected. This is an allowlist, not a set of carve-outs: a new kind of
 * non-session file needs no code change and no test.
 */
const CLAUDE_MAIN_SESSION_FILE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jsonl$/i;
const CLAUDE_AGENT_SESSION_FILE = /^agent-.+\.jsonl$/;

const isClaudeSessionFile = (path: string) => {
  const name = basename(path);
  return CLAUDE_AGENT_SESSION_FILE.test(name) || CLAUDE_MAIN_SESSION_FILE.test(name);
};

/**
 * The native session id is POLYMORPHIC by how a file is populated: a subagent /
 * workflow-agent file keys on the in-record `agentId`; a main session file keys
 * on the in-record `sessionId`. Subagent and workflow-agent files are
 * FIRST-CLASS sessions even though they legitimately have no human user turn.
 */
const isSubagentFile = (path: string) =>
  parentDirectoryName(path) === "subagents" ||
  dirname(path).includes(`${join("subagents", "workflows")}`) ||
  /^agent-/.test(basename(path));

/**
 * Recover the parent MAIN session uuid from a subagent/workflow-agent path:
 * `{project}/{parentMainSessionUuid}/subagents/[workflows/wf_<run>/]agent-…`.
 * The parent uuid is the path segment immediately before the `subagents`
 * directory. Used only as a fallback when the in-record `sessionId` is absent.
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const subagentParentUuidFromPath = (path: string): string | undefined => {
  const segments = path.split(/[\\/]/);
  const index = segments.lastIndexOf("subagents");
  if (index <= 0) return undefined;
  const parent = segments[index - 1];
  // Only accept a real session-uuid directory as the parent — never a project
  // key (which is the dir name when a subagent file is laid out without the
  // intervening `{parentUuid}` directory). The in-record `sessionId` is the
  // primary source; this path fallback is uuid-shaped to avoid false parents.
  return parent !== undefined && UUID_RE.test(parent) ? parent : undefined;
};

const firstStringField = (
  records: readonly Record<string, unknown>[],
  field: string,
): string | undefined => {
  for (const record of records) {
    const value = record[field];
    if (typeof value === "string" && value.trim().length > 0) return value;
  }
  return undefined;
};

/**
 * Derives the polymorphic native id from a file's parsed records. Subagent and
 * workflow-agent files key on the in-record `agentId`; main session files key
 * on the in-record `sessionId`. Falls back to the filename stem only when the
 * expected in-record id is absent (defensive — real data carries it).
 */
const claudeNativeSessionId = (
  path: string,
  records: readonly Record<string, unknown>[],
): ClaudeSessionId => {
  const filenameStem = basename(path).replace(/\.(jsonl|json)$/i, "");
  if (isSubagentFile(path)) {
    const agentId =
      firstStringField(records, "agentId") ?? filenameStem.replace(/^agent-/, "");
    return ClaudeSessionId(agentId);
  }
  return ClaudeSessionId(firstStringField(records, "sessionId") ?? filenameStem);
};

type AdapterOptions = Parameters<SessionAdapter["read"]>[0];
type ClaudeToolCallDraft = Omit<
  ToolCall,
  "sessionId" | "machineId" | "provider" | "agentName" | "projectIdentityKey"
>;
type ClaudeUsageDraft = Omit<
  UsageRecord,
  "sessionId" | "machineId" | "provider" | "agentName" | "projectIdentityKey"
>;
type ClaudeEdgeDraft = Omit<
  SessionEdge,
  "sessionId" | "machineId" | "provider" | "agentName" | "projectIdentityKey"
>;

const contentArray = (message: Record<string, unknown> | undefined) =>
  Array.isArray(message?.content) ? (message.content as unknown[]) : [];

const claudeStructuredContentProjection = (value: unknown): NativeValue | undefined => {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    return value.flatMap((item) => {
      const block = recordFrom(item);
      if (block === undefined) return [];
      const type = typeof block.type === "string" ? block.type : undefined;
      if (type === "text" && typeof block.text === "string") {
        return [{ type, text: block.text } as NativeValue];
      }
      if (type === "thinking" && typeof block.thinking === "string") {
        return [{ type, thinking: block.thinking } as NativeValue];
      }
      if (type === "document") {
        const content =
          block.content === undefined
            ? undefined
            : projectSessionNativeValue(claudeStructuredContentProjection(block.content));
        return [
          {
            type,
            ...(typeof block.title === "string" ? { title: block.title } : {}),
            ...(typeof block.media_type === "string" ? { media_type: block.media_type } : {}),
            ...(content !== undefined ? { content } : {}),
          } as NativeValue,
        ];
      }
      if (type === "image") {
        return [
          {
            type,
            ...(typeof block.media_type === "string" ? { media_type: block.media_type } : {}),
          } as NativeValue,
        ];
      }
      if (type === "file") {
        return [
          {
            type,
            ...(typeof block.file_path === "string" ? { file_path: block.file_path } : {}),
            ...(typeof block.media_type === "string" ? { media_type: block.media_type } : {}),
          } as NativeValue,
        ];
      }
      if (Object.keys(block).length > 0) {
        const value = projectSessionNativeValue(block);
        return value === undefined ? [] : [{ type: type ?? "json", value } as NativeValue];
      }
      return [];
    });
  }
  if (value !== undefined && value !== null) return projectSessionNativeValue(value);
  return undefined;
};

const claudeContentProjection = (
  message: Record<string, unknown> | undefined,
  record: Record<string, unknown>,
): NativeValue | undefined => {
  if (typeof message?.content === "string") return message.content;
  const blocks = contentArray(message);
  if (blocks.length > 0) {
    return blocks.flatMap((blockValue) => {
      const block = recordFrom(blockValue);
      if (block === undefined) return [];
      const type = typeof block.type === "string" ? block.type : undefined;
      if (type === "text" && typeof block.text === "string") {
        return [{ type, text: block.text } as NativeValue];
      }
      if (type === "thinking" && typeof block.thinking === "string") {
        return [{ type, thinking: block.thinking } as NativeValue];
      }
      if (type === "tool_use") {
        const input = projectToolPayloadNativeValue(block.input) as NativeValue | undefined;
        return [
          {
            type,
            ...(typeof block.id === "string" ? { id: block.id } : {}),
            ...(typeof block.name === "string" ? { name: block.name } : {}),
            ...(input !== undefined ? { input } : {}),
          } as NativeValue,
        ];
      }
      if (type === "tool_result") {
        const content =
          block.content === undefined
            ? undefined
            : (projectToolPayloadNativeValue(
                claudeStructuredContentProjection(block.content),
              ) as NativeValue | undefined);
        return [
          {
            type,
            ...(typeof block.tool_use_id === "string" ? { tool_use_id: block.tool_use_id } : {}),
            ...(content !== undefined ? { content } : {}),
          } as NativeValue,
        ];
      }
      if (type === "image") {
        return [
          {
            type,
            ...(typeof block.media_type === "string" ? { media_type: block.media_type } : {}),
          } as NativeValue,
        ];
      }
      if (type === "file") {
        return [
          {
            type,
            ...(typeof block.file_path === "string" ? { file_path: block.file_path } : {}),
            ...(typeof block.media_type === "string" ? { media_type: block.media_type } : {}),
          } as NativeValue,
        ];
      }
      return [];
    });
  }
  return projectSessionNativeValue(record.content);
};

const toolCallIdFor = (sessionId: SessionId, nativeToolId: string) =>
  scopedId(sessionId, "tool", nativeToolId);

const upsertClaudeToolCalls = (
  toolCallsById: Map<string, ClaudeToolCallDraft>,
  sessionId: SessionId,
  eventId: string,
  timestamp: string | undefined,
  blocks: readonly unknown[],
) => {
  let eventToolCallId: string | undefined;
  for (const blockValue of blocks) {
    const block = recordFrom(blockValue);
    if (block === undefined) continue;
    const type = typeof block.type === "string" ? block.type : undefined;
    if (type === "tool_use" && typeof block.id === "string") {
      const id = toolCallIdFor(sessionId, block.id);
      const existing = toolCallsById.get(id);
      const input = projectToolPayloadNativeValue(block.input);
      toolCallsById.set(id, {
        ...existing,
        id,
        eventId: existing?.eventId ?? eventId,
        toolName: typeof block.name === "string" ? block.name : existing?.toolName ?? "claude_tool",
        status: existing?.status === "completed" ? "completed" : "started",
        ...(input !== undefined ? { input } : {}),
        ...(existing?.output !== undefined ? { output: existing.output } : {}),
        ...(timestamp !== undefined ? { startedAt: timestamp } : {}),
        ...(existing?.completedAt !== undefined ? { completedAt: existing.completedAt } : {}),
      });
      eventToolCallId = id;
      continue;
    }
    if (type === "tool_result" && typeof block.tool_use_id === "string") {
      const id = toolCallIdFor(sessionId, block.tool_use_id);
      const existing = toolCallsById.get(id);
      const output = projectToolPayloadNativeValue(block.content);
      toolCallsById.set(id, {
        id,
        eventId: existing?.eventId ?? eventId,
        toolName: existing?.toolName ?? "claude_tool",
        status: "completed",
        ...(existing?.input !== undefined ? { input: existing.input } : {}),
        ...(output !== undefined ? { output } : {}),
        ...(existing?.startedAt !== undefined ? { startedAt: existing.startedAt } : {}),
        ...(timestamp !== undefined ? { completedAt: timestamp } : {}),
      });
      eventToolCallId = id;
    }
  }
  return eventToolCallId;
};

/**
 * Declarative kind -> role projection for a SIGNAL record. Replaces the shared
 * `roleFrom` heuristic locally: the classifier already decided the canonical
 * event kind, so the role follows from the message role (when present) or the
 * kind. No "guess from a free-form type string" path remains.
 */
const claudeRoleFor = (
  kind: ClaudeKind,
  messageRole: string | undefined,
): SessionRole => {
  if (messageRole === "user") return "user";
  if (messageRole === "assistant") return "assistant";
  switch (kind) {
    case "tool_result":
      return "tool";
    case "tool_call":
      return "assistant";
    case "reasoning":
      return "thinking";
    case "summary":
    case "snapshot":
    case "system":
    case "lifecycle":
      return "system";
    default:
      return "unknown";
  }
};

const claudeUsageRecord = (
  sessionId: SessionId,
  eventId: string,
  sequence: number,
  timestamp: string | undefined,
  message: Record<string, unknown> | undefined,
): ClaudeUsageDraft | undefined => {
  const usage = recordFrom(message?.usage);
  if (usage === undefined || Object.keys(usage).length === 0) return undefined;
  const inputTokens =
    numberValue(usage.input_tokens) ?? numberValue(usage.inputTokens);
  const outputTokens =
    numberValue(usage.output_tokens) ?? numberValue(usage.outputTokens);
  const cacheCreationInputTokens =
    numberValue(usage.cache_creation_input_tokens) ??
    numberValue(usage.cacheCreationInputTokens);
  const cacheReadInputTokens =
    numberValue(usage.cache_read_input_tokens) ?? numberValue(usage.cacheReadInputTokens);
  return {
    id: usageIdFor(sessionId, eventId, sequence),
    eventId,
    ...(timestamp !== undefined ? { timestamp } : {}),
    model: typeof message?.model === "string" ? message.model : undefined,
    modelProvider: "anthropic",
    inputTokens,
    outputTokens,
    cacheCreationInputTokens,
    cacheReadInputTokens,
    totalTokens: sumNumbers([inputTokens, outputTokens, cacheCreationInputTokens, cacheReadInputTokens]),
  };
};

const sumNumbers = (values: readonly (number | undefined)[]) => {
  const present = values.filter((value): value is number => value !== undefined);
  return present.length === 0
    ? undefined
    : present.reduce((sum, value) => sum + value, 0);
};

const buildClaudeSessionFromFile = (
  path: string,
  sourcePath: string,
  logicalProjectsRoot: string,
  options: AdapterOptions,
) => {
  const diagnostics: DecodeDiagnostic[] = [];
  const lines = readJsonLines(path, {
    diagnosticName: "claude.line.invalid_json",
    diagnostics,
    sourcePath,
  });
  if (lines.length === 0) {
    diagnostics.push({
      name: "claude.file.empty",
      message: `claude.file.empty for ${sourcePath}: no parseable JSON records found.`,
    });
  }
  const records = lines.map(({ value }) =>
    typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {},
  );
  const projectKey = parentDirectoryName(sourcePath);
  const firstRecord = lines[0]?.value as Record<string, unknown> | undefined;
  const projectPath =
    typeof firstRecord?.cwd === "string"
      ? firstRecord.cwd
      : projectPathFromClaudeKey(projectKey);
  const nativeSessionId = claudeNativeSessionId(sourcePath, records);
  const sessionId = sessionIdFor("claude", nativeSessionId);
  // SESSION lineage: a subagent/workflow-agent file is a FIRST-CLASS child
  // session whose parent is the MAIN session that spawned it. The parent main
  // session uuid is recoverable two ways — the in-record `sessionId` (which on a
  // subagent record is the PARENT's uuid, not the child's `agentId`) and the
  // `{parent-uuid}/subagents/...` path directory — preferring the in-record
  // value, falling back to the path. We emit a `subagent_of` SessionEdge (the
  // canonical pattern hermes/codex/antigravity use) so mapSession projects it
  // onto SessionRow.parentSessionId. This was MISSING — claude was the only one
  // of 7 harnesses emitting no subagent_of edge.
  const subagentEdges: ClaudeEdgeDraft[] = [];
  if (isSubagentFile(sourcePath)) {
    const parentMainSessionUuid =
      firstStringField(records, "sessionId") ?? subagentParentUuidFromPath(sourcePath);
    if (parentMainSessionUuid !== undefined && parentMainSessionUuid !== nativeSessionId) {
      const parentSessionId = sessionIdFor("claude", ClaudeSessionId(parentMainSessionUuid));
      subagentEdges.push({
        id: edgeIdFor(sessionId, "subagent_of", parentSessionId, sessionId),
        kind: "subagent_of",
        fromId: parentSessionId,
        toId: sessionId,
        rawReference: {
          sourcePath,
          nativeType: "subagent_parent_session",
          nativeValue: parentMainSessionUuid,
        },
      });
    }
  }
  const toolCallsById = new Map<string, ClaudeToolCallDraft>();
  const usageRecords: ClaudeUsageDraft[] = [];
  const nativeUuidToEventId = new Map<string, string>();
  // EVERY record's uuid -> parentUuid, across kept AND dropped records. The
  // event lineage map (nativeUuidToEventId) holds only KEPT events, so a kept
  // turn whose parentUuid points at a DROPPED record (e.g. an assistant turn
  // whose parent is a dropped api_error/turn_duration system record) would lose
  // its parent-event link. This full chain lets us walk up past dropped records
  // to the NEAREST KEPT ancestor, preserving the thread (32 turns degraded in a
  // real file before this fix).
  const nativeUuidToParentUuid = new Map<string, string>();
  for (const record of records) {
    const uuid = typeof record.uuid === "string" ? record.uuid : undefined;
    const parent = typeof record.parentUuid === "string" ? record.parentUuid : undefined;
    if (uuid !== undefined && parent !== undefined) {
      nativeUuidToParentUuid.set(uuid, parent);
    }
  }
  /**
   * Resolve a parentUuid to the event id of the nearest KEPT ancestor, walking
   * up the full uuid->parentUuid chain across dropped records. Returns undefined
   * if no ancestor was kept (the lineage genuinely terminates in dropped rows).
   */
  const resolveKeptAncestorEventId = (parentUuid: string): string | undefined => {
    const seen = new Set<string>();
    let current: string | undefined = parentUuid;
    while (current !== undefined && !seen.has(current)) {
      const kept = nativeUuidToEventId.get(current);
      if (kept !== undefined) return kept;
      seen.add(current);
      current = nativeUuidToParentUuid.get(current);
    }
    return undefined;
  };
  const parentEdges: ClaudeEdgeDraft[] = [];
  // Every record's classifier verdict — signal(kind) or drop(reason) —
  // accumulates a NAMED diagnostic on any malformed/unmodeled record. The
  // boundary doctrine: a contract breach is a named diagnostic + a dropped
  // record, never a throw and never a silent "unknown" pass-through.
  // Sequencing is over KEPT (signal) events only, so dropped bookkeeping does
  // not leave gaps or claim event ids in the lineage map.
  let sequence = 0;
  const events = [];
  for (let index = 0; index < lines.length; index += 1) {
    const { value, lineNumber } = lines[index]!;
    const record =
      typeof value === "object" && value !== null
        ? (value as Record<string, unknown>)
        : {};
    const type = typeof record.type === "string" ? record.type : "unknown";
    const decision = classifyClaudeRecord(record, diagnostics);
    // DROP: malformed, unmodeled, or declared harness bookkeeping/telemetry.
    // It contributes its named diagnostic (already pushed) but no event, no
    // tool-call, no usage, and no lineage entry.
    if (!isSignal(decision)) continue;
    const kind = decision.kind;
    const message =
      record.message !== null && typeof record.message === "object"
        ? (record.message as Record<string, unknown>)
        : undefined;
    const content = claudeContentProjection(message, record);
    const nativeEventId = typeof record.uuid === "string" ? record.uuid : undefined;
    const eventId = eventIdFor(sessionId, sequence, nativeEventId ?? lineNumber);
    if (nativeEventId !== undefined) nativeUuidToEventId.set(nativeEventId, eventId);
    const parentUuid = typeof record.parentUuid === "string" ? record.parentUuid : undefined;
    if (parentUuid !== undefined) {
      const parentEventId = resolveKeptAncestorEventId(parentUuid);
      parentEdges.push({
        id: edgeIdFor(sessionId, "parent", parentUuid, nativeEventId ?? eventId),
        kind: "parent",
        ...(parentEventId !== undefined ? { fromEventId: parentEventId } : { fromId: parentUuid }),
        toEventId: eventId,
        rawReference: { sourcePath, line: lineNumber, nativeType: "parentUuid" },
      });
    }
    const timestamp =
      typeof record.timestamp === "string" ? record.timestamp : undefined;
    const blocks = contentArray(message);
    const toolCallId = upsertClaudeToolCalls(
      toolCallsById,
      sessionId,
      eventId,
      timestamp,
      blocks,
    );
    const usageRecord = claudeUsageRecord(
      sessionId,
      eventId,
      sequence,
      timestamp,
      message,
    );
    if (usageRecord !== undefined) usageRecords.push(usageRecord);
    events.push({
      id: eventId,
      nativeEventId,
      parentEventId:
        parentUuid === undefined ? undefined : resolveKeptAncestorEventId(parentUuid) ?? parentUuid,
      sequence,
      timestamp,
      role: claudeRoleFor(kind, typeof message?.role === "string" ? message.role : undefined),
      kind,
      contentText: compactText(content),
      contentSource: content,
      ...(toolCallId !== undefined ? { toolCallId } : {}),
      rawReference: { sourcePath, line: lineNumber, nativeType: type },
    });
    sequence += 1;
  }
  const session = buildSession({
    provider: "claude",
    agentName: "claude-code",
    machine: options.machine,
    sessionId,
    nativeSessionId,
    nativeProjectKey: projectKey,
    sourceRoot: logicalProjectsRoot,
    sourcePath,
    projectPath,
    events,
    toolCalls: [...toolCallsById.values()],
    sessionEdges: [...subagentEdges, ...parentEdges],
    usageRecords,
  });
  return { session, diagnostics };
};

async function* streamClaude(options: AdapterOptions) {
  const root = options.roots?.claude ?? claudeAdapter.defaultRoot();
  if (root === undefined || !existsSync(root)) {
    yield {
      type: "diagnostic" as const,
      diagnostic: {
        adapterId: claudeAdapter.id,
        provider: "claude" as const,
        status: "no_data_found" as const,
        parserConfidence: "observed" as const,
        message: "Claude root was not found.",
        ...(root !== undefined ? { rootPath: root } : {}),
      },
    };
    return;
  }
  const projectsRoot = join(root, "projects");
  const logicalRoot = logicalRootFor("claude", root, options);
  const logicalProjectsRoot = join(logicalRoot, "projects");
  const files = collectFiles(
    projectsRoot,
    isClaudeSessionFile,
    options.limit,
    options.skip,
  );
  yield {
    type: "sourceRoot" as const,
    sourceRoot: sourceRoot("claude", claudeAdapter.id, logicalProjectsRoot, options.machine, options.now),
  };
  let sessionCount = 0;
  for (const path of files) {
    const sourcePath = logicalPathFor(path, projectsRoot, logicalProjectsRoot);
    // Stat-level gate: skip unchanged files BEFORE opening them for content read.
    if (options.shouldReadFile !== undefined) {
      const stat = statSync(path);
      if (!options.shouldReadFile(path, stat)) continue;
    }
    const { session, diagnostics } = buildClaudeSessionFromFile(
      path,
      sourcePath,
      logicalProjectsRoot,
      options,
    );
    // Change-detection gate keyed on the canonical session id (now derived
    // from the file's polymorphic native id) plus the source fingerprint, so an
    // unchanged session is skipped without re-emitting.
    if (options.shouldParseSession !== undefined) {
      const stat = statSync(path);
      const probe = {
        sessionId: session.id,
        sourceFingerprint: sourceFingerprintFor(stat),
      };
      if ((await options.shouldParseSession(probe)) === false) continue;
    }
    sessionCount += 1;
    yield {
      type: "session" as const,
      session,
      sourceUnit: {
        provider: "claude" as const,
        adapterId: claudeAdapter.id,
        rootPath: logicalProjectsRoot,
        sourcePath,
        physicalPath: path,
      },
    };
    // Surface every NAMED decode diagnostic from a malformed/unmodeled record
    // in this file. Each is attributable (diagnostic name + parse failure) so a
    // provider contract breach is visible at the boundary, never silent.
    for (const diagnostic of diagnostics) {
      yield {
        type: "diagnostic" as const,
        diagnostic: {
          adapterId: claudeAdapter.id,
          provider: "claude" as const,
          status: "error" as const,
          parserConfidence: "observed" as const,
          rootPath: logicalProjectsRoot,
          message: `${diagnostic.name} for ${sourcePath}: ${diagnostic.message}`,
        },
      };
    }
  }
  yield {
    type: "diagnostic" as const,
    diagnostic: {
      adapterId: claudeAdapter.id,
      provider: "claude" as const,
      status: sessionCount > 0 ? ("available" as const) : ("no_data_found" as const),
      parserConfidence: "observed" as const,
      rootPath: logicalProjectsRoot,
      message: `Discovered ${sessionCount} Claude session(s).`,
    },
  };
}

export const claudeAdapter: SessionAdapter = {
  id: "claude-code-project-jsonl",
  provider: "claude",
  displayName: "Claude Code project JSONL",
  stable: true,
  defaultRoot: () => process.env.CLAUDE_CONFIG_DIR ?? homePath(".claude"),
  read: async (options) => collectAdapterStream(streamClaude(options)),
  stream: streamClaude,
};
