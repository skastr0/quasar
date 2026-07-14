import { Schema } from "effect";

/** Read plane only; schemas are the single source of truth shared by
 * server (producer, bun:sqlite native), CLI/TUI/vellum (consumers, HTTP clients). */

export const Provider = Schema.Literal(
  "codex",
  "claude",
  "opencode",
  "grok",
  "kimi",
  "hermes",
  "antigravity",
  "omp",
  "pi",
  "cursor",
  "devin",
);
export type Provider = typeof Provider.Type;

export const SearchMode = Schema.Literal(
  "lexical",
  "semantic",
  "fusion",
);
export type SearchMode = typeof SearchMode.Type;

export const MessageRole = Schema.Literal(
  "user",
  "assistant",
  "reasoning",
);
export type MessageRole = typeof MessageRole.Type;

export const IngestRunStatus = Schema.Literal(
  "running",
  "completed",
  "failed",
);
export type IngestRunStatus = typeof IngestRunStatus.Type;

// Optional string columns are read straight out of bun:sqlite server-side
// (packages/server/src/store.ts), where a SQL NULL materializes as JS `null`
// and survives JSON.stringify as a present `"field": null` key -- never an
// absent key. Schema.optional(Schema.String) only accepts absent-or-string
// and rejects `null`, so it decodes real rows fine until the first row with
// an actually-null column arrives, then throws. Caught live against
// https://quasar.tail6742f6.ts.net (LIVE check 1): ProjectRow.rawPath came
// back `null` on a real row. Schema.optionalWith(..., { nullable: true }) is
// the Effect Schema feature built for exactly this SQL-nullable-column shape
// -- it accepts absent OR null on the wire and normalizes both to `undefined`
// in the decoded value, so ProjectRow.rawPath stays `string | undefined` for
// every consumer. Applied to every optional string field sourced the same
// way (server/model.ts's other `?: string` columns), not just the one that
// happened to fail on this query.
const nullableString = Schema.optionalWith(Schema.String, { nullable: true });

export const ProjectRow = Schema.Struct({
  projectKey: Schema.String,
  displayName: Schema.String,
  rawPath: nullableString,
});
export type ProjectRow = typeof ProjectRow.Type;

export const SessionRow = Schema.Struct({
  sessionId: Schema.String,
  projectKey: Schema.String,
  provider: Provider,
  agentName: Schema.String,
  title: nullableString,
  startedAt: nullableString,
  updatedAt: nullableString,
  sourcePath: Schema.String,
  sourceFingerprint: Schema.String,
  host: Schema.String,
  identitySchemeVersion: Schema.Number,
  parentSessionId: nullableString,
  messageCount: Schema.Number,
  toolCallCount: Schema.Number,
});
export type SessionRow = typeof SessionRow.Type;

export const MessageRow = Schema.Struct({
  sessionId: Schema.String,
  seq: Schema.Number,
  role: MessageRole,
  text: Schema.String,
  ts: nullableString,
  projectKey: Schema.String,
  contentHash: Schema.String,
});
export type MessageRow = typeof MessageRow.Type;

export const ToolCallRow = Schema.Struct({
  id: Schema.String,
  sessionId: Schema.String,
  seq: Schema.Number,
  toolName: Schema.String,
  status: nullableString,
  inputText: Schema.String,
  outputText: Schema.String,
  startedAt: nullableString,
  completedAt: nullableString,
  projectKey: Schema.String,
  provider: Provider,
});
export type ToolCallRow = typeof ToolCallRow.Type;

export const IngestRunRow = Schema.Struct({
  runId: Schema.String,
  provider: Schema.Union(Provider, Schema.Literal("all")),
  status: IngestRunStatus,
  startedAt: Schema.String,
  completedAt: nullableString,
  sessionsSeen: Schema.Number,
  sessionsWritten: Schema.Number,
  sessionsSkipped: Schema.Number,
  sessionsFailed: Schema.Number,
});
export type IngestRunRow = typeof IngestRunRow.Type;

export const SearchHitRow = Schema.Struct({
  key: Schema.String,
  sessionId: Schema.String,
  seq: Schema.Number,
  role: MessageRole,
  projectKey: Schema.String,
  provider: Provider,
  text: Schema.String,
  contentHash: Schema.String,
});
export type SearchHitRow = typeof SearchHitRow.Type;

export const SearchHit = Schema.Struct({
  key: Schema.String,
  score: Schema.Number,
  row: SearchHitRow,
});
export type SearchHit = typeof SearchHit.Type;

export const ServerError = Schema.Struct({
  type: Schema.Literal(
    "BadRequest",
    "NotFound",
    "Unauthorized",
    "SemanticDisabled",
    "EmbeddingUnavailable",
    "ServiceUnavailable",
  ),
  message: Schema.String,
  details: Schema.optional(Schema.Unknown),
});
export type ServerError = typeof ServerError.Type;

export const SuccessEnvelope = Schema.Struct({
  ok: Schema.Literal(true),
  command: Schema.optional(Schema.String),
  data: Schema.Unknown,
});
export type SuccessEnvelope = typeof SuccessEnvelope.Type;

export const ErrorEnvelope = Schema.Struct({
  ok: Schema.Literal(false),
  route: Schema.optional(Schema.String),
  command: Schema.optional(Schema.String),
  error: ServerError,
});
export type ErrorEnvelope = typeof ErrorEnvelope.Type;

export const Envelope = Schema.Union(SuccessEnvelope, ErrorEnvelope);
export type Envelope = typeof Envelope.Type;
