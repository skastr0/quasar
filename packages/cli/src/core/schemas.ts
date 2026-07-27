import {
  Provider,
} from "@skastr0/quasar-protocol";
import { Schema } from "effect";

export {
  AgentAssignment,
  Artifact,
  ContentBlock,
  ContentBlockKind,
  ExecutionContextRecord,
  ExecutionContextScope,
  MachineIdentity,
  NormalizedSession,
  ProjectIdentityConfidence,
  ProjectResolution,
  ProjectSignal,
  Provider,
  RawReference,
  SessionEdge,
  SessionEdgeKind,
  SessionEvent,
  SessionEventKind,
  SessionRole,
  SourceRoot,
  ToolCall,
  UsageRecord,
  decodeNormalizedSession,
  decodeNormalizedSessionSync,
} from "@skastr0/quasar-protocol";

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
