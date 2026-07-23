import { existsSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { Brand } from "effect";

import {
  collectAdapterStream,
  type SessionAdapter,
} from "./types";
import { CodexSessionId, type SessionId } from "../core/identity";
import type {
  AgentAssignment,
  ExecutionContextRecord,
  NormalizedSession,
  SessionEventKind,
  SessionRole,
  ToolCall,
  UsageRecord,
} from "../core/schemas";
import {
  CODEX_SESSION_META_DECODE_FAILED,
  CodexSessionMetaSchema,
  CodexThreadSettingsAppliedPayloadSchema,
  CodexTurnContextSchema,
  classifyCodexRecord,
  type CodexClassification,
  type CodexSessionMeta,
} from "./codex-schema";
import { type DecodeDiagnostic, decodeOrDrop, isSignal } from "./harness-schema";
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
  projectSessionNativeValue,
  projectToolPayloadNativeValue,
  recordFrom,
  scopedId,
  sessionIdFor,
  sourceFingerprintFor,
  sourceRoot,
  streamJsonlRecords,
  usageIdFor,
} from "./common";

type CodexRecord = Record<string, unknown>;
type AdapterOptions = Parameters<SessionAdapter["read"]>[0];
type CodexToolCallDraft = Omit<
  ToolCall,
  "sessionId" | "machineId" | "provider" | "agentName" | "projectIdentityKey"
>;
type CodexUsageDraft = Omit<
  UsageRecord,
  "sessionId" | "machineId" | "provider" | "agentName" | "projectIdentityKey"
>;
type CodexExecutionContextDraft = Omit<
  ExecutionContextRecord,
  "sessionId" | "machineId" | "provider" | "agentName" | "projectIdentityKey"
>;
type CodexEventDraft = Parameters<typeof buildSession>[0]["events"][number];
type CodexEdgeDraft = NonNullable<Parameters<typeof buildSession>[0]["sessionEdges"]>[number];
type CodexSessionIdV1LegacyHeader = string & Brand.Brand<"CodexSessionIdV1LegacyHeader">;
const CodexSessionIdV1LegacyHeader = Brand.nominal<CodexSessionIdV1LegacyHeader>();
type CodexSessionIdV2SessionMeta = string & Brand.Brand<"CodexSessionIdV2SessionMeta">;
const CodexSessionIdV2SessionMeta = Brand.nominal<CodexSessionIdV2SessionMeta>();
type CodexNativeIdVariant = "legacy_header_v1" | "session_meta_v2";
type CodexNativeIdProbe = {
  readonly id: CodexSessionId;
  readonly variant: CodexNativeIdVariant;
};
type CodexLegacyProjectHints = {
  readonly projectPath?: string;
  readonly gitRemote?: string;
};

const payloadRecordFrom = (value: unknown): CodexRecord =>
  value !== null && typeof value === "object" ? (value as CodexRecord) : {};

const payloadTypeFrom = (payload: CodexRecord) =>
  typeof payload.type === "string" ? payload.type : undefined;

const firstStringValue = (...values: readonly unknown[]): string | undefined => {
  for (const value of values) {
    if (typeof value !== "string") continue;
    const trimmed = value.trim();
    if (trimmed.length > 0) return trimmed;
  }
  return undefined;
};

const codexNativeType = (recordType: string, payloadType: string | undefined) =>
  payloadType === undefined ? recordType : `${recordType}.${payloadType}`;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ROLLOUT_UUID_RE = /^rollout-.+-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i;

const normalizedUuid = (value: unknown): string | undefined =>
  typeof value === "string" && UUID_RE.test(value) ? value.toLowerCase() : undefined;

const hasOwn = (record: CodexRecord, key: string): boolean =>
  Object.prototype.hasOwnProperty.call(record, key);

const filenameUuid = (path: string): string | undefined => {
  const match = ROLLOUT_UUID_RE.exec(basename(path));
  return match?.[1]?.toLowerCase();
};

/**
 * Codex injects machine-authored context into the transcript as ordinary
 * `user`/`assistant` message records. No human authored these; they are
 * wrappers around session machinery, recognized by the opening tag of the
 * first content block and mapped to `kind: "preamble"` so the ingest layer's
 * injected-kind filter excludes them from the search surface.
 */
const INJECTED_WRAPPER_PREFIXES = [
  "<environment_context",
  "<user_instructions",
  "<turn_aborted",
  "<ide_context",
  "<skill>",
  "<subagent_notification",
  "<goal_context",
  "<codex_internal_context",
  "<proposed_plan",
  "<collaboration_mode",
  "<personality_spec",
  "<model_switch",
  "<app-context",
  "# AGENTS.md instructions",
] as const;

/**
 * Codex instruction bundles share one tag grammar — `<skills_instructions>`,
 * `<apps_instructions>`, `<plugins_instructions>`, `<permissions instructions>`,
 * `<user_instructions>`, … — all harness-injected, none human-authored.
 * Measured 2026-06-11 (full corpus): wrapper blocks only ever lead a message;
 * no genuine user text follows one, so the first-block test is exact.
 */
const INJECTED_INSTRUCTIONS_TAG = /^<[a-z][a-z0-9_-]*[_ ]instructions>/;

const firstContentText = (payload: CodexRecord): string | undefined => {
  const content = payload.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return undefined;
  for (const block of content) {
    const text = recordFrom(block)?.text;
    if (typeof text === "string") return text;
  }
  return undefined;
};

const codexImageOrFileItem = (item: CodexRecord): boolean => {
  const type = typeof item.type === "string" ? item.type.toLowerCase() : "";
  return (
    type.includes("image") ||
    type.includes("file") ||
    item.image_url !== undefined ||
    item.imageUrl !== undefined ||
    item.image !== undefined ||
    item.file !== undefined
  );
};

/**
 * A codex message payload is a session turn only when its content carries
 * non-blank text (string content, a non-blank string item, or an item with a
 * non-blank `text`) or attaches an image/file. The measured corpus holds
 * assistant messages whose entire content is `[{"type":"output_text","text":""}]`
 * — empty stubs, provider machinery: such an event carries no turn content,
 * so a JSON dump of its envelope can never reach the search surface.
 */
const codexMessageHasTurnContent = (payload: CodexRecord): boolean => {
  const content = payload.content;
  if (typeof content === "string") return content.trim().length > 0;
  if (!Array.isArray(content)) {
    // event_msg user_message/agent_message payloads carry text directly.
    const direct = payload.message ?? payload.text;
    return typeof direct === "string" && direct.trim().length > 0;
  }
  return content.some((item) => {
    if (typeof item === "string") return item.trim().length > 0;
    if (item === null || typeof item !== "object") return false;
    const record = item as CodexRecord;
    if (typeof record.text === "string" && record.text.trim().length > 0) return true;
    return codexImageOrFileItem(record);
  });
};

const isInjectedWrapperMessage = (payload: CodexRecord): boolean => {
  const text = firstContentText(payload)?.trimStart();
  return (
    text !== undefined &&
    (INJECTED_WRAPPER_PREFIXES.some((prefix) => text.startsWith(prefix)) ||
      INJECTED_INSTRUCTIONS_TAG.test(text))
  );
};

/**
 * Extract the leaf message text from a codex payload by its `type` discriminant,
 * peeling the harness envelope and returning the verbatim content only.
 *
 * Per-shape rules (grounded against the measured on-disk corpus 2026-06-22):
 *
 *  event_msg.user_message  → payload.message   (the raw user text)
 *  event_msg.agent_message → payload.message   (the agent prose)
 *  response_item.message   → payload.content when it is a string; otherwise
 *                             join the `text` fields of typed content blocks
 *                             (input_text / output_text / …) with "\n\n"
 *  response_item.reasoning → join content[*].text for text blocks; fall back
 *                             to summary text; NEVER read encrypted_content
 *
 * Returns undefined when no leaf text can be found (empty stub, image-only
 * payload, etc.). The caller falls back to the generic `compactText(content)`
 * path for all other payload types (tool calls, usage, lifecycle, …).
 *
 * NON-NEGOTIABLE: the returned value is the verbatim leaf — no reformatting,
 * no JSON re-encoding, no isMostlyProse gate. Agent-generated JSON that the
 * user/agent actually wrote is legitimate searchable content and is kept as-is.
 */
export const codexMessageText = (
  payloadType: string | undefined,
  payload: CodexRecord,
): string | undefined => {
  // event_msg.user_message / event_msg.agent_message: leaf lives in `message`.
  if (payloadType === "user_message" || payloadType === "agent_message") {
    const msg = payload.message;
    if (typeof msg === "string" && msg.length > 0) return msg;
    return undefined;
  }

  // response_item.message: leaf is content (string) or joined block texts.
  if (payloadType === "message") {
    const content = payload.content;
    if (typeof content === "string") return content.length > 0 ? content : undefined;
    if (Array.isArray(content)) {
      const parts: string[] = [];
      for (const item of content) {
        if (typeof item === "string") {
          if (item.length > 0) parts.push(item);
        } else if (item !== null && typeof item === "object") {
          const text = (item as CodexRecord).text;
          if (typeof text === "string" && text.length > 0) parts.push(text);
        }
      }
      return parts.length > 0 ? parts.join("\n\n") : undefined;
    }
    return undefined;
  }

  // response_item.reasoning: join content block texts; fall back to summary.
  // NEVER touch encrypted_content.
  if (payloadType === "reasoning") {
    const content = payload.content;
    if (Array.isArray(content)) {
      const parts: string[] = [];
      for (const item of content) {
        if (typeof item === "string") {
          if (item.length > 0) parts.push(item);
        } else if (item !== null && typeof item === "object") {
          const text = (item as CodexRecord).text;
          if (typeof text === "string" && text.length > 0) parts.push(text);
        }
      }
      if (parts.length > 0) return parts.join("\n\n");
    } else if (typeof content === "string" && content.length > 0) {
      return content;
    }
    // summary fallback: may be a string or an array of summary blocks.
    const summary = payload.summary;
    if (typeof summary === "string" && summary.length > 0) return summary;
    if (Array.isArray(summary)) {
      const parts: string[] = [];
      for (const item of summary) {
        if (typeof item === "string") {
          if (item.length > 0) parts.push(item);
        } else if (item !== null && typeof item === "object") {
          const text = (item as CodexRecord).text;
          if (typeof text === "string" && text.length > 0) parts.push(text);
        }
      }
      if (parts.length > 0) return parts.join("\n\n");
    }
    return undefined;
  }

  // All other payload types: no envelope peeling needed here — the caller uses
  // the generic compactText(content) path which is correct for them.
  return undefined;
};

/** Select only measured fields for provider activity records. */
const codexActivityContent = (
  recordType: string,
  payloadType: string | undefined,
  payload: CodexRecord,
) => {
  if (
    (recordType === "response_item" && payloadType === "agent_message") ||
    (recordType === "event_msg" && payloadType === "sub_agent_activity")
  ) {
    return projectSessionNativeValue({
      type: payloadType,
      ...(typeof payload.event_id === "string" ? { event_id: payload.event_id } : {}),
      ...(typeof payload.occurred_at_ms === "number"
        ? { occurred_at_ms: payload.occurred_at_ms }
        : {}),
      ...(typeof payload.agent_thread_id === "string"
        ? { agent_thread_id: payload.agent_thread_id }
        : {}),
      ...(typeof payload.agent_path === "string"
        ? { agent_path: payload.agent_path }
        : {}),
      ...(typeof payload.kind === "string" ? { kind: payload.kind } : {}),
    });
  }
  if (recordType === "event_msg" && payloadType === "thread_rolled_back") {
    return projectSessionNativeValue({
      type: payloadType,
      ...(typeof payload.num_turns === "number"
        ? { num_turns: payload.num_turns }
        : {}),
    });
  }
  return undefined;
};

/**
 * Map a raw codex role string to the canonical `SessionRole`. Local to this
 * adapter: the codex adapter owns its own role parsing rather than
 * importing a shared heuristic, so the role mapping is declarative here.
 */
const codexRoleLiteralFrom = (value: string | undefined): SessionRole => {
  switch (value) {
    case "user":
    case "assistant":
    case "developer":
    case "system":
    case "tool":
    case "thinking":
      return value;
    default:
      return "unknown";
  }
};

/**
 * The declarative SIGNAL kind, refined for the two codex sub-cases that depend
 * on projected content rather than the schema shape:
 *  - response_item.message whose first content block opens with an injected
 *    wrapper tag is `preamble` (harness machinery, not a human turn).
 *  - event_msg.agent_message with `phase: "commentary"` is `preamble`.
 * Both map to `message` in the registry; the refinement happens here because it
 * reads the payload content, not the record's type discriminator.
 */
const refineCodexSignalKind = (
  payloadType: string | undefined,
  payload: CodexRecord,
  signalKind: SessionEventKind,
): SessionEventKind => {
  if (signalKind !== "message") return signalKind;
  if (payloadType === "message" && isInjectedWrapperMessage(payload)) return "preamble";
  if (payloadType === "agent_message" && payload.phase === "commentary") return "preamble";
  return "message";
};

/**
 * The declarative per-record role. An explicit payload `role` (user / assistant
 * / developer / …) always wins; otherwise the role follows the harness-mapped
 * `kind` (the signal kind from `classifyCodexRecord`), so role and kind stay
 * consistent without re-deriving from the native type string.
 */
const codexRoleFrom = (
  payload: CodexRecord,
  kind: SessionEventKind,
  payloadType: string | undefined,
): SessionRole => {
  const explicitRole = codexRoleLiteralFrom(
    typeof payload.role === "string" ? payload.role : undefined,
  );
  if (explicitRole !== "unknown") return explicitRole;
  if (payloadType === "user_message") return "user";
  if (payloadType === "agent_message" && kind === "message") return "assistant";
  switch (kind) {
    case "tool_call":
      return "assistant";
    case "tool_result":
      return "tool";
    case "reasoning":
      return "thinking";
    case "usage":
    case "lifecycle":
    case "system":
    case "summary":
      return "system";
    default:
      return "unknown";
  }
};

const callIdFromPayload = (payload: CodexRecord) =>
  typeof payload.call_id === "string" && payload.call_id.length > 0
    ? payload.call_id
    : undefined;

const toolCallIdFor = (sessionId: SessionId, callId: string) =>
  scopedId(sessionId, "tool", callId);

const parseToolInput = (value: unknown): unknown => {
  if (typeof value !== "string") return projectToolPayloadNativeValue(value);
  try {
    return projectToolPayloadNativeValue(JSON.parse(value) as unknown);
  } catch {
    return projectToolPayloadNativeValue(value);
  }
};

const codexToolName = (payloadType: string, payload: CodexRecord): string => {
  if (typeof payload.name === "string" && payload.name.length > 0) return payload.name;
  switch (payloadType) {
    case "local_shell_call":
      return "local_shell";
    case "web_search_call":
      return "web_search";
    case "tool_search_call":
    case "tool_search_output":
      return "tool_search";
    default:
      return "codex_tool";
  }
};

const codexToolInput = (payloadType: string, payload: CodexRecord): unknown => {
  switch (payloadType) {
    case "custom_tool_call":
      return projectToolPayloadNativeValue(payload.input);
    case "local_shell_call":
    case "web_search_call":
      return projectToolPayloadNativeValue(payload.action);
    case "tool_search_call":
      return projectToolPayloadNativeValue({
        ...(typeof payload.execution === "string"
          ? { execution: payload.execution }
          : {}),
        ...(payload.arguments !== undefined ? { arguments: payload.arguments } : {}),
      });
    default:
      return parseToolInput(payload.arguments);
  }
};

const codexToolOutput = (payloadType: string, payload: CodexRecord): unknown => {
  switch (payloadType) {
    case "mcp_tool_call_end":
      return projectToolPayloadNativeValue(payload.result);
    case "tool_search_output":
      return projectToolPayloadNativeValue(payload.tools);
    default:
      return projectToolPayloadNativeValue(payload.output);
  }
};

const upsertCodexToolCall = (
  toolCallsById: Map<string, CodexToolCallDraft>,
  sessionId: SessionId,
  eventId: string,
  timestamp: string | undefined,
  payload: CodexRecord,
) => {
  const payloadType = payloadTypeFrom(payload);
  const callId = callIdFromPayload(payload);
  if (callId === undefined) return undefined;
  const id = toolCallIdFor(sessionId, callId);
  // custom_tool_call (apply_patch and friends) shares the function_call shape
  // but carries its payload in `input` (raw text) instead of `arguments` (JSON).
  // local_shell_call carries its payload in `action` (exec command record) and
  // has no `name`.
  // NOTE: local_shell_call / local_shell_call_output are documented in the codex
  // schema but UNOBSERVED on this machine (0 occurrences in the measured corpus
  // 2026-06-21); real shell invocations arrive as function_call name=exec_command.
  // They are modeled fail-closed regardless so the path is ready if they appear.
  if (
    payloadType === "function_call" ||
    payloadType === "local_shell_call" ||
    payloadType === "custom_tool_call" ||
    payloadType === "web_search_call" ||
    payloadType === "tool_search_call"
  ) {
    const toolName = codexToolName(payloadType, payload);
    const existing = toolCallsById.get(id);
    const input = codexToolInput(payloadType, payload);
    const payloadStatus =
      typeof payload.status === "string" && payload.status.length > 0
        ? payload.status
        : "started";
    toolCallsById.set(id, {
      ...existing,
      id,
      eventId: existing?.eventId ?? eventId,
      toolName,
      status: existing?.status === "completed" ? "completed" : payloadStatus,
      ...(input !== undefined ? { input } : {}),
      ...(existing?.output !== undefined ? { output: existing.output } : {}),
      ...(timestamp !== undefined ? { startedAt: timestamp } : {}),
      ...(existing?.completedAt !== undefined ? { completedAt: existing.completedAt } : {}),
    });
    return id;
  }
  // mcp_tool_call_end is a dual carrier (60% share a call_id with a
  // function_call_output that also carries the result). It is routed through the
  // SAME call_id-keyed merge as the *_output records so the duplicate collapses
  // onto the existing tool call; only the 40% sole-carrier case emits standalone.
  // Its output lives in `result`, not `output`.
  if (
    payloadType === "function_call_output" ||
    payloadType === "local_shell_call_output" ||
    payloadType === "custom_tool_call_output" ||
    payloadType === "tool_search_output" ||
    payloadType === "mcp_tool_call_end"
  ) {
    const existing = toolCallsById.get(id);
    const output = codexToolOutput(payloadType, payload);
    toolCallsById.set(id, {
      id,
      eventId: existing?.eventId ?? eventId,
      toolName: existing?.toolName ?? codexToolName(payloadType, payload),
      status: "completed",
      ...(existing?.input !== undefined ? { input: existing.input } : {}),
      ...(output !== undefined ? { output } : {}),
      ...(existing?.startedAt !== undefined ? { startedAt: existing.startedAt } : {}),
      ...(timestamp !== undefined ? { completedAt: timestamp } : {}),
    });
    return id;
  }
  return undefined;
};

const codexUsageRecord = (
  sessionId: SessionId,
  eventId: string,
  sequence: number,
  timestamp: string | undefined,
  payload: CodexRecord,
  modelFallback: string | undefined,
  modelProviderFallback: string | undefined,
): CodexUsageDraft | undefined => {
  if (payloadTypeFrom(payload) !== "token_count") return undefined;
  const info = recordFrom(payload.info);
  const nestedTotalUsage = recordFrom(info?.total_token_usage);
  const usage: CodexRecord =
    nestedTotalUsage !== undefined && Object.keys(nestedTotalUsage).length > 0
      ? nestedTotalUsage
      : info !== undefined && Object.keys(info).length > 0
        ? info
        : payload;
  const inputTokens =
    numberValue(usage.input_tokens) ??
    numberValue(usage.inputTokens) ??
    numberValue(usage.prompt_tokens) ??
    numberValue(usage.promptTokens);
  const outputTokens =
    numberValue(usage.output_tokens) ??
    numberValue(usage.outputTokens) ??
    numberValue(usage.completion_tokens) ??
    numberValue(usage.completionTokens);
  const reasoningTokens =
    numberValue(usage.reasoning_output_tokens) ??
    numberValue(usage.reasoning_tokens) ??
    numberValue(usage.reasoningTokens);
  const cacheCreationInputTokens =
    numberValue(usage.cache_write_input_tokens) ??
    numberValue(usage.cache_creation_input_tokens) ??
    numberValue(usage.cacheCreationInputTokens);
  const cacheReadInputTokens =
    numberValue(usage.cached_input_tokens) ??
    numberValue(usage.cache_read_input_tokens) ??
    numberValue(usage.cacheReadInputTokens);
  const totalTokens =
    numberValue(usage.total_tokens) ??
    numberValue(usage.totalTokens) ??
    sumNumbers([
      inputTokens,
      outputTokens,
      reasoningTokens,
      cacheCreationInputTokens,
      cacheReadInputTokens,
    ]);
  return {
    id: usageIdFor(sessionId, eventId, sequence),
    eventId,
    ...(timestamp !== undefined ? { timestamp } : {}),
    model: firstStringValue(usage.model, payload.model, modelFallback),
    modelProvider: firstStringValue(
      usage.model_provider,
      usage.modelProvider,
      payload.model_provider,
      payload.modelProvider,
      modelProviderFallback,
    ),
    inputTokens,
    outputTokens,
    reasoningTokens,
    cacheCreationInputTokens,
    cacheReadInputTokens,
    totalTokens,
  };
};

const sumNumbers = (values: readonly (number | undefined)[]) => {
  const present = values.filter((value): value is number => value !== undefined);
  return present.length === 0
    ? undefined
    : present.reduce((sum, value) => sum + value, 0);
};

type CodexSessionSlice = {
  readonly events: CodexEventDraft[];
  readonly toolCallIds: Set<string>;
  readonly usageRecords: CodexUsageDraft[];
  readonly executionContexts: CodexExecutionContextDraft[];
  readonly sessionEdges: CodexEdgeDraft[];
};

const emptyCodexSlice = (): CodexSessionSlice => ({
  events: [],
  toolCallIds: new Set<string>(),
  usageRecords: [],
  executionContexts: [],
  sessionEdges: [],
});

class CodexJsonLineParseError extends Error {
  readonly lineNumber: number;

  constructor(path: string, lineNumber: number, cause: unknown) {
    super(
      `Failed to parse Codex JSONL record at ${path}:${lineNumber}: ${
        cause instanceof Error ? cause.message : String(cause)
      }`,
    );
    this.name = "CodexJsonLineParseError";
    this.lineNumber = lineNumber;
  }
}

const readCodexJsonLines = (
  path: string,
  options: {
    readonly strict?: boolean;
    readonly diagnostics?: DecodeDiagnostic[];
    readonly diagnosticName?: string;
    readonly sourcePath?: string;
  } = {},
) =>
  streamJsonlRecords(path, {
    strict: options.strict,
    strictError: (filePath, lineNumber, cause) =>
      new CodexJsonLineParseError(filePath, lineNumber, cause),
    diagnostics: options.diagnostics,
    diagnosticName: options.diagnosticName ?? "codex.line.invalid_json",
    sourcePath: options.sourcePath,
  });

const projectPathFromSessionMeta = (value: unknown) => {
  const record = recordFrom(value);
  if (record?.type !== "session_meta") return undefined;
  const payload = recordFrom(record.payload);
  return typeof payload?.cwd === "string"
    ? payload.cwd
    : typeof payload?.working_dir === "string"
      ? payload.working_dir
      : undefined;
};

const nonEmptyString = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;

const firstStringField = (record: CodexRecord, fields: readonly string[]): string | undefined => {
  for (const field of fields) {
    const value = nonEmptyString(record[field]);
    if (value !== undefined) return value;
  }
  return undefined;
};

const LEGACY_PROJECT_PATH_FIELDS = [
  "cwd",
  "working_dir",
  "workingDir",
  "root",
  "root_dir",
  "rootDir",
  "worktree",
  "worktree_path",
  "worktreePath",
  "repo_path",
  "repoPath",
  "repository_path",
  "repositoryPath",
] as const;

const LEGACY_GIT_REMOTE_FIELDS = [
  "repository_url",
  "repositoryUrl",
  "remote_url",
  "remoteUrl",
  "repo_url",
  "repoUrl",
  "origin",
  "remote",
  "url",
] as const;

const legacyProjectHintsFromHeader = (value: unknown): CodexLegacyProjectHints => {
  const record = recordFrom(value);
  if (record === undefined || !isLegacyHeaderRecord(record)) return {};
  const git = recordFrom(record.git);
  if (git === undefined) return {};
  const projectPath = firstStringField(git, LEGACY_PROJECT_PATH_FIELDS);
  const gitRemote = firstStringField(git, LEGACY_GIT_REMOTE_FIELDS);
  return {
    ...(projectPath !== undefined ? { projectPath } : {}),
    ...(gitRemote !== undefined ? { gitRemote } : {}),
  };
};

const hasLegacyProjectHint = (value: unknown): boolean => {
  const hints = legacyProjectHintsFromHeader(value);
  return hints.projectPath !== undefined || hints.gitRemote !== undefined;
};

/**
 * Codex has at least two private first-record formats. The current format
 * carries the native id at `session_meta.payload.id`; the legacy header format
 * carries it at top-level `id`. Both are content-sourced. The filename UUID is
 * used only as a legacy integrity check, never as the primary id source.
 */
const sessionIdFromSessionMeta = (value: unknown): string | undefined => {
  const record = recordFrom(value);
  if (record?.type !== "session_meta") return undefined;
  const payload = recordFrom(record.payload);
  return normalizedUuid(payload?.id);
};

const legacySessionIdFromHeader = (value: unknown, path: string): string | undefined => {
  const record = recordFrom(value);
  if (record === undefined || record.type !== undefined) return undefined;
  if (!isLegacyHeaderRecord(record)) return undefined;
  if (!hasLegacyProjectHint(value)) return undefined;
  const id = normalizedUuid(record.id);
  if (id === undefined) return undefined;
  return id === filenameUuid(path) ? id : undefined;
};

const isLegacyHeaderRecord = (record: CodexRecord): boolean =>
  record.type === undefined &&
  hasOwn(record, "id") &&
  hasOwn(record, "timestamp") &&
  hasOwn(record, "instructions") &&
  hasOwn(record, "git") &&
  typeof record.timestamp === "string" &&
  typeof record.instructions === "string" &&
  record.git !== null &&
  typeof record.git === "object" &&
  !Array.isArray(record.git);

/**
 * A rollout file missing `session_meta.payload.id` is a contract breach at the
 * ingest boundary, not a fallback case: emitting a path-derived id would
 * silently re-introduce the provenance-bearing filename stem this change
 * removes. The named diagnostic identifies the offending file; the adapter
 * writes zero rows for it and continues.
 */
export const CODEX_MISSING_SESSION_META_ID =
  "codex.session_meta.payload.id.missing";
export const CODEX_SESSION_META_ID_INVALID =
  "codex.session_meta.payload.id.invalid";
export const CODEX_LEGACY_HEADER_ID_INVALID =
  "codex.legacy_header.id.invalid";
export const CODEX_LEGACY_HEADER_SHAPE_INVALID =
  "codex.legacy_header.shape.invalid";
export const CODEX_LEGACY_HEADER_PROJECT_MISSING =
  "codex.legacy_header.project.missing";
export const CODEX_LEGACY_HEADER_ID_FILENAME_MISMATCH =
  "codex.legacy_header.id.filename_mismatch";
export const CODEX_LEGACY_SESSION_META_IGNORED =
  "codex.legacy_header.session_meta_ignored";
export const CODEX_FIRST_RECORD_JSON_INVALID =
  "codex.first_record.json.invalid";
export const CODEX_MISSING_NATIVE_SESSION_ID =
  "codex.native_session_id.missing";

const nativeIdDiagnostic = (value: unknown, sourcePath: string) => {
  const record = recordFrom(value);
  if (record?.type === "session_meta") {
    const payload = recordFrom(record.payload);
    if (payload?.id !== undefined) {
      return {
        name: CODEX_SESSION_META_ID_INVALID,
        message: `${CODEX_SESSION_META_ID_INVALID}: ${sourcePath} has a session_meta.payload.id that is not a UUID; wrote zero rows for this session.`,
      };
    }
    return {
      name: CODEX_MISSING_SESSION_META_ID,
      message: `${CODEX_MISSING_SESSION_META_ID}: ${sourcePath} has no session_meta.payload.id; wrote zero rows for this session.`,
    };
  }
  if (record !== undefined && record.type === undefined && record.id !== undefined) {
    if (normalizedUuid(record.id) === undefined) {
      return {
        name: CODEX_LEGACY_HEADER_ID_INVALID,
        message: `${CODEX_LEGACY_HEADER_ID_INVALID}: ${sourcePath} has a legacy header id that is not a UUID; wrote zero rows for this session.`,
      };
    }
    if (!isLegacyHeaderRecord(record)) {
      return {
        name: CODEX_LEGACY_HEADER_SHAPE_INVALID,
        message: `${CODEX_LEGACY_HEADER_SHAPE_INVALID}: ${sourcePath} has an untyped id record that is not the measured legacy header shape; wrote zero rows for this session.`,
      };
    }
    if (!hasLegacyProjectHint(value)) {
      return {
        name: CODEX_LEGACY_HEADER_PROJECT_MISSING,
        message: `${CODEX_LEGACY_HEADER_PROJECT_MISSING}: ${sourcePath} has a legacy header git object without a usable project path or remote; wrote zero rows for this session.`,
      };
    }
    return {
      name: CODEX_LEGACY_HEADER_ID_FILENAME_MISMATCH,
      message: `${CODEX_LEGACY_HEADER_ID_FILENAME_MISMATCH}: ${sourcePath} legacy header id does not match the rollout filename UUID; wrote zero rows for this session.`,
    };
  }
  return {
    name: CODEX_MISSING_NATIVE_SESSION_ID,
    message: `${CODEX_MISSING_NATIVE_SESSION_ID}: ${sourcePath} has no recognized Codex native session id; wrote zero rows for this session.`,
  };
};

const firstRecordJsonDiagnostic = (error: unknown, sourcePath: string) => ({
  name: CODEX_FIRST_RECORD_JSON_INVALID,
  message: `${CODEX_FIRST_RECORD_JSON_INVALID}: ${sourcePath} first JSON record could not be parsed; wrote zero rows for this session.${
    error instanceof CodexJsonLineParseError ? ` line=${error.lineNumber}` : ""
  }`,
});

/**
 * Codex subagents are separate rollout-*.jsonl files, each with its own UUIDv7.
 * A subagent rollout records its spawning parent AND its agent identity under
 * `session_meta.payload.source.subagent.thread_spawn`: the parent's native id at
 * `thread_spawn.parent_thread_id`, the agent identity at
 * `thread_spawn.agent_nickname` (preferred) / `thread_spawn.agent_role`
 * (fallback). Measured 2026-06-21 across all 517 subagent rollouts: the identity
 * lives under `thread_spawn`, NOT at the subagent level — the subagent-level
 * read is kept only as a secondary fallback. A main-session rollout carries no
 * `source.subagent`, so this returns `undefined` and the session maps with no
 * parent.
 */
type CodexSubagentMetadata = {
  /** The parent rollout's native id (its session_meta.payload.id). */
  readonly parentNativeId?: string;
  /** Typed assignment facts kept independently from the display agentName. */
  readonly assignment?: AgentAssignment;
};

const trimmedNonEmpty = (value: string | null | undefined): string | undefined => {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length === 0 ? undefined : trimmed;
};

const codexSubagentMetadata = (meta: CodexSessionMeta): CodexSubagentMetadata | undefined => {
  const subagent = meta.payload.source?.subagent ?? undefined;
  if (subagent === undefined || subagent === null) return undefined;
  const threadSpawn = subagent.thread_spawn ?? undefined;
  const parentNativeId = trimmedNonEmpty(threadSpawn?.parent_thread_id ?? undefined);
  const nickname =
    trimmedNonEmpty(threadSpawn?.agent_nickname) ??
    trimmedNonEmpty(subagent.agent_nickname);
  const role =
    trimmedNonEmpty(threadSpawn?.agent_role) ??
    trimmedNonEmpty(subagent.agent_role);
  const path = trimmedNonEmpty(threadSpawn?.agent_path);
  const rawDepth = numberValue(threadSpawn?.depth);
  const depth =
    rawDepth !== undefined && Number.isInteger(rawDepth) && rawDepth >= 0
      ? rawDepth
      : undefined;
  const assignment =
    nickname !== undefined || role !== undefined || path !== undefined || depth !== undefined
      ? {
          ...(nickname !== undefined ? { nickname } : {}),
          ...(role !== undefined ? { role } : {}),
          ...(path !== undefined ? { path } : {}),
          ...(depth !== undefined ? { depth } : {}),
        }
      : undefined;
  if (parentNativeId === undefined && assignment === undefined) return undefined;
  return {
    ...(parentNativeId !== undefined ? { parentNativeId } : {}),
    ...(assignment !== undefined ? { assignment } : {}),
  };
};

type CodexExecutionContextCapture = {
  readonly context: CodexExecutionContextDraft;
  readonly model?: string;
  readonly modelProvider?: string;
};

const codexExecutionContextFrom = (
  record: CodexRecord,
  sessionId: SessionId,
  sequence: number,
  timestamp: string | undefined,
  modelProviderFallback: string | undefined,
): CodexExecutionContextCapture | undefined => {
  if (record.type === "turn_context") {
    const decision = decodeOrDrop(CodexTurnContextSchema, record, {
      kind: "turn_context" as const,
      diagnosticName: "codex.turn_context.decode_failed",
      diagnostics: [],
    });
    if (!isSignal(decision)) return undefined;
    const payload = decision.value.payload ?? undefined;
    if (payload === undefined || payload === null) return undefined;
    const model = trimmedNonEmpty(payload.model);
    const modelProvider = modelProviderFallback;
    const reasoningEffort =
      trimmedNonEmpty(payload.effort) ??
      trimmedNonEmpty(payload.collaboration_mode?.settings?.reasoning_effort);
    const turnId = trimmedNonEmpty(payload.turn_id);
    const approvalPolicy = trimmedNonEmpty(payload.approval_policy);
    const collaborationMode = trimmedNonEmpty(payload.collaboration_mode?.mode);
    const multiAgentMode = trimmedNonEmpty(payload.multi_agent_mode);
    const personality = trimmedNonEmpty(payload.personality);
    const permissionProfileType = trimmedNonEmpty(payload.permission_profile?.type);
    const context: CodexExecutionContextDraft = {
      id: scopedId(sessionId, "execution-context", sequence, "turn_context"),
      sequence,
      scope: "turn",
      ...(timestamp !== undefined ? { timestamp } : {}),
      ...(turnId !== undefined ? { turnId } : {}),
      ...(model !== undefined ? { model } : {}),
      ...(modelProvider !== undefined ? { modelProvider } : {}),
      ...(reasoningEffort !== undefined ? { reasoningEffort } : {}),
      ...(approvalPolicy !== undefined ? { approvalPolicy } : {}),
      ...(collaborationMode !== undefined ? { collaborationMode } : {}),
      ...(multiAgentMode !== undefined ? { multiAgentMode } : {}),
      ...(personality !== undefined ? { personality } : {}),
      ...(permissionProfileType !== undefined ? { permissionProfileType } : {}),
    };
    return {
      context,
      ...(model !== undefined ? { model } : {}),
      ...(modelProvider !== undefined ? { modelProvider } : {}),
    };
  }

  if (record.type !== "event_msg") return undefined;
  const payloadRecord = payloadRecordFrom(record.payload);
  if (payloadTypeFrom(payloadRecord) !== "thread_settings_applied") return undefined;
  const decision = decodeOrDrop(CodexThreadSettingsAppliedPayloadSchema, record.payload, {
    kind: "thread_settings_applied" as const,
    diagnosticName: "codex.event_msg.thread_settings_applied.decode_failed",
    diagnostics: [],
  });
  if (!isSignal(decision)) return undefined;
  const settings = decision.value.thread_settings;
  const model = trimmedNonEmpty(settings.model);
  const modelProvider =
    trimmedNonEmpty(settings.model_provider_id) ?? modelProviderFallback;
  const reasoningEffort = trimmedNonEmpty(settings.reasoning_effort);
  const serviceTier = trimmedNonEmpty(settings.service_tier);
  const approvalPolicy = trimmedNonEmpty(settings.approval_policy);
  const collaborationMode = trimmedNonEmpty(settings.collaboration_mode?.mode);
  const personality = trimmedNonEmpty(settings.personality);
  const permissionProfileType = trimmedNonEmpty(settings.permission_profile?.type);
  const context: CodexExecutionContextDraft = {
    id: scopedId(sessionId, "execution-context", sequence, "thread_settings_applied"),
    sequence,
    scope: "session",
    ...(timestamp !== undefined ? { timestamp } : {}),
    ...(model !== undefined ? { model } : {}),
    ...(modelProvider !== undefined ? { modelProvider } : {}),
    ...(reasoningEffort !== undefined ? { reasoningEffort } : {}),
    ...(serviceTier !== undefined ? { serviceTier } : {}),
    ...(approvalPolicy !== undefined ? { approvalPolicy } : {}),
    ...(collaborationMode !== undefined ? { collaborationMode } : {}),
    ...(personality !== undefined ? { personality } : {}),
    ...(permissionProfileType !== undefined ? { permissionProfileType } : {}),
  };
  return {
    context,
    ...(model !== undefined ? { model } : {}),
    ...(modelProvider !== undefined ? { modelProvider } : {}),
  };
};


const readFirstCodexJsonRecord = async (
  path: string,
  parseOptions: { readonly strictJsonLines?: boolean },
): Promise<unknown> => {
  for await (const { value } of readCodexJsonLines(path, {
    strict: parseOptions.strictJsonLines,
  })) {
    return value;
  }
  return undefined;
};

/** Read only the codex native id from the first JSON record. */
const readCodexNativeId = async (
  path: string,
  parseOptions: { readonly strictJsonLines?: boolean },
): Promise<CodexNativeIdProbe | undefined> => {
  const value = await readFirstCodexJsonRecord(path, parseOptions);
  if (value !== undefined) {
    const sessionMetaId = sessionIdFromSessionMeta(value);
    if (sessionMetaId !== undefined) {
      return {
        id: CodexSessionId(CodexSessionIdV2SessionMeta(sessionMetaId)),
        variant: "session_meta_v2",
      };
    }
    const legacyHeaderId = legacySessionIdFromHeader(value, path);
    if (legacyHeaderId !== undefined) {
      return {
        id: CodexSessionId(CodexSessionIdV1LegacyHeader(legacyHeaderId)),
        variant: "legacy_header_v1",
      };
    }
    return undefined;
  }
  return undefined;
};

async function* streamCodexSessionFromFile(
  path: string,
  sourcePath: string,
  logicalSessionsRoot: string,
  nativeIdProbe: CodexNativeIdProbe,
  options: AdapterOptions,
  decodeDiagnostics: DecodeDiagnostic[],
  parseOptions: { readonly strictJsonLines?: boolean } = {},
): AsyncGenerator<NormalizedSession> {
  const nativeSessionId = nativeIdProbe.id;
  const sessionId = sessionIdFor("codex", nativeSessionId);
  const toolCallsById = new Map<string, CodexToolCallDraft>();
  const toolCallEventByToolId = new Map<string, string>();
  let projectPath: string | undefined;
  let gitRemote: string | undefined;
  // Subagent lineage + agent identity, sourced fail-closed from the decoded
  // session_meta. Defaults: no parent, agentName "codex" (a main session).
  let agentName = "codex";
  let assignment: AgentAssignment | undefined;
  let currentModel: string | undefined;
  let currentModelProvider: string | undefined;
  let slice = emptyCodexSlice();

  const buildCompleteSession = () => {
    if (slice.events.length === 0) return undefined;
    const session = buildSession({
      provider: "codex",
      agentName,
      ...(assignment !== undefined ? { assignment } : {}),
      machine: options.machine,
      sessionId,
      nativeSessionId,
      nativeProjectKey: projectPath,
      gitRemote,
      sourceRoot: logicalSessionsRoot,
      sourcePath,
      projectPath,
      events: slice.events,
      toolCalls: [...slice.toolCallIds].flatMap((id) => {
        const toolCall = toolCallsById.get(id);
        return toolCall === undefined ? [] : [toolCall];
      }),
      usageRecords: slice.usageRecords,
      executionContexts: slice.executionContexts,
      sessionEdges: slice.sessionEdges,
    });
    slice = emptyCodexSlice();

    return {
      ...session,
      eventCount: session.events.length,
      toolCallCount: session.toolCalls.length,
      contentBlockCount: session.events.reduce(
        (count, event) => count + event.contentBlocks.length,
        0,
      ),
      sessionEdgeCount: session.sessionEdges.length,
      usageRecordCount: session.usageRecords.length,
      artifactCount: session.artifacts.length,
    };
  };

  for await (const { value, lineNumber, recordIndex } of readCodexJsonLines(path, {
    strict: parseOptions.strictJsonLines,
    diagnostics: decodeDiagnostics,
    diagnosticName: "codex.line.invalid_json",
    sourcePath,
  })) {
    const rawRecord = recordFrom(value);
    if (nativeIdProbe.variant === "legacy_header_v1" && recordIndex === 0) {
      const hints = legacyProjectHintsFromHeader(value);
      projectPath ??= hints.projectPath;
      gitRemote ??= hints.gitRemote;
      continue;
    }
    if (nativeIdProbe.variant === "legacy_header_v1" && rawRecord?.type === "session_meta") {
      decodeDiagnostics.push({
        name: CODEX_LEGACY_SESSION_META_IGNORED,
        message: `${CODEX_LEGACY_SESSION_META_IGNORED}: ignored session_meta inside legacy-header rollout at ${sourcePath}:${lineNumber}.`,
      });
      continue;
    }
    projectPath ??= projectPathFromSessionMeta(value);
    // Fail-closed decode of the session_meta record (the first JSON record) for
    // subagent lineage + agentName ONLY. The named diagnostic for a garbage
    // session_meta is emitted by the unified classifier below (single source),
    // so this block routes its decode failure into a throwaway sink to avoid a
    // duplicate. Lineage is projected ONLY from a successfully decoded record.
    if (rawRecord?.type === "session_meta") {
      const decision = decodeOrDrop(CodexSessionMetaSchema, value, {
        kind: "session_meta" as const,
        diagnosticName: CODEX_SESSION_META_DECODE_FAILED,
        diagnostics: [],
      });
      if (isSignal(decision)) {
        currentModelProvider ??= trimmedNonEmpty(decision.value.payload.model_provider);
        const metadata = codexSubagentMetadata(decision.value);
        if (metadata !== undefined) {
          assignment = metadata.assignment;
          agentName = assignment?.nickname ?? assignment?.role ?? agentName;
          // Session-to-session subagent lineage. The canonical signal is a
          // `subagent_of` edge whose `fromId` is the parent's machine-independent
          // Quasar SessionId and `toId` is this child's; mapSession projects it
          // onto SessionRow.parentSessionId. The parent's native id is preserved
          // in `rawReference`. NEVER `kind: "parent"` (event threading).
          if (metadata.parentNativeId !== undefined) {
            const parentSessionId = sessionIdFor(
              "codex",
              CodexSessionId(metadata.parentNativeId),
            );
            slice.sessionEdges.push({
              id: edgeIdFor(sessionId, "subagent_of", parentSessionId, sessionId),
              kind: "subagent_of",
              fromId: parentSessionId,
              toId: sessionId,
              rawReference: {
                sourcePath,
                line: lineNumber,
                nativeType: "session_meta.payload.source.subagent.thread_spawn.parent_thread_id",
                nativeValue: metadata.parentNativeId,
              },
            });
          }
        }
      }
    }
    const record =
      typeof value === "object" && value !== null
        ? (value as Record<string, unknown>)
        : {};
    const nativeType = typeof record.type === "string" ? record.type : "unknown";
    const payloadValue = record.payload;
    const payloadRecord = payloadRecordFrom(payloadValue);
    const payloadType = payloadTypeFrom(payloadRecord);
    const timestamp = typeof record.timestamp === "string" ? record.timestamp : undefined;
    // Route EVERY record through the declarative fail-closed classifier.
    // It returns a SIGNAL (kept, with a mapped SessionEventKind) or a DROP
    // (discarded, with a NAMED reason). A schema failure or unmodeled type is a
    // named decode diagnostic + a DROP — never a throw, never an `unknown`
    // pass-through event. A DROP emits NO event/tool-call/usage row.
    const classification: CodexClassification = classifyCodexRecord(value, decodeDiagnostics);
    const executionContext = codexExecutionContextFrom(
      record,
      sessionId,
      recordIndex,
      timestamp,
      currentModelProvider,
    );
    if (executionContext !== undefined) {
      slice.executionContexts.push(executionContext.context);
      currentModel = executionContext.model ?? currentModel;
      currentModelProvider = executionContext.modelProvider ?? currentModelProvider;
    }
    if (!isSignal(classification)) continue;
    const content =
      codexActivityContent(nativeType, payloadType, payloadRecord) ??
      projectSessionNativeValue(payloadValue);
    const kind = refineCodexSignalKind(payloadType, payloadRecord, classification.kind);
    const role = codexRoleFrom(payloadRecord, classification.kind, payloadType);
    const payloadCallId = callIdFromPayload(payloadRecord);
    const nativeEventId =
      typeof payloadRecord.id === "string"
        ? payloadRecord.id
        : typeof payloadRecord.event_id === "string"
          ? payloadRecord.event_id
          : payloadCallId ?? (typeof record.id === "string" ? record.id : undefined);
    const eventId = eventIdFor(sessionId, recordIndex, nativeEventId ?? lineNumber);
    const toolCallId = upsertCodexToolCall(
      toolCallsById,
      sessionId,
      eventId,
      timestamp,
      payloadRecord,
    );
    if (toolCallId !== undefined) {
      slice.toolCallIds.add(toolCallId);
      if (kind === "tool_call") toolCallEventByToolId.set(toolCallId, eventId);
      if (kind === "tool_result") {
        const callEventId = toolCallEventByToolId.get(toolCallId);
        if (callEventId !== undefined) {
          slice.sessionEdges.push({
            id: edgeIdFor(sessionId, "tool_result_for", callEventId, eventId),
            kind: "tool_result_for",
            fromEventId: callEventId,
            toEventId: eventId,
          });
        }
      }
    }
    const usageRecord = codexUsageRecord(
      sessionId,
      eventId,
      recordIndex,
      timestamp,
      payloadRecord,
      currentModel,
      currentModelProvider,
    );
    if (usageRecord !== undefined) slice.usageRecords.push(usageRecord);
    // Message events whose payload carries no turn content (empty text stubs)
    // surface as bare events: no contentText/contentSource means no blocks and
    // no fallback JSON dump on the search surface.
    const hasTurnContent = kind !== "message" || codexMessageHasTurnContent(payloadRecord);
    // Peel the harness envelope to the verbatim leaf text for message/reasoning
    // records. codexMessageText returns undefined for all other payload types so
    // those fall through to the generic compactText(content) path unchanged.
    // NON-NEGOTIABLE: no prose-vs-json gate, no reformatting — leaf is kept verbatim.
    const leafText = codexMessageText(payloadType, payloadRecord);
    const resolvedContentText = leafText !== undefined ? leafText : compactText(content);
    slice.events.push({
      id: eventId,
      nativeEventId,
      sequence: recordIndex,
      timestamp,
      role,
      kind,
      ...(hasTurnContent
        ? { contentText: resolvedContentText, contentSource: content }
        : {}),
      ...(toolCallId !== undefined ? { toolCallId } : {}),
      rawReference: {
        sourcePath,
        line: lineNumber,
        nativeType: codexNativeType(nativeType, payloadType),
      },
    });
  }

  const final = buildCompleteSession();
  if (final !== undefined) yield final;
}

async function* streamCodex(options: AdapterOptions) {
  const root = options.roots?.codex ?? codexAdapter.defaultRoot();
  if (root === undefined || !existsSync(root)) {
    yield {
      type: "diagnostic" as const,
      diagnostic: {
        adapterId: codexAdapter.id,
        provider: "codex" as const,
        status: "no_data_found" as const,
        parserConfidence: "documented" as const,
        message: "Codex root was not found.",
        ...(root !== undefined ? { rootPath: root } : {}),
      },
    };
    return;
  }

  const logicalRoot = logicalRootFor("codex", root, options);
  // Codex keeps live rollouts under sessions/<year>/… and archived rollouts
  // flat under archived_sessions/. Both hold the identical JSONL format, so
  // both are scanned; skip/limit apply to the combined file list.
  const scans = ["sessions", "archived_sessions"].map((directory) => ({
    physicalRoot: join(root, directory),
    logicalScanRoot: join(logicalRoot, directory),
  }));
  const logicalSessionsRoot = scans[0]!.logicalScanRoot;
  const allFiles = scans.flatMap((scan) =>
    collectFiles(scan.physicalRoot, (path) => /rollout-.*\.jsonl$/.test(path)).map(
      (path) => ({ path, scan }),
    ),
  );
  const skip =
    options.skip !== undefined && Number.isFinite(options.skip) && options.skip > 0
      ? Math.floor(options.skip)
      : 0;
  const limit =
    options.limit !== undefined && Number.isFinite(options.limit)
      ? Math.max(0, Math.floor(options.limit))
      : Number.POSITIVE_INFINITY;
  const files =
    limit === Number.POSITIVE_INFINITY
      ? allFiles.slice(skip)
      : allFiles.slice(skip, skip + limit);
  for (const scan of scans) {
    yield {
      type: "sourceRoot" as const,
      sourceRoot: sourceRoot("codex", codexAdapter.id, scan.logicalScanRoot, options.machine, options.now),
    };
  }
  let sessionCount = 0;
  let rejectedCount = 0;
  const variantCounts: Record<CodexNativeIdVariant, number> = {
    legacy_header_v1: 0,
    session_meta_v2: 0,
  };
  for (const { path, scan } of files) {
    const sourcePath = logicalPathFor(path, scan.physicalRoot, scan.logicalScanRoot);
    // Stat-level gate: skip files whose mtime+size match the last ingest record
    // BEFORE the expensive first-record read (readCodexNativeId opens the file).
    if (options.shouldReadFile !== undefined) {
      const stat = statSync(path);
      if (!options.shouldReadFile(path, stat)) continue;
    }
    let nativeIdProbe: CodexNativeIdProbe | undefined;
    let nativeIdError: unknown;
    try {
      nativeIdProbe = await readCodexNativeId(path, { strictJsonLines: true });
    } catch (error) {
      nativeIdError = error;
    }
    if (nativeIdProbe === undefined) {
      const diagnostic = nativeIdError !== undefined
        ? firstRecordJsonDiagnostic(nativeIdError, sourcePath)
        : nativeIdDiagnostic(await readFirstCodexJsonRecord(path, {}), sourcePath);
      rejectedCount += 1;
      yield {
        type: "diagnostic" as const,
        diagnostic: {
          adapterId: codexAdapter.id,
          provider: "codex" as const,
          status: "error" as const,
          parserConfidence: "documented" as const,
          rootPath: scan.logicalScanRoot,
          message: diagnostic.message,
          details: { diagnostic: diagnostic.name, sourcePath, physicalPath: path },
        },
      };
      continue;
    }
    variantCounts[nativeIdProbe.variant] += 1;
    // Cheap pre-parse gate: a stat (size/mtime) is the per-session change
    // signal, so an unchanged rollout file never reaches the line parse.
    if (options.shouldParseSession !== undefined) {
      const stat = statSync(path);
      const probe = {
        sessionId: sessionIdFor("codex", nativeIdProbe.id),
        sourceFingerprint: sourceFingerprintFor(stat),
      };
      if ((await options.shouldParseSession(probe)) === false) continue;
    }
    sessionCount += 1;
    // Named decode diagnostics for a malformed session_meta in THIS file. A
    // drop is accumulated here and surfaced as an attributable diagnostic; it
    // never aborts the file and never coerces silently.
    const decodeDiagnostics: DecodeDiagnostic[] = [];
    for await (const session of streamCodexSessionFromFile(
      path,
      sourcePath,
      scan.logicalScanRoot,
      nativeIdProbe,
      options,
      decodeDiagnostics,
    )) {
      yield {
        type: "session" as const,
        session,
        sourceUnit: {
          provider: "codex" as const,
          adapterId: codexAdapter.id,
          rootPath: scan.logicalScanRoot,
          sourcePath,
          physicalPath: path,
        },
      };
    }
    for (const diagnostic of decodeDiagnostics) {
      yield {
        type: "diagnostic" as const,
        diagnostic: {
          adapterId: codexAdapter.id,
          provider: "codex" as const,
          status: "unsupported" as const,
          parserConfidence: "documented" as const,
          rootPath: scan.logicalScanRoot,
          message: `Codex record dropped (${diagnostic.name}) for ${sourcePath}.`,
          details: { diagnostic: diagnostic.name, error: diagnostic.message, sourcePath, physicalPath: path },
        },
      };
    }
  }
  yield {
    type: "diagnostic" as const,
    diagnostic: {
      adapterId: codexAdapter.id,
      provider: "codex" as const,
      status: sessionCount > 0 ? ("available" as const) : ("no_data_found" as const),
      parserConfidence: "documented" as const,
      rootPath: logicalSessionsRoot,
      message:
        rejectedCount > 0
          ? `Discovered ${sessionCount} Codex session(s); variants legacy_header_v1=${variantCounts.legacy_header_v1}, session_meta_v2=${variantCounts.session_meta_v2}; rejected ${rejectedCount} file(s) missing a recognized native session id.`
          : `Discovered ${sessionCount} Codex session(s); variants legacy_header_v1=${variantCounts.legacy_header_v1}, session_meta_v2=${variantCounts.session_meta_v2}.`,
    },
  };
}

export const codexAdapter: SessionAdapter = {
  id: "codex-local-jsonl",
  provider: "codex",
  displayName: "Codex local JSONL",
  stable: true,
  defaultRoot: () => process.env.CODEX_HOME ?? homePath(".codex"),
  read: async (options) => collectAdapterStream(streamCodex(options)),
  stream: streamCodex,
};
