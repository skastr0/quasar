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

/**
 * Prime Agent (prime-agent) session-file schemas. The on-disk format is the
 * direct successor of the Pi coding-agent format (same entry tree, same
 * message envelope) plus the prime-agent additions: a v3 header carrying
 * `rlmDepth`/`git`, and the daemon-era entry types `session_state`,
 * `agent_status`, `git_state`, `child_usage_attributed`, `service_tier_change`.
 *
 * Every record is decoded FAIL-CLOSED through these schemas; a malformed
 * record becomes a NAMED drop via `classifyPrimeRecord` and never aborts the
 * file. Expected machinery records (`agent_status`) are dropped with a named
 * reason at classification time, without a decode diagnostic.
 */

export const PrimeSessionHeaderSchema = Schema.Struct({
  type: Schema.Literal("session"),
  version: Schema.optional(Schema.Number),
  id: Schema.String,
  timestamp: Schema.String,
  cwd: Schema.optional(Schema.String),
  parentSession: Schema.optional(Schema.String),
  rlmDepth: Schema.optional(NonNegativeInteger),
  git: Schema.optional(Schema.Struct({
    repoUrl: Schema.optional(Schema.String),
    commit: Schema.optional(Schema.String),
    branch: Schema.optional(Schema.String),
  })),
});
export type PrimeSessionHeader = typeof PrimeSessionHeaderSchema.Type;

export const PrimeTextContentSchema = Schema.Struct({
  type: Schema.Literal("text"),
  text: Schema.String,
  textSignature: Schema.optional(Schema.String),
});
export type PrimeTextContent = typeof PrimeTextContentSchema.Type;

export const PrimeThinkingContentSchema = Schema.Struct({
  type: Schema.Literal("thinking"),
  thinking: Schema.String,
  thinkingSignature: Schema.optional(Schema.String),
  redacted: Schema.optional(Schema.Boolean),
});
export type PrimeThinkingContent = typeof PrimeThinkingContentSchema.Type;

export const PrimeImageContentSchema = Schema.Struct({
  type: Schema.Literal("image"),
  data: Schema.String,
  mimeType: Schema.String,
});
export type PrimeImageContent = typeof PrimeImageContentSchema.Type;

export const PrimeToolCallContentSchema = Schema.Struct({
  type: Schema.Literal("toolCall"),
  id: Schema.String,
  name: Schema.String,
  arguments: Schema.Record({ key: Schema.String, value: Schema.Unknown }),
  thoughtSignature: Schema.optional(Schema.String),
  // Streaming artifacts written by prime-agent on partial/aborted tool calls.
  // Kept in the schema so strict decode admits the record; never projected.
  partialArgs: Schema.optional(Schema.String),
  partialJson: Schema.optional(Schema.String),
  streamIndex: Schema.optional(Schema.Number),
});
export type PrimeToolCallContent = typeof PrimeToolCallContentSchema.Type;

export const PrimeUsageCostSchema = Schema.Struct({
  input: NonNegativeFiniteNumber,
  output: NonNegativeFiniteNumber,
  cacheRead: NonNegativeFiniteNumber,
  cacheWrite: NonNegativeFiniteNumber,
  total: NonNegativeFiniteNumber,
});

export const PrimeUsageSchema = Schema.Struct({
  input: NonNegativeInteger,
  output: NonNegativeInteger,
  cacheRead: NonNegativeInteger,
  cacheWrite: NonNegativeInteger,
  totalTokens: NonNegativeInteger,
  cost: PrimeUsageCostSchema,
});
export type PrimeUsage = typeof PrimeUsageSchema.Type;

export const PrimeUserMessageSchema = Schema.Struct({
  role: Schema.Literal("user"),
  content: Schema.Union(
    Schema.String,
    Schema.Array(Schema.Union(PrimeTextContentSchema, PrimeImageContentSchema)),
  ),
  timestamp: Schema.Number,
});
export type PrimeUserMessage = typeof PrimeUserMessageSchema.Type;

export const PrimeAssistantMessageSchema = Schema.Struct({
  role: Schema.Literal("assistant"),
  content: Schema.Array(
    Schema.Union(PrimeTextContentSchema, PrimeThinkingContentSchema, PrimeToolCallContentSchema),
  ),
  api: Schema.String,
  provider: Schema.String,
  model: Schema.String,
  responseModel: Schema.optional(Schema.String),
  responseId: Schema.optional(Schema.String),
  diagnostics: Schema.optional(Schema.Unknown),
  usage: PrimeUsageSchema,
  stopReason: Schema.Literal("stop", "length", "toolUse", "error", "aborted"),
  // Provider's raw stop/finish reason when the mapped stopReason is "error"
  // (e.g. "refusal", "SAFETY"). Written on the persisted assistant message by
  // the ai providers (pi-ai types.ts `AssistantMessage.stopReasonRaw`).
  stopReasonRaw: Schema.optional(Schema.String),
  errorMessage: Schema.optional(Schema.String),
  timestamp: Schema.Number,
});
export type PrimeAssistantMessage = typeof PrimeAssistantMessageSchema.Type;

export const PrimeToolResultMessageSchema = Schema.Struct({
  role: Schema.Literal("toolResult"),
  toolCallId: Schema.String,
  toolName: Schema.String,
  content: Schema.Array(Schema.Union(PrimeTextContentSchema, PrimeImageContentSchema)),
  details: Schema.optional(Schema.Unknown),
  isError: Schema.Boolean,
  timestamp: Schema.Number,
});
export type PrimeToolResultMessage = typeof PrimeToolResultMessageSchema.Type;

export const PrimeBashExecutionMessageSchema = Schema.Struct({
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
export type PrimeBashExecutionMessage = typeof PrimeBashExecutionMessageSchema.Type;

export const PrimeCustomAgentMessageSchema = Schema.Struct({
  role: Schema.Literal("custom"),
  customType: Schema.String,
  content: Schema.Union(
    Schema.String,
    Schema.Array(Schema.Union(PrimeTextContentSchema, PrimeImageContentSchema)),
  ),
  display: Schema.Boolean,
  details: Schema.optional(Schema.Unknown),
  timestamp: Schema.Number,
});
export type PrimeCustomAgentMessage = typeof PrimeCustomAgentMessageSchema.Type;

/** v2-era hookMessage role, renamed to `custom` in v3 (migrated on read). */
export const PrimeLegacyHookMessageSchema = Schema.Struct({
  role: Schema.Literal("hookMessage"),
  customType: Schema.String,
  content: Schema.Union(
    Schema.String,
    Schema.Array(Schema.Union(PrimeTextContentSchema, PrimeImageContentSchema)),
  ),
  display: Schema.Boolean,
  details: Schema.optional(Schema.Unknown),
  timestamp: Schema.Number,
});

export const PrimeBranchSummaryMessageSchema = Schema.Struct({
  role: Schema.Literal("branchSummary"),
  summary: Schema.String,
  fromId: Schema.String,
  timestamp: Schema.Number,
});

export const PrimeCompactionSummaryMessageSchema = Schema.Struct({
  role: Schema.Literal("compactionSummary"),
  summary: Schema.String,
  tokensBefore: Schema.Number,
  timestamp: Schema.Number,
});

export const PrimeAgentMessageSchema = Schema.Union(
  PrimeUserMessageSchema,
  PrimeAssistantMessageSchema,
  PrimeToolResultMessageSchema,
  PrimeBashExecutionMessageSchema,
  PrimeCustomAgentMessageSchema,
  PrimeLegacyHookMessageSchema,
  PrimeBranchSummaryMessageSchema,
  PrimeCompactionSummaryMessageSchema,
);
export type PrimeAgentMessage = typeof PrimeAgentMessageSchema.Type;

const PrimeEntryBase = {
  id: Schema.String,
  parentId: Schema.NullOr(Schema.String),
  timestamp: Schema.String,
} as const;

export const PrimeMessageEntrySchema = Schema.Struct({
  type: Schema.Literal("message"),
  ...PrimeEntryBase,
  message: PrimeAgentMessageSchema,
});
export const PrimeThinkingLevelChangeEntrySchema = Schema.Struct({
  type: Schema.Literal("thinking_level_change"),
  ...PrimeEntryBase,
  thinkingLevel: Schema.String,
});
export const PrimeModelChangeEntrySchema = Schema.Struct({
  type: Schema.Literal("model_change"),
  ...PrimeEntryBase,
  provider: Schema.String,
  modelId: Schema.String,
});
export const PrimeServiceTierChangeEntrySchema = Schema.Struct({
  type: Schema.Literal("service_tier_change"),
  ...PrimeEntryBase,
  serviceTier: Schema.String,
});
export const PrimeCompactionEntrySchema = Schema.Struct({
  type: Schema.Literal("compaction"),
  ...PrimeEntryBase,
  summary: Schema.String,
  firstKeptEntryId: Schema.String,
  tokensBefore: Schema.Number,
  details: Schema.optional(Schema.Unknown),
  fromHook: Schema.optional(Schema.Boolean),
  customInstructions: Schema.optional(Schema.String),
});
export const PrimeBranchSummaryEntrySchema = Schema.Struct({
  type: Schema.Literal("branch_summary"),
  ...PrimeEntryBase,
  fromId: Schema.String,
  summary: Schema.String,
  details: Schema.optional(Schema.Unknown),
  fromHook: Schema.optional(Schema.Boolean),
});
export const PrimeCustomEntrySchema = Schema.Struct({
  type: Schema.Literal("custom"),
  ...PrimeEntryBase,
  customType: Schema.String,
  data: Schema.optional(Schema.Unknown),
});
export const PrimeCustomMessageEntrySchema = Schema.Struct({
  type: Schema.Literal("custom_message"),
  ...PrimeEntryBase,
  customType: Schema.String,
  content: Schema.Union(
    Schema.String,
    Schema.Array(Schema.Union(PrimeTextContentSchema, PrimeImageContentSchema)),
  ),
  details: Schema.optional(Schema.Unknown),
  display: Schema.Boolean,
});
export const PrimeLabelEntrySchema = Schema.Struct({
  type: Schema.Literal("label"),
  ...PrimeEntryBase,
  targetId: Schema.String,
  label: Schema.optional(Schema.String),
});
export const PrimeSessionInfoEntrySchema = Schema.Struct({
  type: Schema.Literal("session_info"),
  ...PrimeEntryBase,
  name: Schema.optional(Schema.String),
});
export const PrimeSessionStateEntrySchema = Schema.Struct({
  type: Schema.Literal("session_state"),
  ...PrimeEntryBase,
  state: Schema.Struct({
    status: Schema.Literal("active", "archived", "crash"),
  }),
});
export const PrimeAgentStatusEntrySchema = Schema.Struct({
  type: Schema.Literal("agent_status"),
  ...PrimeEntryBase,
  status: Schema.Struct({
    summary: Schema.String,
    taskState: Schema.optional(Schema.String),
    basedOnMessageCount: Schema.Number,
  }),
});
export const PrimeGitStateEntrySchema = Schema.Struct({
  type: Schema.Literal("git_state"),
  ...PrimeEntryBase,
  git: Schema.Struct({
    repoUrl: Schema.optional(Schema.String),
    commit: Schema.optional(Schema.String),
    branch: Schema.optional(Schema.String),
  }),
});
export const PrimeChildUsageAttributedEntrySchema = Schema.Struct({
  type: Schema.Literal("child_usage_attributed"),
  ...PrimeEntryBase,
  targetId: Schema.String,
  childUsage: PrimeUsageSchema,
  aggregateUsage: PrimeUsageSchema,
  origin: Schema.optional(Schema.String),
});

export const PrimeSessionEntrySchema = Schema.Union(
  PrimeMessageEntrySchema,
  PrimeThinkingLevelChangeEntrySchema,
  PrimeModelChangeEntrySchema,
  PrimeServiceTierChangeEntrySchema,
  PrimeCompactionEntrySchema,
  PrimeBranchSummaryEntrySchema,
  PrimeCustomEntrySchema,
  PrimeCustomMessageEntrySchema,
  PrimeLabelEntrySchema,
  PrimeSessionInfoEntrySchema,
  PrimeSessionStateEntrySchema,
  PrimeAgentStatusEntrySchema,
  PrimeGitStateEntrySchema,
  PrimeChildUsageAttributedEntrySchema,
);
export type PrimeSessionEntry = typeof PrimeSessionEntrySchema.Type;

export type PrimeClassification = SignalDecision<PrimeSessionHeader | PrimeSessionEntry, SessionEventKind>;

export const PRIME_HEADER_DECODE_FAILED = "prime.header.decode_failed";
export const PRIME_ENTRY_DECODE_FAILED = "prime.entry.decode_failed";
export const PRIME_ENTRY_UNKNOWN_TYPE = "prime.entry.unknown_type";
export const PRIME_ENTRY_AGENT_STATUS = "prime.entry.agent_status";
export const PRIME_MESSAGE_DECODE_FAILED = "prime.message.decode_failed";
export const PRIME_MESSAGE_UNKNOWN_ROLE = "prime.message.unknown_role";
export const PRIME_CONTENT_UNKNOWN_TYPE = "prime.content.unknown_type";

/**
 * Declarative per-record dispatch . Every modeled entry type maps to
 * a SessionEventKind; unmodeled types drop with a NAMED reason. `agent_status`
 * is expected append-only daemon status noise (empty summaries, one entry per
 * status tick) and is dropped silently with its named reason — it never
 * surfaces as an event and never raises a decode diagnostic.
 */
const ENTRY_KIND: Readonly<Record<string, SessionEventKind | "drop_agent_status">> = {
  message: "message",
  thinking_level_change: "lifecycle",
  model_change: "lifecycle",
  service_tier_change: "lifecycle",
  compaction: "summary",
  branch_summary: "summary",
  custom: "lifecycle",
  custom_message: "preamble",
  label: "lifecycle",
  session_info: "lifecycle",
  session_state: "lifecycle",
  git_state: "lifecycle",
  child_usage_attributed: "lifecycle",
  agent_status: "drop_agent_status",
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

/** Same diagnostic-name ladder as the Pi adapter, but with `prime.` prefix. */
const decodeFailureName = (record: Record<string, unknown>): string => {
  if (record.type !== "message") return PRIME_ENTRY_DECODE_FAILED;
  const message = recordOf(record.message);
  if (message === undefined) return PRIME_MESSAGE_DECODE_FAILED;
  const role = message.role;
  if (typeof role !== "string" || KNOWN_MESSAGE_ROLES[role] !== true) return PRIME_MESSAGE_UNKNOWN_ROLE;
  const content = message.content;
  if (Array.isArray(content)) {
    for (const part of content) {
      const partRecord = recordOf(part);
      if (partRecord !== undefined && typeof partRecord.type === "string" && KNOWN_CONTENT_TYPES[partRecord.type] !== true) {
        return PRIME_CONTENT_UNKNOWN_TYPE;
      }
    }
  }
  return PRIME_MESSAGE_DECODE_FAILED;
};

export const classifyPrimeRecord = (
  record: unknown,
  options: {
    readonly header?: boolean;
    readonly version?: 2 | 3;
    readonly diagnostics?: { push: (d: { readonly name: string; readonly message: string }) => void };
  } = {},
): PrimeClassification => {
  const source = recordOf(record);
  if (source === undefined) {
    const name = options.header === true ? PRIME_HEADER_DECODE_FAILED : PRIME_ENTRY_DECODE_FAILED;
    const message = "Prime record must be an object";
    options.diagnostics?.push({ name, message });
    return drop(`${name}: ${message}`);
  }
  const type = source.type;
  if (options.header === true) {
    const decoded = Schema.decodeUnknownEither(PrimeSessionHeaderSchema)(record, { errors: "all", onExcessProperty: "error" });
    if (decoded._tag === "Left") {
      const message = ParseResult.TreeFormatter.formatErrorSync(decoded.left);
      options.diagnostics?.push({ name: PRIME_HEADER_DECODE_FAILED, message });
      return drop(`${PRIME_HEADER_DECODE_FAILED}: ${message}`);
    }
    return signal("system", decoded.right);
  }
  if (typeof type !== "string") {
    const message = "Prime entry type must be a string";
    options.diagnostics?.push({ name: PRIME_ENTRY_UNKNOWN_TYPE, message });
    return drop(`${PRIME_ENTRY_UNKNOWN_TYPE}: ${message}`);
  }
  const kind = ENTRY_KIND[type];
  if (kind === undefined) {
    const message = `unmodeled Prime entry type \`${type}\``;
    options.diagnostics?.push({ name: PRIME_ENTRY_UNKNOWN_TYPE, message });
    return drop(`${PRIME_ENTRY_UNKNOWN_TYPE}: ${message}`);
  }
  if (kind === "drop_agent_status") {
    // Expected append-only daemon status noise: silent named drop, never a
    // decode diagnostic (the record may still be malformed; the schema guard
    // below keeps that fail-closed for every other type).
    return drop(`${PRIME_ENTRY_AGENT_STATUS}: append-only daemon status entry`);
  }
  const decoded = Schema.decodeUnknownEither(PrimeSessionEntrySchema)(record, { errors: "all", onExcessProperty: "error" });
  if (decoded._tag === "Left") {
    const name = decodeFailureName(source);
    const message = ParseResult.TreeFormatter.formatErrorSync(decoded.left);
    options.diagnostics?.push({ name, message });
    return drop(`${name}: ${message}`);
  }
  return signal(kind, decoded.right);
};
