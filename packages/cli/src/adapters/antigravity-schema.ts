import { Schema } from "effect";

import { type SignalDecision, drop, signal } from "./harness-schema";

// ---------------------------------------------------------------------------
// Antigravity on-disk record schema (QSR-220 fail-closed boundary)
//
// Grounded against the real ~/.gemini/antigravity-cli/brain/<uuid>/
//   .system_generated/logs/transcript_full.jsonl estate. Each line is a JSON
// object whose load-bearing field is `type` (a string discriminator:
// USER_INPUT, PLANNER_RESPONSE, INVOKE_SUBAGENT, GENERIC, VIEW_FILE, ...).
// Everything else this adapter reads is optional/nullable.
//
// Records are decoded through `decodeOrDrop` (diagnosticName
// `antigravity.record.decode_failed`), so a malformed line becomes a NAMED
// diagnostic + a dropped record — never a throw that aborts the whole
// transcript, never a silently coerced half-record. The schema is lenient
// about excess keys (Effect ignores them) but strict about `type`, the one
// field every downstream branch keys on.
// ---------------------------------------------------------------------------

/** A single tool_call entry on a PLANNER_RESPONSE record. */
const AntigravityToolCallSchema = Schema.Struct({
  name: Schema.optional(Schema.NullOr(Schema.String)),
  args: Schema.optional(Schema.NullOr(Schema.Unknown)),
});

/**
 * The CLOSED set of on-disk transcript record `type` discriminators, grounded
 * against the entire real estate (76,111 records / 15 distinct types, measured
 * 2026-06-21). This is the FULL DATA FIDELITY inventory (QSR-220): every record
 * that exists on disk MUST appear here, and the per-record dispatch below MUST
 * classify each one EXPLICITLY as signal(kind) or drop(reason) — zero records
 * may fall through to an "unknown" pass-through.
 *
 * Modeling `type` as a literal union (not a free `Schema.String`) makes the
 * schema fail-closed on a NEW provider record type: an unrecognised `type`
 * fails to decode → becomes a NAMED `antigravity.record.decode_failed`
 * diagnostic + a dropped record, which is exactly the contract ("a model
 * rambling must never be mistaken for a legitimate response"). When the provider
 * adds a genuinely new type, the decode failure surfaces it loudly rather than
 * silently swallowing it as unknown.
 */
export const ANTIGRAVITY_RECORD_TYPES = [
  "USER_INPUT",
  "PLANNER_RESPONSE",
  "CONVERSATION_HISTORY",
  "INVOKE_SUBAGENT",
  "CHECKPOINT",
  "SYSTEM_MESSAGE",
  "ERROR_MESSAGE",
  "VIEW_FILE",
  "LIST_DIRECTORY",
  "GENERIC",
  "CODE_ACTION",
  "RUN_COMMAND",
  "GREP_SEARCH",
  "FIND",
  "SEARCH_WEB",
] as const;

export type AntigravityRecordType = (typeof ANTIGRAVITY_RECORD_TYPES)[number];

/**
 * The transcript record schema. `type` is the load-bearing discriminator and is
 * a CLOSED literal union (fail-closed: an unknown type is rejected at the
 * boundary). The rest are optional because Antigravity records are heterogeneous
 * (a USER_INPUT carries content, a PLANNER_RESPONSE may carry thinking +
 * tool_calls, an INVOKE_SUBAGENT carries a content blurb, an ERROR_MESSAGE
 * carries `error`/`error_code`). Every field present anywhere in the real estate
 * is modeled here so a schema change breaks the adapter loudly.
 */
export const AntigravityRecordSchema = Schema.Struct({
  type: Schema.Literal(...ANTIGRAVITY_RECORD_TYPES),
  step_index: Schema.optional(Schema.NullOr(Schema.Number)),
  source: Schema.optional(Schema.NullOr(Schema.String)),
  status: Schema.optional(Schema.NullOr(Schema.String)),
  created_at: Schema.optional(Schema.NullOr(Schema.String)),
  content: Schema.optional(Schema.NullOr(Schema.String)),
  thinking: Schema.optional(Schema.NullOr(Schema.String)),
  tool_calls: Schema.optional(Schema.NullOr(Schema.Array(AntigravityToolCallSchema))),
  // ERROR_MESSAGE-only fields (modeled for full fidelity; optional everywhere
  // else): `error` is the human error blurb, `error_code` the HTTP-ish numeric
  // code (429/503) when the failure was a transport/provider error.
  error: Schema.optional(Schema.NullOr(Schema.String)),
  error_code: Schema.optional(Schema.NullOr(Schema.Number)),
});

export type AntigravityRecord = typeof AntigravityRecordSchema.Type;
export type AntigravityToolCallRecord = typeof AntigravityToolCallSchema.Type;

// ---------------------------------------------------------------------------
// Declarative per-record-type signal/drop dispatch (QSR-220 FULL DATA FIDELITY)
//
// Replaces the ad-hoc kind/role heuristic. Every one of the 15 on-disk record
// types is EXPLICITLY either:
//   - signal(role, kind) — kept on a mapped surface, or
//   - drop(reason)       — discarded with a NAMED reason.
// There is NO catch-all "unknown" arm. PLANNER_RESPONSE is the one type whose
// classification depends on runtime turn context (terminal vs mid-loop, whether
// it carries tool_calls / thinking), so its sub-dispatch takes that context;
// every other type maps purely from its `type`.
// ---------------------------------------------------------------------------

/** The narrow role/kind surface this adapter emits (subset of the core enums). */
export type AntigravityRole = "user" | "assistant" | "system" | "thinking" | "unknown";
export type AntigravityKind =
  | "message"
  | "tool_call"
  | "tool_result"
  | "reasoning"
  | "system"
  | "lifecycle";

export interface AntigravityRecordClassification {
  readonly role: AntigravityRole;
  readonly kind: AntigravityKind;
}

/** Context the PLANNER_RESPONSE arm needs; pure-`type` arms ignore it. */
export interface AntigravityClassifyContext {
  readonly hasToolCalls: boolean;
  readonly hasThinking: boolean;
  readonly isTerminalPlannerResponse: boolean;
}

// Tool-result record types: their `content` is a tool execution result (a
// directory listing, a file body, a command transcript, a grep/find hit list, a
// web-search summary) — structural provenance, never an assistant message and
// never embedded. GREP_SEARCH / FIND / SEARCH_WEB are read-only retrieval tools,
// so they map to `tool_result`; the mutating/observing ones (VIEW_FILE,
// LIST_DIRECTORY, RUN_COMMAND, CODE_ACTION, GENERIC) keep `tool_call` for parity
// with the existing started/completed pairing logic in the adapter.
const TOOL_RESULT_TYPES = new Set<AntigravityRecordType>([
  "GREP_SEARCH",
  "FIND",
  "SEARCH_WEB",
]);
const TOOL_EXECUTION_TYPES = new Set<AntigravityRecordType>([
  "VIEW_FILE",
  "LIST_DIRECTORY",
  "GENERIC",
  "CODE_ACTION",
  "RUN_COMMAND",
]);

/**
 * Classify a single decoded record into signal(role/kind) or drop(reason). This
 * is the SOLE record-level dispatch: every `AntigravityRecordType` is handled by
 * an explicit arm and the function is exhaustive (the trailing `never` check
 * proves at compile time that no type is missing), so a new on-disk type can
 * never silently fall through to "unknown".
 */
export const classifyRecord = (
  type: AntigravityRecordType,
  ctx: AntigravityClassifyContext,
): SignalDecision<AntigravityRecordClassification, AntigravityKind> => {
  switch (type) {
    case "CONVERSATION_HISTORY":
      // Replay marker with null content — a pointer into the cumulative replay,
      // never content of its own. Dropped with a named reason (no row emitted).
      return drop("antigravity.record.conversation_history_replay_marker");

    case "USER_INPUT":
      return signal("message", { role: "user", kind: "message" });

    case "PLANNER_RESPONSE": {
      // The turn-terminal response is the assistant's real answer — searchable,
      // one per user turn. Terminal classification wins even when it also
      // carries tool_calls (an aborted/incomplete final turn); the calls still
      // emit, but the record itself is the answer.
      if (ctx.isTerminalPlannerResponse) {
        return signal("message", { role: "assistant", kind: "message" });
      }
      // Mid-loop: tool narration, reasoning, or a bare lifecycle tick. None are
      // messages; none reach the embedding surface.
      if (ctx.hasToolCalls) return signal("tool_call", { role: "assistant", kind: "tool_call" });
      if (ctx.hasThinking) return signal("reasoning", { role: "thinking", kind: "reasoning" });
      return signal("lifecycle", { role: "unknown", kind: "lifecycle" });
    }

    case "INVOKE_SUBAGENT":
      // First-class subagent lifecycle event (the spawn marker). Content is
      // consumed for cross-session lineage, not for search.
      return signal("lifecycle", { role: "system", kind: "lifecycle" });

    case "CHECKPOINT":
    case "SYSTEM_MESSAGE":
      return signal("system", { role: "system", kind: "system" });

    case "ERROR_MESSAGE":
      // A model/transport failure lifecycle record (e.g. 429/503, or a tool-call
      // parse failure). It is NOT an assistant message and is NOT searchable; it
      // is a named lifecycle signal so the failure is preserved as provenance.
      return signal("lifecycle", { role: "system", kind: "lifecycle" });

    case "VIEW_FILE":
    case "LIST_DIRECTORY":
    case "GENERIC":
    case "CODE_ACTION":
    case "RUN_COMMAND":
      return signal("tool_call", { role: "assistant", kind: "tool_call" });

    case "GREP_SEARCH":
    case "FIND":
    case "SEARCH_WEB":
      return signal("tool_result", { role: "assistant", kind: "tool_result" });

    default: {
      // Exhaustiveness guard: if a new AntigravityRecordType is added to the
      // literal union without a classification arm here, this fails to compile.
      const _exhaustive: never = type;
      return drop(`antigravity.record.unclassified:${String(_exhaustive)}`);
    }
  }
};

/** True when this record type carries a tool-execution result `content` body. */
export const isToolExecutionType = (type: AntigravityRecordType): boolean =>
  TOOL_EXECUTION_TYPES.has(type);

/** True when this record type is a read-only retrieval tool result. */
export const isToolResultType = (type: AntigravityRecordType): boolean =>
  TOOL_RESULT_TYPES.has(type);

// ---------------------------------------------------------------------------
// Tool-call classification (SignalDecision)
//
// Every tool call inside a PLANNER_RESPONSE is classified EXPLICITLY — it is
// either kept as a SIGNAL (with a mapped kind) or DROPPED with a named reason.
// The doctrine forbids a silent "unknown" pass-through for the records this
// task names:
//
//   define_subagent / invoke_subagent → signal (first-class subagent control)
//   manage_task / manage_subagents with Action="list" → DROP (polling noise)
//   manage_task / manage_subagents with any other Action → signal (real op)
//   everything else → signal "tool_call" (ordinary tool execution)
// ---------------------------------------------------------------------------

export type AntigravityToolKind =
  | "define_subagent"
  | "invoke_subagent"
  | "subagent_admin"
  | "tool_call";

const SUBAGENT_ADMIN_TOOLS = new Set(["manage_task", "manage_subagents"]);

/** Read the `Action` field off a tool call's args (case-sensitive, as on disk). */
const toolActionOf = (args: unknown): string | undefined => {
  if (typeof args !== "object" || args === null) return undefined;
  const action = (args as Record<string, unknown>).Action;
  return typeof action === "string" ? action : undefined;
};

/**
 * Classify a single tool call. Returns a SignalDecision so the caller never
 * silently coerces: a kept call carries its mapped kind, a dropped call carries
 * a named reason. The `manage_task`/`manage_subagents` Action="list" records are
 * pure background polling that flood real transcripts (thousands of lines) — the
 * model is told "there is no need to poll", yet it does — and they are dropped.
 */
export const classifyToolCall = (
  toolCall: AntigravityToolCallRecord,
): SignalDecision<{ readonly name: string; readonly args: unknown }, AntigravityToolKind> => {
  const name = typeof toolCall.name === "string" ? toolCall.name : undefined;
  if (name === undefined) {
    return drop("antigravity.toolcall.unnamed");
  }
  const args = toolCall.args ?? undefined;

  if (name === "define_subagent") return signal("define_subagent", { name, args });
  if (name === "invoke_subagent") return signal("invoke_subagent", { name, args });

  if (SUBAGENT_ADMIN_TOOLS.has(name)) {
    const action = toolActionOf(args);
    if (action === "list") {
      return drop(`antigravity.subagent_admin.list_poll_noise:${name}`);
    }
    return signal("subagent_admin", { name, args });
  }

  return signal("tool_call", { name, args });
};

// ---------------------------------------------------------------------------
// Cross-session lineage extraction
//
// The parent→child link lives ONLY in the parent's content: an INVOKE_SUBAGENT
// record whose `content` is a human blurb wrapping one-or-more concatenated JSON
// objects, each `{ "conversationId": "<child brain uuid>", "logAbsoluteUri": ...,
// "workspaceUris": [...] }`. The matching `Role`/`TypeName` for each child is in
// the IMMEDIATELY PRECEDING `invoke_subagent` tool call's `args.Subagents[]`
// array, in the same order — so children pair to roles by index.
// ---------------------------------------------------------------------------

const CONVERSATION_ID_RE = /"conversationId"\s*:\s*"([0-9a-fA-F-]{36})"/g;

/**
 * Extract child brain UUIDs (in order) from an INVOKE_SUBAGENT record's content
 * blurb. The content is NOT a clean JSON array — it is a prose preamble followed
 * by one-or-more JSON objects with irregular whitespace — so the conversationId
 * field is scanned directly rather than JSON.parsed.
 */
export const childUuidsFromInvokeContent = (content: string | null | undefined): string[] => {
  if (typeof content !== "string" || content.length === 0) return [];
  const ids: string[] = [];
  for (const match of content.matchAll(CONVERSATION_ID_RE)) {
    const id = match[1];
    if (id !== undefined) ids.push(id.toLowerCase());
  }
  return ids;
};

/** A subagent role/type pulled from an `invoke_subagent` tool call's Subagents. */
export interface SubagentRole {
  readonly role?: string;
  readonly typeName?: string;
}

/**
 * Pull the ordered `Role`/`TypeName` list from an `invoke_subagent` tool call's
 * `args.Subagents[]`. Order matters: the INVOKE_SUBAGENT content's child UUIDs
 * pair to these by index.
 */
export const rolesFromInvokeToolCall = (args: unknown): SubagentRole[] => {
  if (typeof args !== "object" || args === null) return [];
  const subagents = (args as Record<string, unknown>).Subagents;
  if (!Array.isArray(subagents)) return [];
  return subagents.map((entry) => {
    if (typeof entry !== "object" || entry === null) return {};
    const record = entry as Record<string, unknown>;
    return {
      ...(typeof record.Role === "string" ? { role: record.Role } : {}),
      ...(typeof record.TypeName === "string" ? { typeName: record.TypeName } : {}),
    };
  });
};

/**
 * Resolve the display agentName for a child subagent: prefer the human-facing
 * `Role` ("Fabricated Audit Role"); fall back to `TypeName` when Role is
 * absent; `TypeName` is sometimes the unhelpful sentinel "self", so it is only
 * used when no Role exists. Returns undefined when neither is present.
 */
export const agentNameFromRole = (role: SubagentRole | undefined): string | undefined => {
  if (role === undefined) return undefined;
  if (role.role !== undefined && role.role.length > 0) return role.role;
  if (role.typeName !== undefined && role.typeName.length > 0 && role.typeName !== "self") {
    return role.typeName;
  }
  return undefined;
};
