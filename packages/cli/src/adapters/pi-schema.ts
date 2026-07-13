import { ParseResult, Schema } from "effect";

import type { SessionEventKind } from "../core/schemas";
import { drop, signal, type SignalDecision } from "./harness-schema";

const NonNegativeInteger = Schema.Number.pipe(
  Schema.filter((value) => Number.isInteger(value) && value >= 0, {
    message: () => "Expected a non-negative integer",
  }),
);

const NonNegativeFiniteNumber = Schema.Number.pipe(
  Schema.filter((value) => Number.isFinite(value) && value >= 0, {
    message: () => "Expected a non-negative finite number",
  }),
);

export const PiToolArgumentsSchema = Schema.Record({
  key: Schema.String,
  value: Schema.Unknown,
});

export const PiSessionHeaderSchema = Schema.Struct({
  type: Schema.Literal("session"),
  version: Schema.optional(Schema.Number),
  id: Schema.String,
  timestamp: Schema.String,
  cwd: Schema.optional(Schema.String),
  parentSession: Schema.optional(Schema.String),
});
export type PiSessionHeader = typeof PiSessionHeaderSchema.Type;

export const PiTextContentSchema = Schema.Struct({
  type: Schema.Literal("text"),
  text: Schema.String,
  textSignature: Schema.optional(Schema.String),
});
export type PiTextContent = typeof PiTextContentSchema.Type;

export const PiThinkingContentSchema = Schema.Struct({
  type: Schema.Literal("thinking"),
  thinking: Schema.String,
  thinkingSignature: Schema.optional(Schema.String),
  redacted: Schema.optional(Schema.Boolean),
});
export type PiThinkingContent = typeof PiThinkingContentSchema.Type;

export const PiImageContentSchema = Schema.Struct({
  type: Schema.Literal("image"),
  data: Schema.String,
  mimeType: Schema.String,
});
export type PiImageContent = typeof PiImageContentSchema.Type;

export const PiToolCallContentSchema = Schema.Struct({
  type: Schema.Literal("toolCall"),
  id: Schema.String,
  name: Schema.String,
  arguments: PiToolArgumentsSchema,
  thoughtSignature: Schema.optional(Schema.String),
});
export type PiToolCallContent = typeof PiToolCallContentSchema.Type;

export const PiUsageCostSchema = Schema.Struct({
  input: NonNegativeFiniteNumber,
  output: NonNegativeFiniteNumber,
  cacheRead: NonNegativeFiniteNumber,
  cacheWrite: NonNegativeFiniteNumber,
  total: NonNegativeFiniteNumber,
});

export const PiUsageSchema = Schema.Struct({
  input: NonNegativeInteger,
  output: NonNegativeInteger,
  cacheRead: NonNegativeInteger,
  cacheWrite: NonNegativeInteger,
  totalTokens: NonNegativeInteger,
  cost: PiUsageCostSchema,
});
export type PiUsage = typeof PiUsageSchema.Type;

export const PiUserMessageSchema = Schema.Struct({
  role: Schema.Literal("user"),
  content: Schema.Union(
    Schema.String,
    Schema.Array(Schema.Union(PiTextContentSchema, PiImageContentSchema)),
  ),
  timestamp: Schema.Number,
});
export type PiUserMessage = typeof PiUserMessageSchema.Type;

export const PiAssistantMessageSchema = Schema.Struct({
  role: Schema.Literal("assistant"),
  content: Schema.Array(
    Schema.Union(PiTextContentSchema, PiThinkingContentSchema, PiToolCallContentSchema),
  ),
  api: Schema.String,
  provider: Schema.String,
  model: Schema.String,
  responseModel: Schema.optional(Schema.String),
  responseId: Schema.optional(Schema.String),
  diagnostics: Schema.optional(Schema.Unknown),
  usage: PiUsageSchema,
  stopReason: Schema.Literal("stop", "length", "toolUse", "error", "aborted"),
  errorMessage: Schema.optional(Schema.String),
  timestamp: Schema.Number,
});
export type PiAssistantMessage = typeof PiAssistantMessageSchema.Type;

export const PiToolResultMessageSchema = Schema.Struct({
  role: Schema.Literal("toolResult"),
  toolCallId: Schema.String,
  toolName: Schema.String,
  content: Schema.Array(Schema.Union(PiTextContentSchema, PiImageContentSchema)),
  details: Schema.optional(Schema.Unknown),
  isError: Schema.Boolean,
  timestamp: Schema.Number,
});
export type PiToolResultMessage = typeof PiToolResultMessageSchema.Type;

export const PiBashExecutionMessageSchema = Schema.Struct({
  role: Schema.Literal("bashExecution"),
  command: Schema.String,
  output: Schema.String,
  exitCode: Schema.optional(Schema.Number),
  cancelled: Schema.Boolean,
  truncated: Schema.Boolean,
  fullOutputPath: Schema.optional(Schema.String),
  timestamp: Schema.Number,
  excludeFromContext: Schema.optional(Schema.Boolean),
});
export type PiBashExecutionMessage = typeof PiBashExecutionMessageSchema.Type;
export const PiCustomAgentMessageSchema = Schema.Struct({
  role: Schema.Literal("custom"),
  customType: Schema.String,
  content: Schema.Union(
    Schema.String,
    Schema.Array(Schema.Union(PiTextContentSchema, PiImageContentSchema)),
  ),
  display: Schema.Boolean,
  details: Schema.optional(Schema.Unknown),
  timestamp: Schema.Number,
});
export type PiCustomAgentMessage = typeof PiCustomAgentMessageSchema.Type;

export const PiLegacyHookMessageSchema = Schema.Struct({
  role: Schema.Literal("hookMessage"),
  customType: Schema.String,
  content: Schema.Union(
    Schema.String,
    Schema.Array(Schema.Union(PiTextContentSchema, PiImageContentSchema)),
  ),
  display: Schema.Boolean,
  details: Schema.optional(Schema.Unknown),
  timestamp: Schema.Number,
});

export const PiBranchSummaryMessageSchema = Schema.Struct({
  role: Schema.Literal("branchSummary"),
  summary: Schema.String,
  fromId: Schema.String,
  timestamp: Schema.Number,
});

export const PiCompactionSummaryMessageSchema = Schema.Struct({
  role: Schema.Literal("compactionSummary"),
  summary: Schema.String,
  tokensBefore: Schema.Number,
  timestamp: Schema.Number,
});

export const PiAgentMessageSchema = Schema.Union(
  PiUserMessageSchema,
  PiAssistantMessageSchema,
  PiToolResultMessageSchema,
  PiBashExecutionMessageSchema,
  PiCustomAgentMessageSchema,
  PiLegacyHookMessageSchema,
  PiBranchSummaryMessageSchema,
  PiCompactionSummaryMessageSchema,
);
export type PiAgentMessage = typeof PiAgentMessageSchema.Type;

const PiEntryBase = {
  id: Schema.String,
  parentId: Schema.NullOr(Schema.String),
  timestamp: Schema.String,
} as const;

export const PiMessageEntrySchema = Schema.Struct({
  type: Schema.Literal("message"),
  ...PiEntryBase,
  message: PiAgentMessageSchema,
});
export const PiThinkingLevelChangeEntrySchema = Schema.Struct({
  type: Schema.Literal("thinking_level_change"),
  ...PiEntryBase,
  thinkingLevel: Schema.String,
});
export const PiModelChangeEntrySchema = Schema.Struct({
  type: Schema.Literal("model_change"),
  ...PiEntryBase,
  provider: Schema.String,
  modelId: Schema.String,
});
export const PiCompactionEntrySchema = Schema.Struct({
  type: Schema.Literal("compaction"),
  ...PiEntryBase,
  summary: Schema.String,
  firstKeptEntryId: Schema.String,
  tokensBefore: Schema.Number,
  details: Schema.optional(Schema.Unknown),
  fromHook: Schema.optional(Schema.Boolean),
});
export const PiBranchSummaryEntrySchema = Schema.Struct({
  type: Schema.Literal("branch_summary"),
  ...PiEntryBase,
  fromId: Schema.String,
  summary: Schema.String,
  details: Schema.optional(Schema.Unknown),
  fromHook: Schema.optional(Schema.Boolean),
});
export const PiCustomEntrySchema = Schema.Struct({
  type: Schema.Literal("custom"),
  ...PiEntryBase,
  customType: Schema.String,
  data: Schema.optional(Schema.Unknown),
});
export const PiCustomMessageEntrySchema = Schema.Struct({
  type: Schema.Literal("custom_message"),
  ...PiEntryBase,
  customType: Schema.String,
  content: Schema.Union(
    Schema.String,
    Schema.Array(Schema.Union(PiTextContentSchema, PiImageContentSchema)),
  ),
  details: Schema.optional(Schema.Unknown),
  display: Schema.Boolean,
});
export const PiLabelEntrySchema = Schema.Struct({
  type: Schema.Literal("label"),
  ...PiEntryBase,
  targetId: Schema.String,
  label: Schema.optional(Schema.String),
});
export const PiSessionInfoEntrySchema = Schema.Struct({
  type: Schema.Literal("session_info"),
  ...PiEntryBase,
  name: Schema.optional(Schema.String),
});

export const PiSessionEntrySchema = Schema.Union(
  PiMessageEntrySchema,
  PiThinkingLevelChangeEntrySchema,
  PiModelChangeEntrySchema,
  PiCompactionEntrySchema,
  PiBranchSummaryEntrySchema,
  PiCustomEntrySchema,
  PiCustomMessageEntrySchema,
  PiLabelEntrySchema,
  PiSessionInfoEntrySchema,
);
export type PiSessionEntry = typeof PiSessionEntrySchema.Type;

const PiLegacyEntryBase = {
  id: Schema.optional(Schema.String),
  parentId: Schema.optional(Schema.NullOr(Schema.String)),
  timestamp: Schema.String,
} as const;
export const PiLegacyV1EntrySchema = Schema.Union(
  Schema.Struct({ type: Schema.Literal("message"), ...PiLegacyEntryBase, message: PiAgentMessageSchema }),
  Schema.Struct({ type: Schema.Literal("thinking_level_change"), ...PiLegacyEntryBase, thinkingLevel: Schema.String }),
  Schema.Struct({ type: Schema.Literal("model_change"), ...PiLegacyEntryBase, provider: Schema.String, modelId: Schema.String }),
  Schema.Struct({
    type: Schema.Literal("compaction"),
    ...PiLegacyEntryBase,
    summary: Schema.String,
    firstKeptEntryIndex: Schema.Number,
    tokensBefore: Schema.Number,
    details: Schema.optional(Schema.Unknown),
    fromHook: Schema.optional(Schema.Boolean),
  }),
  Schema.Struct({ type: Schema.Literal("branch_summary"), ...PiLegacyEntryBase, fromId: Schema.String, summary: Schema.String, details: Schema.optional(Schema.Unknown), fromHook: Schema.optional(Schema.Boolean) }),
  Schema.Struct({ type: Schema.Literal("custom"), ...PiLegacyEntryBase, customType: Schema.String, data: Schema.optional(Schema.Unknown) }),
  Schema.Struct({ type: Schema.Literal("custom_message"), ...PiLegacyEntryBase, customType: Schema.String, content: Schema.Union(Schema.String, Schema.Array(Schema.Union(PiTextContentSchema, PiImageContentSchema))), details: Schema.optional(Schema.Unknown), display: Schema.Boolean }),
  Schema.Struct({ type: Schema.Literal("label"), ...PiLegacyEntryBase, targetId: Schema.String, label: Schema.optional(Schema.String) }),
  Schema.Struct({ type: Schema.Literal("session_info"), ...PiLegacyEntryBase, name: Schema.optional(Schema.String) }),
);
export type PiLegacyV1Entry = typeof PiLegacyV1EntrySchema.Type;

export type PiClassification = SignalDecision<PiSessionHeader | PiSessionEntry | PiLegacyV1Entry, SessionEventKind>;

export const PI_HEADER_DECODE_FAILED = "pi.header.decode_failed";
export const PI_ENTRY_DECODE_FAILED = "pi.entry.decode_failed";
export const PI_ENTRY_UNKNOWN_TYPE = "pi.entry.unknown_type";
export const PI_MESSAGE_DECODE_FAILED = "pi.message.decode_failed";
export const PI_MESSAGE_UNKNOWN_ROLE = "pi.message.unknown_role";
export const PI_CONTENT_UNKNOWN_TYPE = "pi.content.unknown_type";

const ENTRY_KIND: Readonly<Record<string, SessionEventKind>> = {
  message: "message",
  thinking_level_change: "lifecycle",
  model_change: "lifecycle",
  compaction: "summary",
  branch_summary: "summary",
  custom: "lifecycle",
  custom_message: "preamble",
  label: "lifecycle",
  session_info: "lifecycle",
};

const recordOf = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;

const KNOWN_MESSAGE_ROLES: Readonly<Record<string, true>> = {
  user: true,
  assistant: true,
  toolResult: true,
  bashExecution: true,
  custom: true,
  hookMessage: true,
  branchSummary: true,
  compactionSummary: true,
};
const KNOWN_CONTENT_TYPES: Readonly<Record<string, true>> = {
  text: true,
  thinking: true,
  image: true,
  toolCall: true,
};

const decodeFailureName = (record: Record<string, unknown>): string => {
  if (record.type !== "message") return PI_ENTRY_DECODE_FAILED;
  const message = recordOf(record.message);
  if (message === undefined) return PI_MESSAGE_DECODE_FAILED;
  const role = message.role;
  if (typeof role !== "string" || KNOWN_MESSAGE_ROLES[role] !== true) return PI_MESSAGE_UNKNOWN_ROLE;
  const content = message.content;
  if (Array.isArray(content)) {
    for (const part of content) {
      const partRecord = recordOf(part);
      if (partRecord !== undefined && typeof partRecord.type === "string" && KNOWN_CONTENT_TYPES[partRecord.type] !== true) {
        return PI_CONTENT_UNKNOWN_TYPE;
      }
    }
  }
  return PI_MESSAGE_DECODE_FAILED;
};

export const classifyPiRecord = (
  record: unknown,
  options: {
    readonly header?: boolean;
    readonly version?: 1 | 2 | 3;
    readonly diagnostics?: { push: (d: { readonly name: string; readonly message: string }) => void };
  } = {},
): PiClassification => {
  const source = recordOf(record);
  if (source === undefined) {
    const name = options.header === true ? PI_HEADER_DECODE_FAILED : PI_ENTRY_DECODE_FAILED;
    const message = "Pi record must be an object";
    options.diagnostics?.push({ name, message });
    return drop(`${name}: ${message}`);
  }
  const type = source.type;
  if (options.header === true) {
    const decoded = Schema.decodeUnknownEither(PiSessionHeaderSchema)(record, { errors: "all", onExcessProperty: "error" });
    if (decoded._tag === "Left") {
      const message = ParseResult.TreeFormatter.formatErrorSync(decoded.left);
      options.diagnostics?.push({ name: PI_HEADER_DECODE_FAILED, message });
      return drop(`${PI_HEADER_DECODE_FAILED}: ${message}`);
    }
    return signal("system", decoded.right);
  }
  if (typeof type !== "string" || ENTRY_KIND[type] === undefined) {
    const message = `unmodeled Pi entry type \`${String(type)}\``;
    options.diagnostics?.push({ name: PI_ENTRY_UNKNOWN_TYPE, message });
    return drop(`${PI_ENTRY_UNKNOWN_TYPE}: ${message}`);
  }
  if (options.version === 1) {
    const decoded = Schema.decodeUnknownEither(PiLegacyV1EntrySchema)(record, { errors: "all", onExcessProperty: "error" });
    if (decoded._tag === "Left") {
      const name = decodeFailureName(source);
      const message = ParseResult.TreeFormatter.formatErrorSync(decoded.left);
      options.diagnostics?.push({ name, message });
      return drop(`${name}: ${message}`);
    }
    return signal(ENTRY_KIND[type]!, decoded.right);
  }
  const decoded = Schema.decodeUnknownEither(PiSessionEntrySchema)(record, { errors: "all", onExcessProperty: "error" });
  if (decoded._tag === "Left") {
    const name = decodeFailureName(source);
    const message = ParseResult.TreeFormatter.formatErrorSync(decoded.left);
    options.diagnostics?.push({ name, message });
    return drop(`${name}: ${message}`);
  }
  return signal(ENTRY_KIND[type]!, decoded.right);
};
