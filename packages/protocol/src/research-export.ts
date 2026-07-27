import { Schema } from "effect";

import {
  MessageRole,
  Provider,
} from "./normalized-session";
import {
  QuasarTrajectory,
  TrajectoryProjectionOptions,
} from "./trajectory";

export const RESEARCH_EXPORT_PROTOCOL_VERSION =
  "quasar.research-export/v1" as const;

const strictParseOptions = {
  errors: "all",
  onExcessProperty: "error",
} as const;

const NonNegativeInteger = Schema.Number.pipe(
  Schema.int(),
  Schema.nonNegative(),
);

const PositiveInteger = Schema.Number.pipe(
  Schema.int(),
  Schema.positive(),
);

const NullableString = Schema.NullOr(Schema.String);

export const ResearchExportScanKey = Schema.Struct({
  sessionId: Schema.String.pipe(Schema.minLength(1)),
  sequence: NonNegativeInteger,
});
export type ResearchExportScanKey = typeof ResearchExportScanKey.Type;

export const ResearchExportFilters = Schema.Struct({
  projectKey: Schema.optional(Schema.String),
  providers: Schema.optional(Schema.Array(Provider)),
  sessionId: Schema.optional(Schema.String),
  role: Schema.optional(MessageRole),
  agentName: Schema.optional(Schema.String),
  agentRole: Schema.optional(Schema.String),
  model: Schema.optional(Schema.String),
  modelProvider: Schema.optional(Schema.String),
  messageAfter: Schema.optional(Schema.String),
  messageBefore: Schema.optional(Schema.String),
  sessionStartedAfter: Schema.optional(Schema.String),
  sessionStartedBefore: Schema.optional(Schema.String),
  rootsOnly: Schema.optional(Schema.Boolean),
  lineageRootSessionId: Schema.optional(Schema.String),
});
export type ResearchExportFilters = typeof ResearchExportFilters.Type;
export const decodeResearchExportFiltersSync = Schema.decodeUnknownSync(
  ResearchExportFilters,
  strictParseOptions,
);

export const ResearchExportMessage = Schema.Struct({
  messageId: Schema.String,
  sessionId: Schema.String,
  sequence: NonNegativeInteger,
  role: MessageRole,
  text: Schema.String,
  timestamp: NullableString,
  projectKey: Schema.String,
  provider: Provider,
  title: NullableString,
  agentName: NullableString,
  agentRole: NullableString,
  model: NullableString,
  modelProvider: NullableString,
  executionContextId: NullableString,
  reasoningEffort: NullableString,
});
export type ResearchExportMessage = typeof ResearchExportMessage.Type;

export const ResearchExportManifestFrame = Schema.Struct({
  protocolVersion: Schema.Literal(RESEARCH_EXPORT_PROTOCOL_VERSION),
  kind: Schema.Literal("manifest"),
  snapshot: Schema.String.pipe(Schema.minLength(1)),
  filters: ResearchExportFilters,
  page: Schema.Struct({
    limit: PositiveInteger,
    after: Schema.NullOr(ResearchExportScanKey),
  }),
  trajectoryScope: Schema.Literal("first-matching-message-in-scan"),
  trajectoryProjection: TrajectoryProjectionOptions,
});
export type ResearchExportManifestFrame =
  typeof ResearchExportManifestFrame.Type;

export const ResearchExportMessageFrame = Schema.Struct({
  protocolVersion: Schema.Literal(RESEARCH_EXPORT_PROTOCOL_VERSION),
  kind: Schema.Literal("message"),
  message: ResearchExportMessage,
});
export type ResearchExportMessageFrame = typeof ResearchExportMessageFrame.Type;

export const ResearchExportTrajectoryFrame = Schema.Struct({
  protocolVersion: Schema.Literal(RESEARCH_EXPORT_PROTOCOL_VERSION),
  kind: Schema.Literal("trajectory"),
  sessionId: Schema.String.pipe(Schema.minLength(1)),
  trajectory: QuasarTrajectory,
});
export type ResearchExportTrajectoryFrame =
  typeof ResearchExportTrajectoryFrame.Type;

const Sha256 = Schema.String.pipe(
  Schema.pattern(/^sha256:[a-f0-9]{64}$/),
);

export const ResearchExportReceiptFrame = Schema.Struct({
  protocolVersion: Schema.Literal(RESEARCH_EXPORT_PROTOCOL_VERSION),
  kind: Schema.Literal("receipt"),
  snapshot: Schema.String.pipe(Schema.minLength(1)),
  counts: Schema.Struct({
    messages: NonNegativeInteger,
    trajectories: NonNegativeInteger,
  }),
  content: Schema.Struct({
    bytes: NonNegativeInteger,
    sha256: Sha256,
  }),
  next: Schema.NullOr(ResearchExportScanKey),
});
export type ResearchExportReceiptFrame =
  typeof ResearchExportReceiptFrame.Type;

export const ResearchExportErrorFrame = Schema.Struct({
  protocolVersion: Schema.Literal(RESEARCH_EXPORT_PROTOCOL_VERSION),
  kind: Schema.Literal("error"),
  error: Schema.Struct({
    type: Schema.String.pipe(Schema.minLength(1)),
    message: Schema.String.pipe(Schema.minLength(1)),
    sessionId: Schema.optional(Schema.String),
  }),
});
export type ResearchExportErrorFrame = typeof ResearchExportErrorFrame.Type;

export const ResearchExportFrame = Schema.Union(
  ResearchExportManifestFrame,
  ResearchExportMessageFrame,
  ResearchExportTrajectoryFrame,
  ResearchExportReceiptFrame,
  ResearchExportErrorFrame,
).annotations({
  identifier: "QuasarResearchExportFrameV1",
  title: "Quasar reproducible research export frame v1",
  description:
    "One strict NDJSON frame from a bounded, snapshot-bound corpus research export shard.",
  parseOptions: strictParseOptions,
});
export type ResearchExportFrame = typeof ResearchExportFrame.Type;

export const decodeResearchExportFrameSync = Schema.decodeUnknownSync(
  ResearchExportFrame,
  strictParseOptions,
);
