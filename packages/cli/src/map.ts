import { stableWideHash } from "./core/hash";
import { redactSensitive } from "./core/redaction";
import type {
  AgentAssignment,
  Artifact,
  ContentBlock,
  ExecutionContextRecord,
  NormalizedSession,
  SessionEdge,
  SessionEvent,
  ToolCall,
  UsageRecord,
} from "./core/schemas";

import type { MappedSession, MessageRole } from "./model";
import { NORMALIZATION_VERSION } from "./normalization-version";

const stringifyPayload = (value: unknown): string => {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return value;
  return JSON.stringify(value) ?? "";
};

const redactSourceFact = <A>(value: A): A => redactSensitive(value) as A;

const redactEvent = (event: SessionEvent): SessionEvent => {
  const redacted = redactSourceFact(event);
  return {
    ...redacted,
    id: event.id,
    sessionId: event.sessionId,
    nativeEventId: event.nativeEventId,
    sequence: event.sequence,
    machineId: event.machineId,
    provider: event.provider,
    agentName: event.agentName,
    projectIdentityKey: event.projectIdentityKey,
    toolCallId: event.toolCallId,
    parentEventId: event.parentEventId,
    contentBlocks: redacted.contentBlocks.map((block, index) => {
      const source = event.contentBlocks[index]!;
      return { ...block, id: source.id, sequence: source.sequence, kind: source.kind };
    }),
    rawReference: {
      ...redacted.rawReference,
      line: event.rawReference.line,
      table: event.rawReference.table,
      rowId: event.rawReference.rowId,
      nativeType: event.rawReference.nativeType,
      rawBytes: event.rawReference.rawBytes,
    },
  };
};

const redactUsageRecord = (record: UsageRecord): UsageRecord => ({
  ...redactSourceFact(record),
  id: record.id,
  sessionId: record.sessionId,
  eventId: record.eventId,
  machineId: record.machineId,
  provider: record.provider,
  agentName: record.agentName,
  projectIdentityKey: record.projectIdentityKey,
});

const redactSessionEdge = (edge: SessionEdge): SessionEdge => ({
  ...redactSourceFact(edge),
  id: edge.id,
  sessionId: edge.sessionId,
  machineId: edge.machineId,
  provider: edge.provider,
  agentName: edge.agentName,
  projectIdentityKey: edge.projectIdentityKey,
  fromEventId: edge.fromEventId,
  toEventId: edge.toEventId,
  fromId: edge.fromId,
  toId: edge.toId,
});

const redactArtifact = (artifact: Artifact): Artifact => ({
  ...redactSourceFact(artifact),
  id: artifact.id,
  sessionId: artifact.sessionId,
  eventId: artifact.eventId,
  machineId: artifact.machineId,
  provider: artifact.provider,
  agentName: artifact.agentName,
  projectIdentityKey: artifact.projectIdentityKey,
  contentHash: artifact.contentHash,
});

const redactExecutionContext = (context: ExecutionContextRecord): ExecutionContextRecord => ({
  ...redactSourceFact(context),
  id: context.id,
  sessionId: context.sessionId,
  sequence: context.sequence,
  scope: context.scope,
  turnId: context.turnId,
  machineId: context.machineId,
  provider: context.provider,
  agentName: context.agentName,
  projectIdentityKey: context.projectIdentityKey,
});

const latestModel = (session: NormalizedSession): { readonly model?: string; readonly modelProvider?: string } => {
  let model: string | undefined;
  let modelProvider: string | undefined;
  const contexts = [...session.executionContexts].sort((left, right) => left.sequence - right.sequence);
  for (const context of contexts) {
    if (context.model !== undefined) model = context.model;
    if (context.modelProvider !== undefined) modelProvider = context.modelProvider;
  }
  if (model === undefined || modelProvider === undefined) {
    for (let index = session.usageRecords.length - 1; index >= 0; index -= 1) {
      const usage = session.usageRecords[index]!;
      if (model === undefined && usage.model !== undefined) model = usage.model;
      if (modelProvider === undefined && usage.modelProvider !== undefined) modelProvider = usage.modelProvider;
      if (model !== undefined && modelProvider !== undefined) break;
    }
  }
  return { model, modelProvider };
};

const roleForEvent = (event: SessionEvent): MessageRole | undefined => {
  if (event.role === "user" || event.role === "assistant") return event.role;
  if (event.role === "thinking") return "reasoning";
  return undefined;
};

const blockText = (block: ContentBlock): string | undefined => {
  if (block.kind === "text") return block.text;
  if (block.kind === "markdown") return block.markdown;
  if (block.kind === "thinking") return block.thinking;
  return undefined;
};

const eventText = (event: SessionEvent): string => {
  if (event.contentText !== undefined && event.contentText.trim().length > 0) {
    return event.contentText;
  }
  return event.contentBlocks.flatMap((block) => blockText(block) ?? []).join("\n\n");
};

const messageEvents = (session: NormalizedSession) =>
  session.events.flatMap((event) => {
    const role = roleForEvent(event);
    if (role === undefined) return [];
    const searchableMessage = event.kind === "message"
      && (role === "user" || role === "assistant");
    const searchableReasoning = event.kind === "reasoning" && role === "reasoning";
    if (!searchableMessage && !searchableReasoning) return [];
    const text = String(redactSensitive(eventText(event))).trim();
    if (text.length === 0) return [];
    return [{ event, role, text }];
  });

const toolCallsForSession = (session: NormalizedSession, projectKey: string) => {
  const eventSequenceById = new Map(session.events.map((event) => [event.id, event.sequence]));
  return session.toolCalls.map((toolCall: ToolCall, index) => ({
    id: toolCall.id,
    sessionId: toolCall.sessionId,
    eventId: toolCall.eventId,
    seq: eventSequenceById.get(toolCall.eventId) ?? index,
    toolName: toolCall.toolName,
    status: toolCall.status,
    inputText: String(redactSensitive(stringifyPayload(toolCall.input))),
    outputText: String(redactSensitive(stringifyPayload(toolCall.output))),
    startedAt: toolCall.startedAt,
    completedAt: toolCall.completedAt,
    projectKey,
    provider: toolCall.provider,
  }));
};

export const mapSession = (
  session: NormalizedSession,
  sourceFingerprint: string,
): MappedSession => {
  const projectKey = session.projectIdentity.projectIdentityKey;
  const messages = messageEvents(session).map(({ event, role, text }, index) => ({
    sessionId: session.id,
    seq: index,
    role,
    text,
    ts: event.timestamp,
    projectKey,
    contentHash: stableWideHash(`${session.id}:${index}:${role}:${text}`),
  }));

  const toolCalls = toolCallsForSession(session, projectKey);
  // Canonical parent lineage: ONLY a `kind="subagent_of"` SessionEdge encodes
  // SESSION-to-session subagent lineage, carrying the parent's canonical
  // SessionId on `fromId`. We project it onto the persisted-and-served
  // SessionRow.parentSessionId column — the edge mechanism never reaches SQLite.
  // The `kind="parent"` edge is EVENT-to-event message threading (claude,
  // opencode) whose `fromId` may be a raw message uuid — projecting it here
  // would write a message uuid into the served session column (corruption), so
  // it is deliberately excluded.
  const parentEdge = session.sessionEdges.find((edge) => edge.kind === "subagent_of");
  const parentSessionId = parentEdge?.fromId;
  const executionModel = latestModel(session);
  const assignment = session.assignment === undefined
    ? undefined
    : redactSourceFact<AgentAssignment>(session.assignment);
  return {
    project: {
      projectKey,
      displayName: session.projectIdentity.displayName,
      rawPath: session.projectIdentity.rawPath,
    },
    session: {
      sessionId: session.id,
      projectKey,
      provider: session.provider,
      agentName: session.agentName,
      title: session.title,
      startedAt: session.startedAt,
      updatedAt: session.updatedAt,
      sourcePath: session.sourcePath,
      sourceFingerprint,
      host: session.host,
      identitySchemeVersion: session.identitySchemeVersion,
      normalizationVersion: NORMALIZATION_VERSION,
      ...(executionModel.model !== undefined
        ? { model: String(redactSensitive(executionModel.model)) }
        : {}),
      ...(executionModel.modelProvider !== undefined
        ? { modelProvider: String(redactSensitive(executionModel.modelProvider)) }
        : {}),
      ...(assignment?.role !== undefined ? { assignmentRole: assignment.role } : {}),
      ...(parentSessionId !== undefined ? { parentSessionId } : {}),
      messageCount: messages.length,
      toolCallCount: toolCalls.length,
    },
    messages,
    toolCalls,
    events: session.events.map(redactEvent),
    usageRecords: session.usageRecords.map(redactUsageRecord),
    sessionEdges: session.sessionEdges.map(redactSessionEdge),
    artifacts: session.artifacts.map(redactArtifact),
    executionContexts: session.executionContexts.map(redactExecutionContext),
    ...(assignment !== undefined ? { assignment } : {}),
  };
};
