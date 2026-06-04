import type { MutationCtx } from "./_generated/server";
import {
  deleteSearchDocumentById,
  upsertSearchDocument,
} from "./quasarSearchDocuments";
import type { SearchDocumentUpsertInput } from "./quasarSearchTypes";
import type { EventPatch, SessionIngestState } from "./quasarIngestTypes";
import { upsertToolCallFromEvent } from "./quasarIngestToolCalls";
import { compactSearchText, redactSensitive, safeSummary } from "./quasarText";
import { isToolEventKind, normalizeToolCallId } from "./quasarToolExtraction";
import { dateMillis } from "./quasarValues";

export const upsertSessionEvents = async (
  ctx: MutationCtx,
  state: SessionIngestState,
) => {
  for (const event of state.events) {
    await upsertSessionEvent(ctx, state, event);
  }
};

const upsertSessionEvent = async (
  ctx: MutationCtx,
  state: SessionIngestState,
  event: Record<string, unknown>,
) => {
  const eventId = String(event.id ?? "");
  const kindValue = String(event.kind ?? "unknown");
  const safeContent = redactSensitive(event.content);
  const normalizedToolCallId = isToolEventKind(kindValue)
    ? normalizeToolCallId(state.sessionId, event, eventId, state.lastToolCallByName)
    : undefined;
  if (normalizedToolCallId !== undefined) state.keepToolCallIds.add(normalizedToolCallId);

  const eventPatch = buildEventPatch(state, event, eventId, safeContent, normalizedToolCallId);
  await writeSessionEvent(ctx, state, eventPatch);
  await upsertSearchDocument(ctx, eventSearchDocument(state, event, eventPatch, safeContent));
  if (isToolEventKind(String(eventPatch.kind))) {
    await upsertToolCallFromEvent(ctx, state, event, eventPatch, safeContent);
  }
};

const writeSessionEvent = async (
  ctx: MutationCtx,
  state: SessionIngestState,
  eventPatch: EventPatch,
) => {
  const existing = await ctx.db
    .query("sessionEvents")
    .withIndex("by_eventId", (q) => q.eq("eventId", eventPatch.eventId))
    .unique();
  if (existing === null) await ctx.db.insert("sessionEvents", { ...eventPatch, createdAt: state.batch.now });
  else await ctx.db.patch(existing._id, eventPatch);
};

const buildEventPatch = (
  state: SessionIngestState,
  event: Record<string, unknown>,
  eventId: string,
  safeContent: unknown,
  normalizedToolCallId: string | undefined,
): EventPatch => ({
  eventId,
  sessionId: state.sessionId,
  nativeEventId: typeof event.nativeEventId === "string" ? event.nativeEventId : undefined,
  sequence: Number(event.sequence ?? 0),
  timestamp: typeof event.timestamp === "string" ? event.timestamp : undefined,
  machineId: state.sessionPatch.machineId,
  provider: state.providerValue as never,
  agentName: state.agentName,
  projectIdentityKey: state.sessionPatch.projectIdentityKey,
  canonicalProjectIdentityKey: state.canonicalProjectIdentityKey,
  role: event.role as never,
  kind: event.kind as never,
  contentText:
    typeof event.contentText === "string"
      ? (redactSensitive(event.contentText) as string)
      : undefined,
  content: safeContent,
  toolCallId: normalizedToolCallId,
  parentEventId: typeof event.parentEventId === "string" ? event.parentEventId : undefined,
  rawReference: event.rawReference ?? {},
  raw: undefined,
  importRunId: state.batch.importRunId,
  updatedAt: state.batch.now,
});

const eventSearchDocument = (
  state: SessionIngestState,
  event: Record<string, unknown>,
  eventPatch: EventPatch,
  safeContent: unknown,
): SearchDocumentUpsertInput => {
  const summary = safeSummary(eventPatch.contentText, safeContent);
  return {
    searchDocumentId: `event:${eventPatch.eventId}`,
    sourceTable: "sessionEvents",
    sourceId: eventPatch.eventId,
    family: "sessionEvents",
    projectIdentityKey: state.sessionPatch.projectIdentityKey,
    canonicalProjectIdentityKey: state.canonicalProjectIdentityKey,
    machineId: state.sessionPatch.machineId,
    provider: state.providerValue as never,
    agentName: state.agentName,
    role: eventPatch.role,
    kind: eventPatch.kind,
    title: `${state.providerValue} ${String(event.kind ?? "event")}`,
    summary,
    searchText: compactSearchText([summary, safeContent]),
    sourcePath: eventSourcePath(event, state.sessionPatch.sourcePath),
    sourceRef: { sessionId: state.sessionId, eventId: eventPatch.eventId },
    occurredAt: dateMillis(eventPatch.timestamp),
    activeProject: "",
    activeMachine: "",
    activeProvider: "",
    activeKind: "",
    sourceUpdatedAt: state.batch.now,
  };
};

const eventSourcePath = (event: Record<string, unknown>, fallback: string) => {
  const rawReference = event.rawReference as Record<string, unknown> | undefined;
  return typeof rawReference?.sourcePath === "string" ? rawReference.sourcePath : fallback;
};

export const cleanupMissingSessionRows = async (
  ctx: MutationCtx,
  sessionId: string,
  keepEventIds: Set<string>,
  keepToolCallIds: Set<string>,
) => {
  const existingEvents = await ctx.db
    .query("sessionEvents")
    .withIndex("by_session_sequence", (q) => q.eq("sessionId", sessionId))
    .collect();
  for (const row of existingEvents) {
    if (keepEventIds.has(row.eventId)) continue;
    await deleteSearchDocumentById(ctx, `event:${row.eventId}`);
    await ctx.db.delete(row._id);
  }

  const existingTools = await ctx.db
    .query("toolCalls")
    .withIndex("by_sessionId", (q) => q.eq("sessionId", sessionId))
    .collect();
  for (const row of existingTools) {
    if (keepToolCallIds.has(row.toolCallId)) continue;
    await deleteSearchDocumentById(ctx, `tool:${row.toolCallId}`);
    await ctx.db.delete(row._id);
  }
};
