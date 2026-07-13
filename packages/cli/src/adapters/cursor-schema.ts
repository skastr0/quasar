import { Schema } from "effect";

import { type SignalDecision, drop, signal } from "./harness-schema";

const OptionalString = Schema.optional(Schema.String);
const OptionalNumber = Schema.optional(Schema.Number);
const OptionalBoolean = Schema.optional(Schema.Boolean);

export const CursorMetaRowSchema = Schema.Struct({
  value: Schema.String,
});

export const CursorBlobRowSchema = Schema.Struct({
  data: Schema.Unknown,
});

export const CursorUserVersionRowSchema = Schema.Struct({
  user_version: Schema.Number,
});

export const CursorTableNameRowSchema = Schema.Struct({
  name: Schema.String,
});

export const CursorDatabaseMetadataSchema = Schema.Struct({
  agentId: Schema.String,
  latestRootBlobId: Schema.String,
  name: Schema.String,
  createdAt: Schema.Number,
  mode: Schema.String,
  isRunEverything: OptionalBoolean,
  approvalMode: OptionalString,
  lastUsedModel: OptionalString,
  lastDebugServerPort: OptionalNumber,
  currentPlanUri: OptionalString,
  subagentInfo: Schema.optional(Schema.Unknown),
});
export type CursorDatabaseMetadata = typeof CursorDatabaseMetadataSchema.Type;

export const CursorChatMetaSchema = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  createdAtMs: Schema.Number,
  hasConversation: Schema.Boolean,
  title: Schema.String,
  updatedAtMs: Schema.Number,
  cwd: Schema.String,
});
export type CursorChatMeta = typeof CursorChatMetaSchema.Type;

export const CursorAcpMetaSchema = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  cwd: Schema.String,
  title: Schema.optional(Schema.String),
});
export type CursorAcpMeta = typeof CursorAcpMetaSchema.Type;

export const CursorHighLevelToolResultSchema = Schema.Struct({
  isError: Schema.Boolean,
  output: Schema.optional(Schema.Unknown),
  rawErrorMessages: Schema.optional(Schema.Array(Schema.Unknown)),
});
export type CursorHighLevelToolResult = typeof CursorHighLevelToolResultSchema.Type;

export const CursorProviderOptionsSchema = Schema.Struct({
  highLevelToolCallResult: Schema.optional(CursorHighLevelToolResultSchema),
  modelProviderMessageId: OptionalString,
  requestContextCompleteness: Schema.optional(Schema.Unknown),
  requestId: OptionalString,
  modelName: OptionalString,
  isSummary: OptionalBoolean,
});
export type CursorProviderOptions = typeof CursorProviderOptionsSchema.Type;

export const CursorMessageProviderOptionsSchema = Schema.Struct({
  cursor: Schema.optional(CursorProviderOptionsSchema),
});

export const CursorTextBlockSchema = Schema.Struct({
  type: Schema.Literal("text"),
  text: Schema.String,
});
export type CursorTextBlock = typeof CursorTextBlockSchema.Type;

export const CursorReasoningBlockSchema = Schema.Struct({
  type: Schema.Literal("reasoning"),
  text: Schema.String,
  signature: Schema.optional(Schema.String),
  providerOptions: Schema.optional(CursorMessageProviderOptionsSchema),
});
export type CursorReasoningBlock = typeof CursorReasoningBlockSchema.Type;

export const CursorRedactedReasoningBlockSchema = Schema.Struct({
  type: Schema.Literal("redacted-reasoning"),
  data: Schema.optional(Schema.String),
  text: Schema.optional(Schema.String),
});
export type CursorRedactedReasoningBlock = typeof CursorRedactedReasoningBlockSchema.Type;

export const CursorToolCallBlockSchema = Schema.Struct({
  type: Schema.Literal("tool-call"),
  toolCallId: Schema.String,
  toolName: Schema.String,
  args: Schema.Unknown,
});
export type CursorToolCallBlock = typeof CursorToolCallBlockSchema.Type;

export const CursorExperimentalTextSchema = Schema.Struct({
  type: Schema.Literal("text"),
  text: Schema.String,
});

export const CursorToolResultBlockSchema = Schema.Struct({
  type: Schema.Literal("tool-result"),
  toolCallId: Schema.String,
  toolName: Schema.String,
  result: Schema.String,
  experimental_content: Schema.optional(Schema.Array(CursorExperimentalTextSchema)),
});
export type CursorToolResultBlock = typeof CursorToolResultBlockSchema.Type;

export const CursorImageBlockSchema = Schema.Struct({
  type: Schema.Literal("image"),
  image: Schema.optional(Schema.Unknown),
  uri: Schema.optional(Schema.String),
  mediaType: Schema.optional(Schema.String),
});
export type CursorImageBlock = typeof CursorImageBlockSchema.Type;

export const CursorFileBlockSchema = Schema.Struct({
  type: Schema.Literal("file"),
  filename: Schema.optional(Schema.String),
  data: Schema.optional(Schema.Unknown),
  uri: Schema.optional(Schema.String),
  mediaType: Schema.optional(Schema.String),
});
export type CursorFileBlock = typeof CursorFileBlockSchema.Type;

export const CursorContentBlockSchema = Schema.Union(
  CursorTextBlockSchema,
  CursorReasoningBlockSchema,
  CursorRedactedReasoningBlockSchema,
  CursorToolCallBlockSchema,
  CursorToolResultBlockSchema,
  CursorImageBlockSchema,
  CursorFileBlockSchema,
);
export type CursorContentBlock = typeof CursorContentBlockSchema.Type;

export const CursorMessageSchema = Schema.Struct({
  id: Schema.optional(Schema.String),
  role: Schema.String,
  content: Schema.Union(Schema.String, Schema.Array(Schema.Unknown)),
  providerOptions: Schema.optional(CursorMessageProviderOptionsSchema),
});
export type CursorMessage = typeof CursorMessageSchema.Type;

export type CursorMessageKind = "message" | "system" | "tool_result";
export type CursorMessageRole = "user" | "assistant" | "developer" | "system" | "tool";

export const classifyCursorMessage = (
  message: CursorMessage,
): SignalDecision<
  { readonly message: CursorMessage; readonly role: CursorMessageRole },
  CursorMessageKind
> => {
  switch (message.role) {
    case "user":
    case "assistant":
    case "developer":
      return signal("message", { message, role: message.role });
    case "system":
      return signal("system", { message, role: "system" });
    case "tool":
      return signal("tool_result", { message, role: "tool" });
    default:
      return drop(`cursor.message.invalid_role:${message.role}`);
  }
};

export type CursorBlockKind =
  | "text"
  | "reasoning"
  | "redacted_reasoning"
  | "tool_call"
  | "tool_result"
  | "image"
  | "file";

export const classifyCursorBlock = (
  block: CursorContentBlock,
): SignalDecision<CursorContentBlock, CursorBlockKind> => {
  switch (block.type) {
    case "text":
      return signal("text", block);
    case "reasoning":
      return signal("reasoning", block);
    case "redacted-reasoning":
      return signal("redacted_reasoning", block);
    case "tool-call":
      return signal("tool_call", block);
    case "tool-result":
      return signal("tool_result", block);
    case "image":
      return signal("image", block);
    case "file":
      return signal("file", block);
  }
};

export const cursorBlockSchemaForType = (type: string | undefined) => {
  switch (type) {
    case "text":
      return CursorTextBlockSchema;
    case "reasoning":
      return CursorReasoningBlockSchema;
    case "redacted-reasoning":
      return CursorRedactedReasoningBlockSchema;
    case "tool-call":
      return CursorToolCallBlockSchema;
    case "tool-result":
      return CursorToolResultBlockSchema;
    case "image":
      return CursorImageBlockSchema;
    case "file":
      return CursorFileBlockSchema;
    default:
      return undefined;
  }
};
