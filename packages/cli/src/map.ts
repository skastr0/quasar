import { stableWideHash } from "./core/hash";
import { redactSensitive } from "./core/redaction";
import type {
  ContentBlock,
  NormalizedSession,
  SessionEvent,
  ToolCall,
} from "./core/schemas";

import type { MappedSession, MessageRole } from "./model";

const stringifyPayload = (value: unknown): string => {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return value;
  return JSON.stringify(value) ?? "";
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
    if (event.kind === "tool_call" || event.kind === "tool_result") return [];
    const text = String(redactSensitive(eventText(event))).trim();
    if (text.length === 0) return [];
    return [{ event, role, text }];
  });

const toolCallsForSession = (session: NormalizedSession, projectKey: string) =>
  session.toolCalls.map((toolCall: ToolCall, index) => ({
    id: toolCall.id,
    sessionId: toolCall.sessionId,
    seq: index,
    toolName: toolCall.toolName,
    status: toolCall.status,
    inputText: String(redactSensitive(stringifyPayload(toolCall.input))),
    outputText: String(redactSensitive(stringifyPayload(toolCall.output))),
    startedAt: toolCall.startedAt,
    completedAt: toolCall.completedAt,
    projectKey,
    provider: toolCall.provider,
  }));

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
      ...(parentSessionId !== undefined ? { parentSessionId } : {}),
      messageCount: messages.length,
      toolCallCount: toolCalls.length,
    },
    messages,
    toolCalls,
  };
};
