import { Schema } from "effect";

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

const NonNegativeNumber = Schema.Number.pipe(
  Schema.filter((value) => Number.isFinite(value) && value >= 0, {
    message: () => "Expected a non-negative finite number",
  }),
);

export const Provider = Schema.Literal(
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
export type Provider = typeof Provider.Type;

export const AdapterStatus = Schema.Literal(
  "available",
  "no_data_found",
  "unsupported",
  "error",
);
export type AdapterStatus = typeof AdapterStatus.Type;

export const ParserConfidence = Schema.Literal(
  "documented",
  "observed",
  "brittle",
  "capture-file",
);
export type ParserConfidence = typeof ParserConfidence.Type;

export const ProjectIdentityConfidence = Schema.Literal(
  "explicit",
  "high",
  "medium",
  "low",
);
export type ProjectIdentityConfidence =
  typeof ProjectIdentityConfidence.Type;

export const SessionEventKind = Schema.Literal(
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
export type SessionEventKind = typeof SessionEventKind.Type;

export const SessionRole = Schema.Literal(
  "user",
  "assistant",
  "developer",
  "system",
  "tool",
  "thinking",
  "unknown",
);
export type SessionRole = typeof SessionRole.Type;

export const ContentBlockKind = Schema.Literal(
  "text",
  "markdown",
  "thinking",
  "image",
  "file",
  "json",
);
export type ContentBlockKind = typeof ContentBlockKind.Type;

export const ContentBlock = Schema.Struct({
  id: Schema.String,
  sequence: NonNegativeInteger,
  kind: ContentBlockKind,
  text: Schema.optional(Schema.String),
  markdown: Schema.optional(Schema.String),
  thinking: Schema.optional(Schema.String),
  path: Schema.optional(Schema.String),
  uri: Schema.optional(Schema.String),
  mediaType: Schema.optional(Schema.String),
  value: Schema.optional(Schema.Unknown),
  metadata: Schema.optional(Schema.Unknown),
});
export type ContentBlock = typeof ContentBlock.Type;

export const SessionEdgeKind = Schema.Literal(
  "next",
  "parent",
  "tool_result_for",
  "forked_from",
  "subagent_of",
  "compacted_into",
  "artifact_of",
);
export type SessionEdgeKind = typeof SessionEdgeKind.Type;

export const SessionEdge = Schema.Struct({
  id: Schema.String,
  sessionId: Schema.String,
  machineId: Schema.String,
  provider: Provider,
  agentName: Schema.String,
  projectIdentityKey: Schema.String,
  kind: SessionEdgeKind,
  fromEventId: Schema.optional(Schema.String),
  toEventId: Schema.optional(Schema.String),
  fromId: Schema.optional(Schema.String),
  toId: Schema.optional(Schema.String),
  rawReference: Schema.optional(Schema.Unknown),
  metadata: Schema.optional(Schema.Unknown),
});
export type SessionEdge = typeof SessionEdge.Type;

export const UsageRecord = Schema.Struct({
  id: Schema.String,
  sessionId: Schema.String,
  eventId: Schema.optional(Schema.String),
  machineId: Schema.String,
  provider: Provider,
  agentName: Schema.String,
  projectIdentityKey: Schema.String,
  timestamp: Schema.optional(Schema.String),
  model: Schema.optional(Schema.String),
  modelProvider: Schema.optional(Schema.String),
  inputTokens: Schema.optional(NonNegativeInteger),
  outputTokens: Schema.optional(NonNegativeInteger),
  reasoningTokens: Schema.optional(NonNegativeInteger),
  cacheCreationInputTokens: Schema.optional(NonNegativeInteger),
  cacheReadInputTokens: Schema.optional(NonNegativeInteger),
  totalTokens: Schema.optional(NonNegativeInteger),
  cost: Schema.optional(NonNegativeNumber),
  currency: Schema.optional(Schema.String),
});
export type UsageRecord = typeof UsageRecord.Type;

export const Artifact = Schema.Struct({
  id: Schema.String,
  sessionId: Schema.String,
  eventId: Schema.optional(Schema.String),
  machineId: Schema.String,
  provider: Provider,
  agentName: Schema.String,
  projectIdentityKey: Schema.String,
  kind: Schema.String,
  path: Schema.optional(Schema.String),
  uri: Schema.optional(Schema.String),
  contentHash: Schema.optional(Schema.String),
  sourcePath: Schema.optional(Schema.String),
  sourceRef: Schema.optional(Schema.Unknown),
  metadata: Schema.optional(Schema.Unknown),
});
export type Artifact = typeof Artifact.Type;

export const ProjectSignal = Schema.Struct({
  kind: Schema.Literal(
    "explicit",
    "git_remote",
    "package",
    "workspace",
    "path",
  ),
  value: Schema.String,
  confidence: ProjectIdentityConfidence,
});
export type ProjectSignal = typeof ProjectSignal.Type;

export const ProjectResolution = Schema.Struct({
  projectIdentityKey: Schema.String,
  displayName: Schema.String,
  confidence: ProjectIdentityConfidence,
  rawPath: Schema.optional(Schema.String),
  normalizedPath: Schema.optional(Schema.String),
  gitRemote: Schema.optional(Schema.String),
  gitRemoteNormalized: Schema.optional(Schema.String),
  packageName: Schema.optional(Schema.String),
  signals: Schema.Array(ProjectSignal),
});
export type ProjectResolution = typeof ProjectResolution.Type;

export const MachineIdentity = Schema.Struct({
  machineId: Schema.String,
  hostname: Schema.optional(Schema.String),
  tailscaleName: Schema.optional(Schema.String),
  platform: Schema.optional(Schema.String),
});
export type MachineIdentity = typeof MachineIdentity.Type;

export const SourceRoot = Schema.Struct({
  provider: Provider,
  adapterId: Schema.String,
  rootPath: Schema.String,
  machineId: Schema.String,
  discoveredAt: Schema.String,
});
export type SourceRoot = typeof SourceRoot.Type;

export const RawReference = Schema.Struct({
  sourcePath: Schema.String,
  line: Schema.optional(PositiveInteger),
  table: Schema.optional(Schema.String),
  rowId: Schema.optional(Schema.String),
  nativeType: Schema.optional(Schema.String),
});
export type RawReference = typeof RawReference.Type;

export const ToolCall = Schema.Struct({
  id: Schema.String,
  sessionId: Schema.String,
  eventId: Schema.String,
  machineId: Schema.String,
  provider: Provider,
  agentName: Schema.String,
  projectIdentityKey: Schema.String,
  toolName: Schema.String,
  status: Schema.optional(Schema.String),
  input: Schema.optional(Schema.Unknown),
  output: Schema.optional(Schema.Unknown),
  startedAt: Schema.optional(Schema.String),
  completedAt: Schema.optional(Schema.String),
});
export type ToolCall = typeof ToolCall.Type;

export const SessionEvent = Schema.Struct({
  id: Schema.String,
  sessionId: Schema.String,
  nativeEventId: Schema.optional(Schema.String),
  sequence: NonNegativeInteger,
  timestamp: Schema.optional(Schema.String),
  machineId: Schema.String,
  provider: Provider,
  agentName: Schema.String,
  projectIdentityKey: Schema.String,
  role: SessionRole,
  kind: SessionEventKind,
  contentText: Schema.optional(Schema.String),
  contentBlocks: Schema.Array(ContentBlock),
  toolCallId: Schema.optional(Schema.String),
  parentEventId: Schema.optional(Schema.String),
  rawReference: RawReference,
});
export type SessionEvent = typeof SessionEvent.Type;

export const NormalizedSession = Schema.Struct({
  id: Schema.String,
  nativeSessionId: Schema.String,
  provider: Provider,
  agentName: Schema.String,
  machineId: Schema.String,
  projectIdentity: ProjectResolution,
  nativeProjectKey: Schema.optional(Schema.String),
  title: Schema.optional(Schema.String),
  startedAt: Schema.optional(Schema.String),
  updatedAt: Schema.optional(Schema.String),
  sourceRoot: Schema.String,
  sourcePath: Schema.String,
  events: Schema.Array(SessionEvent),
  toolCalls: Schema.Array(ToolCall),
  sessionEdges: Schema.Array(SessionEdge),
  usageRecords: Schema.Array(UsageRecord),
  artifacts: Schema.Array(Artifact),
  eventCount: Schema.optional(NonNegativeInteger),
  toolCallCount: Schema.optional(NonNegativeInteger),
  contentBlockCount: Schema.optional(NonNegativeInteger),
  sessionEdgeCount: Schema.optional(NonNegativeInteger),
  usageRecordCount: Schema.optional(NonNegativeInteger),
  artifactCount: Schema.optional(NonNegativeInteger),
});
export type NormalizedSession = typeof NormalizedSession.Type;

export const AdapterDiagnostic = Schema.Struct({
  adapterId: Schema.String,
  provider: Provider,
  status: AdapterStatus,
  parserConfidence: Schema.optional(ParserConfidence),
  rootPath: Schema.optional(Schema.String),
  message: Schema.String,
  details: Schema.optional(Schema.Unknown),
});
export type AdapterDiagnostic = typeof AdapterDiagnostic.Type;

export const IngestBatch = Schema.Struct({
  protocolVersion: Schema.Literal("quasar.ingest/v1"),
  machine: MachineIdentity,
  sourceRoots: Schema.Array(SourceRoot),
  sessions: Schema.Array(NormalizedSession),
  diagnostics: Schema.Array(AdapterDiagnostic),
  generatedAt: Schema.String,
});
export type IngestBatch = typeof IngestBatch.Type;

export const ImportJobStatus = Schema.Literal(
  "queued",
  "running",
  "succeeded",
  "partial_failure",
  "failed",
);
export type ImportJobStatus = typeof ImportJobStatus.Type;

export const ImportChunkStatus = Schema.Literal(
  "pending",
  "running",
  "succeeded",
  "failed",
  "dead_letter",
);
export type ImportChunkStatus = typeof ImportChunkStatus.Type;

export const IngestSessionManifest = Schema.Struct({
  id: Schema.String,
  nativeSessionId: Schema.String,
  provider: Provider,
  machineId: Schema.String,
  projectIdentityKey: Schema.String,
  sourceRoot: Schema.String,
  sourcePath: Schema.String,
  eventCount: NonNegativeInteger,
  toolCallCount: NonNegativeInteger,
  contentBlockCount: NonNegativeInteger,
  sessionEdgeCount: NonNegativeInteger,
  usageRecordCount: NonNegativeInteger,
  artifactCount: NonNegativeInteger,
});
export type IngestSessionManifest = typeof IngestSessionManifest.Type;

export const IngestProviderSummary = Schema.Struct({
  provider: Provider,
  sessionCount: NonNegativeInteger,
  eventCount: NonNegativeInteger,
  toolCallCount: NonNegativeInteger,
  contentBlockCount: NonNegativeInteger,
  sessionEdgeCount: NonNegativeInteger,
  usageRecordCount: NonNegativeInteger,
  artifactCount: NonNegativeInteger,
});
export type IngestProviderSummary = typeof IngestProviderSummary.Type;

export const IngestManifest = Schema.Struct({
  protocolVersion: Schema.Literal("quasar.ingest-manifest/v1"),
  machine: MachineIdentity,
  sourceRoots: Schema.Array(SourceRoot),
  sessions: Schema.Array(IngestSessionManifest),
  providerSummaries: Schema.optional(Schema.Array(IngestProviderSummary)),
  diagnostics: Schema.Array(AdapterDiagnostic),
  generatedAt: Schema.String,
  sessionCount: NonNegativeInteger,
  eventCount: NonNegativeInteger,
  toolCallCount: NonNegativeInteger,
  contentBlockCount: NonNegativeInteger,
  sessionEdgeCount: NonNegativeInteger,
  usageRecordCount: NonNegativeInteger,
  artifactCount: NonNegativeInteger,
});
export type IngestManifest = typeof IngestManifest.Type;

export class ImportJobStartRequest extends Schema.Class<ImportJobStartRequest>(
  "ImportJobStartRequest",
)({
  batch: Schema.optional(IngestBatch),
  manifest: Schema.optional(IngestManifest),
  sourceIdentityKey: Schema.optional(Schema.String),
  idempotencyKey: Schema.optional(Schema.String),
  expectedChunkCount: Schema.optional(PositiveInteger),
}) {}

export class ImportJobStartResponse extends Schema.Class<ImportJobStartResponse>(
  "ImportJobStartResponse",
)({
  importJobId: Schema.String,
  status: ImportJobStatus,
  chunkCount: NonNegativeInteger,
  expectedChunkCount: Schema.optional(PositiveInteger),
  sourceIdentityKey: Schema.optional(Schema.String),
  attemptNumber: Schema.optional(Schema.Number),
}) {}

export class ImportJobChunkRequest extends Schema.Class<ImportJobChunkRequest>(
  "ImportJobChunkRequest",
)({
  importJobId: Schema.String,
  batch: IngestBatch,
  chunkId: Schema.optional(Schema.String),
  idempotencyKey: Schema.optional(Schema.String),
  sequence: Schema.optional(NonNegativeInteger),
  expectedChunkCount: Schema.optional(PositiveInteger),
  completeJob: Schema.optional(Schema.Boolean),
}) {}

export class ImportJobChunkResponse extends Schema.Class<ImportJobChunkResponse>(
  "ImportJobChunkResponse",
)({
  importJobId: Schema.String,
  chunkId: Schema.String,
  status: ImportChunkStatus,
  jobStatus: ImportJobStatus,
  enqueued: Schema.optional(Schema.Boolean),
}) {}

export const EmbeddingReadinessCounts = Schema.Struct({
  total: NonNegativeInteger,
  pending: NonNegativeInteger,
  syncing: NonNegativeInteger,
  ready: NonNegativeInteger,
  skipped: NonNegativeInteger,
  failed: NonNegativeInteger,
  deadLetter: Schema.optional(NonNegativeInteger),
});
export type EmbeddingReadinessCounts = typeof EmbeddingReadinessCounts.Type;

export const ImportJobStatusPayload = Schema.Struct({
  job: Schema.Unknown,
  chunks: Schema.optional(Schema.Array(Schema.Unknown)),
  failures: Schema.optional(Schema.Array(Schema.Unknown)),
  readiness: EmbeddingReadinessCounts,
  pagination: Schema.optional(Schema.Unknown),
});
export type ImportJobStatusPayload = typeof ImportJobStatusPayload.Type;

export class ImportJobStatusResponse extends Schema.Class<ImportJobStatusResponse>(
  "ImportJobStatusResponse",
)({
  job: Schema.Unknown,
  chunks: Schema.optional(Schema.Array(Schema.Unknown)),
  failures: Schema.optional(Schema.Array(Schema.Unknown)),
  readiness: EmbeddingReadinessCounts,
  pagination: Schema.optional(Schema.Unknown),
}) {}

export const SourceManifestEntry = Schema.Struct({
  path: Schema.String,
  role: Schema.Literal("source_root", "session_source"),
  exists: Schema.Boolean,
  kind: Schema.Literal("file", "directory", "missing", "other"),
  size: Schema.optional(NonNegativeInteger),
  mtimeMs: Schema.optional(NonNegativeNumber),
  contentHash: Schema.optional(Schema.String),
});
export type SourceManifestEntry = typeof SourceManifestEntry.Type;

export const SourceManifestChange = Schema.Struct({
  path: Schema.String,
  role: Schema.Literal("source_root", "session_source"),
  before: Schema.optional(SourceManifestEntry),
  after: Schema.optional(SourceManifestEntry),
  changed: Schema.Boolean,
});
export type SourceManifestChange = typeof SourceManifestChange.Type;

export const SourceSafetyReport = Schema.Struct({
  sourceReadMode: Schema.Literal("read_only"),
  quasarStateWrites: Schema.Boolean,
  before: Schema.Array(SourceManifestEntry),
  after: Schema.Array(SourceManifestEntry),
  sourceMutations: Schema.Array(SourceManifestChange),
  checkedAt: Schema.String,
});
export type SourceSafetyReport = typeof SourceSafetyReport.Type;

export const SearchMode = Schema.Literal("text", "semantic", "fusion");
export type SearchMode = typeof SearchMode.Type;

export const SearchRequest = Schema.Struct({
  query: Schema.String,
  projectIdentityKey: Schema.optional(Schema.String),
  machineId: Schema.optional(Schema.String),
  provider: Schema.optional(Provider),
  agentName: Schema.optional(Schema.String),
  role: Schema.optional(SessionRole),
  kind: Schema.optional(SessionEventKind),
  toolName: Schema.optional(Schema.String),
  from: Schema.optional(Schema.String),
  to: Schema.optional(Schema.String),
  limit: Schema.optional(PositiveInteger),
});
export type SearchRequest = typeof SearchRequest.Type;
