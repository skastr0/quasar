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
import {
  decodeNormalizedSessionSync,
  NORMALIZED_SESSION_PROTOCOL_VERSION,
} from "@skastr0/quasar-protocol";

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

type EventContext = {
  readonly executionContextId?: string;
  readonly model?: string;
  readonly modelProvider?: string;
  readonly reasoningEffort?: string;
};

const contextForEvent = (
  session: NormalizedSession,
  event: SessionEvent,
): EventContext => {
  const turnIds = new Set(
    [event.id, event.nativeEventId].filter((value): value is string => value !== undefined),
  );
  const ordered = [...session.executionContexts]
    .sort((left, right) => left.sequence - right.sequence || left.id.localeCompare(right.id));
  const exact = ordered.filter(
    (context) =>
      context.scope === "turn"
      && context.turnId !== undefined
      && turnIds.has(context.turnId),
  );
  const exactIds = new Set(exact.map((context) => context.id));
  const timeline = ordered.filter(
    (context) => context.sequence <= event.sequence && !exactIds.has(context.id),
  );
  let executionContextId: string | undefined;
  let model: string | undefined;
  let modelProvider: string | undefined;
  let reasoningEffort: string | undefined;
  for (const context of [...timeline, ...exact]) {
    executionContextId = context.id;
    if (context.model !== undefined) model = context.model;
    if (context.modelProvider !== undefined) modelProvider = context.modelProvider;
    if (context.reasoningEffort !== undefined) reasoningEffort = context.reasoningEffort;
  }
  for (const usage of session.usageRecords) {
    if (usage.eventId !== event.id) continue;
    if (usage.model !== undefined) model = usage.model;
    if (usage.modelProvider !== undefined) modelProvider = usage.modelProvider;
  }
  return {
    ...(executionContextId !== undefined ? { executionContextId } : {}),
    ...(model !== undefined ? { model: String(redactSensitive(model)) } : {}),
    ...(modelProvider !== undefined
      ? { modelProvider: String(redactSensitive(modelProvider)) }
      : {}),
    ...(reasoningEffort !== undefined
      ? { reasoningEffort: String(redactSensitive(reasoningEffort)) }
      : {}),
  };
};

const blockText = (block: ContentBlock): string | undefined => {
  if (block.kind === "text") return block.text;
  if (block.kind === "markdown") return block.markdown;
  if (block.kind === "thinking") return block.thinking;
  return undefined;
};

const isToolPayloadBlock = (block: ContentBlock): boolean => {
  if (block.metadata === null || typeof block.metadata !== "object") return false;
  const nativeType = (block.metadata as Record<string, unknown>).nativeType;
  if (typeof nativeType !== "string") return false;
  const normalized = nativeType.toLowerCase();
  return (
    normalized.includes("tool")
    || normalized.endsWith("_call")
    || normalized.endsWith("_output")
    || normalized.endsWith("_result")
  );
};

const eventText = (event: SessionEvent): string => {
  if (event.contentText !== undefined && event.contentText.trim().length > 0) {
    return event.contentText;
  }
  return event.contentBlocks
    .flatMap((block) =>
      isToolPayloadBlock(block) ? [] : (blockText(block) ?? []),
    )
    .join("\n\n");
};

const messageEvents = (session: NormalizedSession) =>
  session.events.flatMap((event) => {
    const role = roleForEvent(event);
    if (role === undefined) return [];
    const text = String(redactSensitive(eventText(event))).trim();
    if (text.length === 0) return [];
    return [{ event, role, text, context: contextForEvent(session, event) }];
  });

const toolCallsForSession = (session: NormalizedSession, projectKey: string) => {
  const eventSequenceById = new Map(session.events.map((event) => [event.id, event.sequence]));
  const eventById = new Map(session.events.map((event) => [event.id, event]));
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
    ...(eventById.get(toolCall.eventId) === undefined
      ? {}
      : contextForEvent(session, eventById.get(toolCall.eventId)!)),
  }));
};

export const mapSession = (
  sourceSession: NormalizedSession,
  sourceFingerprint: string,
): MappedSession => {
  const session = decodeNormalizedSessionSync(sourceSession);
  const projectKey = session.projectIdentity.projectIdentityKey;
  const messages = messageEvents(session).map(({ event, role, text, context }) => ({
    sessionId: session.id,
    eventId: event.id,
    seq: event.sequence,
    role,
    text,
    ts: event.timestamp,
    projectKey,
    contentHash: stableWideHash(`${session.id}:${event.id}:${event.sequence}:${role}:${text}`),
    ...context,
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
    protocolVersion: NORMALIZED_SESSION_PROTOCOL_VERSION,
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
      title: session.title === undefined
        ? undefined
        : String(redactSensitive(session.title)),
      startedAt: session.startedAt,
      updatedAt: session.updatedAt,
      sourcePath: session.sourcePath,
      sourceFingerprint,
      host: session.host,
      identitySchemeVersion: session.identitySchemeVersion,
      normalizationVersion: session.normalizationVersion,
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
