import { Schema } from "effect";

/**
 * Amp threads list/export JSON — fail-closed Effect Schemas grounded against
 * live `amp threads list --json` and `amp threads export <id>` payloads
 * (measured 2026-07-24).
 *
 * Provider garbage becomes a named diagnostic at the adapter boundary; no
 * silent coercion and no invented byte budgets.
 */

const UnknownRecord = Schema.Record({ key: Schema.String, value: Schema.Unknown });
const NullableText = Schema.optional(Schema.NullOr(Schema.String));

const NonEmptyString = Schema.String.pipe(
  Schema.filter((value) => value.trim().length > 0, {
    message: () => "Expected a non-empty string",
  }),
);

/** One row from `amp threads list --json`. */
export const AmpThreadListEntrySchema = Schema.Struct({
  id: NonEmptyString,
  title: NullableText,
  updated: NonEmptyString,
  tree: NullableText,
  messageCount: Schema.optional(Schema.Number),
});
export type AmpThreadListEntry = typeof AmpThreadListEntrySchema.Type;

/** Text content block. */
export const AmpTextBlockSchema = Schema.Struct({
  type: Schema.Literal("text"),
  text: Schema.String,
  startTime: Schema.optional(Schema.Unknown),
  finalTime: Schema.optional(Schema.Unknown),
  blockState: Schema.optional(Schema.String),
});
export type AmpTextBlock = typeof AmpTextBlockSchema.Type;

/** Thinking/reasoning content block. Opaque encrypted blobs are optional. */
export const AmpThinkingBlockSchema = Schema.Struct({
  type: Schema.Literal("thinking"),
  thinking: Schema.String,
  signature: Schema.optional(Schema.String),
  startTime: Schema.optional(Schema.Unknown),
  finalTime: Schema.optional(Schema.Unknown),
  provider: Schema.optional(Schema.String),
  openAIReasoning: Schema.optional(UnknownRecord),
  blockState: Schema.optional(Schema.String),
});
export type AmpThinkingBlock = typeof AmpThinkingBlockSchema.Type;

/** Tool invocation content block. */
export const AmpToolUseBlockSchema = Schema.Struct({
  type: Schema.Literal("tool_use"),
  id: NonEmptyString,
  name: NonEmptyString,
  input: Schema.optional(Schema.Unknown),
  startTime: Schema.optional(Schema.Unknown),
  finalTime: Schema.optional(Schema.Unknown),
  complete: Schema.optional(Schema.Boolean),
  blockState: Schema.optional(Schema.String),
  providerToolUseId: Schema.optional(Schema.String),
});
export type AmpToolUseBlock = typeof AmpToolUseBlockSchema.Type;

/**
 * Tool result content block. `run.result` is heterogeneous across tools
 * (content[], output string, search-result arrays) — kept as Unknown and
 * projected by the adapter.
 */
export const AmpToolResultBlockSchema = Schema.Struct({
  type: Schema.Literal("tool_result"),
  toolUseID: NonEmptyString,
  run: Schema.optional(UnknownRecord),
  startTime: Schema.optional(Schema.Unknown),
  finalTime: Schema.optional(Schema.Unknown),
  blockState: Schema.optional(Schema.String),
});
export type AmpToolResultBlock = typeof AmpToolResultBlockSchema.Type;

export const AmpMessageSchema = Schema.Struct({
  role: Schema.optional(Schema.String),
  content: Schema.optional(Schema.Array(Schema.Unknown)),
  meta: Schema.optional(UnknownRecord),
  messageId: Schema.optional(Schema.Unknown),
  protocolMessageID: Schema.optional(Schema.String),
  readAt: Schema.optional(Schema.NullOr(Schema.String)),
  state: Schema.optional(UnknownRecord),
  usage: Schema.optional(UnknownRecord),
  userState: Schema.optional(UnknownRecord),
});
export type AmpMessage = typeof AmpMessageSchema.Type;

export const AmpTreeSchema = Schema.Struct({
  uri: Schema.optional(Schema.String),
  repository: Schema.optional(
    Schema.Struct({
      url: Schema.optional(Schema.String),
      ref: Schema.optional(Schema.String),
      sha: Schema.optional(Schema.String),
      type: Schema.optional(Schema.String),
    }),
  ),
  displayName: Schema.optional(Schema.String),
});
export type AmpTree = typeof AmpTreeSchema.Type;

export const AmpExportEnvSchema = Schema.Struct({
  initial: Schema.optional(
    Schema.Struct({
      trees: Schema.optional(Schema.Array(AmpTreeSchema)),
      platform: Schema.optional(UnknownRecord),
    }),
  ),
});
export type AmpExportEnv = typeof AmpExportEnvSchema.Type;

/** Full `amp threads export <id>` payload (v-flexible). */
export const AmpExportSchema = Schema.Struct({
  v: Schema.optional(Schema.Number),
  id: Schema.optional(Schema.String),
  title: NullableText,
  created: Schema.optional(Schema.Number),
  updatedAt: Schema.optional(Schema.String),
  env: Schema.optional(AmpExportEnvSchema),
  meta: Schema.optional(UnknownRecord),
  messages: Schema.optional(Schema.Array(AmpMessageSchema)),
  activatedSkills: Schema.optional(Schema.Unknown),
  creatorUserID: Schema.optional(Schema.Unknown),
  pinned: Schema.optional(Schema.Unknown),
  openExpiresAt: Schema.optional(Schema.Unknown),
});
export type AmpExport = typeof AmpExportSchema.Type;
