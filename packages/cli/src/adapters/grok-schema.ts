import { Schema } from "effect";

import {
  decodeOrDrop,
  drop,
  isSignal,
  signal,
  type DecodeDiagnostic,
  type SignalDecision,
} from "./harness-schema";
import type { SessionEventKind } from "../core/schemas";

/**
 * Grok FULL DATA FIDELITY (QSR-220).
 *
 * Every distinct on-disk record type grok writes — measured against the real
 * `~/.grok/sessions` corpus — is modeled here as a rigorous, fail-closed Effect
 * Schema and classified by a DECLARATIVE per-record-type signal-vs-drop dispatch.
 * Every record type is EXPLICITLY either signal (with a mapped Quasar
 * `SessionEventKind`) or drop (with a NAMED reason). ZERO records fall through to
 * "unknown" pass-through.
 *
 * Full measured inventory (46 record types across 6 surfaces):
 *   chat_history.jsonl : 6  (user, assistant, reasoning, tool_result, system,
 *                            backend_tool_call)
 *   events.jsonl       : 19 (phase_changed, tool_started, tool_completed,
 *                            permission_requested, permission_resolved,
 *                            loop_started, first_token, turn_started, turn_ended,
 *                            yolo_toggled, mcp_server_starting/_failed/_connected,
 *                            mcp_managed_config_result, mcp_config_resolved,
 *                            mcp_init_completed, mcp_tool_call_started/_completed,
 *                            mcp_oauth_discovery_timeout)
 *   updates.jsonl      : 16 sessionUpdate subtypes (tool_call, tool_call_update,
 *                            available_commands_update, agent_thought_chunk,
 *                            agent_message_chunk, user_message_chunk, retry_state,
 *                            task_backgrounded, task_completed, subagent_spawned,
 *                            subagent_finished, auto_compact_started/_completed,
 *                            compaction_checkpoint, plan, current_mode_update)
 *   hunk_records.jsonl : 3  (added, updated, removed)
 *   summary.json       : 1
 *   subagents/.../meta.json : 1 (lineage manifest)
 *
 * The boundary doctrine (AGENTS.md): provider garbage is rejected with a named
 * diagnostic (`grok.record.decode_failed`), it writes nothing for that record,
 * and ingest continues. A malformed record is NEVER silently coerced into a
 * half-built event and NEVER thrown in a way that aborts the file.
 *
 * A record whose `type`/`method`/`sessionUpdate` discriminator is unknown is
 * itself a contract breach: it is dropped with `grok.record.unknown_type` (a
 * NAMED drop, not a pass-through), so a new grok record type surfaces loudly
 * instead of leaking through as `unknown`.
 */

/** Stable diagnostic name for a grok on-disk record that fails to decode. */
export const GROK_DECODE_FAILED = "grok.record.decode_failed";
/** Stable diagnostic name for a grok record whose discriminator is unknown. */
export const GROK_UNKNOWN_TYPE = "grok.record.unknown_type";

// ---------------------------------------------------------------------------
// Shared field fragments
// ---------------------------------------------------------------------------

/** Grok event timestamp: ISO string (`ts`) on events/sidecars. */
const Ts = Schema.optional(Schema.String);

// ===========================================================================
// 1. subagents/<child>/meta.json — session-to-session lineage manifest
// ===========================================================================

/**
 * Grok subagent manifest (`<parent-uuid>/subagents/<child-uuid>/meta.json`).
 * Links a CHILD session to its PARENT and names the subagent role. Grok writes
 * the child as its own top-level session directory (own UUIDv7 + own
 * `chat_history.jsonl`); this manifest is the SOLE record of the parent
 * relationship, so it is the only source of session-to-session lineage for grok.
 *
 * Only the three lineage-bearing fields are required. The measured
 * `effective_model_id` is retained when present; prose and telemetry fields
 * (description, prompt, status, timings, tool_calls, ...) remain ignored. A
 * manifest missing any required field is provider garbage: a NAMED
 * diagnostic + dropped record (never a half-built edge).
 */
export const GrokSubagentManifest = Schema.Struct({
  /** Native UUIDv7 of the PARENT session whose dir contains this manifest. */
  parent_session_id: Schema.NonEmptyString,
  /** Native UUIDv7 of the CHILD (subagent) session this manifest describes. */
  child_session_id: Schema.NonEmptyString,
  /** The subagent role, projected onto the child session's `agentName`. */
  subagent_type: Schema.NonEmptyString,
  /** Model selected for the child by the parent orchestration runtime. */
  effective_model_id: Schema.optional(Schema.NonEmptyString),
});
export type GrokSubagentManifest = typeof GrokSubagentManifest.Type;

// ===========================================================================
// 2. chat_history.jsonl — the canonical conversation stream (6 record types)
// ===========================================================================

/** A grok assistant tool-call entry inside `assistant.tool_calls[]`. */
export const GrokAssistantToolCall = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  /** Serialized JSON arguments string (grok stores args as a string). */
  arguments: Schema.optional(Schema.String),
});
export type GrokAssistantToolCall = typeof GrokAssistantToolCall.Type;

/** `{type:"user"}` — a human turn. */
export const GrokChatUser = Schema.Struct({
  type: Schema.Literal("user"),
  content: Schema.Unknown,
  synthetic_reason: Schema.optional(Schema.String),
});
export type GrokChatUser = typeof GrokChatUser.Type;

/** `{type:"assistant"}` — a model turn, optionally carrying tool calls. */
export const GrokChatAssistant = Schema.Struct({
  type: Schema.Literal("assistant"),
  content: Schema.optional(Schema.Unknown),
  model_id: Schema.optional(Schema.String),
  model_fingerprint: Schema.optional(Schema.String),
  /** May be an array, a JSON string, null, or absent. */
  tool_calls: Schema.optional(Schema.Unknown),
  /** Plaintext reasoning (rare); the encrypted form is `{type:"reasoning"}`. */
  reasoning: Schema.optional(Schema.Unknown),
});
export type GrokChatAssistant = typeof GrokChatAssistant.Type;

/**
 * `{type:"reasoning"}` — an ENCRYPTED reasoning record. `encrypted_content` is
 * opaque ciphertext; only a short plaintext `summary[].text` may exist. We keep
 * the summary as signal `reasoning` when present, and DROP the record when the
 * body is purely encrypted (named drop `encrypted_reasoning`).
 */
export const GrokChatReasoning = Schema.Struct({
  type: Schema.Literal("reasoning"),
  id: Schema.optional(Schema.String),
  status: Schema.optional(Schema.String),
  encrypted_content: Schema.optional(Schema.String),
  summary: Schema.optional(
    Schema.Array(
      Schema.Struct({
        type: Schema.optional(Schema.String),
        text: Schema.optional(Schema.String),
      }),
    ),
  ),
});
export type GrokChatReasoning = typeof GrokChatReasoning.Type;

/** `{type:"tool_result"}` — output for a prior tool call, keyed by id. */
export const GrokChatToolResult = Schema.Struct({
  type: Schema.Literal("tool_result"),
  tool_call_id: Schema.String,
  content: Schema.optional(Schema.Unknown),
});
export type GrokChatToolResult = typeof GrokChatToolResult.Type;

/** `{type:"system"}` — a system/preamble message. */
export const GrokChatSystem = Schema.Struct({
  type: Schema.Literal("system"),
  content: Schema.optional(Schema.Unknown),
});
export type GrokChatSystem = typeof GrokChatSystem.Type;

/**
 * `{type:"backend_tool_call"}` — a provider-side tool (e.g. web_search) executed
 * by grok's backend. The interesting payload is `kind.tool_type` + `kind.action`
 * + `kind.status`. Signal as a `tool_call`.
 */
export const GrokChatBackendToolCall = Schema.Struct({
  type: Schema.Literal("backend_tool_call"),
  kind: Schema.Struct({
    tool_type: Schema.optional(Schema.String),
    action: Schema.optional(Schema.Unknown),
    id: Schema.optional(Schema.String),
    status: Schema.optional(Schema.String),
  }),
});
export type GrokChatBackendToolCall = typeof GrokChatBackendToolCall.Type;

// ===========================================================================
// 3. events.jsonl — telemetry sidecar (19 record types)
// ===========================================================================

export const GrokEvtPhaseChanged = Schema.Struct({
  type: Schema.Literal("phase_changed"),
  phase: Schema.String,
  ts: Ts,
});
export type GrokEvtPhaseChanged = typeof GrokEvtPhaseChanged.Type;

export const GrokEvtToolStarted = Schema.Struct({
  type: Schema.Literal("tool_started"),
  tool_name: Schema.String,
  ts: Ts,
});
export type GrokEvtToolStarted = typeof GrokEvtToolStarted.Type;

export const GrokEvtToolCompleted = Schema.Struct({
  type: Schema.Literal("tool_completed"),
  tool_name: Schema.String,
  outcome: Schema.optional(Schema.String),
  duration_ms: Schema.optional(Schema.Number),
  ts: Ts,
});
export type GrokEvtToolCompleted = typeof GrokEvtToolCompleted.Type;

export const GrokEvtPermissionRequested = Schema.Struct({
  type: Schema.Literal("permission_requested"),
  tool_name: Schema.optional(Schema.String),
  ts: Ts,
});
export type GrokEvtPermissionRequested = typeof GrokEvtPermissionRequested.Type;

export const GrokEvtPermissionResolved = Schema.Struct({
  type: Schema.Literal("permission_resolved"),
  tool_name: Schema.optional(Schema.String),
  decision: Schema.optional(Schema.String),
  wait_ms: Schema.optional(Schema.Number),
  ts: Ts,
});
export type GrokEvtPermissionResolved = typeof GrokEvtPermissionResolved.Type;

export const GrokEvtLoopStarted = Schema.Struct({
  type: Schema.Literal("loop_started"),
  loop_index: Schema.optional(Schema.Number),
  ts: Ts,
});
export type GrokEvtLoopStarted = typeof GrokEvtLoopStarted.Type;

export const GrokEvtFirstToken = Schema.Struct({
  type: Schema.Literal("first_token"),
  ts: Ts,
});
export type GrokEvtFirstToken = typeof GrokEvtFirstToken.Type;

export const GrokEvtTurnStarted = Schema.Struct({
  type: Schema.Literal("turn_started"),
  session_id: Schema.optional(Schema.String),
  turn_number: Schema.optional(Schema.Number),
  model_id: Schema.optional(Schema.String),
  yolo_mode: Schema.optional(Schema.Boolean),
  conversation_message_count: Schema.optional(Schema.Number),
  session_relationship: Schema.optional(Schema.String),
  schema_version: Schema.optional(Schema.String),
  ts: Ts,
});
export type GrokEvtTurnStarted = typeof GrokEvtTurnStarted.Type;

export const GrokEvtTurnEnded = Schema.Struct({
  type: Schema.Literal("turn_ended"),
  outcome: Schema.optional(Schema.String),
  ts: Ts,
});
export type GrokEvtTurnEnded = typeof GrokEvtTurnEnded.Type;

export const GrokEvtYoloToggled = Schema.Struct({
  type: Schema.Literal("yolo_toggled"),
  enabled: Schema.optional(Schema.Boolean),
  ts: Ts,
});
export type GrokEvtYoloToggled = typeof GrokEvtYoloToggled.Type;

export const GrokEvtMcpServerStarting = Schema.Struct({
  type: Schema.Literal("mcp_server_starting"),
  server_name: Schema.optional(Schema.String),
  target: Schema.optional(Schema.String),
  transport: Schema.optional(Schema.String),
  timeout_sec: Schema.optional(Schema.Number),
  ts: Ts,
});
export type GrokEvtMcpServerStarting = typeof GrokEvtMcpServerStarting.Type;

export const GrokEvtMcpServerFailed = Schema.Struct({
  type: Schema.Literal("mcp_server_failed"),
  server_name: Schema.optional(Schema.String),
  target: Schema.optional(Schema.String),
  transport: Schema.optional(Schema.String),
  error_message: Schema.optional(Schema.String),
  error_type: Schema.optional(Schema.String),
  duration_ms: Schema.optional(Schema.Number),
  timeout_sec: Schema.optional(Schema.Number),
  ts: Ts,
});
export type GrokEvtMcpServerFailed = typeof GrokEvtMcpServerFailed.Type;

export const GrokEvtMcpServerConnected = Schema.Struct({
  type: Schema.Literal("mcp_server_connected"),
  server_name: Schema.optional(Schema.String),
  transport: Schema.optional(Schema.String),
  tool_count: Schema.optional(Schema.Number),
  tools: Schema.optional(Schema.Unknown),
  duration_ms: Schema.optional(Schema.Number),
  ts: Ts,
});
export type GrokEvtMcpServerConnected = typeof GrokEvtMcpServerConnected.Type;

export const GrokEvtMcpManagedConfigResult = Schema.Struct({
  type: Schema.Literal("mcp_managed_config_result"),
  server_count: Schema.optional(Schema.Number),
  ts: Ts,
});
export type GrokEvtMcpManagedConfigResult = typeof GrokEvtMcpManagedConfigResult.Type;

export const GrokEvtMcpConfigResolved = Schema.Struct({
  type: Schema.Literal("mcp_config_resolved"),
  servers: Schema.optional(Schema.Unknown),
  disabled: Schema.optional(Schema.Unknown),
  ts: Ts,
});
export type GrokEvtMcpConfigResolved = typeof GrokEvtMcpConfigResolved.Type;

export const GrokEvtMcpInitCompleted = Schema.Struct({
  type: Schema.Literal("mcp_init_completed"),
  auth_required: Schema.optional(Schema.Unknown),
  failed: Schema.optional(Schema.Number),
  failed_servers: Schema.optional(Schema.Unknown),
  succeeded: Schema.optional(Schema.Number),
  total_servers: Schema.optional(Schema.Number),
  total_tools: Schema.optional(Schema.Number),
  is_reinit: Schema.optional(Schema.Boolean),
  duration_ms: Schema.optional(Schema.Number),
  ts: Ts,
});
export type GrokEvtMcpInitCompleted = typeof GrokEvtMcpInitCompleted.Type;

export const GrokEvtMcpToolCallStarted = Schema.Struct({
  type: Schema.Literal("mcp_tool_call_started"),
  server_name: Schema.optional(Schema.String),
  tool_name: Schema.String,
  call_id: Schema.optional(Schema.String),
  timeout_sec: Schema.optional(Schema.Number),
  ts: Ts,
});
export type GrokEvtMcpToolCallStarted = typeof GrokEvtMcpToolCallStarted.Type;

export const GrokEvtMcpToolCallCompleted = Schema.Struct({
  type: Schema.Literal("mcp_tool_call_completed"),
  server_name: Schema.optional(Schema.String),
  tool_name: Schema.String,
  call_id: Schema.optional(Schema.String),
  success: Schema.optional(Schema.Boolean),
  is_timeout: Schema.optional(Schema.Boolean),
  reconnect_attempted: Schema.optional(Schema.Boolean),
  auth_retry_attempted: Schema.optional(Schema.Boolean),
  duration_ms: Schema.optional(Schema.Number),
  ts: Ts,
});
export type GrokEvtMcpToolCallCompleted = typeof GrokEvtMcpToolCallCompleted.Type;

export const GrokEvtMcpOauthDiscoveryTimeout = Schema.Struct({
  type: Schema.Literal("mcp_oauth_discovery_timeout"),
  server_name: Schema.optional(Schema.String),
  url: Schema.optional(Schema.String),
  ts: Ts,
});
export type GrokEvtMcpOauthDiscoveryTimeout = typeof GrokEvtMcpOauthDiscoveryTimeout.Type;

// ===========================================================================
// 4. updates.jsonl — ACP session/update stream (8 sessionUpdate subtypes)
// ===========================================================================

/** Envelope: `{method, params:{sessionId, update:{sessionUpdate, ...}}}`. */
const grokUpdateSubtype = (record: unknown): string | undefined => {
  if (record === null || typeof record !== "object") return undefined;
  const params = (record as Record<string, unknown>).params;
  if (params === null || typeof params !== "object") return undefined;
  const update = (params as Record<string, unknown>).update;
  if (update === null || typeof update !== "object") return undefined;
  const sub = (update as Record<string, unknown>).sessionUpdate;
  return typeof sub === "string" ? sub : undefined;
};

const GrokUpdateMethod = Schema.Literal("session/update", "_x.ai/session/update");

const updateEnvelope = <S extends string>(sessionUpdate: S, extra: Schema.Struct.Fields) =>
  Schema.Struct({
    method: GrokUpdateMethod,
    timestamp: Schema.optional(Schema.Number),
    params: Schema.Struct({
      sessionId: Schema.optional(Schema.String),
      update: Schema.Struct({
        sessionUpdate: Schema.Literal(sessionUpdate),
        ...extra,
      }),
    }),
  });

export const GrokUpdToolCall = updateEnvelope("tool_call", {
  toolCallId: Schema.optional(Schema.String),
  title: Schema.optional(Schema.String),
  rawInput: Schema.optional(Schema.Unknown),
  kind: Schema.optional(Schema.String),
});
export const GrokUpdToolCallUpdate = updateEnvelope("tool_call_update", {
  toolCallId: Schema.optional(Schema.String),
  title: Schema.optional(Schema.String),
  rawInput: Schema.optional(Schema.Unknown),
  kind: Schema.optional(Schema.String),
  locations: Schema.optional(Schema.Unknown),
});
export const GrokUpdAvailableCommands = updateEnvelope("available_commands_update", {
  availableCommands: Schema.optional(Schema.Unknown),
});
export const GrokUpdAgentThoughtChunk = updateEnvelope("agent_thought_chunk", {
  content: Schema.optional(Schema.Unknown),
});
export const GrokUpdAgentMessageChunk = updateEnvelope("agent_message_chunk", {
  content: Schema.optional(Schema.Unknown),
});
export const GrokUpdUserMessageChunk = updateEnvelope("user_message_chunk", {
  content: Schema.optional(Schema.Unknown),
});
export const GrokUpdRetryState = updateEnvelope("retry_state", {
  type: Schema.optional(Schema.String),
  attempt: Schema.optional(Schema.Number),
  max_retries: Schema.optional(Schema.Number),
  reason: Schema.optional(Schema.String),
});
export const GrokUpdTaskBackgrounded = updateEnvelope("task_backgrounded", {
  type: Schema.optional(Schema.String),
  task_id: Schema.optional(Schema.String),
  tool_call_id: Schema.optional(Schema.String),
  command: Schema.optional(Schema.Unknown),
  cwd: Schema.optional(Schema.String),
  output_file: Schema.optional(Schema.String),
});
export const GrokUpdPlan = updateEnvelope("plan", {
  entries: Schema.optional(Schema.Unknown),
});
export const GrokUpdCurrentMode = updateEnvelope("current_mode_update", {
  currentModeId: Schema.optional(Schema.String),
});
export const GrokUpdAutoCompactStarted = updateEnvelope("auto_compact_started", {
  reason: Schema.optional(Schema.String),
  context_window: Schema.optional(Schema.Number),
  tokens_used: Schema.optional(Schema.Number),
  percentage: Schema.optional(Schema.Number),
});
export const GrokUpdAutoCompactCompleted = updateEnvelope("auto_compact_completed", {
  elapsed_ms: Schema.optional(Schema.Number),
  tokens_before: Schema.optional(Schema.Number),
  tokens_after: Schema.optional(Schema.Number),
  // Observed null when no summary was produced.
  summary_preview: Schema.optional(Schema.NullOr(Schema.String)),
});
export const GrokUpdCompactionCheckpoint = updateEnvelope("compaction_checkpoint", {
  checkpoint_id: Schema.optional(Schema.String),
  checkpoint_file: Schema.optional(Schema.String),
  created_at: Schema.optional(Schema.Unknown),
  prompt_index_at_compaction: Schema.optional(Schema.Number),
  // Observed as a numeric version on disk (e.g. 1), not a string.
  schema_version: Schema.optional(Schema.Union(Schema.Number, Schema.String)),
});
export const GrokUpdTaskCompleted = updateEnvelope("task_completed", {
  task_snapshot: Schema.optional(Schema.Unknown),
});
export const GrokUpdSubagentSpawned = updateEnvelope("subagent_spawned", {
  subagent_id: Schema.optional(Schema.String),
  subagent_type: Schema.optional(Schema.String),
  child_session_id: Schema.optional(Schema.String),
  parent_session_id: Schema.optional(Schema.String),
  parent_prompt_id: Schema.optional(Schema.String),
  description: Schema.optional(Schema.String),
  model: Schema.optional(Schema.String),
  effective_context_source: Schema.optional(Schema.Unknown),
});
export const GrokUpdSubagentFinished = updateEnvelope("subagent_finished", {
  subagent_id: Schema.optional(Schema.String),
  child_session_id: Schema.optional(Schema.String),
  status: Schema.optional(Schema.String),
  output: Schema.optional(Schema.Unknown),
  duration_ms: Schema.optional(Schema.Number),
  tokens_used: Schema.optional(Schema.Number),
  tool_calls: Schema.optional(Schema.Unknown),
  turns: Schema.optional(Schema.Number),
});

// ===========================================================================
// 5. hunk_records.jsonl — edit-hunk artifact stream (3 record types)
// ===========================================================================

const hunkBase = {
  hunkId: Schema.optional(Schema.String),
  filePath: Schema.optional(Schema.String),
  hunkStart: Schema.optional(Schema.Number),
  hunkEnd: Schema.optional(Schema.Number),
  linesAdded: Schema.optional(Schema.Number),
  linesRemoved: Schema.optional(Schema.Number),
  agentId: Schema.optional(Schema.String),
  sessionId: Schema.optional(Schema.String),
  timestamp: Schema.optional(Schema.Unknown),
} as const;

export const GrokHunkAdded = Schema.Struct({
  eventType: Schema.Literal("added"),
  authorId: Schema.optional(Schema.String),
  authorType: Schema.optional(Schema.String),
  sourceType: Schema.optional(Schema.String),
  ...hunkBase,
});
export const GrokHunkUpdated = Schema.Struct({
  eventType: Schema.Literal("updated"),
  authorId: Schema.optional(Schema.String),
  authorType: Schema.optional(Schema.String),
  sourceType: Schema.optional(Schema.String),
  promptIndex: Schema.optional(Schema.Number),
  ...hunkBase,
});
export const GrokHunkRemoved = Schema.Struct({
  eventType: Schema.Literal("removed"),
  removalReason: Schema.optional(Schema.String),
  ...hunkBase,
});
export type GrokHunk =
  | typeof GrokHunkAdded.Type
  | typeof GrokHunkUpdated.Type
  | typeof GrokHunkRemoved.Type;

// ===========================================================================
// 6. summary.json — per-session metadata (1 record type)
// ===========================================================================

export const GrokSummary = Schema.Struct({
  agent_name: Schema.optional(Schema.String),
  current_model_id: Schema.optional(Schema.String),
  generated_title: Schema.optional(Schema.String),
  session_summary: Schema.optional(Schema.Unknown),
  session_kind: Schema.optional(Schema.String),
  chat_format_version: Schema.optional(Schema.Unknown),
  created_at: Schema.optional(Schema.Unknown),
  updated_at: Schema.optional(Schema.Unknown),
  last_active_at: Schema.optional(Schema.Unknown),
  git_remotes: Schema.optional(Schema.Unknown),
  git_root_dir: Schema.optional(Schema.String),
  grok_home: Schema.optional(Schema.String),
  head_branch: Schema.optional(Schema.String),
  head_commit: Schema.optional(Schema.String),
  num_chat_messages: Schema.optional(Schema.Number),
  num_messages: Schema.optional(Schema.Number),
  next_trace_turn: Schema.optional(Schema.Unknown),
  request_id: Schema.optional(Schema.String),
  sandbox_profile: Schema.optional(Schema.Unknown),
  info: Schema.optional(Schema.Unknown),
});
export type GrokSummary = typeof GrokSummary.Type;

// ===========================================================================
// Declarative signal/drop dispatch tables
// ===========================================================================

/**
 * A per-record-type classifier entry: the Effect Schema to decode against, and
 * the EXPLICIT outcome — either a mapped `SessionEventKind` (SIGNAL) or a NAMED
 * drop reason (DROP). There is no third option; nothing falls through.
 */
type ChatEntry =
  | { readonly schema: Schema.Schema<any, any>; readonly kind: SessionEventKind }
  | { readonly schema: Schema.Schema<any, any>; readonly dropReason: string };

/**
 * chat_history.jsonl declarative dispatch. Note `reasoning` is dynamic: a record
 * carrying a plaintext `summary[].text` is SIGNAL `reasoning`; a purely-encrypted
 * record is DROP `encrypted_reasoning` (decided in `classifyGrokChat`).
 */
const CHAT_TABLE: Record<string, ChatEntry> = {
  user: { schema: GrokChatUser, kind: "message" },
  assistant: { schema: GrokChatAssistant, kind: "message" },
  tool_result: { schema: GrokChatToolResult, kind: "tool_result" },
  system: { schema: GrokChatSystem, kind: "system" },
  backend_tool_call: { schema: GrokChatBackendToolCall, kind: "tool_call" },
};

/** events.jsonl declarative dispatch — every telemetry type explicitly placed. */
const EVENT_TABLE: Record<string, ChatEntry> = {
  // Signal: real tool activity becomes tool_call / tool_result.
  tool_started: { schema: GrokEvtToolStarted, kind: "tool_call" },
  tool_completed: { schema: GrokEvtToolCompleted, kind: "tool_result" },
  mcp_tool_call_started: { schema: GrokEvtMcpToolCallStarted, kind: "tool_call" },
  mcp_tool_call_completed: { schema: GrokEvtMcpToolCallCompleted, kind: "tool_result" },
  // Signal: turn boundaries are lifecycle markers worth keeping.
  turn_started: { schema: GrokEvtTurnStarted, kind: "lifecycle" },
  turn_ended: { schema: GrokEvtTurnEnded, kind: "lifecycle" },
  // Drop: high-frequency UI/telemetry noise with NAMED reasons.
  phase_changed: { schema: GrokEvtPhaseChanged, dropReason: "ui_phase_telemetry" },
  first_token: { schema: GrokEvtFirstToken, dropReason: "stream_timing_telemetry" },
  loop_started: { schema: GrokEvtLoopStarted, dropReason: "loop_timing_telemetry" },
  yolo_toggled: { schema: GrokEvtYoloToggled, dropReason: "ui_mode_toggle" },
  permission_requested: { schema: GrokEvtPermissionRequested, dropReason: "permission_telemetry" },
  permission_resolved: { schema: GrokEvtPermissionResolved, dropReason: "permission_telemetry" },
  // Drop: MCP server lifecycle / config telemetry (not conversation).
  mcp_server_starting: { schema: GrokEvtMcpServerStarting, dropReason: "mcp_lifecycle_telemetry" },
  mcp_server_failed: { schema: GrokEvtMcpServerFailed, dropReason: "mcp_lifecycle_telemetry" },
  mcp_server_connected: { schema: GrokEvtMcpServerConnected, dropReason: "mcp_lifecycle_telemetry" },
  mcp_managed_config_result: { schema: GrokEvtMcpManagedConfigResult, dropReason: "mcp_config_telemetry" },
  mcp_config_resolved: { schema: GrokEvtMcpConfigResolved, dropReason: "mcp_config_telemetry" },
  mcp_init_completed: { schema: GrokEvtMcpInitCompleted, dropReason: "mcp_config_telemetry" },
  mcp_oauth_discovery_timeout: { schema: GrokEvtMcpOauthDiscoveryTimeout, dropReason: "mcp_oauth_telemetry" },
};

/** updates.jsonl declarative dispatch keyed by `update.sessionUpdate`. */
const UPDATE_TABLE: Record<string, ChatEntry> = {
  tool_call: { schema: GrokUpdToolCall, kind: "tool_call" },
  tool_call_update: { schema: GrokUpdToolCallUpdate, kind: "tool_result" },
  agent_thought_chunk: { schema: GrokUpdAgentThoughtChunk, kind: "reasoning" },
  agent_message_chunk: { schema: GrokUpdAgentMessageChunk, kind: "message" },
  user_message_chunk: { schema: GrokUpdUserMessageChunk, kind: "message" },
  retry_state: { schema: GrokUpdRetryState, kind: "lifecycle" },
  task_backgrounded: { schema: GrokUpdTaskBackgrounded, kind: "lifecycle" },
  task_completed: { schema: GrokUpdTaskCompleted, kind: "lifecycle" },
  subagent_spawned: { schema: GrokUpdSubagentSpawned, kind: "lifecycle" },
  subagent_finished: { schema: GrokUpdSubagentFinished, kind: "lifecycle" },
  auto_compact_started: { schema: GrokUpdAutoCompactStarted, kind: "lifecycle" },
  auto_compact_completed: { schema: GrokUpdAutoCompactCompleted, kind: "summary" },
  compaction_checkpoint: { schema: GrokUpdCompactionCheckpoint, kind: "lifecycle" },
  // The agent's TODO plan is conversation-relevant content.
  plan: { schema: GrokUpdPlan, kind: "message" },
  // Drop: command palette + mode toggle are editor UI state, not conversation.
  available_commands_update: { schema: GrokUpdAvailableCommands, dropReason: "command_palette_ui" },
  current_mode_update: { schema: GrokUpdCurrentMode, dropReason: "ui_mode_toggle" },
};

/** hunk_records.jsonl declarative dispatch keyed by `eventType`. */
const HUNK_TABLE: Record<string, ChatEntry> = {
  added: { schema: GrokHunkAdded, kind: "edit" },
  updated: { schema: GrokHunkUpdated, kind: "edit" },
  removed: { schema: GrokHunkRemoved, kind: "edit" },
};

// ===========================================================================
// Classifier core: decode-or-drop with named diagnostics, zero passthrough
// ===========================================================================

const classifyWithTable = (
  table: Record<string, ChatEntry>,
  discriminator: string | undefined,
  record: unknown,
  diagnostics?: DecodeDiagnostic[],
): SignalDecision<unknown, SessionEventKind> => {
  if (discriminator === undefined) {
    diagnostics?.push({ name: GROK_UNKNOWN_TYPE, message: "record has no discriminator" });
    return drop(`${GROK_UNKNOWN_TYPE}: missing discriminator`);
  }
  const entry = table[discriminator];
  if (entry === undefined) {
    diagnostics?.push({ name: GROK_UNKNOWN_TYPE, message: `unknown record type "${discriminator}"` });
    return drop(`${GROK_UNKNOWN_TYPE}: ${discriminator}`);
  }
  // Drop entries still decode (fail-closed): a malformed drop record is a NAMED
  // decode failure, not a silent skip.
  const decision = decodeOrDrop(entry.schema, record, {
    kind: "kind" in entry ? entry.kind : ("unknown" as SessionEventKind),
    diagnosticName: GROK_DECODE_FAILED,
    ...(diagnostics !== undefined ? { diagnostics } : {}),
  });
  if (!isSignal(decision)) return decision;
  if ("dropReason" in entry) return drop(`grok.drop.${entry.dropReason}`);
  return decision;
};

/** Read a string `type` discriminator off an arbitrary record. */
const typeOf = (record: unknown): string | undefined =>
  record !== null && typeof record === "object" && typeof (record as Record<string, unknown>).type === "string"
    ? ((record as Record<string, unknown>).type as string)
    : undefined;

/** Read a string `eventType` discriminator off an arbitrary record. */
const eventTypeOf = (record: unknown): string | undefined =>
  record !== null && typeof record === "object" && typeof (record as Record<string, unknown>).eventType === "string"
    ? ((record as Record<string, unknown>).eventType as string)
    : undefined;

// ---------------------------------------------------------------------------
// Public per-file classifiers (the adapter calls ONLY these)
// ---------------------------------------------------------------------------

/**
 * Classify a chat_history.jsonl record. `reasoning` is special-cased: keep the
 * plaintext summary as SIGNAL `reasoning`, DROP the purely-encrypted body with a
 * NAMED reason. Everything else flows through the declarative table.
 */
export const classifyGrokChat = (
  record: unknown,
  diagnostics?: DecodeDiagnostic[],
): SignalDecision<unknown, SessionEventKind> => {
  const type = typeOf(record);
  if (type === "reasoning") {
    const decision = decodeOrDrop(GrokChatReasoning, record, {
      kind: "reasoning" as SessionEventKind,
      diagnosticName: GROK_DECODE_FAILED,
      ...(diagnostics !== undefined ? { diagnostics } : {}),
    });
    if (!isSignal(decision)) return decision;
    const value = decision.value as GrokChatReasoning;
    const summaryText = value.summary?.map((s) => s.text ?? "").join("").trim();
    if (summaryText !== undefined && summaryText.length > 0) {
      return signal("reasoning" as SessionEventKind, value);
    }
    return drop("grok.drop.encrypted_reasoning");
  }
  return classifyWithTable(CHAT_TABLE, type, record, diagnostics);
};

/** Classify an events.jsonl record. */
export const classifyGrokEvent = (
  record: unknown,
  diagnostics?: DecodeDiagnostic[],
): SignalDecision<unknown, SessionEventKind> =>
  classifyWithTable(EVENT_TABLE, typeOf(record), record, diagnostics);

/** Classify an updates.jsonl record (keyed by `update.sessionUpdate`). */
export const classifyGrokUpdate = (
  record: unknown,
  diagnostics?: DecodeDiagnostic[],
): SignalDecision<unknown, SessionEventKind> =>
  classifyWithTable(UPDATE_TABLE, grokUpdateSubtype(record), record, diagnostics);

/** Classify a hunk_records.jsonl record (keyed by `eventType`). */
export const classifyGrokHunk = (
  record: unknown,
  diagnostics?: DecodeDiagnostic[],
): SignalDecision<unknown, SessionEventKind> =>
  classifyWithTable(HUNK_TABLE, eventTypeOf(record), record, diagnostics);

/**
 * Decode summary.json fail-closed. Returns the typed summary on success;
 * undefined + named diagnostic on failure (ingest continues with no metadata).
 */
export const decodeGrokSummary = (
  record: unknown,
  diagnostics?: DecodeDiagnostic[],
): GrokSummary | undefined => {
  const decision = decodeOrDrop(GrokSummary, record, {
    kind: "summary",
    diagnosticName: GROK_DECODE_FAILED,
    ...(diagnostics !== undefined ? { diagnostics } : {}),
  });
  return isSignal(decision) ? (decision.value as GrokSummary) : undefined;
};

/**
 * Decode one subagent manifest fail-closed. On success returns the typed
 * manifest; on failure pushes a named `grok.record.decode_failed` diagnostic and
 * returns `undefined` (the dropped record), never throwing.
 */
export const decodeGrokSubagentManifest = (
  record: unknown,
  diagnostics?: DecodeDiagnostic[],
): GrokSubagentManifest | undefined => {
  const decision = decodeOrDrop(GrokSubagentManifest, record, {
    kind: "subagent_of",
    diagnosticName: GROK_DECODE_FAILED,
    ...(diagnostics !== undefined ? { diagnostics } : {}),
  });
  return isSignal(decision) ? (decision.value as GrokSubagentManifest) : undefined;
};
