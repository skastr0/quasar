export type ParsedIngestBatch = {
  machine: Record<string, unknown>;
  sessions: Record<string, unknown>[];
  sourceRoots: Record<string, unknown>[];
  diagnostics: Record<string, unknown>[];
  sanitizedDiagnostics: unknown[];
  now: number;
  importRunId: string;
  eventCount: number;
  toolCallCount: number;
};

export type SessionPatch = {
  sessionId: string;
  nativeSessionId: string;
  provider: never;
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
  updatedAt: number;
};

export type EventPatch = {
  eventId: string;
  sessionId: string;
  nativeEventId?: string;
  sequence: number;
  timestamp?: string;
  machineId: string;
  provider: never;
  agentName: string;
  projectIdentityKey: string;
  canonicalProjectIdentityKey: string;
  role: never;
  kind: never;
  contentText?: string;
  content: unknown;
  toolCallId?: string;
  parentEventId?: string;
  rawReference: unknown;
  raw: undefined;
  importRunId: string;
  updatedAt: number;
};

export type SessionIngestState = {
  batch: ParsedIngestBatch;
  sessionValue: Record<string, unknown>;
  project: Record<string, unknown>;
  canonicalProjectIdentityKey: string;
  sessionId: string;
  providerValue: string;
  agentName: string;
  events: Record<string, unknown>[];
  declaredToolCalls: Record<string, unknown>[];
  sessionPatch: SessionPatch;
  keepEventIds: Set<string>;
  keepToolCallIds: Set<string>;
  lastToolCallByName: Map<string, string>;
};
