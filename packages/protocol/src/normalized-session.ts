import { Schema } from "effect";

export const NORMALIZED_SESSION_PROTOCOL_VERSION =
  "quasar.normalized-session/v1" as const;

/**
 * Increment whenever unchanged provider source must be re-normalized because
 * the canonical projection changed.
 */
export const NORMALIZATION_VERSION = 12;

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

const NonNegativeNumber = Schema.Number.pipe(
  Schema.finite(),
  Schema.nonNegative(),
);

export const Provider = Schema.Literal(
  "codex",
  "claude",
  "opencode",
  "grok",
  "kimi",
  "hermes",
  "antigravity",
  "omp",
  "pi",
  "cursor",
  "devin",
  "amp",
).annotations({
  identifier: "QuasarProvider",
  description: "A provider with a stable Quasar session adapter.",
});
export type Provider = typeof Provider.Type;

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

export const MessageRole = Schema.Literal(
  "user",
  "assistant",
  "reasoning",
);
export type MessageRole = typeof MessageRole.Type;

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

export const AgentAssignment = Schema.Struct({
  nickname: Schema.optional(Schema.String),
  role: Schema.optional(Schema.String),
  path: Schema.optional(Schema.String),
  depth: Schema.optional(NonNegativeInteger),
});
export type AgentAssignment = typeof AgentAssignment.Type;

export const ExecutionContextScope = Schema.Literal("session", "turn");
export type ExecutionContextScope = typeof ExecutionContextScope.Type;

export const ExecutionContextRecord = Schema.Struct({
  id: Schema.String,
  sessionId: Schema.String,
  machineId: Schema.String,
  provider: Provider,
  agentName: Schema.String,
  projectIdentityKey: Schema.String,
  sequence: NonNegativeInteger,
  scope: ExecutionContextScope,
  timestamp: Schema.optional(Schema.String),
  /**
   * Opaque provider-native turn correlation. Providers such as Codex emit a
   * turn_context record whose turn_id names a logical turn without emitting a
   * separate event carrying that id, so this is not an event foreign key.
   */
  turnId: Schema.optional(Schema.String),
  model: Schema.optional(Schema.String),
  modelProvider: Schema.optional(Schema.String),
  reasoningEffort: Schema.optional(Schema.String),
  serviceTier: Schema.optional(Schema.String),
  approvalPolicy: Schema.optional(Schema.String),
  collaborationMode: Schema.optional(Schema.String),
  multiAgentMode: Schema.optional(Schema.String),
  personality: Schema.optional(Schema.String),
  permissionProfileType: Schema.optional(Schema.String),
});
export type ExecutionContextRecord = typeof ExecutionContextRecord.Type;

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
  rawBytes: Schema.optional(NonNegativeInteger),
  metadata: Schema.optional(Schema.Unknown),
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

const duplicateValue = (
  values: ReadonlyArray<string>,
): string | undefined => {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) return value;
    seen.add(value);
  }
  return undefined;
};

const countContentBlocks = (
  events: ReadonlyArray<{ readonly contentBlocks: ReadonlyArray<unknown> }>,
) => events.reduce((count, event) => count + event.contentBlocks.length, 0);

const normalizedSessionInvariant = (session: {
  readonly id: string;
  readonly provider: Provider;
  readonly agentName: string;
  readonly machineId: string;
  readonly projectIdentity: ProjectResolution;
  readonly events: ReadonlyArray<SessionEvent>;
  readonly toolCalls: ReadonlyArray<ToolCall>;
  readonly sessionEdges: ReadonlyArray<SessionEdge>;
  readonly executionContexts: ReadonlyArray<ExecutionContextRecord>;
  readonly usageRecords: ReadonlyArray<UsageRecord>;
  readonly artifacts: ReadonlyArray<Artifact>;
  readonly eventCount: number;
  readonly toolCallCount: number;
  readonly contentBlockCount: number;
  readonly sessionEdgeCount: number;
  readonly usageRecordCount: number;
  readonly artifactCount: number;
}): true | string => {
  const projectKey = session.projectIdentity.projectIdentityKey;
  const factOwnership = (fact: {
    readonly sessionId: string;
    readonly machineId: string;
    readonly provider: Provider;
    readonly agentName: string;
    readonly projectIdentityKey: string;
  }) =>
    fact.sessionId === session.id
    && fact.machineId === session.machineId
    && fact.provider === session.provider
    && fact.agentName === session.agentName
    && fact.projectIdentityKey === projectKey;

  const idCollections = [
    ["event", session.events.map((event) => event.id)],
    ["tool call", session.toolCalls.map((toolCall) => toolCall.id)],
    ["session edge", session.sessionEdges.map((edge) => edge.id)],
    ["execution context", session.executionContexts.map((context) => context.id)],
    ["usage record", session.usageRecords.map((usage) => usage.id)],
    ["artifact", session.artifacts.map((artifact) => artifact.id)],
    [
      "content block",
      session.events.flatMap((event) =>
        event.contentBlocks.map((block) => block.id),
      ),
    ],
  ] as const;
  for (const [kind, ids] of idCollections) {
    const duplicate = duplicateValue(ids);
    if (duplicate !== undefined) return `duplicate ${kind} id: ${duplicate}`;
  }

  const eventIds = new Set(session.events.map((event) => event.id));
  const toolCallIds = new Set(session.toolCalls.map((toolCall) => toolCall.id));
  for (const [index, event] of session.events.entries()) {
    if (event.sequence !== index) {
      return `event sequence must be dense at index ${index}`;
    }
    if (!factOwnership(event)) return `event ${event.id} has cross-session ownership`;
    for (const [blockIndex, block] of event.contentBlocks.entries()) {
      if (block.sequence !== blockIndex) {
        return `content block sequence must be dense for event ${event.id}`;
      }
    }
    if (event.toolCallId !== undefined && !toolCallIds.has(event.toolCallId)) {
      return `event ${event.id} references missing tool call ${event.toolCallId}`;
    }
    if (
      event.parentEventId !== undefined
      && !eventIds.has(event.parentEventId)
    ) {
      return `event ${event.id} references missing parent event ${event.parentEventId}`;
    }
  }

  for (const toolCall of session.toolCalls) {
    if (!factOwnership(toolCall)) {
      return `tool call ${toolCall.id} has cross-session ownership`;
    }
    if (!eventIds.has(toolCall.eventId)) {
      return `tool call ${toolCall.id} references missing event ${toolCall.eventId}`;
    }
  }
  for (const edge of session.sessionEdges) {
    if (!factOwnership(edge)) return `session edge ${edge.id} has cross-session ownership`;
    if (edge.fromEventId !== undefined && !eventIds.has(edge.fromEventId)) {
      return `session edge ${edge.id} references missing fromEventId ${edge.fromEventId}`;
    }
    if (edge.toEventId !== undefined && !eventIds.has(edge.toEventId)) {
      return `session edge ${edge.id} references missing toEventId ${edge.toEventId}`;
    }
  }
  for (const context of session.executionContexts) {
    if (!factOwnership(context)) {
      return `execution context ${context.id} has cross-session ownership`;
    }
  }
  for (const usage of session.usageRecords) {
    if (!factOwnership(usage)) return `usage record ${usage.id} has cross-session ownership`;
    if (usage.eventId !== undefined && !eventIds.has(usage.eventId)) {
      return `usage record ${usage.id} references missing event ${usage.eventId}`;
    }
  }
  for (const artifact of session.artifacts) {
    if (!factOwnership(artifact)) return `artifact ${artifact.id} has cross-session ownership`;
    if (artifact.eventId !== undefined && !eventIds.has(artifact.eventId)) {
      return `artifact ${artifact.id} references missing event ${artifact.eventId}`;
    }
  }

  const expectedCounts = [
    ["eventCount", session.eventCount, session.events.length],
    ["toolCallCount", session.toolCallCount, session.toolCalls.length],
    ["contentBlockCount", session.contentBlockCount, countContentBlocks(session.events)],
    ["sessionEdgeCount", session.sessionEdgeCount, session.sessionEdges.length],
    ["usageRecordCount", session.usageRecordCount, session.usageRecords.length],
    ["artifactCount", session.artifactCount, session.artifacts.length],
  ] as const;
  for (const [field, observed, expected] of expectedCounts) {
    if (observed !== expected) {
      return `${field} must equal ${expected}`;
    }
  }
  return true;
};

const NormalizedSessionShape = Schema.Struct({
  id: Schema.String,
  nativeSessionId: Schema.String,
  provider: Provider,
  agentName: Schema.String,
  assignment: Schema.optional(AgentAssignment),
  machineId: Schema.String,
  host: Schema.String,
  identitySchemeVersion: NonNegativeInteger,
  projectIdentity: ProjectResolution,
  nativeProjectKey: Schema.optional(Schema.String),
  title: Schema.optional(Schema.String),
  startedAt: Schema.optional(Schema.String),
  updatedAt: Schema.optional(Schema.String),
  sourceRoot: Schema.String,
  sourcePath: Schema.String,
  events: Schema.Array(SessionEvent).pipe(Schema.minItems(1)),
  toolCalls: Schema.Array(ToolCall),
  sessionEdges: Schema.Array(SessionEdge),
  executionContexts: Schema.Array(ExecutionContextRecord),
  usageRecords: Schema.Array(UsageRecord),
  artifacts: Schema.Array(Artifact),
  normalizationVersion: PositiveInteger,
  eventCount: NonNegativeInteger,
  toolCallCount: NonNegativeInteger,
  contentBlockCount: NonNegativeInteger,
  sessionEdgeCount: NonNegativeInteger,
  usageRecordCount: NonNegativeInteger,
  artifactCount: NonNegativeInteger,
});

export const NormalizedSession = NormalizedSessionShape.pipe(
  Schema.filter(normalizedSessionInvariant),
).annotations({
  identifier: "QuasarNormalizedSessionV1",
  title: "Quasar Normalized Session v1",
  description:
    "Provider-neutral source facts with event identity, ownership, relationships, context, usage, and artifacts.",
  parseOptions: strictParseOptions,
});
export type NormalizedSession = typeof NormalizedSession.Type;
export type NormalizedSessionEncoded = typeof NormalizedSession.Encoded;

export const decodeNormalizedSession = Schema.decodeUnknown(
  NormalizedSession,
  strictParseOptions,
);
export const decodeNormalizedSessionSync = Schema.decodeUnknownSync(
  NormalizedSession,
  strictParseOptions,
);

export const ProjectRow = Schema.Struct({
  projectKey: Schema.String,
  displayName: Schema.String,
  rawPath: Schema.optional(Schema.String),
});
export type ProjectRow = typeof ProjectRow.Type;

export const SessionRow = Schema.Struct({
  sessionId: Schema.String,
  projectKey: Schema.String,
  provider: Provider,
  agentName: Schema.String,
  title: Schema.optional(Schema.String),
  startedAt: Schema.optional(Schema.String),
  updatedAt: Schema.optional(Schema.String),
  sourcePath: Schema.String,
  sourceFingerprint: Schema.String,
  host: Schema.String,
  identitySchemeVersion: NonNegativeInteger,
  normalizationVersion: PositiveInteger,
  model: Schema.optional(Schema.String),
  modelProvider: Schema.optional(Schema.String),
  assignmentRole: Schema.optional(Schema.String),
  parentSessionId: Schema.optional(Schema.String),
  messageCount: NonNegativeInteger,
  toolCallCount: NonNegativeInteger,
});
export type SessionRow = typeof SessionRow.Type;

export const MessageRow = Schema.Struct({
  sessionId: Schema.String,
  eventId: Schema.String,
  seq: NonNegativeInteger,
  role: MessageRole,
  text: Schema.String,
  ts: Schema.optional(Schema.String),
  projectKey: Schema.String,
  contentHash: Schema.String,
  executionContextId: Schema.optional(Schema.String),
  model: Schema.optional(Schema.String),
  modelProvider: Schema.optional(Schema.String),
  reasoningEffort: Schema.optional(Schema.String),
});
export type MessageRow = typeof MessageRow.Type;

export const ToolCallRow = Schema.Struct({
  id: Schema.String,
  sessionId: Schema.String,
  eventId: Schema.String,
  seq: NonNegativeInteger,
  toolName: Schema.String,
  status: Schema.optional(Schema.String),
  inputText: Schema.String,
  outputText: Schema.String,
  startedAt: Schema.optional(Schema.String),
  completedAt: Schema.optional(Schema.String),
  projectKey: Schema.String,
  provider: Provider,
  executionContextId: Schema.optional(Schema.String),
  model: Schema.optional(Schema.String),
  modelProvider: Schema.optional(Schema.String),
  reasoningEffort: Schema.optional(Schema.String),
});
export type ToolCallRow = typeof ToolCallRow.Type;

const mappedSessionInvariant = (mapped: {
  readonly project: ProjectRow;
  readonly session: SessionRow;
  readonly messages: ReadonlyArray<MessageRow>;
  readonly toolCalls: ReadonlyArray<ToolCallRow>;
  readonly events: ReadonlyArray<SessionEvent>;
  readonly usageRecords: ReadonlyArray<UsageRecord>;
  readonly sessionEdges: ReadonlyArray<SessionEdge>;
  readonly artifacts: ReadonlyArray<Artifact>;
  readonly executionContexts: ReadonlyArray<ExecutionContextRecord>;
  readonly assignment?: AgentAssignment;
}): true | string => {
  const { project, session } = mapped;
  if (project.projectKey !== session.projectKey) {
    return "project.projectKey must equal session.projectKey";
  }
  if (mapped.messages.length !== session.messageCount) {
    return "messages.length must equal session.messageCount";
  }
  if (mapped.toolCalls.length !== session.toolCallCount) {
    return "toolCalls.length must equal session.toolCallCount";
  }
  if (mapped.assignment?.role !== session.assignmentRole) {
    return "assignment.role must equal session.assignmentRole";
  }

  const idCollections = [
    ["event", mapped.events.map((event) => event.id)],
    ["message event", mapped.messages.map((message) => message.eventId)],
    ["tool call", mapped.toolCalls.map((toolCall) => toolCall.id)],
    ["session edge", mapped.sessionEdges.map((edge) => edge.id)],
    ["execution context", mapped.executionContexts.map((context) => context.id)],
    ["usage record", mapped.usageRecords.map((usage) => usage.id)],
    ["artifact", mapped.artifacts.map((artifact) => artifact.id)],
    [
      "content block",
      mapped.events.flatMap((event) =>
        event.contentBlocks.map((block) => block.id),
      ),
    ],
  ] as const;
  for (const [kind, ids] of idCollections) {
    const duplicate = duplicateValue(ids);
    if (duplicate !== undefined) return `duplicate ${kind} id: ${duplicate}`;
  }

  const factOwnership = (fact: {
    readonly sessionId: string;
    readonly provider: Provider;
    readonly agentName: string;
    readonly projectIdentityKey: string;
  }) =>
    fact.sessionId === session.sessionId
    && fact.provider === session.provider
    && fact.agentName === session.agentName
    && fact.projectIdentityKey === session.projectKey;
  const eventById = new Map<string, SessionEvent>();
  for (const [index, event] of mapped.events.entries()) {
    if (event.sequence !== index) {
      return `event sequence must be dense at index ${index}`;
    }
    if (!factOwnership(event)) return `event ${event.id} has cross-session ownership`;
    eventById.set(event.id, event);
    for (const [blockIndex, block] of event.contentBlocks.entries()) {
      if (block.sequence !== blockIndex) {
        return `content block sequence must be dense for event ${event.id}`;
      }
    }
  }
  const eventIds = new Set(eventById.keys());
  const toolCallIds = new Set(mapped.toolCalls.map((toolCall) => toolCall.id));
  const contextIds = new Set(
    mapped.executionContexts.map((context) => context.id),
  );

  for (const message of mapped.messages) {
    if (
      message.sessionId !== session.sessionId
      || message.projectKey !== session.projectKey
    ) {
      return `message ${message.eventId} has cross-session ownership`;
    }
    const event = eventById.get(message.eventId);
    if (event === undefined) {
      return `message references missing event ${message.eventId}`;
    }
    if (event.sequence !== message.seq) {
      return `message ${message.eventId} sequence differs from its event`;
    }
    const expectedRole = event.role === "thinking" ? "reasoning" : event.role;
    if (message.role !== expectedRole) {
      return `message ${message.eventId} role differs from its event`;
    }
    if (
      message.executionContextId !== undefined
      && !contextIds.has(message.executionContextId)
    ) {
      return `message ${message.eventId} references missing execution context ${message.executionContextId}`;
    }
  }
  for (const toolCall of mapped.toolCalls) {
    if (
      toolCall.sessionId !== session.sessionId
      || toolCall.projectKey !== session.projectKey
      || toolCall.provider !== session.provider
    ) {
      return `tool call ${toolCall.id} has cross-session ownership`;
    }
    const event = eventById.get(toolCall.eventId);
    if (event === undefined) {
      return `tool call ${toolCall.id} references missing event ${toolCall.eventId}`;
    }
    if (event.sequence !== toolCall.seq) {
      return `tool call ${toolCall.id} sequence differs from its event`;
    }
    if (
      toolCall.executionContextId !== undefined
      && !contextIds.has(toolCall.executionContextId)
    ) {
      return `tool call ${toolCall.id} references missing execution context ${toolCall.executionContextId}`;
    }
  }
  for (const event of mapped.events) {
    if (event.toolCallId !== undefined && !toolCallIds.has(event.toolCallId)) {
      return `event ${event.id} references missing tool call ${event.toolCallId}`;
    }
    if (
      event.parentEventId !== undefined
      && !eventIds.has(event.parentEventId)
    ) {
      return `event ${event.id} references missing parent event ${event.parentEventId}`;
    }
  }
  for (const edge of mapped.sessionEdges) {
    if (!factOwnership(edge)) return `session edge ${edge.id} has cross-session ownership`;
    if (edge.fromEventId !== undefined && !eventIds.has(edge.fromEventId)) {
      return `session edge ${edge.id} references missing fromEventId ${edge.fromEventId}`;
    }
    if (edge.toEventId !== undefined && !eventIds.has(edge.toEventId)) {
      return `session edge ${edge.id} references missing toEventId ${edge.toEventId}`;
    }
  }
  for (const context of mapped.executionContexts) {
    if (!factOwnership(context)) {
      return `execution context ${context.id} has cross-session ownership`;
    }
  }
  for (const usage of mapped.usageRecords) {
    if (!factOwnership(usage)) return `usage record ${usage.id} has cross-session ownership`;
    if (usage.eventId !== undefined && !eventIds.has(usage.eventId)) {
      return `usage record ${usage.id} references missing event ${usage.eventId}`;
    }
  }
  for (const artifact of mapped.artifacts) {
    if (!factOwnership(artifact)) return `artifact ${artifact.id} has cross-session ownership`;
    if (artifact.eventId !== undefined && !eventIds.has(artifact.eventId)) {
      return `artifact ${artifact.id} references missing event ${artifact.eventId}`;
    }
  }

  const machineIds = [
    ...mapped.events,
    ...mapped.sessionEdges,
    ...mapped.executionContexts,
    ...mapped.usageRecords,
    ...mapped.artifacts,
  ].map((fact) => fact.machineId);
  if (new Set(machineIds).size > 1) {
    return "source facts contain multiple machineId values";
  }
  return true;
};

const MappedSessionShape = Schema.Struct({
  protocolVersion: Schema.Literal(NORMALIZED_SESSION_PROTOCOL_VERSION),
  project: ProjectRow,
  session: SessionRow,
  messages: Schema.Array(MessageRow),
  toolCalls: Schema.Array(ToolCallRow),
  events: Schema.Array(SessionEvent),
  usageRecords: Schema.Array(UsageRecord),
  sessionEdges: Schema.Array(SessionEdge),
  artifacts: Schema.Array(Artifact),
  executionContexts: Schema.Array(ExecutionContextRecord),
  assignment: Schema.optional(AgentAssignment),
});

export const MappedSession = MappedSessionShape.pipe(
  Schema.filter(mappedSessionInvariant),
).annotations({
  identifier: "QuasarMappedSessionV1",
  title: "Quasar Mapped Session v1",
  description:
    "The strict versioned ingest envelope shared by the Quasar CLI and server.",
  parseOptions: strictParseOptions,
});
export type MappedSession = typeof MappedSession.Type;
export type MappedSessionEncoded = typeof MappedSession.Encoded;

export const decodeMappedSession = Schema.decodeUnknown(
  MappedSession,
  strictParseOptions,
);
export const decodeMappedSessionSync = Schema.decodeUnknownSync(
  MappedSession,
  strictParseOptions,
);

const exampleProject = {
  projectIdentityKey: "project-example",
  displayName: "Example",
  confidence: "explicit",
  rawPath: "/work/example",
  normalizedPath: "/work/example",
  signals: [{
    kind: "explicit",
    value: "project-example",
    confidence: "explicit",
  }],
} as const;

const exampleEvent = {
  id: "codex:example:event:0",
  sessionId: "codex:example",
  nativeEventId: "native-event-0",
  sequence: 0,
  timestamp: "2026-07-26T12:00:00.000Z",
  machineId: "machine-example",
  provider: "codex",
  agentName: "codex",
  projectIdentityKey: "project-example",
  role: "user",
  kind: "message",
  contentText: "Inspect the session contract.",
  contentBlocks: [],
  rawReference: {
    sourcePath: "/history/example.jsonl",
    line: 1,
    nativeType: "response_item",
    rawBytes: 128,
  },
} as const;

export const normalizedSessionExamples = [{
  name: "event-faithful Codex source session",
  input: {
    id: "codex:example",
    nativeSessionId: "example",
    provider: "codex",
    agentName: "codex",
    machineId: "machine-example",
    host: "example.local",
    identitySchemeVersion: 1,
    projectIdentity: exampleProject,
    title: "Session contract",
    startedAt: "2026-07-26T12:00:00.000Z",
    updatedAt: "2026-07-26T12:00:00.000Z",
    sourceRoot: "/history",
    sourcePath: "/history/example.jsonl",
    events: [exampleEvent],
    toolCalls: [],
    sessionEdges: [],
    executionContexts: [],
    usageRecords: [],
    artifacts: [],
    normalizationVersion: NORMALIZATION_VERSION,
    eventCount: 1,
    toolCallCount: 0,
    contentBlockCount: 0,
    sessionEdgeCount: 0,
    usageRecordCount: 0,
    artifactCount: 0,
  },
}] as const;

export const mappedSessionExamples = [{
  name: "versioned event-faithful ingest",
  input: {
    protocolVersion: NORMALIZED_SESSION_PROTOCOL_VERSION,
    project: {
      projectKey: "project-example",
      displayName: "Example",
      rawPath: "/work/example",
    },
    session: {
      sessionId: "codex:example",
      projectKey: "project-example",
      provider: "codex",
      agentName: "codex",
      title: "Session contract",
      startedAt: "2026-07-26T12:00:00.000Z",
      updatedAt: "2026-07-26T12:00:00.000Z",
      sourcePath: "/history/example.jsonl",
      sourceFingerprint: "{\"size\":128,\"mtimeMs\":1}",
      host: "example.local",
      identitySchemeVersion: 1,
      normalizationVersion: NORMALIZATION_VERSION,
      messageCount: 1,
      toolCallCount: 0,
    },
    messages: [{
      sessionId: "codex:example",
      eventId: "codex:example:event:0",
      seq: 0,
      role: "user",
      text: "Inspect the session contract.",
      ts: "2026-07-26T12:00:00.000Z",
      projectKey: "project-example",
      contentHash: "hash-example",
    }],
    toolCalls: [],
    events: [exampleEvent],
    usageRecords: [],
    sessionEdges: [],
    artifacts: [],
    executionContexts: [],
  },
}] as const;
