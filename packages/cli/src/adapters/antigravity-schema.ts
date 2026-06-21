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
 * The transcript record schema. `type` is the load-bearing discriminator and
 * is required; the rest are optional because Antigravity records are
 * heterogeneous (a USER_INPUT carries content, a PLANNER_RESPONSE may carry
 * thinking + tool_calls, an INVOKE_SUBAGENT carries a content blurb, etc.).
 */
export const AntigravityRecordSchema = Schema.Struct({
  type: Schema.String,
  step_index: Schema.optional(Schema.NullOr(Schema.Number)),
  source: Schema.optional(Schema.NullOr(Schema.String)),
  status: Schema.optional(Schema.NullOr(Schema.String)),
  created_at: Schema.optional(Schema.NullOr(Schema.String)),
  content: Schema.optional(Schema.NullOr(Schema.String)),
  thinking: Schema.optional(Schema.NullOr(Schema.String)),
  tool_calls: Schema.optional(Schema.NullOr(Schema.Array(AntigravityToolCallSchema))),
});

export type AntigravityRecord = typeof AntigravityRecordSchema.Type;
export type AntigravityToolCallRecord = typeof AntigravityToolCallSchema.Type;

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
 * `Role` ("Adversarial API Auditor"); fall back to `TypeName` when Role is
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
