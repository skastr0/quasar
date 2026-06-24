import { createReadStream, existsSync, readdirSync, statSync, type Stats } from "node:fs";
import { basename, join } from "node:path";
import { createInterface } from "node:readline";
import { Brand } from "effect";

import {
  collectAdapterStream,
  type SessionAdapter,
} from "./types";
import { CodexSessionId, type SessionId } from "../core/identity";
import type { NormalizedSession, SessionEventKind, SessionRole, ToolCall, UsageRecord } from "../core/schemas";
import {
  CODEX_SESSION_META_DECODE_FAILED,
  CodexSessionMetaSchema,
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
    const text = recordFrom(block).text;
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
  if (payloadType === "agent_message") return "assistant";
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
    payloadType === "custom_tool_call"
  ) {
    const toolName =
      typeof payload.name === "string" && payload.name.length > 0
        ? payload.name
        : payloadType === "local_shell_call"
          ? "local_shell"
          : "codex_tool";
    const existing = toolCallsById.get(id);
    const input =
      payloadType === "custom_tool_call"
        ? projectToolPayloadNativeValue(payload.input)
        : payloadType === "local_shell_call"
          ? projectToolPayloadNativeValue(payload.action)
          : parseToolInput(payload.arguments);
    toolCallsById.set(id, {
      ...existing,
      id,
      eventId: existing?.eventId ?? eventId,
      toolName,
      status: existing?.status === "completed" ? "completed" : "started",
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
    payloadType === "mcp_tool_call_end"
  ) {
    const existing = toolCallsById.get(id);
    const output = projectToolPayloadNativeValue(
      payloadType === "mcp_tool_call_end" ? payload.result : payload.output,
    );
    toolCallsById.set(id, {
      id,
      eventId: existing?.eventId ?? eventId,
      toolName: existing?.toolName ?? "codex_tool",
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
): CodexUsageDraft | undefined => {
  if (payloadTypeFrom(payload) !== "token_count") return undefined;
  const info = recordFrom(payload.info);
  const nestedTotalUsage = recordFrom(info.total_token_usage);
  const usage =
    Object.keys(nestedTotalUsage).length > 0
      ? nestedTotalUsage
      : Object.keys(info).length > 0
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
    numberValue(usage.reasoning_tokens) ?? numberValue(usage.reasoningTokens);
  const cacheCreationInputTokens =
    numberValue(usage.cache_creation_input_tokens) ??
    numberValue(usage.cacheCreationInputTokens);
  const cacheReadInputTokens =
    numberValue(usage.cache_read_input_tokens) ?? numberValue(usage.cacheReadInputTokens);
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
    model:
      typeof usage.model === "string"
        ? usage.model
        : typeof payload.model === "string"
          ? payload.model
          : undefined,
    modelProvider: "openai",
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
  readonly sessionEdges: CodexEdgeDraft[];
};

const emptyCodexSlice = (): CodexSessionSlice => ({
  events: [],
  toolCallIds: new Set<string>(),
  usageRecords: [],
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

async function* readCodexJsonLines(
  path: string,
  options: { readonly strict?: boolean } = {},
) {
  const lines = createInterface({
    input: createReadStream(path, { encoding: "utf8" }),
    crlfDelay: Infinity,
  });
  let lineNumber = 0;
  let recordIndex = 0;
  for await (const line of lines) {
    lineNumber += 1;
    if (line.trim().length === 0) continue;
    try {
      yield { value: JSON.parse(line) as unknown, lineNumber, recordIndex };
      recordIndex += 1;
    } catch (cause) {
      if (options.strict === true) {
        throw new CodexJsonLineParseError(path, lineNumber, cause);
      }
      // Preserve best-effort behavior from readJsonLines.
    }
  }
}

const projectPathFromSessionMeta = (value: unknown) => {
  const record = recordFrom(value);
  if (record.type !== "session_meta") return undefined;
  const payload = recordFrom(record.payload);
  return typeof payload.cwd === "string"
    ? payload.cwd
    : typeof payload.working_dir === "string"
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
  if (!isLegacyHeaderRecord(record)) return {};
  const git = recordFrom(record.git);
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
  if (record.type !== "session_meta") return undefined;
  const payload = recordFrom(record.payload);
  return normalizedUuid(payload.id);
};

const legacySessionIdFromHeader = (value: unknown, path: string): string | undefined => {
  const record = recordFrom(value);
  if (record.type !== undefined) return undefined;
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
  if (record.type === "session_meta") {
    const payload = recordFrom(record.payload);
    if (payload.id !== undefined) {
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
  if (record.type === undefined && record.id !== undefined) {
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
type CodexSubagentLineage = {
  /** The parent rollout's native id (its session_meta.payload.id). */
  readonly parentNativeId: string;
  /** Human label for the spawned agent, or undefined when none was recorded. */
  readonly agentName: string | undefined;
};

const trimmedNonEmpty = (value: string | null | undefined): string | undefined => {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length === 0 ? undefined : trimmed;
};

const codexSubagentLineage = (meta: CodexSessionMeta): CodexSubagentLineage | undefined => {
  const subagent = meta.payload.source?.subagent ?? undefined;
  if (subagent === undefined || subagent === null) return undefined;
  const threadSpawn = subagent.thread_spawn ?? undefined;
  const parentNativeId = trimmedNonEmpty(threadSpawn?.parent_thread_id ?? undefined);
  if (parentNativeId === undefined) return undefined;
  // Agent identity lives under thread_spawn on real disk (all 517 subagent
  // rollouts); the subagent-level read is a secondary fallback only.
  return {
    parentNativeId,
    agentName:
      trimmedNonEmpty(threadSpawn?.agent_nickname) ??
      trimmedNonEmpty(threadSpawn?.agent_role) ??
      trimmedNonEmpty(subagent.agent_nickname) ??
      trimmedNonEmpty(subagent.agent_role),
  };
};


const parseFileWalkInput = (root: string, limit: number | undefined, skip: number | undefined) => {
  const trimmedRoot = root.trim();
  if (trimmedRoot.length === 0 || (limit !== undefined && limit <= 0)) return undefined;
  return {
    root: trimmedRoot,
    limit: limit === undefined || !Number.isFinite(limit) ? Number.POSITIVE_INFINITY : Math.floor(limit),
    skip: skip === undefined || !Number.isFinite(skip) || skip <= 0 ? 0 : Math.floor(skip),
  };
};

function* walkFilesWithStats(
  root: string,
  predicate: (path: string) => boolean,
  limit?: number,
  skip?: number,
): Generator<{ readonly path: string; readonly stats: Stats }> {
  const input = parseFileWalkInput(root, limit, skip);
  if (input === undefined || !existsSync(input.root)) return;
  const walkInput = input;
  let matched = 0;
  let emitted = 0;

  function* visit(path: string): Generator<{ readonly path: string; readonly stats: Stats }> {
    if (emitted >= walkInput.limit) return;
    let stats: Stats;
    try {
      stats = statSync(path);
    } catch {
      return;
    }
    if (stats.isDirectory()) {
      for (const entry of readdirSync(path).sort()) {
        yield* visit(join(path, entry));
        if (emitted >= walkInput.limit) return;
      }
      return;
    }
    if (!predicate(path)) return;
    if (matched >= walkInput.skip) {
      emitted += 1;
      yield { path, stats };
    }
    matched += 1;
  }

  yield* visit(walkInput.root);
}

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
  let slice = emptyCodexSlice();

  const buildCompleteSession = () => {
    if (slice.events.length === 0) return undefined;
    const session = buildSession({
      provider: "codex",
      agentName,
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
  })) {
    const rawRecord = recordFrom(value);
    if (nativeIdProbe.variant === "legacy_header_v1" && recordIndex === 0) {
      const hints = legacyProjectHintsFromHeader(value);
      projectPath ??= hints.projectPath;
      gitRemote ??= hints.gitRemote;
      continue;
    }
    if (nativeIdProbe.variant === "legacy_header_v1" && rawRecord.type === "session_meta") {
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
    if (rawRecord.type === "session_meta") {
      const decision = decodeOrDrop(CodexSessionMetaSchema, value, {
        kind: "session_meta" as const,
        diagnosticName: CODEX_SESSION_META_DECODE_FAILED,
        diagnostics: [],
      });
      if (isSignal(decision)) {
        const lineage = codexSubagentLineage(decision.value);
        if (lineage !== undefined) {
          if (lineage.agentName !== undefined) agentName = lineage.agentName;
          // Session-to-session subagent lineage. The canonical signal is a
          // `subagent_of` edge whose `fromId` is the parent's machine-independent
          // Quasar SessionId and `toId` is this child's; mapSession projects it
          // onto SessionRow.parentSessionId. The parent's native id is preserved
          // in `rawReference`. NEVER `kind: "parent"` (event threading).
          const parentSessionId = sessionIdFor("codex", CodexSessionId(lineage.parentNativeId));
          slice.sessionEdges.push({
            id: edgeIdFor(sessionId, "subagent_of", parentSessionId, sessionId),
            kind: "subagent_of",
            fromId: parentSessionId,
            toId: sessionId,
            rawReference: {
              sourcePath,
              line: lineNumber,
              nativeType: "session_meta.payload.source.subagent.thread_spawn.parent_thread_id",
              nativeValue: lineage.parentNativeId,
            },
          });
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
    // Route EVERY record through the declarative fail-closed classifier.
    // It returns a SIGNAL (kept, with a mapped SessionEventKind) or a DROP
    // (discarded, with a NAMED reason). A schema failure or unmodeled type is a
    // named decode diagnostic + a DROP — never a throw, never an `unknown`
    // pass-through event. A DROP emits NO event/tool-call/usage row.
    const classification: CodexClassification = classifyCodexRecord(value, decodeDiagnostics);
    if (!isSignal(classification)) continue;
    const content = projectSessionNativeValue(payloadValue);
    const kind = refineCodexSignalKind(payloadType, payloadRecord, classification.kind);
    const role = codexRoleFrom(payloadRecord, classification.kind, payloadType);
    const payloadCallId = callIdFromPayload(payloadRecord);
    const nativeEventId =
      typeof payloadRecord.id === "string"
        ? payloadRecord.id
        : payloadCallId ?? (typeof record.id === "string" ? record.id : undefined);
    const eventId = eventIdFor(sessionId, recordIndex, nativeEventId ?? lineNumber);
    const timestamp = typeof record.timestamp === "string" ? record.timestamp : undefined;
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
