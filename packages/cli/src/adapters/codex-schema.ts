import { ParseResult, Schema } from "effect";

import {
  type SignalDecision,
  drop,
  signal,
} from "./harness-schema";
import type { SessionEventKind } from "../core/schemas";

/**
 * QSR-220 FULL DATA FIDELITY — codex.
 *
 * The ENTIRE on-disk codex rollout format is modeled here as rigorous,
 * fail-closed Effect Schemas, one per distinct record type, unified under a
 * single discriminated registry. The adapter routes EVERY provider record
 * through `classifyCodexRecord`, which decodes the record against its modeled
 * schema and returns a DECLARATIVE verdict: either SIGNAL (kept, with the
 * harness-mapped `SessionEventKind`) or DROP (discarded, with a NAMED reason).
 *
 * There is no `unknown` pass-through. A record whose discriminator is not in the
 * registry is an explicit DROP under `codex.unknown_record_type`; a record that
 * matches a known discriminator but fails its schema is an explicit DROP under
 * that type's `codex.<type>.decode_failed` name (a named, attributable
 * diagnostic — never a throw, never a silent coercion). "Data structures are the
 * project; a model rambling must never be mistaken for a legitimate response."
 *
 * Grounded 2026-06-21 against the real on-disk corpus (~/.codex/sessions/**,
 * ~/.codex/archived_sessions/**). The distinct record types (top-level `type`,
 * and for `response_item`/`event_msg` the `payload.type`) measured there:
 *
 *   top-level : session_meta, compacted, turn_context
 *   response_item.* : message, function_call, function_call_output,
 *     custom_tool_call, custom_tool_call_output, reasoning, local_shell_call,
 *     local_shell_call_output, web_search_call, tool_search_call,
 *     tool_search_output
 *   event_msg.* : token_count, agent_message, user_message, task_started,
 *     task_complete, turn_aborted, exec_command_end, patch_apply_end,
 *     mcp_tool_call_end, web_search_end, thread_goal_updated, context_compacted,
 *     item_completed, thread_name_updated, collab_agent_spawn_end,
 *     collab_waiting_end, error
 *
 * Signal-vs-drop decisions (every type is EXPLICIT):
 *  - message            -> signal message  (preamble for injected wrappers; the
 *                          adapter refines the wrapper sub-case locally)
 *  - function_call /
 *    local_shell_call /
 *    custom_tool_call /
 *    web_search_call /
 *    tool_search_call   -> signal tool_call
 *  - function_call_output /
 *    local_shell_call_output /
 *    custom_tool_call_output /
 *    tool_search_output -> signal tool_result   (FIX: tool_search_output was
 *                          previously misclassified as tool_call)
 *  - reasoning          -> signal reasoning
 *  - token_count        -> signal usage
 *  - agent_message      -> signal message (preamble for commentary; refined
 *                          locally by the adapter)
 *  - user_message       -> signal message
 *  - task_started /
 *    task_complete /
 *    turn_aborted        -> signal lifecycle
 *  - mcp_tool_call_end   -> signal tool_result  (dual carrier: merged by call_id
 *                          with function_call_output; collapses the 60% duplicate,
 *                          standalone only in the 40% sole-carrier case)
 *  - session_meta        -> signal system
 *  - compacted (top)     -> signal summary      (FIX: was unknown pass-through)
 *  - turn_context (top)  -> drop  codex.turn_context.provider_bookkeeping
 *  - exec_command_end    -> drop  codex.event_msg.exec_command_end.provider_bookkeeping
 *  - patch_apply_end     -> drop  codex.event_msg.patch_apply_end.provider_bookkeeping
 *  - thread_goal_updated -> drop  codex.event_msg.thread_goal_updated.provider_bookkeeping
 *  - thread_name_updated -> drop  codex.event_msg.thread_name_updated.provider_bookkeeping
 *  - item_completed      -> drop  codex.event_msg.item_completed.provider_bookkeeping
 *  - context_compacted   -> drop  codex.event_msg.context_compacted.provider_bookkeeping
 *  - web_search_end      -> drop  codex.event_msg.web_search_end.provider_bookkeeping
 *                          (bookkeeping echo of response_item.web_search_call)
 *  - collab_agent_spawn_end /
 *    collab_waiting_end  -> drop  codex.event_msg.<type>.provider_bookkeeping
 *                          (subagent lineage is sourced from session_meta, not
 *                          from these spawn echoes — never regress that)
 *  - error               -> drop  codex.event_msg.error.provider_bookkeeping
 */

// ---------------------------------------------------------------------------
// session_meta — the first JSON record of every rollout-*.jsonl file.
//
// The load-bearing fields are `type` (literal `session_meta`) and `payload.id`
// (the bare UUIDv7 = the codex native session id). Subagent lineage AND agent
// identity both live under `payload.source.subagent.thread_spawn`: the parent
// native id at `thread_spawn.parent_thread_id`, the agent identity at
// `thread_spawn.agent_nickname` (preferred) / `thread_spawn.agent_role`
// (fallback), alongside `agent_path` / `depth`. Grounded 2026-06-21 against all
// 517 subagent rollouts on disk: every one carries these under `thread_spawn`,
// NOT at the subagent level. These are present ONLY on subagent rollouts; a
// main-session rollout carries no `source.subagent`, admitted by leaving the
// branch optional/nullable.
// ---------------------------------------------------------------------------

/**
 * The `thread_spawn` block on a subagent rollout. Carries the parent native id
 * AND the spawned agent's identity (nickname/role/path/depth) — the real
 * on-disk location for all of these (measured: all 517 subagent rollouts).
 */
const CodexThreadSpawnSchema = Schema.Struct({
  // The parent rollout's native id (its session_meta.payload.id). Present on
  // subagent rollouts; this is the SESSION-to-SESSION lineage signal.
  parent_thread_id: Schema.optional(Schema.NullOr(Schema.String)),
  // Human-readable nickname for the spawned agent; the preferred agentName.
  agent_nickname: Schema.optional(Schema.NullOr(Schema.String)),
  // Structural role; the agentName fallback when no nickname is present.
  agent_role: Schema.optional(Schema.NullOr(Schema.String)),
  // Path to the spawned agent's definition; provenance, modeled for fidelity.
  agent_path: Schema.optional(Schema.NullOr(Schema.String)),
  // Spawn depth in the subagent tree; provenance, modeled for fidelity.
  depth: Schema.optional(Schema.NullOr(Schema.Number)),
});

/**
 * The `subagent` block: the thread_spawn lineage + identity pointer. The
 * agent_nickname/agent_role kept here are a SECONDARY fallback only — the real
 * on-disk carrier is thread_spawn (see CodexThreadSpawnSchema).
 */
const CodexSubagentSchema = Schema.Struct({
  // Secondary fallback for the nickname; the canonical carrier is thread_spawn.
  agent_nickname: Schema.optional(Schema.NullOr(Schema.String)),
  // Secondary fallback for the role; the canonical carrier is thread_spawn.
  agent_role: Schema.optional(Schema.NullOr(Schema.String)),
  thread_spawn: Schema.optional(Schema.NullOr(CodexThreadSpawnSchema)),
});

/** The `source` block on the session_meta payload (cli/subagent provenance). */
const CodexSourceSchema = Schema.Struct({
  subagent: Schema.optional(Schema.NullOr(CodexSubagentSchema)),
});

const CodexSessionMetaPayloadSchema = Schema.Struct({
  // payload.id is the bare UUIDv7 — the load-bearing native session id.
  id: Schema.String,
  timestamp: Schema.optional(Schema.NullOr(Schema.String)),
  cwd: Schema.optional(Schema.NullOr(Schema.String)),
  working_dir: Schema.optional(Schema.NullOr(Schema.String)),
  originator: Schema.optional(Schema.NullOr(Schema.String)),
  cli_version: Schema.optional(Schema.NullOr(Schema.String)),
  source: Schema.optional(Schema.NullOr(CodexSourceSchema)),
});

export const CodexSessionMetaSchema = Schema.Struct({
  // The record discriminator — must be the literal session_meta.
  type: Schema.Literal("session_meta"),
  timestamp: Schema.optional(Schema.NullOr(Schema.String)),
  payload: CodexSessionMetaPayloadSchema,
});

export type CodexSessionMeta = typeof CodexSessionMetaSchema.Type;

/** Stable diagnostic name for a session_meta that fails the schema. */
export const CODEX_SESSION_META_DECODE_FAILED = "codex.session_meta.decode_failed";

// ---------------------------------------------------------------------------
// Shared building blocks.
// ---------------------------------------------------------------------------

/** A content block inside a message: { type, text? , ... }. */
const CodexMessageContentBlockSchema = Schema.Struct({
  type: Schema.optional(Schema.NullOr(Schema.String)),
  text: Schema.optional(Schema.NullOr(Schema.String)),
});

/** Message content: a string, or an array of typed content blocks. */
const CodexMessageContentSchema = Schema.Union(
  Schema.String,
  Schema.Array(Schema.Union(Schema.String, CodexMessageContentBlockSchema)),
);

/** A flexible record value — used where the codex payload nests free-form JSON. */
const CodexAnyRecord = Schema.Record({ key: Schema.String, value: Schema.Unknown });

// ---------------------------------------------------------------------------
// response_item.* payload schemas.
// ---------------------------------------------------------------------------

const CodexMessagePayloadSchema = Schema.Struct({
  type: Schema.Literal("message"),
  // Measured roles: user, assistant, developer.
  role: Schema.optional(Schema.NullOr(Schema.String)),
  content: Schema.optional(Schema.NullOr(CodexMessageContentSchema)),
});

const CodexFunctionCallPayloadSchema = Schema.Struct({
  type: Schema.Literal("function_call"),
  call_id: Schema.optional(Schema.NullOr(Schema.String)),
  name: Schema.optional(Schema.NullOr(Schema.String)),
  // `arguments` is a JSON-encoded string of the tool input.
  arguments: Schema.optional(Schema.NullOr(Schema.String)),
  namespace: Schema.optional(Schema.NullOr(Schema.String)),
  metadata: Schema.optional(Schema.NullOr(CodexAnyRecord)),
});

const CodexFunctionCallOutputPayloadSchema = Schema.Struct({
  type: Schema.Literal("function_call_output"),
  call_id: Schema.optional(Schema.NullOr(Schema.String)),
  output: Schema.optional(Schema.Unknown),
});

const CodexCustomToolCallPayloadSchema = Schema.Struct({
  type: Schema.Literal("custom_tool_call"),
  call_id: Schema.optional(Schema.NullOr(Schema.String)),
  name: Schema.optional(Schema.NullOr(Schema.String)),
  status: Schema.optional(Schema.NullOr(Schema.String)),
  // custom_tool_call (apply_patch et al.) carries raw text in `input`.
  input: Schema.optional(Schema.Unknown),
  metadata: Schema.optional(Schema.NullOr(CodexAnyRecord)),
});

const CodexCustomToolCallOutputPayloadSchema = Schema.Struct({
  type: Schema.Literal("custom_tool_call_output"),
  call_id: Schema.optional(Schema.NullOr(Schema.String)),
  output: Schema.optional(Schema.Unknown),
});

const CodexLocalShellCallPayloadSchema = Schema.Struct({
  type: Schema.Literal("local_shell_call"),
  call_id: Schema.optional(Schema.NullOr(Schema.String)),
  status: Schema.optional(Schema.NullOr(Schema.String)),
  // local_shell_call carries its exec command record in `action`.
  action: Schema.optional(Schema.Unknown),
});

const CodexLocalShellCallOutputPayloadSchema = Schema.Struct({
  type: Schema.Literal("local_shell_call_output"),
  call_id: Schema.optional(Schema.NullOr(Schema.String)),
  output: Schema.optional(Schema.Unknown),
});

const CodexReasoningPayloadSchema = Schema.Struct({
  type: Schema.Literal("reasoning"),
  summary: Schema.optional(Schema.Unknown),
  // encrypted_content is provider ciphertext; the native projection strips it.
  encrypted_content: Schema.optional(Schema.NullOr(Schema.String)),
  content: Schema.optional(Schema.Unknown),
  metadata: Schema.optional(Schema.NullOr(CodexAnyRecord)),
});

const CodexWebSearchCallPayloadSchema = Schema.Struct({
  type: Schema.Literal("web_search_call"),
  call_id: Schema.optional(Schema.NullOr(Schema.String)),
  status: Schema.optional(Schema.NullOr(Schema.String)),
  action: Schema.optional(Schema.Unknown),
});

const CodexToolSearchCallPayloadSchema = Schema.Struct({
  type: Schema.Literal("tool_search_call"),
  call_id: Schema.optional(Schema.NullOr(Schema.String)),
  status: Schema.optional(Schema.NullOr(Schema.String)),
  execution: Schema.optional(Schema.NullOr(Schema.String)),
  arguments: Schema.optional(Schema.Unknown),
});

const CodexToolSearchOutputPayloadSchema = Schema.Struct({
  type: Schema.Literal("tool_search_output"),
  call_id: Schema.optional(Schema.NullOr(Schema.String)),
  status: Schema.optional(Schema.NullOr(Schema.String)),
  execution: Schema.optional(Schema.NullOr(Schema.String)),
  tools: Schema.optional(Schema.Unknown),
});

// ---------------------------------------------------------------------------
// event_msg.* payload schemas.
// ---------------------------------------------------------------------------

const CodexTokenUsageSchema = Schema.Struct({
  input_tokens: Schema.optional(Schema.NullOr(Schema.Number)),
  cached_input_tokens: Schema.optional(Schema.NullOr(Schema.Number)),
  output_tokens: Schema.optional(Schema.NullOr(Schema.Number)),
  reasoning_output_tokens: Schema.optional(Schema.NullOr(Schema.Number)),
  total_tokens: Schema.optional(Schema.NullOr(Schema.Number)),
});

const CodexTokenCountInfoSchema = Schema.Struct({
  total_token_usage: Schema.optional(Schema.NullOr(CodexTokenUsageSchema)),
  last_token_usage: Schema.optional(Schema.NullOr(CodexTokenUsageSchema)),
  model_context_window: Schema.optional(Schema.NullOr(Schema.Number)),
});

const CodexTokenCountPayloadSchema = Schema.Struct({
  type: Schema.Literal("token_count"),
  info: Schema.optional(Schema.NullOr(CodexTokenCountInfoSchema)),
  rate_limits: Schema.optional(Schema.Unknown),
  model: Schema.optional(Schema.NullOr(Schema.String)),
});

const CodexAgentMessagePayloadSchema = Schema.Struct({
  type: Schema.Literal("agent_message"),
  message: Schema.optional(Schema.NullOr(Schema.String)),
  // phase "commentary" marks injected machinery; the adapter maps it to preamble.
  phase: Schema.optional(Schema.NullOr(Schema.String)),
  memory_citation: Schema.optional(Schema.Unknown),
});

const CodexUserMessagePayloadSchema = Schema.Struct({
  type: Schema.Literal("user_message"),
  message: Schema.optional(Schema.NullOr(Schema.String)),
  images: Schema.optional(Schema.Unknown),
  local_images: Schema.optional(Schema.Unknown),
  text_elements: Schema.optional(Schema.Unknown),
});

const CodexTaskStartedPayloadSchema = Schema.Struct({
  type: Schema.Literal("task_started"),
  turn_id: Schema.optional(Schema.NullOr(Schema.String)),
  started_at: Schema.optional(Schema.NullOr(Schema.Number)),
  model_context_window: Schema.optional(Schema.NullOr(Schema.Number)),
  collaboration_mode_kind: Schema.optional(Schema.NullOr(Schema.String)),
});

const CodexTaskCompletePayloadSchema = Schema.Struct({
  type: Schema.Literal("task_complete"),
  turn_id: Schema.optional(Schema.NullOr(Schema.String)),
  last_agent_message: Schema.optional(Schema.NullOr(Schema.String)),
  completed_at: Schema.optional(Schema.NullOr(Schema.Number)),
  duration_ms: Schema.optional(Schema.NullOr(Schema.Number)),
  time_to_first_token_ms: Schema.optional(Schema.NullOr(Schema.Number)),
});

const CodexTurnAbortedPayloadSchema = Schema.Struct({
  type: Schema.Literal("turn_aborted"),
  turn_id: Schema.optional(Schema.NullOr(Schema.String)),
  reason: Schema.optional(Schema.NullOr(Schema.String)),
  completed_at: Schema.optional(Schema.NullOr(Schema.Number)),
  duration_ms: Schema.optional(Schema.NullOr(Schema.Number)),
});

// mcp_tool_call_end is a DUAL-CARRIER result. Measured 2026-06-21: 60% of
// mcp_tool_call_end records share their `call_id` with a
// response_item.function_call_output that ALSO carries the result — two
// carriers for one logical result. The adapter routes this through the
// call_id-keyed merge (treating `result` as the output) so it COLLAPSES onto
// the existing tool call when a function_call_output with the same call_id
// exists, and only emits a standalone tool result in the 40% sole-carrier case.
const CodexMcpToolCallEndPayloadSchema = Schema.Struct({
  type: Schema.Literal("mcp_tool_call_end"),
  call_id: Schema.optional(Schema.NullOr(Schema.String)),
  invocation: Schema.optional(Schema.Unknown),
  duration: Schema.optional(Schema.Unknown),
  result: Schema.optional(Schema.Unknown),
});

const CodexExecCommandEndPayloadSchema = Schema.Struct({
  type: Schema.Literal("exec_command_end"),
  call_id: Schema.optional(Schema.NullOr(Schema.String)),
  turn_id: Schema.optional(Schema.NullOr(Schema.String)),
  command: Schema.optional(Schema.Unknown),
  exit_code: Schema.optional(Schema.NullOr(Schema.Number)),
  status: Schema.optional(Schema.NullOr(Schema.String)),
});

const CodexPatchApplyEndPayloadSchema = Schema.Struct({
  type: Schema.Literal("patch_apply_end"),
  call_id: Schema.optional(Schema.NullOr(Schema.String)),
  turn_id: Schema.optional(Schema.NullOr(Schema.String)),
  success: Schema.optional(Schema.NullOr(Schema.Boolean)),
  changes: Schema.optional(Schema.Unknown),
});

const CodexWebSearchEndPayloadSchema = Schema.Struct({
  type: Schema.Literal("web_search_end"),
  call_id: Schema.optional(Schema.NullOr(Schema.String)),
  query: Schema.optional(Schema.NullOr(Schema.String)),
  action: Schema.optional(Schema.Unknown),
});

const CodexThreadGoalUpdatedPayloadSchema = Schema.Struct({
  type: Schema.Literal("thread_goal_updated"),
  threadId: Schema.optional(Schema.NullOr(Schema.String)),
  turnId: Schema.optional(Schema.NullOr(Schema.String)),
  goal: Schema.optional(Schema.Unknown),
});

const CodexContextCompactedPayloadSchema = Schema.Struct({
  type: Schema.Literal("context_compacted"),
});

const CodexItemCompletedPayloadSchema = Schema.Struct({
  type: Schema.Literal("item_completed"),
  thread_id: Schema.optional(Schema.NullOr(Schema.String)),
  turn_id: Schema.optional(Schema.NullOr(Schema.String)),
  item: Schema.optional(Schema.Unknown),
  completed_at_ms: Schema.optional(Schema.NullOr(Schema.Number)),
});

const CodexThreadNameUpdatedPayloadSchema = Schema.Struct({
  type: Schema.Literal("thread_name_updated"),
  thread_id: Schema.optional(Schema.NullOr(Schema.String)),
  thread_name: Schema.optional(Schema.NullOr(Schema.String)),
});

const CodexCollabAgentSpawnEndPayloadSchema = Schema.Struct({
  type: Schema.Literal("collab_agent_spawn_end"),
  call_id: Schema.optional(Schema.NullOr(Schema.String)),
  sender_thread_id: Schema.optional(Schema.NullOr(Schema.String)),
  new_thread_id: Schema.optional(Schema.NullOr(Schema.String)),
  new_agent_nickname: Schema.optional(Schema.NullOr(Schema.String)),
  new_agent_role: Schema.optional(Schema.NullOr(Schema.String)),
  prompt: Schema.optional(Schema.NullOr(Schema.String)),
  model: Schema.optional(Schema.NullOr(Schema.String)),
  status: Schema.optional(Schema.NullOr(Schema.String)),
});

const CodexCollabWaitingEndPayloadSchema = Schema.Struct({
  type: Schema.Literal("collab_waiting_end"),
  sender_thread_id: Schema.optional(Schema.NullOr(Schema.String)),
  call_id: Schema.optional(Schema.NullOr(Schema.String)),
  agent_statuses: Schema.optional(Schema.Unknown),
  statuses: Schema.optional(Schema.Unknown),
});

const CodexErrorPayloadSchema = Schema.Struct({
  type: Schema.Literal("error"),
  message: Schema.optional(Schema.NullOr(Schema.String)),
  codex_error_info: Schema.optional(Schema.NullOr(Schema.String)),
});

// ---------------------------------------------------------------------------
// Top-level record envelopes (the discriminator is the top-level `type`).
//
// `response_item` and `event_msg` are envelopes whose meaningful discriminator
// is `payload.type`; `session_meta`, `compacted`, and `turn_context` carry their
// semantics directly at the top level.
// ---------------------------------------------------------------------------

const CodexCompactedPayloadSchema = Schema.Struct({
  message: Schema.optional(Schema.Unknown),
  replacement_history: Schema.optional(Schema.Unknown),
});

export const CodexCompactedSchema = Schema.Struct({
  type: Schema.Literal("compacted"),
  timestamp: Schema.optional(Schema.NullOr(Schema.String)),
  payload: Schema.optional(Schema.NullOr(CodexCompactedPayloadSchema)),
});

const CodexTurnContextPayloadSchema = Schema.Struct({
  turn_id: Schema.optional(Schema.NullOr(Schema.String)),
  cwd: Schema.optional(Schema.NullOr(Schema.String)),
  model: Schema.optional(Schema.NullOr(Schema.String)),
  approval_policy: Schema.optional(Schema.NullOr(Schema.String)),
});

export const CodexTurnContextSchema = Schema.Struct({
  type: Schema.Literal("turn_context"),
  timestamp: Schema.optional(Schema.NullOr(Schema.String)),
  payload: Schema.optional(Schema.NullOr(CodexTurnContextPayloadSchema)),
});

// ---------------------------------------------------------------------------
// Declarative signal/drop dispatch.
//
// Every modeled record type maps EXPLICITLY to a verdict factory: given the
// successfully-decoded value, return SIGNAL(kind) or DROP(named reason). There
// is no default-signal and no default-drop — a type missing from the table is a
// compile gap, and an on-disk discriminator missing from the table is the
// explicit `codex.unknown_record_type` drop.
// ---------------------------------------------------------------------------

/**
 * The verdict for a codex record: SIGNAL with the harness-mapped
 * `SessionEventKind`, or DROP with a named reason. For `message`/`agent_message`
 * the adapter further refines the wrapper/commentary sub-case into `preamble`
 * locally (it depends on the projected content, not the schema shape).
 */
export type CodexClassification = SignalDecision<unknown, SessionEventKind>;

type CodexRecordEntry = {
  /** The Effect Schema for this record type (fail-closed). */
  readonly schema: Schema.Schema<unknown, unknown>;
  /** The declarative verdict for a successfully-decoded record. */
  readonly verdict: (value: unknown) => CodexClassification;
  /** Stable diagnostic name for a decode failure of this type. */
  readonly decodeFailedName: string;
};

const signalKind = (kind: SessionEventKind) => (value: unknown): CodexClassification =>
  signal(kind, value);

const dropReason = (reason: string) => (_value: unknown): CodexClassification =>
  drop(reason);

/**
 * The discriminator key for a record: top-level `type`, except `response_item`
 * and `event_msg` envelopes whose meaningful type lives at `payload.type`,
 * surfaced as `response_item.<payload.type>` / `event_msg.<payload.type>`.
 */
export const codexDiscriminatorOf = (record: unknown): string | undefined => {
  if (record === null || typeof record !== "object") return undefined;
  const top = (record as { type?: unknown }).type;
  if (typeof top !== "string") return undefined;
  if (top === "response_item" || top === "event_msg") {
    const payload = (record as { payload?: unknown }).payload;
    const payloadType =
      payload !== null && typeof payload === "object"
        ? (payload as { type?: unknown }).type
        : undefined;
    if (typeof payloadType !== "string") return top;
    return `${top}.${payloadType}`;
  }
  return top;
};

/**
 * For a `response_item`/`event_msg` envelope, the schema models the PAYLOAD, so
 * decode the payload; for a top-level record, decode the whole record. This
 * keeps each payload schema focused on its own fields.
 */
const subjectFor = (discriminator: string, record: unknown): unknown => {
  if (discriminator.startsWith("response_item.") || discriminator.startsWith("event_msg.")) {
    return record !== null && typeof record === "object"
      ? (record as { payload?: unknown }).payload
      : undefined;
  }
  return record;
};

const responseItemEntry = (
  payloadType: string,
  schema: Schema.Schema<unknown, unknown>,
  verdict: (value: unknown) => CodexClassification,
): [string, CodexRecordEntry] => [
  `response_item.${payloadType}`,
  { schema, verdict, decodeFailedName: `codex.response_item.${payloadType}.decode_failed` },
];

const eventMsgEntry = (
  payloadType: string,
  schema: Schema.Schema<unknown, unknown>,
  verdict: (value: unknown) => CodexClassification,
): [string, CodexRecordEntry] => [
  `event_msg.${payloadType}`,
  { schema, verdict, decodeFailedName: `codex.event_msg.${payloadType}.decode_failed` },
];

const asSchema = <A, I>(schema: Schema.Schema<A, I>): Schema.Schema<unknown, unknown> =>
  schema as unknown as Schema.Schema<unknown, unknown>;

/**
 * The complete, fail-closed registry over EVERY codex on-disk record type. This
 * is the single source of truth for "what shapes exist on disk and what each
 * one means". A schema change here breaks the typed fixture constructors.
 */
export const CODEX_RECORD_REGISTRY: ReadonlyMap<string, CodexRecordEntry> = new Map([
  // Top-level records.
  [
    "session_meta",
    {
      schema: asSchema(CodexSessionMetaSchema),
      verdict: signalKind("system"),
      decodeFailedName: CODEX_SESSION_META_DECODE_FAILED,
    },
  ],
  [
    "compacted",
    {
      schema: asSchema(CodexCompactedSchema),
      // FIX: top-level compacted is a conversation summary, not unknown.
      verdict: signalKind("summary"),
      decodeFailedName: "codex.compacted.decode_failed",
    },
  ],
  [
    "turn_context",
    {
      schema: asSchema(CodexTurnContextSchema),
      // Per-turn provider configuration snapshot — bookkeeping, no turn content.
      verdict: dropReason("codex.turn_context.provider_bookkeeping"),
      decodeFailedName: "codex.turn_context.decode_failed",
    },
  ],
  // response_item.* records.
  responseItemEntry("message", asSchema(CodexMessagePayloadSchema), signalKind("message")),
  responseItemEntry("function_call", asSchema(CodexFunctionCallPayloadSchema), signalKind("tool_call")),
  responseItemEntry(
    "function_call_output",
    asSchema(CodexFunctionCallOutputPayloadSchema),
    signalKind("tool_result"),
  ),
  responseItemEntry("custom_tool_call", asSchema(CodexCustomToolCallPayloadSchema), signalKind("tool_call")),
  responseItemEntry(
    "custom_tool_call_output",
    asSchema(CodexCustomToolCallOutputPayloadSchema),
    signalKind("tool_result"),
  ),
  responseItemEntry("local_shell_call", asSchema(CodexLocalShellCallPayloadSchema), signalKind("tool_call")),
  responseItemEntry(
    "local_shell_call_output",
    asSchema(CodexLocalShellCallOutputPayloadSchema),
    signalKind("tool_result"),
  ),
  responseItemEntry("reasoning", asSchema(CodexReasoningPayloadSchema), signalKind("reasoning")),
  responseItemEntry("web_search_call", asSchema(CodexWebSearchCallPayloadSchema), signalKind("tool_call")),
  responseItemEntry("tool_search_call", asSchema(CodexToolSearchCallPayloadSchema), signalKind("tool_call")),
  responseItemEntry(
    "tool_search_output",
    asSchema(CodexToolSearchOutputPayloadSchema),
    // FIX: tool_search_output is a tool RESULT (the returned tools), not a call.
    signalKind("tool_result"),
  ),
  // event_msg.* records.
  eventMsgEntry("token_count", asSchema(CodexTokenCountPayloadSchema), signalKind("usage")),
  eventMsgEntry("agent_message", asSchema(CodexAgentMessagePayloadSchema), signalKind("message")),
  eventMsgEntry("user_message", asSchema(CodexUserMessagePayloadSchema), signalKind("message")),
  eventMsgEntry("task_started", asSchema(CodexTaskStartedPayloadSchema), signalKind("lifecycle")),
  eventMsgEntry("task_complete", asSchema(CodexTaskCompletePayloadSchema), signalKind("lifecycle")),
  eventMsgEntry("turn_aborted", asSchema(CodexTurnAbortedPayloadSchema), signalKind("lifecycle")),
  eventMsgEntry(
    "mcp_tool_call_end",
    asSchema(CodexMcpToolCallEndPayloadSchema),
    // mcp_tool_call_end carries the tool result. It is a dual carrier: 60% share
    // a call_id with a function_call_output that also carries the result, so the
    // adapter merges by call_id (collapsing the duplicate) and only emits a
    // standalone result in the 40% sole-carrier case.
    signalKind("tool_result"),
  ),
  eventMsgEntry(
    "exec_command_end",
    asSchema(CodexExecCommandEndPayloadSchema),
    dropReason("codex.event_msg.exec_command_end.provider_bookkeeping"),
  ),
  eventMsgEntry(
    "patch_apply_end",
    asSchema(CodexPatchApplyEndPayloadSchema),
    dropReason("codex.event_msg.patch_apply_end.provider_bookkeeping"),
  ),
  eventMsgEntry(
    "web_search_end",
    asSchema(CodexWebSearchEndPayloadSchema),
    // Bookkeeping echo of response_item.web_search_call (the signal carrier).
    dropReason("codex.event_msg.web_search_end.provider_bookkeeping"),
  ),
  eventMsgEntry(
    "thread_goal_updated",
    asSchema(CodexThreadGoalUpdatedPayloadSchema),
    dropReason("codex.event_msg.thread_goal_updated.provider_bookkeeping"),
  ),
  eventMsgEntry(
    "context_compacted",
    asSchema(CodexContextCompactedPayloadSchema),
    dropReason("codex.event_msg.context_compacted.provider_bookkeeping"),
  ),
  eventMsgEntry(
    "item_completed",
    asSchema(CodexItemCompletedPayloadSchema),
    dropReason("codex.event_msg.item_completed.provider_bookkeeping"),
  ),
  eventMsgEntry(
    "thread_name_updated",
    asSchema(CodexThreadNameUpdatedPayloadSchema),
    dropReason("codex.event_msg.thread_name_updated.provider_bookkeeping"),
  ),
  eventMsgEntry(
    "collab_agent_spawn_end",
    asSchema(CodexCollabAgentSpawnEndPayloadSchema),
    // Subagent lineage is sourced from session_meta; this spawn echo is bookkeeping.
    dropReason("codex.event_msg.collab_agent_spawn_end.provider_bookkeeping"),
  ),
  eventMsgEntry(
    "collab_waiting_end",
    asSchema(CodexCollabWaitingEndPayloadSchema),
    dropReason("codex.event_msg.collab_waiting_end.provider_bookkeeping"),
  ),
  eventMsgEntry(
    "error",
    asSchema(CodexErrorPayloadSchema),
    dropReason("codex.event_msg.error.provider_bookkeeping"),
  ),
]);

/** Stable diagnostic name for a record whose discriminator is not modeled. */
export const CODEX_UNKNOWN_RECORD_TYPE = "codex.unknown_record_type";

/**
 * Classify ONE codex on-disk record, fail-closed and declarative.
 *
 * 1. Resolve the discriminator (top-level `type`, or `response_item`/`event_msg`
 *    + `payload.type`). An unresolvable / unmodeled discriminator is the
 *    explicit `codex.unknown_record_type` DROP — never a silent unknown event.
 * 2. Decode the record (or its payload) against the modeled schema. A schema
 *    failure becomes the type's named `codex.<type>.decode_failed` DROP plus an
 *    accumulated diagnostic.
 * 3. On success, apply the type's declarative verdict: SIGNAL(kind) or
 *    DROP(named reason).
 *
 * The returned `value` on a signal is the decoded record/payload — its kind is
 * the harness-mapped `SessionEventKind`. The caller never sees an `unknown`
 * pass-through.
 */
export const classifyCodexRecord = (
  record: unknown,
  diagnostics?: { push: (d: { readonly name: string; readonly message: string }) => void },
): CodexClassification => {
  const discriminator = codexDiscriminatorOf(record);
  if (discriminator === undefined) {
    const message = "record has no resolvable codex discriminator (top-level `type`)";
    diagnostics?.push({ name: CODEX_UNKNOWN_RECORD_TYPE, message });
    return drop(`${CODEX_UNKNOWN_RECORD_TYPE}: ${message}`);
  }
  const entry = CODEX_RECORD_REGISTRY.get(discriminator);
  if (entry === undefined) {
    const message = `unmodeled codex record type \`${discriminator}\``;
    diagnostics?.push({ name: CODEX_UNKNOWN_RECORD_TYPE, message });
    return drop(`${CODEX_UNKNOWN_RECORD_TYPE}: ${message}`);
  }
  const subject = subjectFor(discriminator, record);
  const decoded = Schema.decodeUnknownEither(entry.schema)(subject, { errors: "all" });
  if (decoded._tag === "Left") {
    const message = ParseResult.TreeFormatter.formatErrorSync(decoded.left);
    diagnostics?.push({ name: entry.decodeFailedName, message });
    return drop(`${entry.decodeFailedName}: ${message}`);
  }
  return entry.verdict(decoded.right);
};
