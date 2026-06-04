import { Schema } from "effect";

import { Provider, SearchRequest } from "@quasar/core";

export const IngestOptions = Schema.Struct({
  providers: Schema.optional(Schema.Array(Provider)),
  includeExperimental: Schema.optional(Schema.Boolean),
  limit: Schema.optional(Schema.Number),
  roots: Schema.optional(Schema.Record({ key: Provider, value: Schema.String })),
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
});

export const ToolCallReadInput = Schema.Struct({
  toolCallId: Schema.optional(Schema.String),
  sessionId: Schema.optional(Schema.String),
  limit: Schema.optional(Schema.Number),
});

export const SearchInput = SearchRequest;
