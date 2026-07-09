import { existsSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";

import { collectAdapterStream, type AdapterStreamItem, type SessionAdapter } from "./types";
import { GrokSessionId, type SessionId } from "../core/identity";
import type { Artifact, SessionEdge, SessionEvent, ToolCall } from "../core/schemas";
import {
  artifactIdFor,
  buildSession,
  collectFiles,
  compactText,
  edgeIdFor,
  eventIdFor,
  homePath,
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
} from "./common";
import type { SessionEventKind, SessionRole } from "../core/schemas";
import {
  classifyGrokChat,
  classifyGrokEvent,
  classifyGrokHunk,
  classifyGrokUpdate,
  decodeGrokSubagentManifest,
  decodeGrokSummary,
  GROK_DECODE_FAILED,
  GROK_UNKNOWN_TYPE,
} from "./grok-schema";
import { isSignal, type DecodeDiagnostic, type SignalDecision } from "./harness-schema";

/**
 * Local, DECLARATIVE role mapping (QSR-220). The adapter no longer borrows the
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

/**
 * Lineage recovered for a grok CHILD session from its parent's subagent
 * manifest: the parent's native UUIDv7 and the subagent role. Keyed by the
 * child's native UUIDv7.
 */
type GrokLineage = { readonly parentNativeId: string; readonly subagentType: string };
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
  | { readonly emit: true; readonly kind: SessionEventKind }
  | { readonly emit: false; readonly reason: string };

const toClassifyResult = (
  decision: SignalDecision<unknown, SessionEventKind>,
): ClassifyResult =>
  isSignal(decision)
    ? { emit: true, kind: decision.kind }
    : { emit: false, reason: decision.reason };

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
    const id = artifactIdFor(sessionId, record.hunkId ?? lineNumber);
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

/**
 * Strip a leading/trailing `<user_query>...</user_query>` or
 * `<user_info>...</user_info>` wrapper if the ENTIRE text is the wrapper.
 * Only removes the wrapper tags; the inner content is kept verbatim.
 * Both wrappers are harness-injected; `<user_info>` carries env/OS context
 * (mutually exclusive with `<user_query>` in any given record).
 */
const stripUserQueryWrapper = (text: string): string => {
  const trimmed = text.trim();
  for (const [openTag, closeTag] of [
    ["<user_query>", "</user_query>"],
    ["<user_info>", "</user_info>"],
  ] as const) {
    if (trimmed.startsWith(openTag) && trimmed.endsWith(closeTag)) {
      return trimmed.slice(openTag.length, trimmed.length - closeTag.length).trim();
    }
  }
  return text;
};

/**
 * Extract the leaf text from a grok content value.
 * - string: use directly (strip user_query wrapper)
 * - array: join `.text` from items with `.text` field (e.g. [{type:"text",text:"..."}])
 * - object with `.text`: extract the text field (e.g. {type:"text",text:"..."})
 * - other: return undefined (caller handles as NativeValue)
 */
const extractGrokContentLeaf = (content: unknown): string | undefined => {
  if (typeof content === "string") {
    return stripUserQueryWrapper(content);
  }
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const item of content) {
      if (item === null || typeof item !== "object") continue;
      const itemRecord = item as Record<string, unknown>;
      // Accept {type:"text", text:"..."} or any {text:"..."} block
      if (typeof itemRecord.text === "string") {
        parts.push(itemRecord.text);
      }
    }
    const joined = parts.join("").trim();
    return joined.length > 0 ? stripUserQueryWrapper(joined) : undefined;
  }
  if (content !== null && typeof content === "object") {
    const rec = content as Record<string, unknown>;
    if (typeof rec.text === "string") return stripUserQueryWrapper(rec.text);
  }
  return undefined;
};

/**
 * Peel the known per-harness grok envelope down to the leaf message value.
 *
 * Record shapes:
 *   - chat_history: record.content (string | [{type:"text",text:"..."}])
 *   - updates: record.params.update.content (string | [{text:"..."}])
 *   - fallback: record.text, record.message, record.delta
 *
 * The leaf is returned VERBATIM — no prose-vs-json classification, no
 * reformatting. Agent-generated JSON inside a text block is legitimate
 * searchable content and is preserved as-is.
 */
export const extractGrokProse = (record: Record<string, unknown>): string | undefined => {
  // 1. Direct content field (chat_history user/assistant/tool_result/system)
  if (record.content !== undefined) {
    const leaf = extractGrokContentLeaf(record.content);
    if (leaf !== undefined) return leaf;
  }
  // 2. updates.jsonl: params.update.content
  const params = recordFrom(record.params);
  const update = recordFrom(params?.update);
  if (update?.content !== undefined) {
    const leaf = extractGrokContentLeaf(update.content);
    if (leaf !== undefined) return leaf;
  }
  // 3. Direct text / message / delta fallbacks
  if (typeof record.text === "string") return stripUserQueryWrapper(record.text);
  if (typeof record.message === "string") return stripUserQueryWrapper(record.message);
  if (typeof record.delta === "string") return stripUserQueryWrapper(record.delta);
  return undefined;
};

/**
 * Extract plaintext reasoning text from a STANDALONE `{type:"reasoning"}` record.
 * The dominant shape: `record.summary` is an array of `{type?, text}` items.
 * Fallback: top-level `record.text` field.
 * This is distinct from the EMBEDDED path (record.reasoning inside an assistant
 * record) handled by `grokReasoningText`.
 */
const grokStandaloneReasoningText = (record: Record<string, unknown>): string | undefined => {
  // Primary: summary[*].text joined
  if (Array.isArray(record.summary)) {
    const parts: string[] = [];
    for (const item of record.summary) {
      if (item !== null && typeof item === "object") {
        const t = (item as Record<string, unknown>).text;
        if (typeof t === "string") parts.push(t);
      }
    }
    const joined = parts.join("").trim();
    if (joined.length > 0) return joined;
  }
  // Fallback: top-level text field
  if (typeof record.text === "string" && record.text.length > 0) return record.text;
  return undefined;
};

/** Extract plaintext reasoning text from an assistant record's `reasoning` field. */
const grokReasoningText = (record: Record<string, unknown>): string | undefined => {
  const reasoningField = record.reasoning;
  if (reasoningField === undefined || reasoningField === null) return undefined;
  const reasoningRecord =
    typeof reasoningField === "string"
      ? recordFrom(parseJsonString(reasoningField))
      : recordFrom(reasoningField);
  if (reasoningRecord === undefined) return undefined;
  // Try reasoning.summary[*].text first (encrypted reasoning block with plaintext summary)
  if (Array.isArray(reasoningRecord.summary)) {
    const summaryParts: string[] = [];
    for (const item of reasoningRecord.summary) {
      if (item !== null && typeof item === "object") {
        const s = (item as Record<string, unknown>).text;
        if (typeof s === "string") summaryParts.push(s);
      }
    }
    const summaryText = summaryParts.join("").trim();
    if (summaryText.length > 0) return summaryText;
  }
  // Fallback: reasoning.text
  return stringValue(reasoningRecord.text);
};

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

const buildGrokSessionFromChatPath = (
  chatPath: string,
  sessionsRoot: string,
  lineageMap: GrokLineageMap,
  options: AdapterOptions,
) => {
  // Per-session named decode/drop diagnostics (QSR-220). A malformed record or an
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

  // Derive session metadata from summary.json.
  const generatedTitle = stringValue(summary.generated_title);
  // Session-to-session subagent lineage (QSR-220): grok records the parent only
  // in the parent's `subagents/<child>/meta.json` manifest. If THIS session is a
  // known child, the subagent role names the agent (e.g. "explore") and we emit
  // the canonical `subagent_of` edge below; otherwise it is a top-level session.
  const lineage = lineageMap.get(basename(sessionDir))?.lineage;
  const agentName =
    lineage?.subagentType
    ?? stringValue(summary.agent_name)
    ?? stringValue(summary.current_model_id)
    ?? "grok-build";
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

  const chatEvents = chatLines.flatMap(({ value, lineNumber }, index) => {
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
          rawReference: { sourcePath: chatPath, line: lineNumber, nativeType: "reasoning" },
        });
      }
      const toolCallId =
        collectAssistantToolCalls(sessionId, eventId, record, toolCallsById) ??
        collectTool(eventId, record);
      const content = grokContentProjection(record);
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
        rawReference: { sourcePath: chatPath, line: lineNumber, nativeType: type },
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
        contentText: extractGrokProse(record) ?? compactText(content),
        contentSource: content,
        ...(toolCallId !== undefined ? { toolCallId } : {}),
        rawReference: { sourcePath: chatPath, line: lineNumber, nativeType: type },
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
        rawReference: { sourcePath: chatPath, line: lineNumber, nativeType: "reasoning" },
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
        contentText: extractGrokProse(record) ?? compactText(content),
        contentSource: content,
        ...(toolCallId !== undefined ? { toolCallId } : {}),
        rawReference: { sourcePath: chatPath, line: lineNumber, nativeType: type },
      });
    }
    return result;
  });

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
    const toolCallId = collectTool(eventId, record);
    const content = grokContentProjection(record);
    return [
      {
        id: eventId,
        nativeEventId,
        sequence: chatLines.length + index,
        timestamp: grokTime(record),
        role: "unknown" as const,
        kind: classified.kind,
        contentText: compactText(content),
        contentSource: content,
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
    const content = grokContentProjection(innerUpdate);
    // extractGrokProse on innerUpdate finds content directly (innerUpdate IS params.update).
    // For the `content` field on innerUpdate (e.g. agent_message_chunk.content), it peels the
    // leaf string from the content block array.
    const proseText = extractGrokProse(innerUpdate) ?? compactText(content);
    return [
      {
        id: eventId,
        sequence: chatLines.length + eventLines.length + index,
        timestamp: grokTime(record),
        role: "system" as const,
        kind: classified.kind,
        contentText: proseText,
        contentSource: content,
        ...(toolCallId !== undefined ? { toolCallId } : {}),
        rawReference: { sourcePath: updatePath, line: lineNumber, nativeType: subtype ?? "update" },
      } satisfies GrokEventDraft,
    ];
  });

  const events = [...chatEvents, ...sidecarEvents, ...updateEvents];
  const session = buildSession({
    provider: "grok",
    agentName,
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
        status: "error",
        parserConfidence: "observed",
        message: `Grok subagent manifest dropped (${diagnostic.name}).`,
        details: { error: diagnostic.message },
        rootPath: sessionsRoot,
      },
    };
  }
  let sessionCount = 0;
  for (const chatPath of files) {
    // Stat-level gate on the canonical chat file BEFORE touching any sidecar
    // files. An unchanged chat_history.jsonl means the session's primary content
    // has not changed; the whole session is skipped.
    if (options.shouldReadFile !== undefined) {
      const stat = statSync(chatPath);
      if (!options.shouldReadFile(chatPath, stat)) continue;
    }
    // Cheap pre-parse gate over the full session surface: chat is canonical,
    // while events/updates are optional sidecars whose late creation must
    // invalidate the prior ingest.
    const sessionDir = dirname(chatPath);
    const fingerprint = grokSessionFingerprint(sessionDir);
    if (options.shouldParseSession !== undefined) {
      const probe = {
        sessionId: sessionIdFor("grok", GrokSessionId(basename(sessionDir))),
        sourceFingerprint: sourceFingerprintFor(fingerprint),
      };
      if ((await options.shouldParseSession(probe)) === false) continue;
    }
    const { session, decodeDiagnostics } = buildGrokSessionFromChatPath(
      chatPath,
      sessionsRoot,
      lineageMap,
      options,
    );
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
    // QSR-220 boundary doctrine: a malformed record or an unknown record type is
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
    if (hardFailures.length > 0) {
      yield {
        type: "diagnostic",
        diagnostic: {
          adapterId: grokAdapter.id,
          provider: "grok",
          status: "error",
          parserConfidence: "observed",
          rootPath: sessionsRoot,
          message: `Dropped ${hardFailures.length} malformed/unknown grok record(s) in ${basename(sessionDir)} (fail-closed; ingest continued).`,
          details: { sessionDir, diagnostics: hardFailures },
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
