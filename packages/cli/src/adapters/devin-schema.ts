import { Schema } from "effect";

import { type SignalDecision, drop, signal } from "./harness-schema";

const NullableText = Schema.optional(Schema.NullOr(Schema.String));
const NullableNumber = Schema.optional(Schema.NullOr(Schema.Number));
const UnknownRecord = Schema.Record({ key: Schema.String, value: Schema.Unknown });
const NullableUnknownRecord = Schema.optional(Schema.NullOr(UnknownRecord));

/** Exact `sessions` columns read from Devin CLI's local sessions.db. */
export const DevinSessionRowSchema = Schema.Struct({
  id: Schema.String,
  working_directory: Schema.String,
  backend_type: Schema.String,
  model: Schema.String,
  agent_mode: Schema.String,
  created_at: Schema.Number,
  last_activity_at: Schema.Number,
  title: NullableText,
  main_chain_id: Schema.NullOr(Schema.Number),
  shell_last_seen_index: Schema.Number,
  cogs_json: NullableText,
  workspace_dirs: NullableText,
  hidden: Schema.Number,
  metadata: NullableText,
});
export type DevinSessionRow = typeof DevinSessionRowSchema.Type;

/** Exact `message_nodes` columns read for one canonical ancestry node. */
export const DevinMessageNodeRowSchema = Schema.Struct({
  row_id: Schema.Number,
  session_id: Schema.String,
  node_id: Schema.Number,
  parent_node_id: Schema.NullOr(Schema.Number),
  chat_message: Schema.String,
  created_at: Schema.Number,
  metadata: NullableText,
});
export type DevinMessageNodeRow = typeof DevinMessageNodeRowSchema.Type;

/** Lightweight recursive-ancestry row. It deliberately contains no JSON blob. */
export const DevinGraphCoordinateSchema = Schema.Struct({
  node_id: Schema.Number,
  parent_node_id: Schema.NullOr(Schema.Number),
  depth: Schema.Number,
  cycle: Schema.Number,
});
export type DevinGraphCoordinate = typeof DevinGraphCoordinateSchema.Type;

/** JSON stored in sessions.metadata. Costs are retained only at the decode boundary. */
export const DevinSessionMetadataSchema = Schema.Struct({
  total_acu_cost: Schema.optional(Schema.Number),
  total_credit_cost: Schema.optional(Schema.Number),
});
export type DevinSessionMetadata = typeof DevinSessionMetadataSchema.Type;
export const DevinSessionMetadataValueSchema = Schema.NullOr(DevinSessionMetadataSchema);

/** JSON stored in message_nodes.metadata. It describes forest bookkeeping, not prose. */
export const DevinNodeMetadataSchema = Schema.Struct({
  extensions: NullableUnknownRecord,
  is_system_prefix: Schema.optional(Schema.NullOr(Schema.Boolean)),
  num_tokens_preceding: NullableNumber,
  summarized_from: NullableNumber,
});
export type DevinNodeMetadata = typeof DevinNodeMetadataSchema.Type;
export const DevinNodeMetadataValueSchema = Schema.NullOr(DevinNodeMetadataSchema);

const CommonMessageMetadataFields = {
  created_at: Schema.String,
  telemetry: UnknownRecord,
  finish_reason: Schema.optional(Schema.NullOr(Schema.String)),
  is_user_input: Schema.optional(Schema.NullOr(Schema.Boolean)),
  metrics: NullableUnknownRecord,
  num_tokens: NullableNumber,
  request_id: NullableText,
} as const;

export const DevinToolResultMetaSchema = Schema.Struct({
  kind: Schema.String,
  success: Schema.Boolean,
  failure_reason: Schema.optional(Schema.Unknown),
});
export type DevinToolResultMeta = typeof DevinToolResultMetaSchema.Type;

export const DevinToolTimingSchema = Schema.Struct({
  started_at: Schema.String,
  finished_at: Schema.String,
  duration_ms: Schema.Number,
});
export type DevinToolTiming = typeof DevinToolTimingSchema.Type;

export const DevinTerminalOutputSchema = Schema.Struct({
  cwd: Schema.String,
  text: Schema.String,
  original_bytes: Schema.optional(Schema.Number),
  truncated_lines: Schema.optional(Schema.Number),
});
export type DevinTerminalOutput = typeof DevinTerminalOutputSchema.Type;

export const DevinSystemExtensionsSchema = Schema.Struct({
  "agent-ext/rules-loaded": Schema.optional(UnknownRecord),
  "agent-ext/skills-loaded": Schema.optional(UnknownRecord),
  "compact/edited_files": Schema.optional(UnknownRecord),
  "compact/todo_list": Schema.optional(UnknownRecord),
  "devin-rs/summary": Schema.optional(UnknownRecord),
});
export type DevinSystemExtensions = typeof DevinSystemExtensionsSchema.Type;

export const DevinAssistantExtensionsSchema = Schema.Struct({
  "chisel/tool_call_content": Schema.optional(UnknownRecord),
});
export type DevinAssistantExtensions = typeof DevinAssistantExtensionsSchema.Type;

export const DevinToolExtensionsSchema = Schema.Struct({
  "chisel/terminal_output": Schema.optional(DevinTerminalOutputSchema),
  "chisel/tool_call_timing": Schema.optional(DevinToolTimingSchema),
  "chisel/tool_failure": Schema.optional(UnknownRecord),
  "chisel/tool_result_meta": DevinToolResultMetaSchema,
  "chisel/undo": Schema.optional(Schema.Array(Schema.Unknown)),
});
export type DevinToolExtensions = typeof DevinToolExtensionsSchema.Type;

export const DevinSystemMetadataSchema = Schema.Struct({
  ...CommonMessageMetadataFields,
  extensions: Schema.optional(DevinSystemExtensionsSchema),
});
export const DevinUserMetadataSchema = Schema.Struct({
  ...CommonMessageMetadataFields,
  from_event_id: Schema.optional(Schema.String),
});
export const DevinAssistantMetadataSchema = Schema.Struct({
  ...CommonMessageMetadataFields,
  generation_model: Schema.String,
  started_generation_at: Schema.String,
  extensions: Schema.optional(DevinAssistantExtensionsSchema),
});
export const DevinToolMetadataSchema = Schema.Struct({
  ...CommonMessageMetadataFields,
  extensions: DevinToolExtensionsSchema,
});

export const DevinThinkingSchema = Schema.Struct({
  thinking: Schema.String,
  signature: Schema.String,
});
export type DevinThinking = typeof DevinThinkingSchema.Type;

export const DevinToolCallSchema = Schema.Struct({
  id: Schema.String,
  index: Schema.Number,
  kind: Schema.String,
  name: Schema.String,
  arguments: UnknownRecord,
});
export type DevinToolCall = typeof DevinToolCallSchema.Type;
export const DevinToolCallsSchema = Schema.Array(DevinToolCallSchema);

/** Measured inline image shape. Base64 bytes are decoded but never projected as session prose. */
export const DevinImageSchema = Schema.Struct({
  base64_data: Schema.String,
  height: Schema.Number,
  mime_type: Schema.String,
  width: Schema.Number,
});
export type DevinImage = typeof DevinImageSchema.Type;

/** First-pass envelope used to name unsupported roles separately from malformed messages. */
export const DevinChatMessageEnvelopeSchema = Schema.Struct({
  message_id: Schema.String,
  role: Schema.String,
  content: Schema.String,
  metadata: UnknownRecord,
  thinking: Schema.optional(DevinThinkingSchema),
  tool_calls: Schema.optional(DevinToolCallsSchema),
  tool_call_id: Schema.optional(Schema.String),
  images: Schema.optional(Schema.Array(DevinImageSchema)),
});
export type DevinChatMessageEnvelope = typeof DevinChatMessageEnvelopeSchema.Type;

export const DevinSystemMessageSchema = Schema.Struct({
  message_id: Schema.String,
  role: Schema.Literal("system"),
  content: Schema.String,
  metadata: DevinSystemMetadataSchema,
});
export type DevinSystemMessage = typeof DevinSystemMessageSchema.Type;

export const DevinUserMessageSchema = Schema.Struct({
  message_id: Schema.String,
  role: Schema.Literal("user"),
  content: Schema.String,
  metadata: DevinUserMetadataSchema,
});
export type DevinUserMessage = typeof DevinUserMessageSchema.Type;

export const DevinAssistantMessageSchema = Schema.Struct({
  message_id: Schema.String,
  role: Schema.Literal("assistant"),
  content: Schema.String,
  metadata: DevinAssistantMetadataSchema,
  thinking: Schema.optional(DevinThinkingSchema),
  tool_calls: DevinToolCallsSchema,
});
export type DevinAssistantMessage = typeof DevinAssistantMessageSchema.Type;

export const DevinToolMessageSchema = Schema.Struct({
  message_id: Schema.String,
  role: Schema.Literal("tool"),
  content: Schema.String,
  metadata: DevinToolMetadataSchema,
  tool_call_id: Schema.String,
  images: Schema.optional(Schema.Array(DevinImageSchema)),
});
export type DevinToolMessage = typeof DevinToolMessageSchema.Type;

export const DevinChatMessageSchema = Schema.Union(
  DevinSystemMessageSchema,
  DevinUserMessageSchema,
  DevinAssistantMessageSchema,
  DevinToolMessageSchema,
);
export type DevinChatMessage = typeof DevinChatMessageSchema.Type;

export type DevinRole = "system" | "user" | "assistant" | "tool";
export const classifyDevinRole = (
  message: DevinChatMessageEnvelope,
): SignalDecision<DevinRole, DevinRole> => {
  switch (message.role) {
    case "system":
    case "user":
    case "assistant":
    case "tool":
      return signal(message.role, message.role);
    default:
      return drop("devin.message.role_unsupported");
  }
};

export type DevinMessageKind = "message" | "system" | "summary" | "tool_call" | "tool_result";
export interface DevinMessageSignal {
  readonly role: DevinRole;
}

/** Exhaustive declarative classification after variant decoding. */
export const classifyDevinMessage = (
  message: DevinChatMessage,
): SignalDecision<DevinMessageSignal, DevinMessageKind> => {
  switch (message.role) {
    case "user":
      return signal("message", { role: "user" });
    case "system":
      return signal(
        message.metadata.extensions?.["devin-rs/summary"] === undefined ? "system" : "summary",
        { role: "system" },
      );
    case "assistant":
      return signal(message.tool_calls.length > 0 ? "tool_call" : "message", {
        role: "assistant",
      });
    case "tool":
      return signal("tool_result", { role: "tool" });
  }
};

export interface DevinToolResultSignal {
  readonly message: DevinToolMessage;
  readonly status: "completed" | "failed";
}

/** Tool terminal status comes only from persisted chisel/tool_result_meta.success. */
export const classifyDevinToolResult = (
  message: DevinToolMessage,
): SignalDecision<DevinToolResultSignal, "tool_result"> =>
  signal("tool_result", {
    message,
    status: message.metadata.extensions["chisel/tool_result_meta"].success
      ? "completed"
      : "failed",
  });

export const classifyDevinToolCall = (
  call: DevinToolCall,
): SignalDecision<DevinToolCall, "tool_call"> =>
  call.id.length > 0 && call.name.length > 0
    ? signal("tool_call", call)
    : drop("devin.tool_call.decode_failed");

export const classifyDevinSession = (
  session: DevinSessionRow,
): SignalDecision<DevinSessionRow, "session"> =>
  session.id.trim().length === 0
    ? drop("devin.session.id_invalid")
    : session.main_chain_id === null
      ? drop("devin.graph.head_missing")
      : signal("session", session);
