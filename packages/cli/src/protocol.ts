import { Schema } from "effect";

import { Provider, SearchRequest } from "@skastr0/quasar-core";

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

export const IngestOptions = Schema.Struct({
  providers: Schema.optional(Schema.Array(Provider)),
  includeExperimental: Schema.optional(Schema.Boolean),
  limit: Schema.optional(PositiveInteger),
  roots: Schema.optional(Schema.partial(Schema.Record({ key: Provider, value: Schema.String }))),
  logicalRoots: Schema.optional(Schema.partial(Schema.Record({ key: Provider, value: Schema.String }))),
  snapshotSources: Schema.optional(Schema.Boolean),
  maxUploadChunks: Schema.optional(PositiveInteger),
  drainPollIntervalMs: Schema.optional(PositiveInteger),
  drainTimeoutMs: Schema.optional(NonNegativeInteger),
  drainRescheduleIntervalMs: Schema.optional(PositiveInteger),
  inFlightHighWatermark: Schema.optional(NonNegativeInteger),
  dryRun: Schema.optional(Schema.Boolean),
});
export type IngestOptions = typeof IngestOptions.Type;

export const ProjectAliasInput = Schema.Struct({
  sourceProjectIdentityKey: Schema.String,
  targetProjectIdentityKey: Schema.String,
  reason: Schema.optional(Schema.String),
});

export const SessionReadInput = Schema.Struct({
  sessionId: Schema.String,
  view: Schema.optional(Schema.Literal("chronological", "branch", "tool-expanded")),
  leafEventId: Schema.optional(Schema.String),
});

export const ToolCallReadInput = Schema.Struct({
  toolCallId: Schema.optional(Schema.String),
  sessionId: Schema.optional(Schema.String),
  projectIdentityKey: Schema.optional(Schema.String),
  machineId: Schema.optional(Schema.String),
  provider: Schema.optional(Provider),
  agentName: Schema.optional(Schema.String),
  toolName: Schema.optional(Schema.String),
  limit: Schema.optional(PositiveInteger),
});

export const SearchInput = SearchRequest;
