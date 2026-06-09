import { ParseResult, Schema } from "effect";

export const UnknownRecord = Schema.Record({
  key: Schema.String,
  value: Schema.Unknown,
});
export type UnknownRecord = typeof UnknownRecord.Type;

export const ProviderSchema = Schema.Literal(
  "codex",
  "claude",
  "opencode",
  "grok",
  "amp",
  "pi",
  "kimi",
  "droid",
  "hermes",
  "antigravity",
  "cursor",
  "gemini",
  "unknown",
);
export type ProviderSchema = typeof ProviderSchema.Type;

export const AdapterStatusSchema = Schema.Literal(
  "available",
  "no_data_found",
  "unsupported",
  "error",
);
export type AdapterStatusSchema = typeof AdapterStatusSchema.Type;

export const ParserConfidenceSchema = Schema.Literal(
  "documented",
  "observed",
  "brittle",
  "capture-file",
);
export type ParserConfidenceSchema = typeof ParserConfidenceSchema.Type;

export const ProjectIdentityConfidenceSchema = Schema.Literal(
  "explicit",
  "high",
  "medium",
  "low",
);
export type ProjectIdentityConfidenceSchema = typeof ProjectIdentityConfidenceSchema.Type;

export const SessionRoleSchema = Schema.Literal(
  "user",
  "assistant",
  "developer",
  "system",
  "tool",
  "thinking",
  "unknown",
);
export type SessionRoleSchema = typeof SessionRoleSchema.Type;

export const SessionEventKindSchema = Schema.Literal(
  "message",
  "tool_call",
  "tool_result",
  "reasoning",
  "preamble",
  "system",
  "summary",
  "edit",
  "snapshot",
  "lifecycle",
  "usage",
  "unknown",
);
export type SessionEventKindSchema = typeof SessionEventKindSchema.Type;

export const ContentBlockKindSchema = Schema.Literal(
  "text",
  "markdown",
  "thinking",
  "image",
  "file",
  "json",
);
export type ContentBlockKindSchema = typeof ContentBlockKindSchema.Type;

export const SessionEdgeKindSchema = Schema.Literal(
  "next",
  "parent",
  "tool_result_for",
  "forked_from",
  "subagent_of",
  "compacted_into",
  "artifact_of",
);
export type SessionEdgeKindSchema = typeof SessionEdgeKindSchema.Type;

export const MachineIdentityBoundary = Schema.Struct({
  machineId: Schema.String,
  hostname: Schema.optional(Schema.String),
  tailscaleName: Schema.optional(Schema.String),
  platform: Schema.optional(Schema.String),
});
export type MachineIdentityBoundary = typeof MachineIdentityBoundary.Type;

export const SourceRootBoundary = Schema.Struct({
  provider: ProviderSchema,
  adapterId: Schema.String,
  rootPath: Schema.String,
  machineId: Schema.String,
  discoveredAt: Schema.String,
});
export type SourceRootBoundary = typeof SourceRootBoundary.Type;

export const ProjectSignalBoundary = Schema.Struct({
  kind: Schema.Literal("explicit", "git_remote", "package", "workspace", "path"),
  value: Schema.String,
  confidence: ProjectIdentityConfidenceSchema,
});
export type ProjectSignalBoundary = typeof ProjectSignalBoundary.Type;

export const ProjectResolutionBoundary = Schema.Struct({
  projectIdentityKey: Schema.String,
  displayName: Schema.String,
  confidence: ProjectIdentityConfidenceSchema,
  rawPath: Schema.optional(Schema.String),
  normalizedPath: Schema.optional(Schema.String),
  gitRemote: Schema.optional(Schema.String),
  gitRemoteNormalized: Schema.optional(Schema.String),
  packageName: Schema.optional(Schema.String),
  signals: Schema.Array(ProjectSignalBoundary),
});
export type ProjectResolutionBoundary = typeof ProjectResolutionBoundary.Type;

export const ContentBlockBoundary = Schema.Struct({
  id: Schema.String,
  sequence: Schema.Number,
  kind: ContentBlockKindSchema,
  text: Schema.optional(Schema.String),
  markdown: Schema.optional(Schema.String),
  thinking: Schema.optional(Schema.String),
  path: Schema.optional(Schema.String),
  uri: Schema.optional(Schema.String),
  mediaType: Schema.optional(Schema.String),
  value: Schema.optional(Schema.Unknown),
  metadata: Schema.optional(Schema.Unknown),
});
export type ContentBlockBoundary = typeof ContentBlockBoundary.Type;

export const RawReferenceBoundary = Schema.Struct({
  sourcePath: Schema.String,
  line: Schema.optional(Schema.Number),
  table: Schema.optional(Schema.String),
  rowId: Schema.optional(Schema.String),
  nativeType: Schema.optional(Schema.String),
});
export type RawReferenceBoundary = typeof RawReferenceBoundary.Type;

export const SessionEventBoundary = Schema.Struct({
  id: Schema.String,
  sessionId: Schema.String,
  nativeEventId: Schema.optional(Schema.String),
  sequence: Schema.Number,
  timestamp: Schema.optional(Schema.String),
  machineId: Schema.String,
  provider: ProviderSchema,
  agentName: Schema.String,
  projectIdentityKey: Schema.String,
  role: SessionRoleSchema,
  kind: SessionEventKindSchema,
  contentText: Schema.optional(Schema.String),
  contentBlocks: Schema.optionalWith(Schema.Array(ContentBlockBoundary), {
    default: () => [],
  }),
  toolCallId: Schema.optional(Schema.String),
  parentEventId: Schema.optional(Schema.String),
  rawReference: RawReferenceBoundary,
});
export type SessionEventBoundary = typeof SessionEventBoundary.Type;

export const ToolCallBoundary = Schema.Struct({
  id: Schema.String,
  sessionId: Schema.optional(Schema.String),
  eventId: Schema.optional(Schema.String),
  machineId: Schema.optional(Schema.String),
  provider: Schema.optional(ProviderSchema),
  agentName: Schema.optional(Schema.String),
  projectIdentityKey: Schema.optional(Schema.String),
  toolName: Schema.String,
  status: Schema.optional(Schema.String),
  input: Schema.optional(Schema.Unknown),
  output: Schema.optional(Schema.Unknown),
  startedAt: Schema.optional(Schema.String),
  completedAt: Schema.optional(Schema.String),
});
export type ToolCallBoundary = typeof ToolCallBoundary.Type;

export const SessionEdgeBoundary = Schema.Struct({
  id: Schema.String,
  sessionId: Schema.optional(Schema.String),
  machineId: Schema.optional(Schema.String),
  provider: Schema.optional(ProviderSchema),
  agentName: Schema.optional(Schema.String),
  projectIdentityKey: Schema.optional(Schema.String),
  kind: SessionEdgeKindSchema,
  fromEventId: Schema.optional(Schema.String),
  toEventId: Schema.optional(Schema.String),
  fromId: Schema.optional(Schema.String),
  toId: Schema.optional(Schema.String),
  rawReference: Schema.optional(Schema.Unknown),
  metadata: Schema.optional(Schema.Unknown),
});
export type SessionEdgeBoundary = typeof SessionEdgeBoundary.Type;

export const UsageRecordBoundary = Schema.Struct({
  id: Schema.String,
  sessionId: Schema.optional(Schema.String),
  eventId: Schema.optional(Schema.String),
  machineId: Schema.optional(Schema.String),
  provider: Schema.optional(ProviderSchema),
  agentName: Schema.optional(Schema.String),
  projectIdentityKey: Schema.optional(Schema.String),
  timestamp: Schema.optional(Schema.String),
  model: Schema.optional(Schema.String),
  modelProvider: Schema.optional(Schema.String),
  inputTokens: Schema.optional(Schema.Number),
  outputTokens: Schema.optional(Schema.Number),
  reasoningTokens: Schema.optional(Schema.Number),
  cacheCreationInputTokens: Schema.optional(Schema.Number),
  cacheReadInputTokens: Schema.optional(Schema.Number),
  totalTokens: Schema.optional(Schema.Number),
  cost: Schema.optional(Schema.Number),
  currency: Schema.optional(Schema.String),
});
export type UsageRecordBoundary = typeof UsageRecordBoundary.Type;

export const ArtifactBoundary = Schema.Struct({
  id: Schema.String,
  sessionId: Schema.optional(Schema.String),
  eventId: Schema.optional(Schema.String),
  machineId: Schema.optional(Schema.String),
  provider: Schema.optional(ProviderSchema),
  agentName: Schema.optional(Schema.String),
  projectIdentityKey: Schema.optional(Schema.String),
  kind: Schema.String,
  path: Schema.optional(Schema.String),
  uri: Schema.optional(Schema.String),
  contentHash: Schema.optional(Schema.String),
  sourcePath: Schema.optional(Schema.String),
  sourceRef: Schema.optional(Schema.Unknown),
  metadata: Schema.optional(Schema.Unknown),
});
export type ArtifactBoundary = typeof ArtifactBoundary.Type;

export const IngestSessionBoundary = Schema.Struct({
  id: Schema.String,
  nativeSessionId: Schema.String,
  provider: ProviderSchema,
  agentName: Schema.String,
  machineId: Schema.String,
  projectIdentity: ProjectResolutionBoundary,
  nativeProjectKey: Schema.optional(Schema.String),
  title: Schema.optional(Schema.String),
  startedAt: Schema.optional(Schema.String),
  updatedAt: Schema.optional(Schema.String),
  sourceRoot: Schema.String,
  sourcePath: Schema.String,
  events: Schema.optionalWith(Schema.Array(SessionEventBoundary), {
    default: () => [],
  }),
  toolCalls: Schema.optionalWith(Schema.Array(ToolCallBoundary), {
    default: () => [],
  }),
  sessionEdges: Schema.optionalWith(Schema.Array(SessionEdgeBoundary), {
    default: () => [],
  }),
  usageRecords: Schema.optionalWith(Schema.Array(UsageRecordBoundary), {
    default: () => [],
  }),
  artifacts: Schema.optionalWith(Schema.Array(ArtifactBoundary), {
    default: () => [],
  }),
  eventCount: Schema.optional(Schema.Number),
  toolCallCount: Schema.optional(Schema.Number),
  contentBlockCount: Schema.optional(Schema.Number),
  sessionEdgeCount: Schema.optional(Schema.Number),
  usageRecordCount: Schema.optional(Schema.Number),
  artifactCount: Schema.optional(Schema.Number),
  expectedEventIds: Schema.optional(Schema.Array(Schema.String)),
  expectedToolCallIds: Schema.optional(Schema.Array(Schema.String)),
  expectedContentBlockIds: Schema.optional(Schema.Array(Schema.String)),
  expectedSessionEdgeIds: Schema.optional(Schema.Array(Schema.String)),
  expectedUsageRecordIds: Schema.optional(Schema.Array(Schema.String)),
  expectedArtifactIds: Schema.optional(Schema.Array(Schema.String)),
  partialSession: Schema.optional(Schema.Boolean),
  deferCleanup: Schema.optional(Schema.Boolean),
});
export type IngestSessionBoundary = typeof IngestSessionBoundary.Type;

export const AdapterDiagnosticBoundary = Schema.Struct({
  adapterId: Schema.String,
  provider: ProviderSchema,
  status: AdapterStatusSchema,
  parserConfidence: Schema.optional(ParserConfidenceSchema),
  rootPath: Schema.optional(Schema.String),
  message: Schema.String,
  details: Schema.optional(Schema.Unknown),
});
export type AdapterDiagnosticBoundary = typeof AdapterDiagnosticBoundary.Type;

export const ImportJobStatusSchema = Schema.Literal(
  "queued",
  "running",
  "succeeded",
  "partial_failure",
  "failed",
);
export type ImportJobStatusSchema = typeof ImportJobStatusSchema.Type;

export const ImportChunkStatusSchema = Schema.Literal(
  "pending",
  "running",
  "succeeded",
  "failed",
  "dead_letter",
);
export type ImportChunkStatusSchema = typeof ImportChunkStatusSchema.Type;

export const IngestBatchBoundary = Schema.Struct({
  protocolVersion: Schema.Literal("quasar.ingest/v1"),
  machine: MachineIdentityBoundary,
  sourceRoots: Schema.Array(SourceRootBoundary),
  sessions: Schema.Array(IngestSessionBoundary),
  diagnostics: Schema.Array(AdapterDiagnosticBoundary),
  generatedAt: Schema.String,
});
export type IngestBatchBoundary = typeof IngestBatchBoundary.Type;

export const IngestSessionManifestBoundary = Schema.Struct({
  id: Schema.String,
  nativeSessionId: Schema.String,
  provider: ProviderSchema,
  machineId: Schema.String,
  projectIdentityKey: Schema.String,
  sourceRoot: Schema.String,
  sourcePath: Schema.String,
  eventCount: Schema.Number,
  toolCallCount: Schema.Number,
  contentBlockCount: Schema.Number,
  sessionEdgeCount: Schema.Number,
  usageRecordCount: Schema.Number,
  artifactCount: Schema.Number,
});
export type IngestSessionManifestBoundary = typeof IngestSessionManifestBoundary.Type;

export const IngestManifestBoundary = Schema.Struct({
  protocolVersion: Schema.Literal("quasar.ingest-manifest/v1"),
  machine: MachineIdentityBoundary,
  sourceRoots: Schema.Array(SourceRootBoundary),
  sessions: Schema.Array(IngestSessionManifestBoundary),
  diagnostics: Schema.Array(AdapterDiagnosticBoundary),
  generatedAt: Schema.optional(Schema.String),
  sessionCount: Schema.Number,
  eventCount: Schema.Number,
  toolCallCount: Schema.Number,
  contentBlockCount: Schema.Number,
  sessionEdgeCount: Schema.Number,
  usageRecordCount: Schema.Number,
  artifactCount: Schema.Number,
});
export type IngestManifestBoundary = typeof IngestManifestBoundary.Type;

const NonNegativeInteger = Schema.Number.pipe(
  Schema.filter((value) => Number.isInteger(value) && value >= 0, {
    message: () => "Expected a non-negative integer",
  }),
);

const PositiveInteger = Schema.Number.pipe(
  Schema.filter((value) => Number.isInteger(value) && value > 0, {
    message: () => "Expected a positive integer",
  }),
);

export class StartImportJobInput extends Schema.Class<StartImportJobInput>(
  "StartImportJobInput",
)({
  batch: Schema.optional(IngestBatchBoundary),
  manifest: Schema.optional(IngestManifestBoundary),
  sourceIdentityKey: Schema.optional(Schema.String),
  idempotencyKey: Schema.optional(Schema.String),
  expectedChunkCount: Schema.optional(PositiveInteger),
}) {}

export class SubmitImportChunkInput extends Schema.Class<SubmitImportChunkInput>(
  "SubmitImportChunkInput",
)({
  importJobId: Schema.String,
  batch: IngestBatchBoundary,
  chunkId: Schema.optional(Schema.String),
  idempotencyKey: Schema.optional(Schema.String),
  sequence: Schema.optional(NonNegativeInteger),
  expectedChunkCount: Schema.optional(PositiveInteger),
  completeJob: Schema.optional(Schema.Boolean),
}) {}

export const SubmitImportChunkItemInput = Schema.Struct({
  batch: IngestBatchBoundary,
  chunkId: Schema.optional(Schema.String),
  idempotencyKey: Schema.optional(Schema.String),
  sequence: Schema.optional(NonNegativeInteger),
  completeJob: Schema.optional(Schema.Boolean),
});
export type SubmitImportChunkItemInput = typeof SubmitImportChunkItemInput.Type;

export class SubmitImportChunksInput extends Schema.Class<SubmitImportChunksInput>(
  "SubmitImportChunksInput",
)({
  importJobId: Schema.String,
  expectedChunkCount: Schema.optional(PositiveInteger),
  scheduleWorker: Schema.optional(Schema.Boolean),
  chunks: Schema.Array(SubmitImportChunkItemInput),
}) {}

export class ReadImportJobInput extends Schema.Class<ReadImportJobInput>(
  "ReadImportJobInput",
)({
  importJobId: Schema.String,
  chunkCursor: Schema.optional(Schema.Union(Schema.String, Schema.Null)),
  failureCursor: Schema.optional(Schema.Union(Schema.String, Schema.Null)),
  limit: Schema.optional(Schema.Number),
}) {}

export const EmbeddingOutboxStatusSchema = Schema.Literal(
  "pending",
  "syncing",
  "ready",
  "failed",
  "skipped",
  "dead_letter",
);
export type EmbeddingOutboxStatusSchema = typeof EmbeddingOutboxStatusSchema.Type;

export const RagSyncStateSchema = Schema.Literal(
  "pending",
  "syncing",
  "ready",
  "skipped",
  "failed",
  "dead_letter",
);
export type RagSyncStateSchema = typeof RagSyncStateSchema.Type;

export const EmbeddingChunkSchema = Schema.Union(
  Schema.String,
  Schema.Struct({
    text: Schema.optional(Schema.String),
    pageContent: Schema.optional(Schema.String),
    keywords: Schema.optional(Schema.String),
    embedding: Schema.optional(Schema.Array(Schema.Number)),
    metadata: Schema.optional(UnknownRecord),
  }),
);
export type EmbeddingChunkSchema = typeof EmbeddingChunkSchema.Type;

export const EmbeddingCachePutInput = Schema.Struct({
  embeddingCacheKey: Schema.String,
  embeddingScopeId: Schema.String,
  modelId: Schema.String,
  dimensions: Schema.Number,
  policyVersion: Schema.String,
  chunkerVersion: Schema.String,
  normalizedChunkHash: Schema.String,
  chunks: Schema.Array(EmbeddingChunkSchema),
});
export type EmbeddingCachePutInput = typeof EmbeddingCachePutInput.Type;

export const EmbeddingControlInput = Schema.Struct({
  paused: Schema.optional(Schema.Boolean),
  retryFailed: Schema.optional(Schema.Boolean),
  rebuildPending: Schema.optional(Schema.Boolean),
  projectIdentityKey: Schema.optional(Schema.String),
  limit: Schema.optional(Schema.Number),
});
export type EmbeddingControlInput = typeof EmbeddingControlInput.Type;

export const decodeBoundarySync = <A, I>(
  schema: Schema.Schema<A, I, never>,
  value: unknown,
  label: string,
): A => {
  try {
    return Schema.decodeUnknownSync(schema)(value);
  } catch (error) {
    if (ParseResult.isParseError(error)) {
      throw new Error(
        `${label} failed schema validation:\n${ParseResult.TreeFormatter.formatErrorSync(error)}`,
      );
    }
    throw error;
  }
};

export const decodeEmbeddingChunksSync = (
  value: unknown,
  dimensions: number,
): readonly EmbeddingChunkSchema[] => {
  const chunks = decodeBoundarySync(
    Schema.Array(EmbeddingChunkSchema),
    value,
    "embedding chunks",
  );
  for (const chunk of chunks) {
    if (typeof chunk === "string") continue;
    const embedding = chunk.embedding;
    if (embedding !== undefined && embedding.length !== dimensions) {
      throw new Error(
        `embedding chunk has ${embedding.length} dimensions; expected ${dimensions}.`,
      );
    }
  }
  return chunks;
};
