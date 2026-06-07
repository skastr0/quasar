import type {
  AdapterDiagnosticBoundary,
  ArtifactBoundary,
  IngestSessionBoundary,
  MachineIdentityBoundary,
  ProviderSchema,
  SessionEdgeBoundary,
  SessionEventBoundary,
  SessionEventKindSchema,
  SessionRoleSchema,
  SourceRootBoundary,
  ToolCallBoundary,
  UsageRecordBoundary,
} from "./quasarDomainSchemas";

export type ParsedIngestBatch = {
  machine: MachineIdentityBoundary;
  sessions: readonly IngestSessionBoundary[];
  sourceRoots: readonly SourceRootBoundary[];
  diagnostics: readonly AdapterDiagnosticBoundary[];
  sanitizedDiagnostics: unknown[];
  now: number;
  importRunId: string;
  eventCount: number;
  toolCallCount: number;
  contentBlockCount: number;
  sessionEdgeCount: number;
  usageRecordCount: number;
  artifactCount: number;
  importJobId?: string;
  importChunkId?: string;
};

export type SessionPatch = {
  sessionId: string;
  nativeSessionId: string;
  provider: ProviderSchema;
  agentName: string;
  machineId: string;
  projectIdentityKey: string;
  canonicalProjectIdentityKey: string;
  nativeProjectKey?: string;
  title?: string;
  startedAt?: string;
  updatedAtNative?: string;
  sourceRoot: string;
  sourcePath: string;
  rawMetadata: unknown;
  eventCount: number;
  toolCallCount: number;
  importRunId: string;
  importJobId?: string;
  importChunkId?: string;
  ingestState?: "partial" | "complete" | "failed";
  updatedAt: number;
};

export type EventPatch = {
  eventId: string;
  sessionId: string;
  nativeEventId?: string;
  sequence: number;
  timestamp?: string;
  machineId: string;
  provider: ProviderSchema;
  agentName: string;
  projectIdentityKey: string;
  canonicalProjectIdentityKey: string;
  role: SessionRoleSchema;
  kind: SessionEventKindSchema;
  contentText?: string;
  content: unknown;
  contentBlocks?: unknown[];
  toolCallId?: string;
  parentEventId?: string;
  rawReference: unknown;
  raw: undefined;
  importRunId: string;
  importJobId?: string;
  importChunkId?: string;
  updatedAt: number;
};

export type SessionIngestState = {
  batch: ParsedIngestBatch;
  sessionValue: IngestSessionBoundary;
  project: IngestSessionBoundary["projectIdentity"];
  canonicalProjectIdentityKey: string;
  sessionId: string;
  providerValue: ProviderSchema;
  agentName: string;
  events: SessionEventBoundary[];
  declaredToolCalls: ToolCallBoundary[];
  contentBlocksByEvent: Map<string, SessionEventBoundary["contentBlocks"]>;
  sessionEdges: SessionEdgeBoundary[];
  usageRecords: UsageRecordBoundary[];
  artifacts: ArtifactBoundary[];
  sessionPatch: SessionPatch;
  keepEventIds: Set<string>;
  keepToolCallIds: Set<string>;
  keepContentBlockIds: Set<string>;
  keepSessionEdgeIds: Set<string>;
  keepUsageRecordIds: Set<string>;
  keepArtifactIds: Set<string>;
  lastToolCallByName: Map<string, string>;
};
