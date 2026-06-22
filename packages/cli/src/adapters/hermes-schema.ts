import { Schema } from "effect";

import { type SignalDecision, drop, signal } from "./harness-schema";

// ---------------------------------------------------------------------------
// Hermes on-disk record schemas + declarative classification (QSR-220 FULL
// DATA FIDELITY).
//
// Grounded against the real ~/.hermes/state.db `.schema` and live column
// distributions (measured 2026-06-21). The hermes estate is a set of SQLite
// `state.db` files (top-level + profiles/<name>/state.db). The on-disk format
// is TWO tables (sessions, messages) plus several JSON-encoded TEXT columns on
// the messages table whose inner structure is its own record type.
//
// Every distinct record type below is modeled by a rigorous fail-closed Effect
// Schema and every record is classified by a DECLARATIVE signal/drop dispatch:
// it is EXPLICITLY either signal(mapped kind) or drop(named reason). There is
// NO "unknown" pass-through. A malformed record is decoded through
// `decodeOrDrop` at the boundary → a NAMED diagnostic + a dropped record; never
// a throw, never silent coercion.
//
// Measured ground truth (real db, not copied here):
//   sessions.id TEXT PK NOT NULL; started_at REAL NOT NULL; source TEXT NOT
//     NULL; everything else this adapter reads is nullable.
//   sessions.source ∈ {cli, cron, matrix, prism-workflow}.
//   messages.id INTEGER PK; session_id/role/timestamp NOT NULL; rest nullable.
//   messages.role ∈ {user, assistant, tool, session_meta}.
//     - session_meta: a lifecycle marker row — content/tool_calls/reasoning ALL
//       null (0 of 42 carry any payload). It is NOT a conversational turn.
//     - tool: every one of 2214 carries tool_call_id; tool_name on 712.
//     - assistant: 1731/1942 carry tool_calls; reasoning co-occurs WITH content
//       (0 assistant rows are reasoning-only-no-content).
//   messages.finish_reason ∈ {NULL, tool_calls, stop}.
//   tool_calls column: JSON array of OpenAI-style function call objects.
//   codex_reasoning_items: JSON array of {type:"reasoning", encrypted_content,
//     id, summary[]}.
//   codex_message_items: JSON array of {type:"message", role, status,
//     content[], id, phase}.
//   reasoning_details: present in schema, 0 rows populated on this estate, but
//     modeled (a JSON array) so a future write is admitted, not dropped.
// ---------------------------------------------------------------------------

/** A SQLite TEXT column that may be absent or NULL. */
const NullableText = Schema.optional(Schema.NullOr(Schema.String));
/** A SQLite numeric (INTEGER/REAL) column that may be absent or NULL. */
const NullableNumeric = Schema.optional(Schema.NullOr(Schema.Number));
/** A nullable column whose stored type we do not constrain (free-form TEXT/JSON-as-text). */
const NullableLoose = Schema.optional(Schema.NullOr(Schema.Unknown));

// ---------------------------------------------------------------------------
// Record type 1: sessions row
//
// The load-bearing identity (`id`) and ordering (`started_at`) fields are
// strict; `source` is NOT NULL on disk so it is required. handoff_* fields are
// modeled (a session handed off to another platform/cron/matrix carries them).
// ---------------------------------------------------------------------------
export const HermesSessionRowSchema = Schema.Struct({
  // sessions.id TEXT PRIMARY KEY NOT NULL — the load-bearing native id.
  id: Schema.String,
  // source TEXT NOT NULL — provenance lane (cli/cron/matrix/prism-workflow).
  source: Schema.String,
  // started_at REAL NOT NULL — the ordering key.
  started_at: Schema.Number,
  model: NullableText,
  parent_session_id: NullableText,
  ended_at: NullableNumeric,
  input_tokens: NullableNumeric,
  output_tokens: NullableNumeric,
  cache_read_tokens: NullableNumeric,
  cache_write_tokens: NullableNumeric,
  reasoning_tokens: NullableNumeric,
  billing_provider: NullableText,
  estimated_cost_usd: NullableNumeric,
  actual_cost_usd: NullableNumeric,
  title: NullableText,
  cwd: NullableText,
  // Cross-platform handoff lineage (sessions can be handed off to matrix/cron).
  handoff_state: NullableText,
  handoff_platform: NullableText,
  handoff_error: NullableText,
});
export type HermesSessionRow = typeof HermesSessionRowSchema.Type;

// ---------------------------------------------------------------------------
// Record type 2: messages row
//
// `role` is the load-bearing discriminator and is NOT NULL on disk, so it is a
// required string. The classifier below maps every role explicitly.
// ---------------------------------------------------------------------------
export const HermesMessageRowSchema = Schema.Struct({
  // messages.id INTEGER PRIMARY KEY AUTOINCREMENT — arrives as a number.
  id: Schema.Number,
  // session_id/role/timestamp are NOT NULL on disk.
  session_id: Schema.String,
  role: Schema.String,
  timestamp: Schema.Number,
  content: NullableText,
  tool_call_id: NullableText,
  // tool_calls is stored as a TEXT column holding a JSON array; its inner shape
  // is modeled by HermesToolCallSchema and decoded separately.
  tool_calls: NullableLoose,
  tool_name: NullableText,
  token_count: NullableNumeric,
  finish_reason: NullableText,
  reasoning: NullableText,
  reasoning_content: NullableText,
  reasoning_details: NullableLoose,
  codex_reasoning_items: NullableLoose,
  codex_message_items: NullableLoose,
  platform_message_id: NullableText,
});
export type HermesMessageRow = typeof HermesMessageRowSchema.Type;

// ---------------------------------------------------------------------------
// Record type 3: tool_calls[] entry (JSON sub-record inside the tool_calls
// TEXT column)
//
// Grounded shape (OpenAI function-call envelope):
//   { id, call_id, response_item_id, type:"function",
//     function: { name, arguments } }
// The fields vary by provider (anthropic-shaped calls put name/input at the
// top level; codex/openai nest under `function`), so everything is optional
// except that the object must be a struct. The classifier requires a resolvable
// name to keep the call as SIGNAL.
// ---------------------------------------------------------------------------
const HermesToolFunctionSchema = Schema.Struct({
  name: Schema.optional(Schema.NullOr(Schema.String)),
  arguments: Schema.optional(Schema.NullOr(Schema.Unknown)),
  input: Schema.optional(Schema.NullOr(Schema.Unknown)),
  parameters: Schema.optional(Schema.NullOr(Schema.Unknown)),
});

export const HermesToolCallSchema = Schema.Struct({
  id: Schema.optional(Schema.NullOr(Schema.String)),
  call_id: Schema.optional(Schema.NullOr(Schema.String)),
  tool_call_id: Schema.optional(Schema.NullOr(Schema.String)),
  toolCallId: Schema.optional(Schema.NullOr(Schema.String)),
  response_item_id: Schema.optional(Schema.NullOr(Schema.String)),
  type: Schema.optional(Schema.NullOr(Schema.String)),
  name: Schema.optional(Schema.NullOr(Schema.String)),
  tool_name: Schema.optional(Schema.NullOr(Schema.String)),
  toolName: Schema.optional(Schema.NullOr(Schema.String)),
  function: Schema.optional(Schema.NullOr(HermesToolFunctionSchema)),
  arguments: Schema.optional(Schema.NullOr(Schema.Unknown)),
  args: Schema.optional(Schema.NullOr(Schema.Unknown)),
  input: Schema.optional(Schema.NullOr(Schema.Unknown)),
  params: Schema.optional(Schema.NullOr(Schema.Unknown)),
  parameters: Schema.optional(Schema.NullOr(Schema.Unknown)),
});
export type HermesToolCall = typeof HermesToolCallSchema.Type;
/** The tool_calls column is a JSON array of HermesToolCall objects. */
export const HermesToolCallsArraySchema = Schema.Array(HermesToolCallSchema);

// ---------------------------------------------------------------------------
// Record type 4: codex_reasoning_items[] entry (JSON sub-record)
//
// Grounded shape: { type:"reasoning", encrypted_content, id, summary[] }.
// ---------------------------------------------------------------------------
export const HermesCodexReasoningItemSchema = Schema.Struct({
  type: Schema.optional(Schema.NullOr(Schema.String)),
  id: Schema.optional(Schema.NullOr(Schema.String)),
  encrypted_content: Schema.optional(Schema.NullOr(Schema.String)),
  summary: Schema.optional(Schema.NullOr(Schema.Array(Schema.Unknown))),
});
export const HermesCodexReasoningItemsArraySchema = Schema.Array(HermesCodexReasoningItemSchema);

// ---------------------------------------------------------------------------
// Record type 5: codex_message_items[] entry (JSON sub-record)
//
// Grounded shape: { type:"message", role, status, content[], id, phase }.
// ---------------------------------------------------------------------------
const HermesCodexContentBlockSchema = Schema.Struct({
  type: Schema.optional(Schema.NullOr(Schema.String)),
  text: Schema.optional(Schema.NullOr(Schema.String)),
});
export const HermesCodexMessageItemSchema = Schema.Struct({
  type: Schema.optional(Schema.NullOr(Schema.String)),
  role: Schema.optional(Schema.NullOr(Schema.String)),
  status: Schema.optional(Schema.NullOr(Schema.String)),
  id: Schema.optional(Schema.NullOr(Schema.String)),
  phase: Schema.optional(Schema.NullOr(Schema.String)),
  content: Schema.optional(Schema.NullOr(Schema.Array(HermesCodexContentBlockSchema))),
});
export const HermesCodexMessageItemsArraySchema = Schema.Array(HermesCodexMessageItemSchema);

// ---------------------------------------------------------------------------
// Record type 6: reasoning_details[] entry (JSON sub-record)
//
// Present in the schema but unpopulated on the measured estate. Modeled (a JSON
// array of loose objects) so a future write is ADMITTED rather than silently
// dropped — fidelity means the format is declared even where no row exists yet.
// ---------------------------------------------------------------------------
export const HermesReasoningDetailSchema = Schema.Struct({
  type: Schema.optional(Schema.NullOr(Schema.String)),
  text: Schema.optional(Schema.NullOr(Schema.String)),
  summary: Schema.optional(Schema.NullOr(Schema.Unknown)),
});
export const HermesReasoningDetailsArraySchema = Schema.Array(HermesReasoningDetailSchema);

// ---------------------------------------------------------------------------
// Declarative MESSAGE classification (signal kind / drop reason)
//
// Replaces the ad-hoc `roleFrom` + `messageKind` heuristics for this adapter.
// Every messages.role and every message shape resolves to EXACTLY one verdict;
// there is no fall-through to "unknown". The classifier keys off the row's
// (already decoded) fields:
//
//   role=session_meta            → DROP "hermes.message.session_meta_marker"
//     (lifecycle marker; carries no conversational payload on disk)
//   role=tool  OR tool_call_id   → signal "tool_result"  (role tool)
//   role=assistant + tool_calls  → signal "tool_call"     (role assistant)
//   role=assistant, reasoning,
//     no content                 → signal "reasoning"     (role assistant)
//   role=user                    → signal "message"       (role user)
//   role=assistant (content)     → signal "message"       (role assistant)
//   any other (empty) role       → DROP "hermes.message.empty_unclassifiable"
//
// The mapped Quasar role rides alongside the kind so the adapter never calls
// the shared `roleFrom` (which would mislabel session_meta as "unknown").
// ---------------------------------------------------------------------------

/** Quasar event kind this classifier may emit (subset of SessionEventKind). */
export type HermesMessageKind = "message" | "tool_call" | "tool_result" | "reasoning";
/** Quasar role this classifier may emit (subset of SessionRole). */
export type HermesMessageRole = "user" | "assistant" | "tool";

export interface HermesMessageSignal {
  readonly kind: HermesMessageKind;
  readonly role: HermesMessageRole;
}

const present = (value: string | null | undefined): value is string =>
  typeof value === "string" && value.length > 0;

const hasToolCalls = (decodedCalls: readonly HermesToolCall[]): boolean => decodedCalls.length > 0;

const hasReasoning = (row: HermesMessageRow): boolean =>
  present(row.reasoning) ||
  present(row.reasoning_content) ||
  (row.reasoning_details !== undefined && row.reasoning_details !== null) ||
  (row.codex_reasoning_items !== undefined && row.codex_reasoning_items !== null);

/**
 * A row with `codex_message_items` carries real conversational content via the
 * codex bridge (the `content` TEXT column is absent/null in this path). We
 * treat such a row as having content so it is not dropped as `empty_assistant`.
 */
const hasCodexContent = (row: HermesMessageRow): boolean =>
  row.codex_message_items !== undefined && row.codex_message_items !== null;

/**
 * Classify a decoded message row into a SIGNAL (kind + mapped role) or a DROP
 * (named reason). `decodedCalls` is the already-decoded tool_calls array so the
 * tool_call vs message branch is keyed on real structure, not a string sniff.
 *
 * This is the declarative replacement for the shared `roleFrom`/`messageKind`
 * heuristics: every branch is explicit and the only non-signal outcomes are
 * NAMED drops, never an "unknown" pass-through.
 */
export const classifyMessage = (
  row: HermesMessageRow,
  decodedCalls: readonly HermesToolCall[],
): SignalDecision<HermesMessageSignal, HermesMessageKind> => {
  const role = row.role;

  // Lifecycle marker — not a conversational turn. Named drop.
  if (role === "session_meta") {
    return drop("hermes.message.session_meta_marker");
  }

  // A tool RESULT: either the explicit tool role or any row carrying a
  // tool_call_id back-reference.
  if (role === "tool" || present(row.tool_call_id)) {
    return signal("tool_result", { kind: "tool_result", role: "tool" });
  }

  if (role === "assistant") {
    if (hasToolCalls(decodedCalls)) {
      return signal("tool_call", { kind: "tool_call", role: "assistant" });
    }
    // Reasoning-only assistant turn (no content, no codex bridge) → reasoning.
    // When content is present the reasoning is carried as an extra block on a
    // normal message (handled via extractReasoningText in hermes.ts).
    if (hasReasoning(row) && !present(row.content) && !hasCodexContent(row)) {
      return signal("reasoning", { kind: "reasoning", role: "assistant" });
    }
    if (present(row.content) || hasReasoning(row) || hasCodexContent(row)) {
      return signal("message", { kind: "message", role: "assistant" });
    }
    return drop("hermes.message.empty_assistant");
  }

  if (role === "user") {
    if (present(row.content) || present(row.tool_call_id)) {
      return signal("message", { kind: "message", role: "user" });
    }
    return drop("hermes.message.empty_user");
  }

  // Any role we do not explicitly map is a contract breach — NAMED drop, never
  // an "unknown" pass-through.
  return drop(`hermes.message.unmapped_role:${role}`);
};

// ---------------------------------------------------------------------------
// Declarative TOOL-CALL classification (signal kind / drop reason)
//
// Each entry inside the tool_calls JSON array is classified explicitly: a call
// with a resolvable name is SIGNAL; an unnamed/empty call is a NAMED DROP.
// ---------------------------------------------------------------------------
export type HermesToolCallKind = "tool_call";

/** Resolve a tool call's name across the provider-variant field placements. */
export const toolNameOf = (call: HermesToolCall): string | undefined => {
  const fromFunction = call.function?.name ?? undefined;
  return (
    (present(fromFunction) ? fromFunction : undefined) ??
    (present(call.name) ? call.name : undefined) ??
    (present(call.tool_name) ? call.tool_name : undefined) ??
    (present(call.toolName) ? call.toolName : undefined)
  );
};

/**
 * Classify a single decoded tool_calls[] entry. A call with no resolvable name
 * is structurally meaningless (it cannot be attributed to a tool) and is a
 * NAMED drop rather than an invented "hermes_tool" placeholder.
 */
export const classifyToolCall = (
  call: HermesToolCall,
): SignalDecision<{ readonly name: string; readonly call: HermesToolCall }, HermesToolCallKind> => {
  const name = toolNameOf(call);
  if (name === undefined) {
    return drop("hermes.toolcall.unnamed");
  }
  return signal("tool_call", { name, call });
};
