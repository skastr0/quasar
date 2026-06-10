import { ParseResult, Schema } from "effect";

export const UnknownRecord = Schema.Record({
  key: Schema.String,
  value: Schema.Unknown,
});
export type UnknownRecord = typeof UnknownRecord.Type;

const PositiveInteger = Schema.Number.pipe(
  Schema.filter((value) => Number.isInteger(value) && value > 0, {
    message: () => "Expected a positive integer",
  }),
);

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

export const MachineIdentityBoundary = Schema.Struct({
  machineId: Schema.String,
  hostname: Schema.optional(Schema.String),
  tailscaleName: Schema.optional(Schema.String),
  platform: Schema.optional(Schema.String),
});
export type MachineIdentityBoundary = typeof MachineIdentityBoundary.Type;

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
  limit: Schema.optional(PositiveInteger),
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
