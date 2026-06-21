import { Schema } from "effect";

import { type DecodeDiagnostic, decodeOrDrop, isSignal, type SignalDecision } from "./harness-schema";

// ---------------------------------------------------------------------------
// On-disk row + record schemas (QSR-220 FULL DATA FIDELITY fail-closed boundary)
//
// Grounded against the real ~/.local/share/opencode/{opencode.db,
// opencode-local.db} `.schema` and a full census of every distinct
// `message.data.role` and `part.data.type` discriminator present on disk
// (both DB generations, measured 2026-06-21):
//
//   session: id TEXT PRIMARY KEY, project_id TEXT NOT NULL, directory TEXT
//            NOT NULL, title TEXT NOT NULL, time_created INTEGER NOT NULL,
//            time_updated INTEGER NOT NULL; parent_id TEXT (nullable, the
//            subagent's own parent ses_ id), agent TEXT (nullable, the named
//            subagent role), path TEXT (nullable, newer DBs only).
//   message: id TEXT PRIMARY KEY, time_created INTEGER, data TEXT (JSON blob),
//            plus an adapter-projected raw_bytes (pre-prune byte length).
//            data.role census: { user, assistant } — EXHAUSTIVE on disk.
//   part:    id TEXT, message_id TEXT, time_created INTEGER, data TEXT (JSON).
//            data.type census: { text, reasoning, tool, step-start,
//            step-finish, compaction, patch, file } — EXHAUSTIVE on disk.
//
// Every record is routed through `decodeOrDrop` (harness-schema.ts): a
// malformed/garbage record becomes a NAMED diagnostic + a dropped record —
// never a throw that aborts the file, never a silently coerced half-row. Every
// part type and message role is EXPLICITLY classified as either signal(kind) or
// drop(named reason); an unrecognised type/role is itself a NAMED drop, never an
// "unknown" pass-through. Data structures are the project: a model rambling
// (e.g. a bare `{"type":"reasoning"}` envelope) must never be mistaken for a
// legitimate response.
//
// Effect ignores excess columns/keys by default, so the schemas are lenient
// about extra provider fields but strict about the load-bearing
// identity/ordering/discriminator fields.
// ---------------------------------------------------------------------------

/** A SQLite TEXT column that may be absent or NULL. */
const NullableText = Schema.optional(Schema.NullOr(Schema.String));
/** A SQLite numeric (INTEGER/REAL) column that may be absent or NULL. */
const NullableNumeric = Schema.optional(Schema.NullOr(Schema.Number));

export const OpenCodeSessionRowSchema = Schema.Struct({
  // session.id is TEXT PRIMARY KEY — the load-bearing native id.
  id: Schema.String,
  // title/directory are NOT NULL TEXT; the ordering key time_updated is NOT NULL.
  title: Schema.String,
  directory: Schema.String,
  time_created: Schema.Number,
  time_updated: Schema.Number,
  // path is nullable and only present on newer DBs; the SELECT aliases
  // path|directory to this column, so it is always a string in practice but
  // declared nullable for the boundary.
  path: NullableText,
  // parent_id: the subagent's own parent ses_ id (NULL for a root session).
  parent_id: NullableText,
  // agent: the named subagent role (NULL on root sessions and older DBs).
  agent: NullableText,
});

export const OpenCodeMessageRowSchema = Schema.Struct({
  // message.id is TEXT PRIMARY KEY.
  id: Schema.String,
  // time_created is the ordering key.
  time_created: Schema.Number,
  // data is the JSON message envelope (post-prune projection).
  data: Schema.String,
  // raw_bytes is the adapter-projected pre-prune byte length.
  raw_bytes: NullableNumeric,
});

export type OpenCodeSessionRow = typeof OpenCodeSessionRowSchema.Type;
export type OpenCodeMessageRow = typeof OpenCodeMessageRowSchema.Type;

/** Raw reads return UNVALIDATED rows; decoding happens at the boundary. */
export type OpenCodeRawRow = Record<string, unknown>;

const OPENCODE_ROW_DIAGNOSTIC = "opencode.row.decode_failed" as const;
const OPENCODE_PART_DIAGNOSTIC = "opencode.part.decode_failed" as const;
const OPENCODE_MESSAGE_PAYLOAD_DIAGNOSTIC = "opencode.message.decode_failed" as const;

/**
 * Decode the raw session-window rows fail-closed: valid rows pass through,
 * malformed rows become a named diagnostic in `diagnostics` and are dropped
 * from the window.
 */
export const decodeSessionRows = (
  rows: readonly OpenCodeRawRow[],
  diagnostics: DecodeDiagnostic[],
): OpenCodeSessionRow[] =>
  rows.flatMap((row) => {
    const decision = decodeOrDrop(OpenCodeSessionRowSchema, row, {
      kind: "session" as const,
      diagnosticName: OPENCODE_ROW_DIAGNOSTIC,
      diagnostics,
    });
    return isSignal(decision) ? [decision.value] : [];
  });

/** Decode the raw message rows for a session fail-closed; drops are named. */
export const decodeMessageRows = (
  rows: readonly OpenCodeRawRow[],
  diagnostics: DecodeDiagnostic[],
): OpenCodeMessageRow[] =>
  rows.flatMap((row) => {
    const decision = decodeOrDrop(OpenCodeMessageRowSchema, row, {
      kind: "message" as const,
      diagnosticName: OPENCODE_ROW_DIAGNOSTIC,
      diagnostics,
    });
    return isSignal(decision) ? [decision.value] : [];
  });

// ---------------------------------------------------------------------------
// message.data payload — declarative role classification
// ---------------------------------------------------------------------------

const NestedTime = Schema.optional(
  Schema.NullOr(
    Schema.Struct({
      created: NullableNumeric,
      start: NullableNumeric,
      end: NullableNumeric,
    }),
  ),
);

/**
 * A user-authored turn. `summary` carries the (already SQL-pruned) compaction
 * summary envelope; the adapter further narrows it to the allow-listed text
 * keys. Extra provider fields (agent, model, …) are tolerated.
 */
export const OpenCodeUserMessageSchema = Schema.Struct({
  role: Schema.Literal("user"),
  time: NestedTime,
});

/**
 * An assistant turn. Token/cost accounting + model identity ride here; the
 * adapter projects them into the usage record. Extra provider fields
 * (path, finish, mode, variant, …) are tolerated.
 */
export const OpenCodeAssistantMessageSchema = Schema.Struct({
  role: Schema.Literal("assistant"),
  time: NestedTime,
});

/**
 * The full message-payload census discriminated on `role`. A payload whose
 * role is neither `user` nor `assistant` fails to decode and becomes a NAMED
 * drop — never an "unknown" pass-through turn.
 */
export const OpenCodeMessagePayloadSchema = Schema.Union(
  OpenCodeUserMessageSchema,
  OpenCodeAssistantMessageSchema,
);

export type OpenCodeMessagePayload = typeof OpenCodeMessagePayloadSchema.Type;

/** Mapped message-payload kinds. Every role resolves to exactly one. */
export type OpenCodeMessageKind = "user_message" | "assistant_message";

/**
 * Classify a parsed `message.data` payload fail-closed. The role discriminator
 * is exhaustive against the on-disk census; an unrecognised role decodes to a
 * NAMED drop rather than silently becoming a `role: "unknown"` envelope dump.
 */
export const classifyOpenCodeMessage = (
  payload: unknown,
  diagnostics?: DecodeDiagnostic[],
): SignalDecision<OpenCodeMessagePayload, OpenCodeMessageKind> => {
  const decision = decodeOrDrop(OpenCodeMessagePayloadSchema, payload, {
    kind: "message" as const,
    diagnosticName: OPENCODE_MESSAGE_PAYLOAD_DIAGNOSTIC,
    diagnostics,
  });
  if (!isSignal(decision)) return decision;
  const kind: OpenCodeMessageKind =
    decision.value.role === "user" ? "user_message" : "assistant_message";
  return { _tag: "signal", kind, value: decision.value };
};

// ---------------------------------------------------------------------------
// part.data — full per-type schema census + declarative signal/drop dispatch
//
// Every part type on disk gets a rigorous schema. The classifier returns, for
// EVERY part, one of:
//   signal("message")     — visible assistant/user text (type=text)
//   signal("reasoning")   — plaintext thinking (type=reasoning)
//   signal("tool_call")   — an in-flight tool invocation (tool, state≠terminal)
//   signal("tool_result") — a settled tool invocation (tool, state terminal)
//   signal("artifact")    — a code change record (patch)
//   drop("opencode.part.<type>.machinery") — lifecycle/attachment machinery
//   drop("opencode.part.decode_failed: …") — a malformed/unknown-type part
// There is NO unknown pass-through arm.
// ---------------------------------------------------------------------------

const PartTime = Schema.optional(
  Schema.NullOr(
    Schema.Struct({ start: NullableNumeric, end: NullableNumeric }),
  ),
);

/** type=text: visible model/user prose. `text` is the load-bearing field. */
export const OpenCodeTextPartSchema = Schema.Struct({
  type: Schema.Literal("text"),
  text: Schema.String,
});

/** type=reasoning: plaintext thinking. Encrypted reasoning rides in metadata. */
export const OpenCodeReasoningPartSchema = Schema.Struct({
  type: Schema.Literal("reasoning"),
  text: Schema.String,
  time: PartTime,
});

const ToolState = Schema.Struct({
  status: Schema.optional(Schema.NullOr(Schema.String)),
  input: Schema.optional(Schema.Unknown),
  output: Schema.optional(Schema.Unknown),
  time: PartTime,
});

/** type=tool: a tool invocation with a state envelope (status/input/output). */
export const OpenCodeToolPartSchema = Schema.Struct({
  type: Schema.Literal("tool"),
  // `tool` is the tool name; `callID` correlates the call to its result.
  tool: Schema.String,
  callID: Schema.optional(Schema.NullOr(Schema.String)),
  state: Schema.optional(Schema.NullOr(ToolState)),
});

/** type=step-start: an LLM step lifecycle marker. Pure machinery. */
export const OpenCodeStepStartPartSchema = Schema.Struct({
  type: Schema.Literal("step-start"),
});

/** type=step-finish: per-step token/cost accounting. Machinery, not a turn. */
export const OpenCodeStepFinishPartSchema = Schema.Struct({
  type: Schema.Literal("step-finish"),
  reason: Schema.optional(Schema.NullOr(Schema.String)),
  cost: NullableNumeric,
});

/** type=compaction: a context-window compaction marker. Machinery. */
export const OpenCodeCompactionPartSchema = Schema.Struct({
  type: Schema.Literal("compaction"),
  auto: Schema.optional(Schema.NullOr(Schema.Boolean)),
  tail_start_id: Schema.optional(Schema.NullOr(Schema.String)),
});

/** type=file: a file attachment reference. Machinery (surfaced elsewhere). */
export const OpenCodeFilePartSchema = Schema.Struct({
  type: Schema.Literal("file"),
  filename: Schema.optional(Schema.NullOr(Schema.String)),
  mime: Schema.optional(Schema.NullOr(Schema.String)),
  url: Schema.optional(Schema.NullOr(Schema.String)),
});

/** type=patch: a code change record. Signal — surfaced as an artifact, not as turn text. */
export const OpenCodePatchPartSchema = Schema.Struct({
  type: Schema.Literal("patch"),
  hash: Schema.optional(Schema.NullOr(Schema.String)),
  files: Schema.optional(Schema.Unknown),
});

/** The full part-type census discriminated on `type`. */
export const OpenCodePartSchema = Schema.Union(
  OpenCodeTextPartSchema,
  OpenCodeReasoningPartSchema,
  OpenCodeToolPartSchema,
  OpenCodeStepStartPartSchema,
  OpenCodeStepFinishPartSchema,
  OpenCodeCompactionPartSchema,
  OpenCodeFilePartSchema,
  OpenCodePatchPartSchema,
);

export type OpenCodePart = typeof OpenCodePartSchema.Type;

/** Mapped part kinds: the signal arm of the per-type dispatch. */
export type OpenCodePartKind =
  | "message"
  | "reasoning"
  | "tool_call"
  | "tool_result"
  | "artifact";

/**
 * Tool state statuses that are TERMINAL — the call has settled, so the part is
 * a tool_result. Anything else (running, queued, absent) is an in-flight
 * tool_call. Grounded against the on-disk census: { completed, error, running }.
 */
const TERMINAL_TOOL_STATUSES = new Set(["completed", "error"]);

/**
 * Declarative per-record-type dispatch for an OpenCode `part.data` payload,
 * fail-closed. EVERY part type resolves to exactly one explicit outcome:
 *   - text       -> signal("message")
 *   - reasoning  -> signal("reasoning")
 *   - tool       -> signal("tool_result") if state is terminal else signal("tool_call")
 *   - patch      -> signal("artifact")
 *   - step-start | step-finish | compaction | file -> drop(named machinery reason)
 * A part that fails to decode (malformed shape OR an unrecognised `type`) is a
 * NAMED drop via `decodeOrDrop` — there is no unknown pass-through.
 */
export const classifyOpenCodePart = (
  payload: unknown,
  diagnostics?: DecodeDiagnostic[],
): SignalDecision<OpenCodePart, OpenCodePartKind> => {
  const decision = decodeOrDrop(OpenCodePartSchema, payload, {
    kind: "part" as const,
    diagnosticName: OPENCODE_PART_DIAGNOSTIC,
    diagnostics,
  });
  if (!isSignal(decision)) return decision;
  const part = decision.value;
  switch (part.type) {
    case "text":
      return { _tag: "signal", kind: "message", value: part };
    case "reasoning":
      return { _tag: "signal", kind: "reasoning", value: part };
    case "tool": {
      const status =
        part.state !== null && part.state !== undefined ? part.state.status ?? undefined : undefined;
      const kind: OpenCodePartKind =
        status !== undefined && TERMINAL_TOOL_STATUSES.has(status) ? "tool_result" : "tool_call";
      return { _tag: "signal", kind, value: part };
    }
    case "patch":
      return { _tag: "signal", kind: "artifact", value: part };
    case "step-start":
      return { _tag: "drop", reason: "opencode.part.step-start.machinery" };
    case "step-finish":
      return { _tag: "drop", reason: "opencode.part.step-finish.machinery" };
    case "compaction":
      return { _tag: "drop", reason: "opencode.part.compaction.machinery" };
    case "file":
      return { _tag: "drop", reason: "opencode.part.file.machinery" };
  }
};
