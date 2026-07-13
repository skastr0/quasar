import { Schema } from "effect";

/**
 * Closed, source-backed schemas for the OMP v3 JSONL persistence format.
 * Unknown record, message-role, and content discriminators fail decoding; the
 * adapter turns those failures into named per-line diagnostics and continues.
 */

const OptionalTimestamp = Schema.optional(Schema.Union(Schema.String, Schema.Number));
const OptionalEntryId = Schema.optional(Schema.String);
const OptionalParentId = Schema.optional(Schema.Union(Schema.String, Schema.Null));

const NonWhitespaceString = Schema.String.pipe(
  Schema.filter((value) => value.trim().length > 0, {
    message: () => "Expected a non-whitespace string",
  }),
);

const EntryBase = {
  id: OptionalEntryId,
  parentId: OptionalParentId,
  timestamp: Schema.String,
} as const;

export const OmpTitleEntrySchema = Schema.Struct({
  type: Schema.Literal("title"),
  v: Schema.Literal(1),
  title: Schema.String,
  source: Schema.optional(Schema.Literal("auto", "user")),
  updatedAt: Schema.String,
  pad: Schema.String,
});

export const OmpSessionHeaderSchema = Schema.Struct({
  type: Schema.Literal("session"),
  version: Schema.optional(Schema.Number),
  id: NonWhitespaceString,
  title: Schema.optional(Schema.String),
  titleSource: Schema.optional(Schema.Literal("auto", "user")),
  timestamp: Schema.String,
  cwd: Schema.String,
  parentSession: Schema.optional(Schema.String),
  fork: Schema.optional(Schema.String),
  // Deliberately modeled only as presence at the source boundary. The adapter
  // never copies this opaque cache identity into normalized output.
  providerPromptCacheKey: Schema.optional(Schema.String),
});

export const OmpTextContentSchema = Schema.Struct({
  type: Schema.Literal("text"),
  text: Schema.String,
  textSignature: Schema.optional(Schema.Union(Schema.String, Schema.Struct({
    v: Schema.Literal(1),
    id: Schema.String,
    phase: Schema.optional(Schema.Literal("commentary", "final_answer")),
  }))),
});

export const OmpThinkingContentSchema = Schema.Struct({
  type: Schema.Literal("thinking"),
  thinking: Schema.String,
  thinkingSignature: Schema.optional(Schema.String),
  itemId: Schema.optional(Schema.String),
});

export const OmpRedactedThinkingContentSchema = Schema.Struct({
  type: Schema.Literal("redactedThinking"),
  data: Schema.String,
});

export const OmpFallbackContentSchema = Schema.Struct({
  type: Schema.Literal("fallback"),
  from: Schema.Struct({ model: Schema.String }),
  to: Schema.Struct({ model: Schema.String }),
});

export const OmpImageContentSchema = Schema.Struct({
  type: Schema.Literal("image"),
  data: Schema.String,
  mimeType: Schema.String,
  detail: Schema.optional(Schema.Literal("auto", "low", "high", "original")),
});

export const OmpToolCallContentSchema = Schema.Struct({
  type: Schema.Literal("toolCall"),
  id: Schema.String,
  name: Schema.String,
  arguments: Schema.Record({ key: Schema.String, value: Schema.Unknown }),
  intent: Schema.optional(Schema.String),
  thoughtSignature: Schema.optional(Schema.String),
  rawBlock: Schema.optional(Schema.String),
  customWireName: Schema.optional(Schema.String),
});

export const OmpUserContentSchema = Schema.Union(
  Schema.String,
  Schema.Array(Schema.Union(OmpTextContentSchema, OmpImageContentSchema)),
);

export const OmpAssistantContentSchema = Schema.Array(
  Schema.Union(
    OmpTextContentSchema,
    OmpThinkingContentSchema,
    OmpRedactedThinkingContentSchema,
    OmpFallbackContentSchema,
    OmpImageContentSchema,
    OmpToolCallContentSchema,
  ),
);

const OmpUsageCostSchema = Schema.Struct({
  input: Schema.optional(Schema.Number),
  output: Schema.optional(Schema.Number),
  cacheRead: Schema.optional(Schema.Number),
  cacheWrite: Schema.optional(Schema.Number),
  total: Schema.optional(Schema.Number),
});

export const OmpUsageSchema = Schema.Struct({
  input: Schema.optional(Schema.Number),
  output: Schema.optional(Schema.Number),
  cacheRead: Schema.optional(Schema.Number),
  cacheWrite: Schema.optional(Schema.Number),
  totalTokens: Schema.optional(Schema.Number),
  reasoningTokens: Schema.optional(Schema.Number),
  cost: Schema.optional(OmpUsageCostSchema),
});

export const OmpUserMessageSchema = Schema.Struct({
  role: Schema.Literal("user"),
  content: OmpUserContentSchema,
  synthetic: Schema.optional(Schema.Boolean),
  steering: Schema.optional(Schema.Boolean),
  attribution: Schema.optional(Schema.String),
  timestamp: OptionalTimestamp,
});

export const OmpDeveloperMessageSchema = Schema.Struct({
  role: Schema.Literal("developer"),
  content: OmpUserContentSchema,
  attribution: Schema.optional(Schema.String),
  timestamp: OptionalTimestamp,
});

export const OmpAssistantMessageSchema = Schema.Struct({
  role: Schema.Literal("assistant"),
  content: OmpAssistantContentSchema,
  api: Schema.optional(Schema.String),
  provider: Schema.optional(Schema.String),
  model: Schema.optional(Schema.String),
  usage: Schema.optional(OmpUsageSchema),
  stopReason: Schema.optional(Schema.Literal("stop", "length", "toolUse", "error", "aborted")),
  stopDetails: Schema.optional(Schema.Unknown),
  errorMessage: Schema.optional(Schema.String),
  errorStatus: Schema.optional(Schema.Number),
  duration: Schema.optional(Schema.Number),
  ttft: Schema.optional(Schema.Number),
  responseId: Schema.optional(Schema.String),
  upstreamProvider: Schema.optional(Schema.String),
  timestamp: OptionalTimestamp,
});

export const OmpToolResultMessageSchema = Schema.Struct({
  role: Schema.Literal("toolResult"),
  toolCallId: Schema.String,
  toolName: Schema.String,
  content: Schema.Array(Schema.Union(OmpTextContentSchema, OmpImageContentSchema)),
  details: Schema.optional(Schema.Unknown),
  isError: Schema.Boolean,
  attribution: Schema.optional(Schema.String),
  prunedAt: Schema.optional(Schema.Number),
  useless: Schema.optional(Schema.Boolean),
  timestamp: OptionalTimestamp,
});

const OmpExecutionMessageFields = {
  command: Schema.optional(Schema.String),
  code: Schema.optional(Schema.String),
  output: Schema.String,
  exitCode: Schema.optional(Schema.Union(Schema.Number, Schema.Null)),
  cancelled: Schema.Boolean,
  truncated: Schema.Boolean,
  meta: Schema.optional(Schema.Unknown),
  excludeFromContext: Schema.optional(Schema.Boolean),
  timestamp: OptionalTimestamp,
} as const;

export const OmpBashExecutionMessageSchema = Schema.Struct({
  role: Schema.Literal("bashExecution"),
  ...OmpExecutionMessageFields,
  command: Schema.String,
});

export const OmpPythonExecutionMessageSchema = Schema.Struct({
  role: Schema.Literal("pythonExecution"),
  ...OmpExecutionMessageFields,
  code: Schema.String,
});

const OmpCustomMessageFields = {
  customType: Schema.String,
  content: OmpUserContentSchema,
  display: Schema.Boolean,
  details: Schema.optional(Schema.Unknown),
  attribution: Schema.optional(Schema.String),
  timestamp: OptionalTimestamp,
} as const;

export const OmpCustomRoleMessageSchema = Schema.Struct({
  role: Schema.Literal("custom"),
  ...OmpCustomMessageFields,
});

export const OmpHookMessageSchema = Schema.Struct({
  role: Schema.Literal("hookMessage"),
  ...OmpCustomMessageFields,
});

export const OmpFileMentionMessageSchema = Schema.Struct({
  role: Schema.Literal("fileMention"),
  files: Schema.Array(Schema.Struct({
    path: Schema.String,
    content: Schema.String,
    lineCount: Schema.optional(Schema.Number),
    byteSize: Schema.optional(Schema.Number),
    skippedReason: Schema.optional(Schema.Literal("tooLarge", "binary")),
    image: Schema.optional(OmpImageContentSchema),
  })),
  timestamp: OptionalTimestamp,
});

export const OmpBranchSummaryMessageSchema = Schema.Struct({
  role: Schema.Literal("branchSummary"),
  summary: Schema.String,
  fromId: Schema.String,
  timestamp: OptionalTimestamp,
});

export const OmpCompactionSummaryMessageSchema = Schema.Struct({
  role: Schema.Literal("compactionSummary"),
  summary: Schema.String,
  shortSummary: Schema.optional(Schema.String),
  tokensBefore: Schema.Number,
  blocks: Schema.optional(Schema.Array(Schema.Union(OmpTextContentSchema, OmpImageContentSchema))),
  images: Schema.optional(Schema.Array(OmpImageContentSchema)),
  timestamp: OptionalTimestamp,
});

export const OmpMessageSchema = Schema.Union(
  OmpUserMessageSchema,
  OmpDeveloperMessageSchema,
  OmpAssistantMessageSchema,
  OmpToolResultMessageSchema,
  OmpBashExecutionMessageSchema,
  OmpPythonExecutionMessageSchema,
  OmpCustomRoleMessageSchema,
  OmpHookMessageSchema,
  OmpFileMentionMessageSchema,
  OmpBranchSummaryMessageSchema,
  OmpCompactionSummaryMessageSchema,
);

export const OmpMessageEntrySchema = Schema.Struct({
  type: Schema.Literal("message"),
  ...EntryBase,
  message: OmpMessageSchema,
});

export const OmpThinkingLevelChangeEntrySchema = Schema.Struct({
  type: Schema.Literal("thinking_level_change"), ...EntryBase,
  thinkingLevel: Schema.optional(Schema.Union(Schema.String, Schema.Null)),
  configured: Schema.optional(Schema.Union(Schema.String, Schema.Null)),
});
export const OmpModelChangeEntrySchema = Schema.Struct({
  type: Schema.Literal("model_change"), ...EntryBase,
  model: Schema.String,
  role: Schema.optional(Schema.String),
});
export const OmpServiceTierChangeEntrySchema = Schema.Struct({
  type: Schema.Literal("service_tier_change"), ...EntryBase,
  serviceTier: Schema.optional(Schema.Unknown),
});
export const OmpToolChoiceChangeEntrySchema = Schema.Struct({
  type: Schema.Literal("tool_choice_change"), ...EntryBase,
  toolChoice: Schema.optional(Schema.Unknown),
});
export const OmpCompactionEntrySchema = Schema.Struct({
  type: Schema.Literal("compaction"), ...EntryBase,
  summary: Schema.String,
  shortSummary: Schema.optional(Schema.String),
  firstKeptEntryId: Schema.String,
  tokensBefore: Schema.Number,
  details: Schema.optional(Schema.Unknown),
  preserveData: Schema.optional(Schema.Unknown),
  fromExtension: Schema.optional(Schema.Boolean),
});
export const OmpBranchSummaryEntrySchema = Schema.Struct({
  type: Schema.Literal("branch_summary"), ...EntryBase,
  fromId: Schema.String,
  summary: Schema.String,
  details: Schema.optional(Schema.Unknown),
  fromExtension: Schema.optional(Schema.Boolean),
});
export const OmpCustomEntrySchema = Schema.Struct({
  type: Schema.Literal("custom"), ...EntryBase,
  customType: Schema.String,
  data: Schema.optional(Schema.Unknown),
});
export const OmpCustomMessageEntrySchema = Schema.Struct({
  type: Schema.Literal("custom_message"), ...EntryBase,
  customType: Schema.String,
  content: OmpUserContentSchema,
  details: Schema.optional(Schema.Unknown),
  display: Schema.Boolean,
  attribution: Schema.optional(Schema.String),
});
export const OmpLabelEntrySchema = Schema.Struct({
  type: Schema.Literal("label"), ...EntryBase,
  targetId: Schema.String,
  label: Schema.optional(Schema.String),
});
export const OmpTitleChangeEntrySchema = Schema.Struct({
  type: Schema.Literal("title_change"), ...EntryBase,
  title: Schema.String,
  previousTitle: Schema.optional(Schema.String),
  source: Schema.Literal("auto", "user"),
  trigger: Schema.optional(Schema.String),
});
export const OmpTtsrInjectionEntrySchema = Schema.Struct({
  type: Schema.Literal("ttsr_injection"), ...EntryBase,
  injectedRules: Schema.Array(Schema.String),
});
export const OmpMcpToolSelectionEntrySchema = Schema.Struct({
  type: Schema.Literal("mcp_tool_selection"), ...EntryBase,
  selectedToolNames: Schema.Array(Schema.String),
});
export const OmpSessionInitEntrySchema = Schema.Struct({
  type: Schema.Literal("session_init"), ...EntryBase,
  systemPrompt: Schema.String,
  task: Schema.String,
  tools: Schema.Array(Schema.String),
  outputSchema: Schema.optional(Schema.Unknown),
  spawns: Schema.optional(Schema.String),
  readSummarize: Schema.optional(Schema.Boolean),
});
export const OmpModeChangeEntrySchema = Schema.Struct({
  type: Schema.Literal("mode_change"), ...EntryBase,
  mode: Schema.String,
  data: Schema.optional(Schema.Unknown),
});

// Read-only variants observed in older OMP persistence revisions.
export const OmpSessionInfoEntrySchema = Schema.Struct({
  type: Schema.Literal("session_info"), ...EntryBase,
  data: Schema.optional(Schema.Unknown),
});
export const OmpSessionMetadataEntrySchema = Schema.Struct({
  type: Schema.Literal("session_metadata"), ...EntryBase,
  data: Schema.optional(Schema.Unknown),
});
export const OmpCheckpointEntrySchema = Schema.Struct({
  type: Schema.Literal("checkpoint"), ...EntryBase,
  data: Schema.optional(Schema.Unknown),
});
export const OmpModeEntrySchema = Schema.Struct({
  type: Schema.Literal("mode"), ...EntryBase,
  mode: Schema.optional(Schema.String),
  data: Schema.optional(Schema.Unknown),
});

export const OmpEntrySchema = Schema.Union(
  OmpMessageEntrySchema,
  OmpThinkingLevelChangeEntrySchema,
  OmpModelChangeEntrySchema,
  OmpServiceTierChangeEntrySchema,
  OmpToolChoiceChangeEntrySchema,
  OmpCompactionEntrySchema,
  OmpBranchSummaryEntrySchema,
  OmpCustomEntrySchema,
  OmpCustomMessageEntrySchema,
  OmpLabelEntrySchema,
  OmpTitleChangeEntrySchema,
  OmpTtsrInjectionEntrySchema,
  OmpMcpToolSelectionEntrySchema,
  OmpSessionInitEntrySchema,
  OmpModeChangeEntrySchema,
  OmpSessionInfoEntrySchema,
  OmpSessionMetadataEntrySchema,
  OmpCheckpointEntrySchema,
  OmpModeEntrySchema,
);

export const OmpFileRecordSchema = Schema.Union(
  OmpTitleEntrySchema,
  OmpSessionHeaderSchema,
  OmpEntrySchema,
);

export type OmpTitleEntry = typeof OmpTitleEntrySchema.Type;
export type OmpSessionHeader = typeof OmpSessionHeaderSchema.Type;
export type OmpMessage = typeof OmpMessageSchema.Type;
export type OmpMessageEntry = typeof OmpMessageEntrySchema.Type;
export type OmpEntry = typeof OmpEntrySchema.Type;
export type OmpFileRecord = typeof OmpFileRecordSchema.Type;

export type OmpSignalKind = "title" | "header" | "message" | "summary" | "title_change" | "custom_message" | "lifecycle";
export type OmpClassification =
  | { readonly _tag: "signal"; readonly kind: OmpSignalKind }
  | { readonly _tag: "drop"; readonly reason: string };

const signal = (kind: OmpSignalKind): OmpClassification => ({ _tag: "signal", kind });

/** Exhaustive declarative classification for every modeled physical variant. */
export const classifyOmpRecord = (record: OmpFileRecord): OmpClassification => {
  switch (record.type) {
    case "title": return signal("title");
    case "session": return signal("header");
    case "message": return signal("message");
    case "compaction":
    case "branch_summary": return signal("summary");
    case "title_change": return signal("title_change");
    case "custom_message": return signal("custom_message");
    case "thinking_level_change":
    case "model_change":
    case "service_tier_change":
    case "tool_choice_change":
    case "custom":
    case "label":
    case "ttsr_injection":
    case "mcp_tool_selection":
    case "session_init":
    case "mode_change":
    case "session_info":
    case "session_metadata":
    case "checkpoint":
    case "mode":
      return signal("lifecycle");
  }
};

const OMP_ENTRY_TYPES: Readonly<Record<string, true>> = {
  message: true,
  thinking_level_change: true,
  model_change: true,
  service_tier_change: true,
  tool_choice_change: true,
  compaction: true,
  branch_summary: true,
  custom: true,
  custom_message: true,
  label: true,
  title_change: true,
  ttsr_injection: true,
  mcp_tool_selection: true,
  session_init: true,
  mode_change: true,
  session_info: true,
  session_metadata: true,
  checkpoint: true,
  mode: true,
};

export const isOmpEntryType = (value: string): boolean => OMP_ENTRY_TYPES[value] === true;
