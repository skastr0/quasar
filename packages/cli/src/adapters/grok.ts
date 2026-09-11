import { existsSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";

import { collectAdapterStream, type AdapterStreamItem, type SessionAdapter } from "./types";
import { GrokSessionId, type SessionId } from "../core/identity";
import type {
  AgentAssignment,
  Artifact,
  ExecutionContextRecord,
  NormalizedSession,
  SessionEdge,
  SessionEvent,
  ToolCall,
  UsageRecord,
} from "../core/schemas";
import {
  artifactIdFor,
  buildSession,
  collectFiles,
  compactText,
  edgeIdFor,
  eventIdFor,
  homePath,
  jsonBlock,
  parseJsonString,
  projectSessionNativeValue,
  projectToolPayloadNativeValue,
  recordFrom,
  readJsonFile,
  readJsonLines,
  scopedId,
  sessionIdFor,
  sourceFingerprintFor,
  sourceRoot,
  stringValue,
  type NativeValue,
  usageIdFor,
} from "./common";
import { truncateDiagnosticMessage, type SessionEventKind, type SessionRole } from "../core/schemas";
import {
  classifyGrokChat,
  classifyGrokEvent,
  classifyGrokHunk,
  classifyGrokUpdate,
  decodeGrokSubagentManifest,
  decodeGrokSummary,
  GROK_DECODE_FAILED,
  GROK_UNKNOWN_TYPE,
  type GrokUpdTurnCompletedRecord,
} from "./grok-schema";
import {
  extractGrokProse,
  grokReasoningText,
  grokStandaloneReasoningText,
} from "./grok-text";
import {
  grokArchiveInputPaths,
  planGrokHistoryRecovery,
  readGrokArchiveHistories,
  type GrokChatSource,
} from "./grok-recovery";
import { isSignal, type DecodeDiagnostic, type SignalDecision } from "./harness-schema";

// Test and downstream surface: chat-entry prose extraction is shared with the
// archive recovery path so both derive text identically.
export { extractGrokProse } from "./grok-text";

/**
 * Local, DECLARATIVE role mapping . The adapter no longer borrows the
 * shared `roleFrom`/`kindFromNative` string heuristics: every grok record's kind
 * comes from the per-record-type classifier in `grok-schema.ts`, and the role is
 * derived here from the (already-validated) record type. Nothing is inferred from
 * fuzzy substring matching.
 */
const grokRole = (type: string | undefined): SessionRole => {
  switch (type) {
    case "user":
      return "user";
    case "assistant":
      return "assistant";
    case "reasoning":
      return "thinking";
    case "system":
      return "system";
    case "tool_result":
    case "backend_tool_call":
      return "tool";
    default:
      return "unknown";
  }
};

const decodeProjectPath = (encoded: string) => {
  try {
    return decodeURIComponent(encoded);
  } catch {
    return encoded;
  }
};

type GrokToolCallDraft = Omit<
  ToolCall,
  "sessionId" | "machineId" | "provider" | "agentName" | "projectIdentityKey"
>;
type GrokArtifactDraft = Omit<
  Artifact,
  "sessionId" | "machineId" | "provider" | "agentName" | "projectIdentityKey"
>;
type GrokEdgeDraft = Omit<
  SessionEdge,
  "sessionId" | "machineId" | "provider" | "agentName" | "projectIdentityKey"
>;
type GrokExecutionContextDraft = Omit<
  ExecutionContextRecord,
  "sessionId" | "machineId" | "provider" | "agentName" | "projectIdentityKey"
>;
type GrokUsageDraft = Omit<
  UsageRecord,
  "sessionId" | "machineId" | "provider" | "agentName" | "projectIdentityKey"
>;

/**
 * Lineage recovered for a grok CHILD session from its parent's subagent
 * manifest: the parent's native UUIDv7 and the subagent role. Keyed by the
 * child's native UUIDv7.
 */
type GrokLineage = {
  readonly parentNativeId: string;
  readonly subagentType: string;
  readonly effectiveModelId?: string;
};
type GrokLineageMap = ReadonlyMap<string, { lineage: GrokLineage; manifestPath: string }>;

/**
 * Walk every `<parent-uuid>/subagents/<child-uuid>/meta.json` under the sessions
 * root and build a child-native-id -> lineage map. Each manifest is decoded
 * fail-closed (`grok.record.decode_failed`): a malformed manifest is dropped
 * with a named diagnostic and contributes no edge, never aborting discovery. The
 * scan is deliberately UN-paged (no limit/skip): the lineage map must be
 * complete even when the session stream itself is paged, so any child page can
 * resolve its parent.
 */
const buildGrokLineageMap = (
  sessionsRoot: string,
  diagnostics?: DecodeDiagnostic[],
): GrokLineageMap => {
  const manifestPaths = collectFiles(sessionsRoot, (path) =>
    /[/\\]subagents[/\\][^/\\]+[/\\]meta\.json$/.test(path),
  );
  const map = new Map<string, { lineage: GrokLineage; manifestPath: string }>();
  for (const manifestPath of manifestPaths) {
    const raw = readJsonFile(manifestPath, {
      diagnosticName: "grok.subagent_manifest.invalid_json",
      diagnostics,
      sourcePath: manifestPath,
    });
    const manifest = decodeGrokSubagentManifest(raw);
    if (manifest === undefined) continue;
    map.set(manifest.child_session_id, {
      lineage: {
        parentNativeId: manifest.parent_session_id,
        subagentType: manifest.subagent_type,
        ...(manifest.effective_model_id !== undefined
          ? { effectiveModelId: manifest.effective_model_id }
          : {}),
      },
      manifestPath,
    });
  }
  return map;
};
type GrokEventDraft = Omit<
  SessionEvent,
  "sessionId" | "machineId" | "provider" | "agentName" | "projectIdentityKey" | "contentBlocks"
> & { readonly contentBlocks?: readonly import("../core/schemas").ContentBlock[]; readonly contentSource?: NativeValue };
type AdapterOptions = Parameters<SessionAdapter["read"]>[0];

const grokSessionFingerprint = (sessionDir: string) => {
  let size = 0;
  let mtimeMs = 0;
  for (const fileName of ["chat_history.jsonl", "events.jsonl", "updates.jsonl"]) {
    const path = join(sessionDir, fileName);
    if (!existsSync(path)) continue;
    const stat = statSync(path);
    size += stat.size;
    mtimeMs = Math.max(mtimeMs, stat.mtimeMs);
  }
  // Recovery reads the compaction/recap archive inputs, so they are part of the
  // session fingerprint: an archive change without a chat_history change must
  // invalidate the stored fingerprint instead of being skipped.
  for (const path of grokArchiveInputPaths(sessionDir)) {
    const stat = statSync(path);
    size += stat.size;
    mtimeMs = Math.max(mtimeMs, stat.mtimeMs);
  }
  return { size, mtimeMs };
};

const grokTime = (record: Record<string, unknown>) => {
  if (typeof record.timestamp === "string") return record.timestamp;
  if (typeof record.ts === "string") return record.ts;
  if (typeof record.timestamp === "number") return new Date(record.timestamp * 1000).toISOString();
  if (typeof record.ts === "number") return new Date(record.ts * 1000).toISOString();
  return undefined;
};

const grokToolName = (record: Record<string, unknown>) => {
  if (typeof record.toolName === "string") return record.toolName;
  if (typeof record.tool === "string") return record.tool;
  // tool_calls array entries have `name` directly (no `type` wrapping)
  if (typeof record.name === "string" && record.type === undefined) return record.name;
  if (typeof record.name === "string" && String(record.type ?? "").includes("tool")) return record.name;
  const state = recordFrom(record.state);
  if (typeof state?.tool === "string") return state.tool;
  const params = recordFrom(record.params);
  if (typeof params?.tool === "string") return params.tool;
  return undefined;
};

const stringContent = (record: Record<string, unknown>) =>
  typeof record.content === "string"
    ? record.content
    : typeof record.text === "string"
      ? record.text
      : typeof record.message === "string"
        ? record.message
        : undefined;

const CONTENT_KEYS = ["content", "text", "message", "delta", "response", "output", "result"] as const;

const grokNestedContent = (record: Record<string, unknown>): NativeValue | undefined => {
  const direct = contentFields(record);
  if (direct !== undefined) return direct;
  for (const key of ["params", "state", "delta"] as const) {
    const nestedRecord = recordFrom(record[key]);
    if (nestedRecord === undefined) continue;
    const nested = contentFields(nestedRecord);
    if (nested !== undefined) return nested;
  }
  return undefined;
};

const contentFields = (record: Record<string, unknown>): NativeValue | undefined => {
  const text = stringContent(record);
  if (text !== undefined) return text;
  const entries = CONTENT_KEYS.flatMap((key) => {
    const value = record[key];
    return value === undefined ? [] : [[key, value] as const];
  });
  return entries.length === 0 ? undefined : projectSessionNativeValue(Object.fromEntries(entries));
};

const grokToolCall = (
  sessionId: SessionId,
  eventId: string,
  record: Record<string, unknown>,
): GrokToolCallDraft | undefined => {
  const toolName = grokToolName(record);
  if (toolName === undefined) return undefined;
  const state = recordFrom(record.state);
  const nativeToolId =
    typeof record.callID === "string"
      ? record.callID
      : typeof record.call_id === "string"
        ? record.call_id
        : typeof record.toolCallId === "string"
          ? record.toolCallId
          : typeof record.id === "string"
            ? record.id
            : eventId;
  const timestamp = grokTime(record);
  const status =
    typeof state?.status === "string"
      ? state.status
      : typeof record.status === "string"
        ? record.status
        : undefined;
  const input = projectToolPayloadNativeValue(state?.input ?? record.input ?? record.args ?? record.params);
  const output = projectToolPayloadNativeValue(state?.output ?? record.output ?? record.result);
  return {
    id: scopedId(sessionId, "tool", nativeToolId),
    eventId,
    toolName,
    status,
    ...(input !== undefined ? { input } : {}),
    ...(output !== undefined ? { output } : {}),
    ...(timestamp !== undefined ? { startedAt: timestamp } : {}),
    ...(status === "completed" && timestamp !== undefined ? { completedAt: timestamp } : {}),
  };
};

/**
 * A classify result for one on-disk record. `dropped` carries the named reason
 * (telemetry drop, encrypted-reasoning drop, decode failure, or unknown type) so
 * the caller can both skip emission AND surface a diagnostic — zero records fall
 * through to an `unknown` pass-through event.
 */
type ClassifyResult =
  | { readonly emit: true; readonly kind: SessionEventKind; readonly value: unknown }
  | { readonly emit: false; readonly reason: string };

const toClassifyResult = (
  decision: SignalDecision<unknown, SessionEventKind>,
): ClassifyResult =>
  isSignal(decision)
    ? { emit: true, kind: decision.kind, value: decision.value }
    : { emit: false, reason: decision.reason };

type GrokUsageCounters = {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly totalTokens: number;
  readonly reasoningTokens: number;
  readonly cachedReadTokens: number;
};

const grokUsageDraft = (
  sessionId: SessionId,
  eventId: string,
  sequence: number,
  timestamp: string | undefined,
  counters: GrokUsageCounters,
  model?: string,
): GrokUsageDraft => ({
  id: usageIdFor(sessionId, eventId, sequence),
  eventId,
  ...(timestamp !== undefined ? { timestamp } : {}),
  ...(model !== undefined ? { model } : {}),
  inputTokens: counters.inputTokens,
  outputTokens: counters.outputTokens,
  reasoningTokens: counters.reasoningTokens,
  cacheReadInputTokens: counters.cachedReadTokens,
  totalTokens: counters.totalTokens,
});

const grokUsageDrafts = (
  sessionId: SessionId,
  eventId: string,
  sequenceOffset: number,
  timestamp: string | undefined,
  update: GrokUpdTurnCompletedRecord["params"]["update"],
): GrokUsageDraft[] => {
  const usage = update.usage;
  if (usage === undefined) return [];
  const perModel = Object.entries(usage.modelUsage);
  if (perModel.length > 0) {
    return perModel.map(([model, counters], index) =>
      grokUsageDraft(
        sessionId,
        eventId,
        sequenceOffset + index,
        timestamp,
        counters,
        model.trim().length > 0 ? model : undefined,
      ),
    );
  }
  return [grokUsageDraft(sessionId, eventId, sequenceOffset, timestamp, usage)];
};

const grokContentProjection = (record: Record<string, unknown>): NativeValue | undefined => {
  const content = grokNestedContent(record);
  if (content !== undefined) return content;
  const toolName = grokToolName(record);
  if (toolName === undefined) return undefined;
  const state = recordFrom(record.state);
  const status =
    typeof state?.status === "string"
      ? state.status
      : typeof record.status === "string"
        ? record.status
        : undefined;
  return {
    type: "tool",
    toolName,
    ...(status !== undefined ? { status } : {}),
  };
};

const grokArtifacts = (
  sessionId: SessionId,
  sessionDir: string,
  hunkPath: string,
  diagnostics: DecodeDiagnostic[],
) =>
  readJsonLines(hunkPath, {
    diagnosticName: "grok.line.invalid_json",
    diagnostics,
    sourcePath: hunkPath,
  }).flatMap(({ value, lineNumber }) => {
    const record = recordFrom(value);
    if (record === undefined || Object.keys(record).length === 0) return [];
    // Fail-closed classify: an unknown/garbage hunk eventType is a NAMED drop,
    // never a silently-kept artifact.
    if (!isSignal(classifyGrokHunk(value, diagnostics))) return [];
    const path = typeof record.filePath === "string" ? record.filePath : undefined;
    // A Grok hunk id identifies the logical edit, not one record in its
    // lifecycle. The same id legitimately recurs for added/updated/removed
    // records, so source-line occurrence identity is required to preserve every
    // fact without colliding in the normalized artifact collection.
    const id = artifactIdFor(sessionId, [record.hunkId ?? null, lineNumber]);
    return [
      {
        id,
        kind: "edit_hunk",
        ...(path !== undefined ? { path } : {}),
        sourcePath: hunkPath,
        sourceRef: {
          line: lineNumber,
          hunkId: record.hunkId,
          hunkStart: record.hunkStart,
          hunkEnd: record.hunkEnd,
        },
        metadata: {
          linesAdded: record.linesAdded,
          linesRemoved: record.linesRemoved,
          authorType: record.authorType,
          eventType: record.eventType,
          timestamp: record.timestamp,
          sessionDir,
        },
      } satisfies GrokArtifactDraft,
    ];
  });

/** Collect tool calls from the `tool_calls` array on an assistant event.
 *  Returns the first collected tool id for the event's `toolCallId` link. */
const collectAssistantToolCalls = (
  sessionId: SessionId,
  eventId: string,
  record: Record<string, unknown>,
  toolCallsById: Map<string, GrokToolCallDraft>,
): string | undefined => {
  const rawToolCalls = record.tool_calls;
  if (rawToolCalls === undefined || rawToolCalls === null) return undefined;
  const calls = Array.isArray(rawToolCalls)
    ? rawToolCalls
    : Array.isArray(parseJsonString(rawToolCalls))
      ? (parseJsonString(rawToolCalls) as unknown[])
      : [];
  let firstId: string | undefined;
  for (const call of calls) {
    const callRecord = recordFrom(call);
    if (callRecord === undefined) continue;
    const toolName = grokToolName(callRecord);
    if (toolName === undefined) continue;
    const nativeToolId = stringValue(callRecord.id) ?? eventId;
    const input = projectToolPayloadNativeValue(
      parseJsonString(callRecord.arguments) ?? callRecord.input ?? callRecord.params,
    );
    const timestamp = grokTime(record);
    const toolCall: GrokToolCallDraft = {
      id: scopedId(sessionId, "tool", nativeToolId),
      eventId,
      toolName,
      status: "started",
      ...(input !== undefined ? { input } : {}),
      ...(timestamp !== undefined ? { startedAt: timestamp } : {}),
    };
    toolCallsById.set(nativeToolId, toolCall);
    firstId ??= toolCall.id;
  }
  return firstId;
};

/** Merge a tool_result record's output into the matching ToolCall record. */
const mergeToolResult = (
  sessionId: SessionId,
  eventId: string,
  record: Record<string, unknown>,
  toolCallsById: Map<string, GrokToolCallDraft>,
): string | undefined => {
  const nativeToolId = stringValue(record.tool_call_id);
  if (nativeToolId === undefined) return undefined;
  const existing = toolCallsById.get(nativeToolId);
  const timestamp = grokTime(record);
  const output = projectToolPayloadNativeValue(
    stringValue(record.content) ?? record.content,
  );
  const merged: GrokToolCallDraft = {
    id: existing?.id ?? scopedId(sessionId, "tool", nativeToolId),
    eventId: existing?.eventId ?? eventId,
    toolName: existing?.toolName ?? "grok_tool",
    status: "completed",
    ...(existing?.input !== undefined ? { input: existing.input } : {}),
    ...(output !== undefined ? { output } : {}),
    ...(existing?.startedAt !== undefined ? { startedAt: existing.startedAt } : {}),
    ...(timestamp !== undefined ? { completedAt: timestamp } : {}),
  };
  toolCallsById.set(nativeToolId, merged);
  return merged.id;
};

type GrokSessionBuild =
  | {
      readonly session: NormalizedSession;
      readonly decodeDiagnostics: DecodeDiagnostic[];
      readonly recoveryBlock?: undefined;
    }
  | {
      readonly session: undefined;
      readonly decodeDiagnostics: DecodeDiagnostic[];
      readonly recoveryBlock: { readonly code: string; readonly message: string };
    };

const buildGrokSessionFromChatPath = (
  chatPath: string,
  sessionsRoot: string,
  lineageMap: GrokLineageMap,
  options: AdapterOptions,
): GrokSessionBuild => {
  // Per-session named decode/drop diagnostics . A malformed record or an
  // unknown record type is accumulated here and surfaced as a session-level
  // boundary diagnostic; ingest of the rest of the session continues.
  const decodeDiagnostics: DecodeDiagnostic[] = [];
  const sessionDir = dirname(chatPath);
  const nativeSessionId = GrokSessionId(basename(sessionDir));
  const sessionId = sessionIdFor("grok", nativeSessionId);
  const projectKey = basename(dirname(sessionDir));
  const projectPath = decodeProjectPath(projectKey);
  // A missing summary.json is simple absence, not garbage: only a PRESENT but
  // malformed summary is a named decode failure.
  const summaryPath = join(sessionDir, "summary.json");
  const summaryRaw = existsSync(summaryPath)
    ? readJsonFile(summaryPath, {
        diagnosticName: "grok.summary.invalid_json",
        diagnostics: decodeDiagnostics,
        sourcePath: summaryPath,
      })
    : undefined;
  const summary: Record<string, unknown> =
    summaryRaw === undefined || summaryRaw === null
      ? {}
      : ((decodeGrokSummary(summaryRaw, decodeDiagnostics) as Record<string, unknown> | undefined) ??
        {});
  const chatLines = readJsonLines(chatPath, {
    diagnosticName: "grok.line.invalid_json",
    diagnostics: decodeDiagnostics,
    sourcePath: chatPath,
  });
  if (chatLines.length === 0) {
    decodeDiagnostics.push({
      name: "grok.file.empty",
      message: `grok.file.empty for ${chatPath}: no parseable JSON records found.`,
    });
  }
  const readOptionalLines = (path: string) =>
    existsSync(path)
      ? readJsonLines(path, {
          diagnosticName: "grok.line.invalid_json",
          diagnostics: decodeDiagnostics,
          sourcePath: path,
        })
      : [];
  const eventLines = readOptionalLines(join(sessionDir, "events.jsonl"));
  const updateLines = readOptionalLines(join(sessionDir, "updates.jsonl"));
  const hunkPath = join(sessionDir, "hunk_records.jsonl");
  const toolCallsById = new Map<string, GrokToolCallDraft>();
  const usageRecords: GrokUsageDraft[] = [];

  // Derive session metadata from summary.json.
  const generatedTitle = stringValue(summary.generated_title);
  // Session-to-session subagent lineage : grok records the parent only
  // in the parent's `subagents/<child>/meta.json` manifest. If THIS session is a
  // known child, the subagent role names the agent (e.g. "explore") and we emit
  // the canonical `subagent_of` edge below; otherwise it is a top-level session.
  const lineage = lineageMap.get(basename(sessionDir))?.lineage;
  const summaryAgentName = stringValue(summary.agent_name);
  const agentName = lineage?.subagentType ?? summaryAgentName ?? "grok-build";
  const assignment: AgentAssignment | undefined =
    lineage === undefined ? undefined : { role: lineage.subagentType };
  const executionContexts: GrokExecutionContextDraft[] = [];
  const effectiveModel = lineage?.effectiveModelId;
  const summaryModel = stringValue(summary.current_model_id);
  if (effectiveModel !== undefined) {
    executionContexts.push({
      id: scopedId(sessionId, "execution-context", "subagent-manifest"),
      sequence: 0,
      scope: "session",
      model: effectiveModel,
    });
  }
  if (summaryModel !== undefined) {
    executionContexts.push({
      id: scopedId(sessionId, "execution-context", "summary"),
      sequence: executionContexts.length,
      scope: "session",
      model: summaryModel,
    });
  }
  const sessionEdges: GrokEdgeDraft[] = [];
  if (lineage !== undefined) {
    // Canonical lineage signal: a `subagent_of` SessionEdge whose `fromId` is the
    // PARENT's machine-independent Quasar SessionId (so it joins to
    // `sessions.session_id`) and whose `toId` is this child. `map.ts` projects
    // ONLY `subagent_of` onto `SessionRow.parentSessionId`. The native parent id
    // is preserved in `rawReference`; we never emit `parent` (event threading).
    const parentSessionId = sessionIdFor("grok", GrokSessionId(lineage.parentNativeId));
    sessionEdges.push({
      id: edgeIdFor(sessionId, "subagent_of", parentSessionId, sessionId),
      kind: "subagent_of",
      fromId: parentSessionId,
      toId: sessionId,
      rawReference: {
        sourcePath: lineageMap.get(basename(sessionDir))?.manifestPath ?? sessionDir,
        nativeType: "subagent_manifest",
        nativeValue: lineage.parentNativeId,
        subagentType: lineage.subagentType,
      },
    });
  }
  const gitRemote = (() => {
    const remotes = summary.git_remotes;
    if (Array.isArray(remotes) && typeof remotes[0] === "string") return remotes[0] as string;
    return undefined;
  })();

  const collectTool = (
    eventId: string,
    record: Record<string, unknown>,
  ) => {
    const toolCall = grokToolCall(sessionId, eventId, record);
    if (toolCall !== undefined) toolCallsById.set(toolCall.id, toolCall);
    return toolCall?.id;
  };

  const updatePath = join(sessionDir, "updates.jsonl");
  const eventPath = join(sessionDir, "events.jsonl");

  // Historical archive recovery: after a Grok compaction the live chat is a
  // compacted view, and the pre-compaction authored turns exist only in the
  // request/checkpoint archive files. The plan either returns the live chat
  // unchanged or the maximal anchored pre-compaction history plus the new
  // epoch tail, never a speculative merge.
  const archiveHistories = readGrokArchiveHistories(sessionDir, decodeDiagnostics);
  const currentChatSources: GrokChatSource[] = chatLines.map(({ value, lineNumber }) => ({
    value,
    sourcePath: chatPath,
    line: lineNumber,
    nativeType: "chat_history",
    createdAt: "",
    archive: false,
  }));
  // Decoded compaction boundary count from the live update stream. This is
  // session metadata, not a message-count heuristic: it proves whether the
  // retained checkpoint archives cover every compaction the session performed.
  const compactionCheckpointUpdates = updateLines.reduce((count, { value }) => {
    const record = recordFrom(value);
    const update = recordFrom(recordFrom(record?.params)?.update);
    return update !== undefined && stringValue(update.sessionUpdate) === "compaction_checkpoint"
      ? count + 1
      : count;
  }, 0);
  const recovery = planGrokHistoryRecovery(currentChatSources, archiveHistories, {
    compactionCheckpointUpdates,
  });
  for (const diagnostic of recovery.diagnostics) decodeDiagnostics.push(diagnostic);
  if (recovery.block !== undefined) {
    // Fail the session closed instead of projecting a shorter replacement over
    // a stored canonical that current source metadata proves is unrecoverable
    // from the available archive inputs.
    return {
      session: undefined,
      decodeDiagnostics,
      recoveryBlock: recovery.block,
    };
  }
  const chatSources = recovery.sources;

  const chatEvents = chatSources.flatMap((source, index) => {
    const value = source.value;
    const lineNumber = source.line;
    const record =
      typeof value === "object" && value !== null
        ? (value as Record<string, unknown>)
        : {};
    const type = typeof record.type === "string" ? record.type : undefined;
    // DECLARATIVE classify: zero passthrough. A drop (telemetry, encrypted
    // reasoning, decode failure, unknown type) emits NO event for this line.
    const classified = toClassifyResult(classifyGrokChat(value, decodeDiagnostics));
    if (!classified.emit) return [];
    const nativeEventId = typeof record.id === "string" ? record.id : undefined;
    const eventId = eventIdFor(sessionId, index, nativeEventId ?? lineNumber);
    const result: GrokEventDraft[] = [];

    if (type === "assistant") {
      // Emit a reasoning event ahead of the assistant reply when plaintext reasoning exists.
      const reasoningText = grokReasoningText(record);
      if (reasoningText !== undefined) {
        const reasoningEventId = `${eventId}:r`;
        result.push({
          id: reasoningEventId,
          nativeEventId: nativeEventId !== undefined ? `${nativeEventId}:r` : undefined,
          sequence: index,
          timestamp: grokTime(record),
          role: "thinking" as const,
          kind: "reasoning" as const,
          contentText: reasoningText,
          rawReference: { sourcePath: source.sourcePath, line: lineNumber, nativeType: "reasoning" },
        });
      }
      const toolCallId =
        collectAssistantToolCalls(sessionId, eventId, record, toolCallsById) ??
        collectTool(eventId, record);
      const content = grokContentProjection(record);
      const messageModel = stringValue(record.model_id);
      if (messageModel !== undefined) {
        executionContexts.push({
          // Recovered archive entries and live chat entries can share a line
          // number, so the context seed must be the unique per-position event id
          // when the record has no native id.
          id: scopedId(sessionId, "execution-context", "chat", nativeEventId ?? eventId),
          sequence: index,
          scope: "turn",
          ...(grokTime(record) !== undefined ? { timestamp: grokTime(record) } : {}),
          turnId: nativeEventId ?? eventId,
          model: messageModel,
        });
      }
      result.push({
        id: eventId,
        nativeEventId,
        sequence: index,
        timestamp: grokTime(record),
        role: grokRole(type),
        kind: toolCallId !== undefined ? ("tool_call" as const) : classified.kind,
        contentText: extractGrokProse(record) ?? compactText(content),
        contentSource: content,
        ...(toolCallId !== undefined ? { toolCallId } : {}),
        rawReference: { sourcePath: source.sourcePath, line: lineNumber, nativeType: type },
      });
    } else if (type === "tool_result") {
      const toolCallId =
        mergeToolResult(sessionId, eventId, record, toolCallsById) ??
        collectTool(eventId, record);
      const content = grokContentProjection(record);
      result.push({
        id: eventId,
        nativeEventId,
        sequence: index,
        timestamp: grokTime(record),
        role: grokRole(type),
        kind: classified.kind,
        ...(toolCallId === undefined
          ? {
              contentText: extractGrokProse(record) ?? compactText(content),
              contentSource: content,
            }
          : {}),
        ...(toolCallId !== undefined ? { toolCallId } : {}),
        rawReference: { sourcePath: source.sourcePath, line: lineNumber, nativeType: type },
      });
    } else if (type === "reasoning") {
      // Standalone {type:"reasoning"} — the DOMINANT shape (~86% of grok reasoning).
      // Plaintext lives in record.summary[*].text (joined), not in record.content.
      // classifyGrokChat already confirmed a non-empty summaryText exists (else it
      // would have dropped the record as `encrypted_reasoning`).
      const contentText = grokStandaloneReasoningText(record);
      result.push({
        id: eventId,
        nativeEventId,
        sequence: index,
        timestamp: grokTime(record),
        role: "thinking" as const,
        kind: "reasoning" as const,
        ...(contentText !== undefined ? { contentText } : {}),
        rawReference: { sourcePath: source.sourcePath, line: lineNumber, nativeType: "reasoning" },
      });
    } else {
      // user / system / backend_tool_call: kind comes from the classifier.
      const toolCallId =
        type === "backend_tool_call" ? collectTool(eventId, record) : undefined;
      const content = grokContentProjection(record);
      result.push({
        id: eventId,
        nativeEventId,
        sequence: index,
        timestamp: grokTime(record),
        role: grokRole(type),
        kind: classified.kind,
        ...(toolCallId === undefined
          ? {
              contentText: extractGrokProse(record) ?? compactText(content),
              contentSource: content,
            }
          : {}),
        ...(toolCallId !== undefined ? { toolCallId } : {}),
        rawReference: { sourcePath: source.sourcePath, line: lineNumber, nativeType: type },
      });
    }
    return result;
  });

  // Provider context preserved with provenance: one event per distinct
  // compaction continuation summary. Role `system` keeps it out of the
  // authored message projection while the prose stays in the event store.
  const contextEvents: GrokEventDraft[] = recovery.contextSources.map((source, index) => {
    const record = recordFrom(source.value) ?? {};
    const eventId = eventIdFor(sessionId, chatSources.length + index, `context:${index}`);
    const text = extractGrokProse(record);
    return {
      id: eventId,
      sequence: chatSources.length + index,
      timestamp: grokTime(record),
      role: "system" as const,
      kind: "summary" as const,
      ...(text !== undefined ? { contentText: text } : {}),
      contentSource: projectSessionNativeValue(record),
      rawReference: { sourcePath: source.sourcePath, line: source.line, nativeType: "compaction_bootstrap" },
    } satisfies GrokEventDraft;
  });
  const chatEventOffset = chatSources.length + contextEvents.length;

  const sidecarEvents = eventLines.flatMap(({ value, lineNumber }, index) => {
    const record =
      typeof value === "object" && value !== null
        ? (value as Record<string, unknown>)
        : {};
    const type = typeof record.type === "string" ? record.type : undefined;
    const classified = toClassifyResult(classifyGrokEvent(value, decodeDiagnostics));
    if (!classified.emit) return [];
    const nativeEventId = typeof record.id === "string" ? record.id : undefined;
    const eventId = eventIdFor(sessionId, index, nativeEventId ?? `events:${lineNumber}`);
    const eventModel = type === "turn_started" ? stringValue(record.model_id) : undefined;
    if (eventModel !== undefined) {
      const turnNumber =
        typeof record.turn_number === "number" && Number.isInteger(record.turn_number)
          ? String(record.turn_number)
          : nativeEventId ?? eventId;
      executionContexts.push({
        id: scopedId(sessionId, "execution-context", "turn-started", lineNumber),
        sequence: chatEventOffset + index,
        scope: "turn",
        ...(grokTime(record) !== undefined ? { timestamp: grokTime(record) } : {}),
        turnId: turnNumber,
        model: eventModel,
      });
    }
    const toolCallId = collectTool(eventId, record);
    const content = type === "interjected"
      ? projectSessionNativeValue(classified.value)
      : grokContentProjection(record);
    const linkedToolEvent =
      toolCallId !== undefined
      && (classified.kind === "tool_call" || classified.kind === "tool_result");
    return [
      {
        id: eventId,
        nativeEventId,
        sequence: chatEventOffset + index,
        timestamp: grokTime(record),
        role: type === "interjected" ? ("system" as const) : ("unknown" as const),
        kind: classified.kind,
        ...(!linkedToolEvent
          ? {
              contentText: type === "interjected" ? undefined : compactText(content),
              contentSource: content,
              ...(type === "interjected" && content !== undefined
                ? { contentBlocks: [jsonBlock(sessionId, eventId, 0, content)] }
                : {}),
            }
          : {}),
        ...(toolCallId !== undefined ? { toolCallId } : {}),
        rawReference: { sourcePath: eventPath, line: lineNumber, nativeType: type ?? "event" },
      } satisfies GrokEventDraft,
    ];
  });

  const updateEvents = updateLines.flatMap(({ value, lineNumber }, index) => {
    const record = recordFrom(value);
    if (record === undefined) return [];
    const classified = toClassifyResult(classifyGrokUpdate(value, decodeDiagnostics));
    if (!classified.emit) return [];
    const params = recordFrom(record.params);
    const innerUpdate = recordFrom(params?.update);
    if (innerUpdate === undefined) return [];
    const subtype = stringValue(innerUpdate.sessionUpdate);
    const eventId = eventIdFor(sessionId, index, `updates:${lineNumber}`);
    const toolCallId = collectTool(eventId, innerUpdate);
    const turnCompleted = subtype === "turn_completed"
      ? classified.value as GrokUpdTurnCompletedRecord
      : undefined;
    if (turnCompleted !== undefined) {
      usageRecords.push(...grokUsageDrafts(
        sessionId,
        eventId,
        usageRecords.length,
        grokTime(record),
        turnCompleted.params.update,
      ));
    }
    const content = turnCompleted !== undefined
      ? projectSessionNativeValue(turnCompleted.params.update)
      : subtype === "session_recap"
        ? projectSessionNativeValue({ auto: innerUpdate.auto })
        : grokContentProjection(innerUpdate);
    const opaqueContent =
      subtype === "turn_completed" || subtype === "session_recap";
    // extractGrokProse on innerUpdate finds content directly (innerUpdate IS params.update).
    // For the `content` field on innerUpdate (e.g. agent_message_chunk.content), it peels the
    // leaf string from the content block array.
    const proseText =
      subtype === "session_recap" && typeof innerUpdate.summary === "string"
        ? innerUpdate.summary
        : subtype === "turn_completed"
          ? undefined
          : extractGrokProse(innerUpdate) ?? compactText(content);
    const linkedToolEvent =
      toolCallId !== undefined
      && (classified.kind === "tool_call" || classified.kind === "tool_result");
    return [
      {
        id: eventId,
        sequence: chatEventOffset + eventLines.length + index,
        timestamp: grokTime(record),
        role: subtype === "session_recap" ? ("assistant" as const) : ("system" as const),
        kind: classified.kind,
        ...(!linkedToolEvent
          ? {
              contentText: proseText,
              contentSource: content,
              ...(opaqueContent && content !== undefined
                ? { contentBlocks: [jsonBlock(sessionId, eventId, 0, content)] }
                : {}),
            }
          : {}),
        ...(toolCallId !== undefined ? { toolCallId } : {}),
        rawReference: { sourcePath: updatePath, line: lineNumber, nativeType: subtype ?? "update" },
      } satisfies GrokEventDraft,
    ];
  });

  const events = [...chatEvents, ...contextEvents, ...sidecarEvents, ...updateEvents];
  const session = buildSession({
    provider: "grok",
    agentName,
    ...(assignment !== undefined ? { assignment } : {}),
    machine: options.machine,
    sessionId,
    nativeSessionId,
    nativeProjectKey: projectKey,
    title: generatedTitle,
    sourceRoot: sessionsRoot,
    sourcePath: sessionDir,
    projectPath,
    gitRemote,
    events,
    toolCalls: [...toolCallsById.values()],
    sessionEdges,
    executionContexts,
    usageRecords,
    artifacts: existsSync(hunkPath)
      ? grokArtifacts(sessionId, sessionDir, hunkPath, decodeDiagnostics)
      : [],
  });
  return { session, decodeDiagnostics };
};

async function* streamGrok(options: AdapterOptions): AsyncGenerator<AdapterStreamItem> {
  const root = options.roots?.grok ?? grokAdapter.defaultRoot();
  if (root === undefined || !existsSync(root)) {
    yield {
      type: "diagnostic",
      diagnostic: {
        adapterId: grokAdapter.id,
        provider: "grok",
        status: "no_data_found",
        parserConfidence: "observed",
        message: "Grok root was not found.",
        ...(root !== undefined ? { rootPath: root } : {}),
      },
    };
    return;
  }
  const sessionsRoot = join(root, "sessions");
  // Build the complete child -> parent lineage map once, UN-paged, so any paged
  // child session can still resolve its parent's canonical id.
  const lineageDiagnostics: DecodeDiagnostic[] = [];
  const lineageMap = buildGrokLineageMap(sessionsRoot, lineageDiagnostics);
  const files = collectFiles(
    sessionsRoot,
    (path) => path.endsWith("chat_history.jsonl"),
    options.limit,
    options.skip,
  );
  const rootRecord = sourceRoot("grok", grokAdapter.id, sessionsRoot, options.machine, options.now);
  yield { type: "sourceRoot", sourceRoot: rootRecord };
  for (const diagnostic of lineageDiagnostics) {
    yield {
      type: "diagnostic",
      diagnostic: {
        adapterId: grokAdapter.id,
        provider: "grok",
        status: "unsupported",
        // A corrupt subagent manifest costs one lineage EDGE, never a session:
        // both the parent and the child still ingest (fail-closed, no edge).
        // Grading it `error` failed every grok session on every tick forever,
        // because a file on disk does not repair itself.
        severity: "warning",
        parserConfidence: "observed",
        message: truncateDiagnosticMessage(
          `Grok subagent manifest dropped (${diagnostic.name}): ${diagnostic.message}`,
        ),
        details: { diagnostic: diagnostic.name, error: diagnostic.message },
        rootPath: sessionsRoot,
      },
    };
  }
  let sessionCount = 0;
  for (const chatPath of files) {
    const sessionDir = dirname(chatPath);
    // Stat-level gate over the canonical chat file AND every archive input the
    // adapter consults. An added/removed compaction request or checkpoint must
    // invalidate the prior ingest even when chat_history.jsonl is unchanged.
    if (options.shouldReadFile !== undefined) {
      let shouldRead = false;
      for (const path of [chatPath, ...grokArchiveInputPaths(sessionDir)]) {
        if (!existsSync(path)) continue;
        if (options.shouldReadFile(path, statSync(path))) shouldRead = true;
      }
      if (!shouldRead) continue;
    }
    // Cheap pre-parse gate over the full session surface: chat is canonical,
    // while events/updates are optional sidecars whose late creation must
    // invalidate the prior ingest.
    const fingerprint = grokSessionFingerprint(sessionDir);
    if (options.shouldParseSession !== undefined) {
      const probe = {
        sessionId: sessionIdFor("grok", GrokSessionId(basename(sessionDir))),
        sourceFingerprint: sourceFingerprintFor(fingerprint),
      };
      if ((await options.shouldParseSession(probe)) === false) continue;
    }
    const built = buildGrokSessionFromChatPath(
      chatPath,
      sessionsRoot,
      lineageMap,
      options,
    );
    if (built.recoveryBlock !== undefined) {
      // Durable hold: source metadata proves the stored session cannot be
      // faithfully replaced from available archive inputs. Emit an attributable
      // ERROR (not a warning) and yield no session, so the ingest fails closed
      // and the stored canonical is never overwritten on a normal cycle.
      const nativeSessionId = basename(sessionDir);
      yield {
        type: "diagnostic",
        diagnostic: {
          adapterId: grokAdapter.id,
          provider: "grok",
          status: "unsupported",
          severity: "error",
          parserConfidence: "observed",
          rootPath: sessionsRoot,
          message: truncateDiagnosticMessage(
            `${built.recoveryBlock.code} for grok session ${nativeSessionId} `
            + `(fail-closed; stored session left unchanged): ${built.recoveryBlock.message}`,
          ),
          details: {
            diagnostic: built.recoveryBlock.code,
            sessionId: sessionIdFor("grok", GrokSessionId(nativeSessionId)),
            sessionDir,
            sourcePath: chatPath,
            physicalPath: chatPath,
          },
        },
      };
      continue;
    }
    const { session, decodeDiagnostics } = built;
    yield {
      type: "session",
      session,
      sourceUnit: {
        provider: "grok",
        adapterId: grokAdapter.id,
        rootPath: sessionsRoot,
        sourcePath: session.sourcePath,
        physicalPath: chatPath,
      },
      fingerprint,
    };
    sessionCount += 1;
    // work-item boundary doctrine: a malformed record or an unknown record type is
    // a NAMED, attributable diagnostic — never a silent skip. Only true decode
    // failures / unknown types surface here; declarative telemetry drops
    // (`grok.drop.*`) are expected and accumulate into the diagnostics sink but
    // do not raise an error. Ingest already continued (the session was emitted).
    const hardFailures = decodeDiagnostics.filter(
      (d) =>
        d.name === GROK_DECODE_FAILED ||
        d.name === GROK_UNKNOWN_TYPE ||
        (d.name.startsWith("grok.") && !d.name.startsWith("grok.drop.")),
    );
    // Severity, not status: the SESSION was already yielded above and ingests
    // normally, so a dropped record is a `warning`. Grading it `error` failed
    // the session AND — with no path on the diagnostic — left the whole grok
    // walk unattributable, so nothing persisted and every grok session was
    // re-parsed and re-posted on every tick, forever.
    for (const failure of hardFailures) {
      yield {
        type: "diagnostic",
        diagnostic: {
          adapterId: grokAdapter.id,
          provider: "grok",
          status: "unsupported",
          severity: "warning",
          parserConfidence: "observed",
          rootPath: sessionsRoot,
          // Presentation cap only: a decode failure renders the offending
          // record inline, so an uncapped message ships a serialized session
          // into every report and log line.
          message: truncateDiagnosticMessage(
            `${failure.name} in ${basename(sessionDir)} (fail-closed; ingest continued): ${failure.message}`,
          ),
          details: {
            diagnostic: failure.name,
            sessionDir,
            sourcePath: session.sourcePath,
            physicalPath: chatPath,
          },
        },
      };
    }
  }
  yield {
    type: "diagnostic",
    diagnostic: {
      adapterId: grokAdapter.id,
      provider: "grok",
      status: sessionCount > 0 ? "available" : "no_data_found",
      parserConfidence: "observed",
      rootPath: sessionsRoot,
      message: `Discovered ${sessionCount} Grok session(s).`,
    },
  };
}

export const grokAdapter: SessionAdapter = {
  id: "grok-session-folder",
  provider: "grok",
  displayName: "Grok session folder",
  stable: true,
  defaultRoot: () => homePath(".grok"),
  read: async (options) => collectAdapterStream(streamGrok(options)),
  stream: streamGrok,
};
