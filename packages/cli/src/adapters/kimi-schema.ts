import { Schema } from "effect";

/**
 * FULL on-disk data-fidelity schema for the Kimi adapter (QSR-220).
 *
 * The entire Kimi wire format is `~/.kimi-code/sessions/<wd>/<session>/agents/
 * <id>/wire.jsonl`: one JSON object per line, discriminated by a string `type`.
 * This module models EVERY distinct on-disk record type that occurs there, plus
 * the inner discriminators of the one polymorphic outer type
 * (`context.append_loop_event`), as rigorous, fail-closed Effect Schemas. The
 * classifier `classifyKimiRecord` then declares, for every record type, whether
 * it is SIGNAL (kept under a mapped kind) or DROP (discarded with a NAMED
 * reason). There is NO unknown pass-through: an outer `type` the schema does not
 * recognise is itself a drop with a named reason, and a record that fails its
 * per-type schema becomes a named decode diagnostic + drop at the boundary.
 *
 * Grounded against the real corpus (measured 2026-06-21): 23 outer types and 5
 * inner loop-event kinds (content.part — text|think — , tool.call, tool.result,
 * step.begin, step.end). Counts of each type informed which fields are required
 * vs optional and which records carry transcript signal vs lifecycle noise.
 *
 * Doctrine (AGENTS.md): provider garbage is rejected at the boundary with a
 * named diagnostic, never silently coerced and never thrown in a way that aborts
 * the whole file. Every field declares its expectation; a model rambling (a
 * malformed record) must never be mistaken for a legitimate response.
 */

// ===========================================================================
// Shared field fragments
// ===========================================================================

/** Epoch-ms ordering key. Present on every record except bootstrap `metadata`. */
const Time = Schema.optional(Schema.Number);

// ===========================================================================
// context.append_message — the user/turn input surface
//
// Real corpus: message.role is always "user"; message.origin.kind is one of
// user | injection | system_trigger | skill_activation | background_task.
// content is an array of { type:"text", text }. The origin.kind decides whether
// the record is a genuine user turn (signal: message) or an injected/triggered
// preamble (signal: preamble) — never dropped, the content is always transcript.
// ===========================================================================

const KimiMessageOrigin = Schema.Struct({
  kind: Schema.optional(Schema.String),
});

const KimiMessage = Schema.Struct({
  role: Schema.String,
  content: Schema.optional(Schema.Array(Schema.Unknown)),
  origin: Schema.optional(KimiMessageOrigin),
});

export const KimiAppendMessage = Schema.Struct({
  type: Schema.Literal("context.append_message"),
  time: Time,
  message: KimiMessage,
  // Some early records carried a top-level origin instead of message.origin.
  origin: Schema.optional(Schema.Union(KimiMessageOrigin, Schema.Null)),
  originKind: Schema.optional(Schema.Union(Schema.String, Schema.Null)),
});

// ===========================================================================
// context.append_loop_event — the assistant output surface (polymorphic)
//
// The single polymorphic outer type. `event.type` is the inner discriminator:
//   content.part  -> part.type text|think     (signal: message | reasoning)
//   tool.call     -> a tool invocation        (signal: tool_call)
//   tool.result   -> a tool result            (signal: tool_result)
//   step.begin    -> turn-step lifecycle       (drop: loop.step_begin)
//   step.end      -> turn-step lifecycle       (drop: loop.step_end)
// ===========================================================================

const KimiLoopContentPart = Schema.Struct({
  type: Schema.Literal("content.part"),
  part: Schema.Struct({
    type: Schema.String,
    text: Schema.optional(Schema.String),
    think: Schema.optional(Schema.String),
  }),
});

const KimiLoopToolCall = Schema.Struct({
  type: Schema.Literal("tool.call"),
  toolCallId: Schema.optional(Schema.String),
  name: Schema.optional(Schema.String),
  args: Schema.optional(Schema.Unknown),
  description: Schema.optional(Schema.String),
});

const KimiLoopToolResult = Schema.Struct({
  type: Schema.Literal("tool.result"),
  toolCallId: Schema.optional(Schema.String),
  result: Schema.optional(Schema.Unknown),
});

const KimiLoopStepBegin = Schema.Struct({
  type: Schema.Literal("step.begin"),
});

const KimiLoopStepEnd = Schema.Struct({
  type: Schema.Literal("step.end"),
});

/**
 * The inner loop-event union. Excess fields are ignored; the inner `type`
 * literal set is closed — an unrecognised inner type fails decode (and surfaces
 * as a named decode diagnostic rather than a silent unknown).
 */
const KimiLoopEvent = Schema.Union(
  KimiLoopContentPart,
  KimiLoopToolCall,
  KimiLoopToolResult,
  KimiLoopStepBegin,
  KimiLoopStepEnd,
);

export const KimiAppendLoopEvent = Schema.Struct({
  type: Schema.Literal("context.append_loop_event"),
  time: Time,
  event: KimiLoopEvent,
});

// ===========================================================================
// Compaction family — produced summaries + lifecycle markers
// ===========================================================================

export const KimiApplyCompaction = Schema.Struct({
  type: Schema.Literal("context.apply_compaction"),
  time: Time,
  summary: Schema.optional(Schema.String),
  compactedCount: Schema.optional(Schema.Number),
  tokensBefore: Schema.optional(Schema.Number),
  tokensAfter: Schema.optional(Schema.Number),
});

export const KimiMicroCompactionApply = Schema.Struct({
  type: Schema.Literal("micro_compaction.apply"),
  time: Time,
  cutoff: Schema.optional(Schema.Unknown),
});

export const KimiFullCompactionBegin = Schema.Struct({
  type: Schema.Literal("full_compaction.begin"),
  time: Time,
  source: Schema.optional(Schema.Unknown),
});

export const KimiFullCompactionComplete = Schema.Struct({
  type: Schema.Literal("full_compaction.complete"),
  time: Time,
});

// ===========================================================================
// usage.record — token accounting
// ===========================================================================

const KimiUsage = Schema.Struct({
  inputOther: Schema.optional(Schema.Number),
  output: Schema.optional(Schema.Number),
  inputCacheRead: Schema.optional(Schema.Number),
  inputCacheCreation: Schema.optional(Schema.Number),
});

export const KimiUsageRecord = Schema.Struct({
  type: Schema.Literal("usage.record"),
  time: Time,
  model: Schema.optional(Schema.String),
  usage: Schema.optional(KimiUsage),
  usageScope: Schema.optional(Schema.String),
});

// ===========================================================================
// metadata — bootstrap record (NO time)
// ===========================================================================

export const KimiMetadata = Schema.Struct({
  type: Schema.Literal("metadata"),
  protocol_version: Schema.optional(Schema.String),
  created_at: Schema.optional(Schema.Number),
  app_version: Schema.optional(Schema.String),
});

// ===========================================================================
// config / permission / tools / goal / turn / mode lifecycle records
// ===========================================================================

export const KimiConfigUpdate = Schema.Struct({
  type: Schema.Literal("config.update"),
  time: Time,
  profileName: Schema.optional(Schema.String),
  systemPrompt: Schema.optional(Schema.String),
  cwd: Schema.optional(Schema.String),
  modelAlias: Schema.optional(Schema.String),
  thinkingLevel: Schema.optional(Schema.Unknown),
});

export const KimiPermissionSetMode = Schema.Struct({
  type: Schema.Literal("permission.set_mode"),
  time: Time,
  mode: Schema.optional(Schema.String),
});

export const KimiPermissionRecordApprovalResult = Schema.Struct({
  type: Schema.Literal("permission.record_approval_result"),
  time: Time,
  action: Schema.optional(Schema.Unknown),
  result: Schema.optional(Schema.Unknown),
  toolCallId: Schema.optional(Schema.String),
  toolName: Schema.optional(Schema.String),
  turnId: Schema.optional(Schema.String),
});

export const KimiToolsSetActiveTools = Schema.Struct({
  type: Schema.Literal("tools.set_active_tools"),
  time: Time,
  names: Schema.optional(Schema.Array(Schema.Unknown)),
});

export const KimiToolsUpdateStore = Schema.Struct({
  type: Schema.Literal("tools.update_store"),
  time: Time,
  key: Schema.optional(Schema.String),
  value: Schema.optional(Schema.Unknown),
});

export const KimiGoalCreate = Schema.Struct({
  type: Schema.Literal("goal.create"),
  time: Time,
  goalId: Schema.optional(Schema.String),
  objective: Schema.optional(Schema.String),
  completionCriterion: Schema.optional(Schema.String),
});

export const KimiGoalUpdate = Schema.Struct({
  type: Schema.Literal("goal.update"),
  time: Time,
  tokensUsed: Schema.optional(Schema.Number),
  turnsUsed: Schema.optional(Schema.Number),
  actor: Schema.optional(Schema.Unknown),
  status: Schema.optional(Schema.Unknown),
  wallClockMs: Schema.optional(Schema.Number),
});

export const KimiGoalClear = Schema.Struct({
  type: Schema.Literal("goal.clear"),
  time: Time,
});

export const KimiTurnPrompt = Schema.Struct({
  type: Schema.Literal("turn.prompt"),
  time: Time,
  input: Schema.optional(Schema.Unknown),
  origin: Schema.optional(Schema.Unknown),
});

export const KimiTurnSteer = Schema.Struct({
  type: Schema.Literal("turn.steer"),
  time: Time,
  input: Schema.optional(Schema.Unknown),
  origin: Schema.optional(Schema.Unknown),
});

export const KimiTurnCancel = Schema.Struct({
  type: Schema.Literal("turn.cancel"),
  time: Time,
  turnId: Schema.optional(Schema.String),
});

export const KimiSwarmModeEnter = Schema.Struct({
  type: Schema.Literal("swarm_mode.enter"),
  time: Time,
  trigger: Schema.optional(Schema.Unknown),
});

export const KimiSwarmModeExit = Schema.Struct({
  type: Schema.Literal("swarm_mode.exit"),
  time: Time,
});

export const KimiPlanModeEnter = Schema.Struct({
  type: Schema.Literal("plan_mode.enter"),
  time: Time,
  id: Schema.optional(Schema.String),
});

export const KimiPlanModeExit = Schema.Struct({
  type: Schema.Literal("plan_mode.exit"),
  time: Time,
});

// ===========================================================================
// The closed discriminated union of EVERY modeled outer record type.
// ===========================================================================

export const KimiWireRecordSchema = Schema.Union(
  KimiAppendMessage,
  KimiAppendLoopEvent,
  KimiApplyCompaction,
  KimiMicroCompactionApply,
  KimiFullCompactionBegin,
  KimiFullCompactionComplete,
  KimiUsageRecord,
  KimiMetadata,
  KimiConfigUpdate,
  KimiPermissionSetMode,
  KimiPermissionRecordApprovalResult,
  KimiToolsSetActiveTools,
  KimiToolsUpdateStore,
  KimiGoalCreate,
  KimiGoalUpdate,
  KimiGoalClear,
  KimiTurnPrompt,
  KimiTurnSteer,
  KimiTurnCancel,
  KimiSwarmModeEnter,
  KimiSwarmModeExit,
  KimiPlanModeEnter,
  KimiPlanModeExit,
);

export type KimiWireRecord = typeof KimiWireRecordSchema.Type;
export type KimiAppendMessageRecord = typeof KimiAppendMessage.Type;
export type KimiAppendLoopEventRecord = typeof KimiAppendLoopEvent.Type;
export type KimiUsageRecordType = typeof KimiUsageRecord.Type;

// ===========================================================================
// Declarative signal/drop dispatch
//
// One verdict per record type. SIGNAL records carry a semantic kind the adapter
// projects into a transcript event/tool-call/usage row; DROP records carry a
// NAMED reason so the boundary diagnostic is attributable. There is no
// fall-through: the union decode already rejects any unmodeled outer type, and
// every modeled type appears below exactly once.
// ===========================================================================

/** Semantic kinds the Kimi adapter projects a SIGNAL record into. */
export type KimiSignalKind =
  | "message.user"
  | "message.preamble"
  | "assistant.text"
  | "assistant.think"
  | "tool.call"
  | "tool.result"
  | "summary"
  | "usage";

export type KimiClassification =
  | { readonly _tag: "signal"; readonly kind: KimiSignalKind }
  | { readonly _tag: "drop"; readonly reason: string };

const sig = (kind: KimiSignalKind): KimiClassification => ({ _tag: "signal", kind });
const drp = (reason: string): KimiClassification => ({ _tag: "drop", reason });

/**
 * The single source of truth mapping a decoded Kimi record to signal/drop. The
 * exhaustive `switch` over the discriminated union means adding a new outer type
 * to the schema without classifying it is a compile error (no implicit unknown).
 */
export const classifyKimiRecord = (record: KimiWireRecord): KimiClassification => {
  switch (record.type) {
    case "context.append_message": {
      const originKind =
        record.message.origin?.kind ??
        (record.origin && typeof record.origin === "object" ? record.origin.kind : undefined) ??
        (typeof record.originKind === "string" ? record.originKind : undefined);
      // A genuine user turn is origin=user; injected/triggered/skill/background
      // messages are real transcript but not the operator's own turn — preamble.
      return record.message.role === "user" && originKind === "user"
        ? sig("message.user")
        : sig("message.preamble");
    }
    case "context.append_loop_event": {
      const ev = record.event;
      switch (ev.type) {
        case "content.part":
          if (ev.part.type === "text") return sig("assistant.text");
          if (ev.part.type === "think") return sig("assistant.think");
          // A content.part whose part.type is neither text nor think is a
          // future part kind we deliberately do not project as transcript.
          return drp(`loop.content_part.${ev.part.type}`);
        case "tool.call":
          return sig("tool.call");
        case "tool.result":
          return sig("tool.result");
        case "step.begin":
          return drp("loop.step_begin");
        case "step.end":
          return drp("loop.step_end");
      }
    }
    case "context.apply_compaction":
      return sig("summary");
    case "usage.record":
      return sig("usage");
    case "micro_compaction.apply":
      return drp("compaction.micro_apply");
    case "full_compaction.begin":
      return drp("compaction.full_begin");
    case "full_compaction.complete":
      return drp("compaction.full_complete");
    case "metadata":
      return drp("bootstrap.metadata");
    case "config.update":
      return drp("config.update");
    case "permission.set_mode":
      return drp("permission.set_mode");
    case "permission.record_approval_result":
      return drp("permission.record_approval_result");
    case "tools.set_active_tools":
      return drp("tools.set_active_tools");
    case "tools.update_store":
      return drp("tools.update_store");
    case "goal.create":
      return drp("goal.create");
    case "goal.update":
      return drp("goal.update");
    case "goal.clear":
      return drp("goal.clear");
    case "turn.prompt":
      return drp("turn.prompt");
    case "turn.steer":
      return drp("turn.steer");
    case "turn.cancel":
      return drp("turn.cancel");
    case "swarm_mode.enter":
      return drp("swarm_mode.enter");
    case "swarm_mode.exit":
      return drp("swarm_mode.exit");
    case "plan_mode.enter":
      return drp("plan_mode.enter");
    case "plan_mode.exit":
      return drp("plan_mode.exit");
  }
};
