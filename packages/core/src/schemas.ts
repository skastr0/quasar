import { Schema } from "effect";

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
  sequence: Schema.Number,
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
  inputTokens: Schema.optional(Schema.Number),
  outputTokens: Schema.optional(Schema.Number),
  reasoningTokens: Schema.optional(Schema.Number),
  cacheCreationInputTokens: Schema.optional(Schema.Number),
  cacheReadInputTokens: Schema.optional(Schema.Number),
  totalTokens: Schema.optional(Schema.Number),
  cost: Schema.optional(Schema.Number),
  currency: Schema.optional(Schema.String),
  raw: Schema.optional(Schema.Unknown),
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
  raw: Schema.optional(Schema.Unknown),
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
  line: Schema.optional(Schema.Number),
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
  raw: Schema.optional(Schema.Unknown),
});
export type ToolCall = typeof ToolCall.Type;

export const SessionEvent = Schema.Struct({
  id: Schema.String,
  sessionId: Schema.String,
  nativeEventId: Schema.optional(Schema.String),
  sequence: Schema.Number,
  timestamp: Schema.optional(Schema.String),
  machineId: Schema.String,
  provider: Provider,
  agentName: Schema.String,
  projectIdentityKey: Schema.String,
  role: SessionRole,
  kind: SessionEventKind,
  contentText: Schema.optional(Schema.String),
  content: Schema.optional(Schema.Unknown),
  contentBlocks: Schema.Array(ContentBlock),
  toolCallId: Schema.optional(Schema.String),
  parentEventId: Schema.optional(Schema.String),
  rawReference: RawReference,
  raw: Schema.optional(Schema.Unknown),
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
  rawMetadata: Schema.optional(Schema.Unknown),
  events: Schema.Array(SessionEvent),
  toolCalls: Schema.Array(ToolCall),
  sessionEdges: Schema.Array(SessionEdge),
  usageRecords: Schema.Array(UsageRecord),
  artifacts: Schema.Array(Artifact),
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
  limit: Schema.optional(Schema.Number),
});
export type SearchRequest = typeof SearchRequest.Type;
