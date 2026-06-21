import { Schema } from "effect";

import {
  type DecodeDiagnostic,
  type SignalDecision,
  decodeOrDrop,
  drop,
} from "./harness-schema";

/**
 * QSR-220 FULL DATA FIDELITY — claude harness.
 *
 * Models the ENTIRE on-disk Claude Code project-JSONL format: every distinct
 * record `type` (and, for `system`/`attachment`, every distinct subtype) is
 * modeled as a rigorous fail-closed Effect Schema and routed through a single
 * DECLARATIVE per-record-type signal-vs-drop dispatch (`classifyClaudeRecord`).
 *
 * Doctrine (AGENTS.md + the data-structures mandate): every record is EXPLICITLY
 * either signal(kind) or drop(named reason). ZERO records fall through to a
 * generic "unknown" pass-through; a malformed record becomes a NAMED diagnostic
 * + a dropped record via `decodeOrDrop` (never throw, never silent coercion).
 *
 * Inventory grounded against the real root (`~/.claude/projects/**.jsonl`):
 *   top-level types : user, assistant, system, attachment, file-history-snapshot,
 *                     last-prompt, mode, permission-mode, ai-title,
 *                     queue-operation, agent-setting, agent-name
 *   system subtypes : turn_duration, away_summary, stop_hook_summary,
 *                     local_command, compact_boundary, api_error,
 *                     scheduled_task_fire, informational
 *   attachment subs : deferred_tools_delta, skill_listing, task_reminder,
 *                     queued_command, command_permissions, agent_listing_delta,
 *                     edited_text_file, ultra_effort_enter, ultra_effort_exit,
 *                     file, goal_status, date_change, hook_success, plan_mode,
 *                     plan_mode_exit, plan_mode_reentry, workflow_keyword_request,
 *                     budget_usd, invoked_skills, plan_file_reference,
 *                     compact_file_reference, directory
 *   (`journal.jsonl` run-manifest files are excluded upstream — never reach here.)
 *
 * The kinds emitted here are the canonical `SessionEventKind` literals (see
 * core/schemas.ts): message, tool_call, tool_result, reasoning, system, summary,
 * snapshot, lifecycle. Subagent lineage + identity are handled by the adapter on
 * top of these decoded records and are NOT regressed by this dispatch.
 */

// ---------------------------------------------------------------------------
// Shared envelope fields
//
// Most conversation/system/attachment records carry the same provenance
// envelope. We model only the fields the adapter actually reads; Effect ignores
// excess properties by default, so a real record carrying many more keys still
// decodes. Every field declares its expectation (string / nullable / optional)
// so a contract breach (e.g. a number where a uuid string is required) is a
// NAMED decode failure, not a silent coercion.
// ---------------------------------------------------------------------------

/** Provenance envelope shared by conversation/system/attachment records. */
const EnvelopeFields = {
  uuid: Schema.optional(Schema.String),
  parentUuid: Schema.optional(Schema.NullOr(Schema.String)),
  sessionId: Schema.optional(Schema.String),
  agentId: Schema.optional(Schema.String),
  timestamp: Schema.optional(Schema.String),
  cwd: Schema.optional(Schema.String),
  gitBranch: Schema.optional(Schema.NullOr(Schema.String)),
  isSidechain: Schema.optional(Schema.Boolean),
  isMeta: Schema.optional(Schema.Boolean),
  userType: Schema.optional(Schema.String),
  version: Schema.optional(Schema.String),
} as const;

// ---------------------------------------------------------------------------
// Conversation records: user / assistant
//
// `message.content` is polymorphic: a bare string OR an array of typed content
// blocks (text / thinking / tool_use / tool_result / image / file / document).
// We accept the loose `Unknown` for content because the adapter has its own
// rigorous block projection (claudeContentProjection); the schema's job here is
// to assert the RECORD shape (a real message envelope with a role), not to
// re-validate every block. `message` itself and `role` ARE load-bearing and are
// required so a role-less / message-less impostor is dropped.
// ---------------------------------------------------------------------------

const ClaudeMessageSchema = Schema.Struct({
  role: Schema.String,
  content: Schema.Unknown,
  model: Schema.optional(Schema.NullOr(Schema.String)),
  usage: Schema.optional(Schema.Unknown),
});

export const ClaudeUserRecordSchema = Schema.Struct({
  type: Schema.Literal("user"),
  message: ClaudeMessageSchema,
  ...EnvelopeFields,
});
export type ClaudeUserRecord = typeof ClaudeUserRecordSchema.Type;

export const ClaudeAssistantRecordSchema = Schema.Struct({
  type: Schema.Literal("assistant"),
  message: ClaudeMessageSchema,
  ...EnvelopeFields,
});
export type ClaudeAssistantRecord = typeof ClaudeAssistantRecordSchema.Type;

// ---------------------------------------------------------------------------
// system records — discriminated by `subtype`
// ---------------------------------------------------------------------------

const SystemBase = {
  type: Schema.Literal("system"),
  content: Schema.optional(Schema.NullOr(Schema.String)),
  level: Schema.optional(Schema.NullOr(Schema.String)),
  ...EnvelopeFields,
} as const;

export const ClaudeSystemTurnDurationSchema = Schema.Struct({
  ...SystemBase,
  subtype: Schema.Literal("turn_duration"),
  durationMs: Schema.optional(Schema.Number),
  messageCount: Schema.optional(Schema.Number),
});

export const ClaudeSystemAwaySummarySchema = Schema.Struct({
  ...SystemBase,
  subtype: Schema.Literal("away_summary"),
  content: Schema.String,
});

export const ClaudeSystemStopHookSummarySchema = Schema.Struct({
  ...SystemBase,
  subtype: Schema.Literal("stop_hook_summary"),
  stopReason: Schema.optional(Schema.NullOr(Schema.String)),
  hookCount: Schema.optional(Schema.Number),
});

export const ClaudeSystemLocalCommandSchema = Schema.Struct({
  ...SystemBase,
  subtype: Schema.Literal("local_command"),
  content: Schema.String,
});

export const ClaudeSystemCompactBoundarySchema = Schema.Struct({
  ...SystemBase,
  subtype: Schema.Literal("compact_boundary"),
  content: Schema.String,
});

export const ClaudeSystemApiErrorSchema = Schema.Struct({
  ...SystemBase,
  subtype: Schema.Literal("api_error"),
  error: Schema.optional(Schema.NullOr(Schema.String)),
});

export const ClaudeSystemScheduledTaskFireSchema = Schema.Struct({
  ...SystemBase,
  subtype: Schema.Literal("scheduled_task_fire"),
  content: Schema.String,
});

export const ClaudeSystemInformationalSchema = Schema.Struct({
  ...SystemBase,
  subtype: Schema.Literal("informational"),
  content: Schema.String,
});

/** Every modeled system subtype. */
export type ClaudeSystemSubtype =
  | "turn_duration"
  | "away_summary"
  | "stop_hook_summary"
  | "local_command"
  | "compact_boundary"
  | "api_error"
  | "scheduled_task_fire"
  | "informational";

// ---------------------------------------------------------------------------
// attachment records — discriminated by `attachment.type`
//
// The envelope is the same provenance shape; the discriminating subtype lives
// at `.attachment.type`. We model the attachment inner struct loosely (only its
// `type` is load-bearing for dispatch) but REQUIRE the inner `type` string so a
// malformed attachment (no inner type) is dropped, not silently passed.
// ---------------------------------------------------------------------------

const AttachmentInner = (subtype: string) =>
  Schema.Struct({ type: Schema.Literal(subtype) }).pipe(
    Schema.extend(Schema.Record({ key: Schema.String, value: Schema.Unknown })),
  );

const attachmentSchema = (subtype: string) =>
  Schema.Struct({
    type: Schema.Literal("attachment"),
    attachment: AttachmentInner(subtype),
    slug: Schema.optional(Schema.NullOr(Schema.String)),
    entrypoint: Schema.optional(Schema.NullOr(Schema.String)),
    ...EnvelopeFields,
  });

/** Every modeled attachment subtype. */
export type ClaudeAttachmentSubtype =
  | "deferred_tools_delta"
  | "skill_listing"
  | "task_reminder"
  | "queued_command"
  | "command_permissions"
  | "agent_listing_delta"
  | "edited_text_file"
  | "ultra_effort_enter"
  | "ultra_effort_exit"
  | "file"
  | "goal_status"
  | "date_change"
  | "hook_success"
  | "plan_mode"
  | "plan_mode_exit"
  | "plan_mode_reentry"
  | "workflow_keyword_request"
  | "budget_usd"
  | "invoked_skills"
  | "plan_file_reference"
  | "compact_file_reference"
  | "directory";

/**
 * Per-attachment-subtype verdict: subtypes carrying real user/assistant content
 * (a queued prompt, an edited/attached file, a plan/skill body, a hook command
 * + its output) are SIGNAL; pure harness bookkeeping (capability deltas, status
 * pings, budget/effort markers) is DROP with a named reason. This is the
 * declarative table — there is no fall-through.
 */
const ATTACHMENT_VERDICT: Record<
  ClaudeAttachmentSubtype,
  { readonly kind: "message" } | { readonly reason: string }
> = {
  // Real user/assistant-facing content → signal as a message.
  queued_command: { kind: "message" },
  edited_text_file: { kind: "message" },
  file: { kind: "message" },
  directory: { kind: "message" },
  plan_file_reference: { kind: "message" },
  compact_file_reference: { kind: "message" },
  skill_listing: { kind: "message" },
  invoked_skills: { kind: "message" },
  hook_success: { kind: "message" },
  // Pure harness bookkeeping → drop with a named reason.
  deferred_tools_delta: { reason: "harness bookkeeping: tool-availability delta" },
  task_reminder: { reason: "harness bookkeeping: todo/task reminder injection" },
  command_permissions: { reason: "harness bookkeeping: allowed-tools permission set" },
  agent_listing_delta: { reason: "harness bookkeeping: agent-availability delta" },
  goal_status: { reason: "harness bookkeeping: sentinel goal status ping" },
  date_change: { reason: "harness bookkeeping: wall-clock date rollover" },
  ultra_effort_enter: { reason: "harness bookkeeping: effort-mode enter marker" },
  ultra_effort_exit: { reason: "harness bookkeeping: effort-mode exit marker" },
  plan_mode: { reason: "harness bookkeeping: plan-mode enter reminder" },
  plan_mode_exit: { reason: "harness bookkeeping: plan-mode exit marker" },
  plan_mode_reentry: { reason: "harness bookkeeping: plan-mode reentry marker" },
  workflow_keyword_request: { reason: "harness bookkeeping: workflow keyword request" },
  budget_usd: { reason: "harness bookkeeping: spend budget snapshot" },
};

// ---------------------------------------------------------------------------
// file-history-snapshot
// ---------------------------------------------------------------------------

export const ClaudeFileHistorySnapshotSchema = Schema.Struct({
  type: Schema.Literal("file-history-snapshot"),
  messageId: Schema.optional(Schema.NullOr(Schema.String)),
  isSnapshotUpdate: Schema.optional(Schema.Boolean),
  snapshot: Schema.Unknown,
});
export type ClaudeFileHistorySnapshot = typeof ClaudeFileHistorySnapshotSchema.Type;

// ---------------------------------------------------------------------------
// session-scoped bookkeeping records (all carry a sessionId, no conversation)
// ---------------------------------------------------------------------------

export const ClaudeLastPromptSchema = Schema.Struct({
  type: Schema.Literal("last-prompt"),
  sessionId: Schema.String,
  lastPrompt: Schema.optional(Schema.NullOr(Schema.String)),
  leafUuid: Schema.optional(Schema.NullOr(Schema.String)),
});

export const ClaudeModeSchema = Schema.Struct({
  type: Schema.Literal("mode"),
  sessionId: Schema.String,
  mode: Schema.optional(Schema.NullOr(Schema.String)),
});

export const ClaudePermissionModeSchema = Schema.Struct({
  type: Schema.Literal("permission-mode"),
  sessionId: Schema.String,
  permissionMode: Schema.optional(Schema.NullOr(Schema.String)),
});

export const ClaudeAiTitleSchema = Schema.Struct({
  type: Schema.Literal("ai-title"),
  sessionId: Schema.String,
  aiTitle: Schema.optional(Schema.NullOr(Schema.String)),
});

export const ClaudeQueueOperationSchema = Schema.Struct({
  type: Schema.Literal("queue-operation"),
  sessionId: Schema.String,
  operation: Schema.optional(Schema.NullOr(Schema.String)),
  content: Schema.optional(Schema.NullOr(Schema.String)),
  timestamp: Schema.optional(Schema.String),
});

export const ClaudeAgentSettingSchema = Schema.Struct({
  type: Schema.Literal("agent-setting"),
  sessionId: Schema.String,
  agentSetting: Schema.Unknown,
});

export const ClaudeAgentNameSchema = Schema.Struct({
  type: Schema.Literal("agent-name"),
  sessionId: Schema.String,
  agentName: Schema.optional(Schema.NullOr(Schema.String)),
});

// ---------------------------------------------------------------------------
// Diagnostic names (stable, attributable). One per major decode site.
// ---------------------------------------------------------------------------

export const CLAUDE_USER_DECODE_FAILED = "claude.user.decode_failed";
export const CLAUDE_ASSISTANT_DECODE_FAILED = "claude.assistant.decode_failed";
export const CLAUDE_SYSTEM_DECODE_FAILED = "claude.system.decode_failed";
export const CLAUDE_ATTACHMENT_DECODE_FAILED = "claude.attachment.decode_failed";
export const CLAUDE_SNAPSHOT_DECODE_FAILED = "claude.file_history_snapshot.decode_failed";
export const CLAUDE_BOOKKEEPING_DECODE_FAILED = "claude.bookkeeping.decode_failed";
export const CLAUDE_UNKNOWN_TYPE = "claude.unknown_type";
export const CLAUDE_UNKNOWN_SYSTEM_SUBTYPE = "claude.system.unknown_subtype";
export const CLAUDE_UNKNOWN_ATTACHMENT_SUBTYPE = "claude.attachment.unknown_subtype";

// ---------------------------------------------------------------------------
// The kind a successfully-decoded record is signalled under.
// ---------------------------------------------------------------------------

export type ClaudeKind =
  | "message"
  | "tool_call"
  | "tool_result"
  | "reasoning"
  | "system"
  | "summary"
  | "snapshot"
  | "lifecycle";

const recordOf = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};

/**
 * For a decoded user/assistant message, the conversation kind is derived from
 * the content blocks: a tool_result block → tool_result, a tool_use block →
 * tool_call, an assistant thinking-only block → reasoning, else message. This is
 * the DECLARATIVE replacement for the old ad-hoc `claudeKindFrom` +
 * `kindFromNative` heuristic, applied locally to a SCHEMA-DECODED record.
 */
export const claudeMessageKind = (
  role: string,
  content: unknown,
): "message" | "tool_call" | "tool_result" | "reasoning" => {
  if (Array.isArray(content)) {
    const types = content.map((block) => recordOf(block).type);
    if (types.includes("tool_result")) return "tool_result";
    if (types.includes("tool_use")) return "tool_call";
    if (role === "assistant" && types.includes("thinking") && !types.includes("text")) {
      return "reasoning";
    }
  }
  return "message";
};

const SYSTEM_SCHEMA: Record<ClaudeSystemSubtype, Schema.Schema<unknown, unknown>> = {
  turn_duration: ClaudeSystemTurnDurationSchema as unknown as Schema.Schema<unknown, unknown>,
  away_summary: ClaudeSystemAwaySummarySchema as unknown as Schema.Schema<unknown, unknown>,
  stop_hook_summary: ClaudeSystemStopHookSummarySchema as unknown as Schema.Schema<unknown, unknown>,
  local_command: ClaudeSystemLocalCommandSchema as unknown as Schema.Schema<unknown, unknown>,
  compact_boundary: ClaudeSystemCompactBoundarySchema as unknown as Schema.Schema<unknown, unknown>,
  api_error: ClaudeSystemApiErrorSchema as unknown as Schema.Schema<unknown, unknown>,
  scheduled_task_fire: ClaudeSystemScheduledTaskFireSchema as unknown as Schema.Schema<unknown, unknown>,
  informational: ClaudeSystemInformationalSchema as unknown as Schema.Schema<unknown, unknown>,
};

/**
 * system subtype verdicts. Subtypes carrying real model/user prose
 * (away_summary, local_command, scheduled_task_fire, informational) and the
 * conversation-shaping compact_boundary are SIGNAL; pure telemetry
 * (turn_duration, stop_hook_summary, api_error) is DROP with a named reason.
 */
const SYSTEM_VERDICT: Record<
  ClaudeSystemSubtype,
  { readonly kind: ClaudeKind } | { readonly reason: string }
> = {
  away_summary: { kind: "summary" },
  scheduled_task_fire: { kind: "message" },
  informational: { kind: "system" },
  local_command: { kind: "message" },
  compact_boundary: { kind: "summary" },
  turn_duration: { reason: "harness telemetry: per-turn duration metric" },
  stop_hook_summary: { reason: "harness telemetry: stop-hook execution summary" },
  api_error: { reason: "harness telemetry: provider api error/retry record" },
};

/** Validate a bookkeeping record then drop it with a named reason. */
const bookkeepingDrop = <A, I>(
  schema: Schema.Schema<A, I>,
  record: unknown,
  reason: string,
  diagnostics?: DecodeDiagnostic[],
): SignalDecision<unknown, ClaudeKind> => {
  const decision = decodeOrDrop(schema, record, {
    kind: "system" as const,
    diagnosticName: CLAUDE_BOOKKEEPING_DECODE_FAILED,
    diagnostics,
  });
  if (decision._tag === "drop") return decision;
  return drop(reason);
};

const classifySystem = (
  raw: Record<string, unknown>,
  record: unknown,
  diagnostics?: DecodeDiagnostic[],
): SignalDecision<unknown, ClaudeKind> => {
  const subtype = typeof raw.subtype === "string" ? raw.subtype : undefined;
  if (subtype === undefined || !(subtype in SYSTEM_SCHEMA)) {
    diagnostics?.push({
      name: CLAUDE_UNKNOWN_SYSTEM_SUBTYPE,
      message: `Unmodeled claude system subtype: ${String(subtype)}`,
    });
    return drop(`${CLAUDE_UNKNOWN_SYSTEM_SUBTYPE}: ${String(subtype)}`);
  }
  const key = subtype as ClaudeSystemSubtype;
  const verdict = SYSTEM_VERDICT[key];
  const kind = "kind" in verdict ? verdict.kind : ("system" as const);
  const decision = decodeOrDrop(SYSTEM_SCHEMA[key], record, {
    kind,
    diagnosticName: CLAUDE_SYSTEM_DECODE_FAILED,
    diagnostics,
  });
  if (decision._tag === "drop") return decision;
  if ("reason" in verdict) return drop(verdict.reason);
  return decision;
};

const classifyAttachment = (
  raw: Record<string, unknown>,
  record: unknown,
  diagnostics?: DecodeDiagnostic[],
): SignalDecision<unknown, ClaudeKind> => {
  const inner = recordOf(raw.attachment);
  const subtype = typeof inner.type === "string" ? inner.type : undefined;
  if (subtype === undefined || !(subtype in ATTACHMENT_VERDICT)) {
    diagnostics?.push({
      name: CLAUDE_UNKNOWN_ATTACHMENT_SUBTYPE,
      message: `Unmodeled claude attachment subtype: ${String(subtype)}`,
    });
    return drop(`${CLAUDE_UNKNOWN_ATTACHMENT_SUBTYPE}: ${String(subtype)}`);
  }
  const key = subtype as ClaudeAttachmentSubtype;
  const verdict = ATTACHMENT_VERDICT[key];
  const decision = decodeOrDrop(attachmentSchema(subtype), record, {
    kind: "message" as const,
    diagnosticName: CLAUDE_ATTACHMENT_DECODE_FAILED,
    diagnostics,
  });
  if (decision._tag === "drop") return decision;
  if ("reason" in verdict) return drop(verdict.reason);
  return decision;
};

/**
 * THE declarative dispatch. Every on-disk record is routed to exactly one
 * decode site and gets an explicit signal(kind)/drop(reason) verdict. There is
 * no `unknown` pass-through: an unmodeled top-level type, an unmodeled
 * system/attachment subtype, and any decode failure ALL become a named drop.
 */
export const classifyClaudeRecord = (
  record: unknown,
  diagnostics?: DecodeDiagnostic[],
): SignalDecision<unknown, ClaudeKind> => {
  const raw = recordOf(record);
  const type = typeof raw.type === "string" ? raw.type : undefined;

  switch (type) {
    case "user": {
      const decision = decodeOrDrop(ClaudeUserRecordSchema, record, {
        kind: "message" as const,
        diagnosticName: CLAUDE_USER_DECODE_FAILED,
        diagnostics,
      });
      if (decision._tag === "drop") return decision;
      const r = decision.value as ClaudeUserRecord;
      return { _tag: "signal", kind: claudeMessageKind(r.message.role, r.message.content), value: r };
    }
    case "assistant": {
      const decision = decodeOrDrop(ClaudeAssistantRecordSchema, record, {
        kind: "message" as const,
        diagnosticName: CLAUDE_ASSISTANT_DECODE_FAILED,
        diagnostics,
      });
      if (decision._tag === "drop") return decision;
      const r = decision.value as ClaudeAssistantRecord;
      return { _tag: "signal", kind: claudeMessageKind(r.message.role, r.message.content), value: r };
    }
    case "system":
      return classifySystem(raw, record, diagnostics);
    case "attachment":
      return classifyAttachment(raw, record, diagnostics);
    case "file-history-snapshot":
      return decodeOrDrop(ClaudeFileHistorySnapshotSchema, record, {
        kind: "snapshot" as const,
        diagnosticName: CLAUDE_SNAPSHOT_DECODE_FAILED,
        diagnostics,
      });
    case "ai-title":
      return decodeOrDrop(ClaudeAiTitleSchema, record, {
        kind: "summary" as const,
        diagnosticName: CLAUDE_BOOKKEEPING_DECODE_FAILED,
        diagnostics,
      });
    // Session-scoped bookkeeping carrying no conversation content. Each is
    // schema-validated (so a malformed one is a named drop) then dropped with a
    // named bookkeeping reason — explicit, never an "unknown" pass-through.
    case "last-prompt":
      return bookkeepingDrop(ClaudeLastPromptSchema, record, "session ui state: last prompt", diagnostics);
    case "mode":
      return bookkeepingDrop(ClaudeModeSchema, record, "session ui state: editor mode", diagnostics);
    case "permission-mode":
      return bookkeepingDrop(ClaudePermissionModeSchema, record, "session ui state: permission mode", diagnostics);
    case "queue-operation":
      return bookkeepingDrop(ClaudeQueueOperationSchema, record, "session ui state: prompt queue operation", diagnostics);
    case "agent-setting":
      return bookkeepingDrop(ClaudeAgentSettingSchema, record, "session ui state: agent setting", diagnostics);
    case "agent-name":
      return bookkeepingDrop(ClaudeAgentNameSchema, record, "session ui state: agent name", diagnostics);
    default:
      diagnostics?.push({
        name: CLAUDE_UNKNOWN_TYPE,
        message: `Unmodeled claude record type: ${String(type)}`,
      });
      return drop(`${CLAUDE_UNKNOWN_TYPE}: ${String(type)}`);
  }
};
