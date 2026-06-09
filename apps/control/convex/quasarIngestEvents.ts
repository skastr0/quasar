import type { MutationCtx } from "./_generated/server";
import {
  deleteSearchDocumentById,
  upsertSearchDocument,
} from "./quasarSearchDocuments";
import type { SearchDocumentUpsertInput } from "./quasarSearchTypes";
import type { EventPatch, SessionIngestState } from "./quasarIngestTypes";
import type { SessionEventBoundary } from "./quasarDomainSchemas";
import { upsertToolCallFromEvent } from "./quasarIngestToolCalls";
import { compactSearchText, redactSensitive, safeSummary, wideHash } from "./quasarText";
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
  event: SessionEventBoundary,
) => {
  const eventId = event.id;
  const kindValue = event.kind;
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
  event: SessionEventBoundary,
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
  provider: state.providerValue,
  agentName: state.agentName,
  projectIdentityKey: state.sessionPatch.projectIdentityKey,
  canonicalProjectIdentityKey: state.canonicalProjectIdentityKey,
  role: event.role,
  kind: event.kind,
  contentText:
    typeof event.contentText === "string"
      ? (redactSensitive(event.contentText) as string)
      : undefined,
  content: safeContent,
  contentBlocks: undefined,
  toolCallId: normalizedToolCallId,
  parentEventId: typeof event.parentEventId === "string" ? event.parentEventId : undefined,
  rawReference: event.rawReference ?? {},
  raw: undefined,
  importRunId: state.batch.importRunId,
  importJobId: state.batch.importJobId,
  importChunkId: state.batch.importChunkId,
  updatedAt: state.batch.now,
});

const eventSearchDocument = (
  state: SessionIngestState,
  event: SessionEventBoundary,
  eventPatch: EventPatch,
  safeContent: unknown,
): SearchDocumentUpsertInput => {
  const toolBacked = isToolBackedEvent(eventPatch);
  const canonicalText = compactSearchText(eventPatch.contentText);
  const metadata = toolBacked ? toolMetadata(safeContent) : eventContentMetadata(safeContent);
  const summary = toolBacked
    ? compactSearchText([eventPatch.kind, metadata])
    : safeSummary(canonicalText, metadata);
  return {
    searchDocumentId: `event:${eventPatch.eventId}`,
    sourceTable: "sessionEvents",
    sourceId: eventPatch.eventId,
    family: "sessionEvents",
    projectIdentityKey: state.sessionPatch.projectIdentityKey,
    canonicalProjectIdentityKey: state.canonicalProjectIdentityKey,
    machineId: state.sessionPatch.machineId,
    provider: state.providerValue,
    agentName: state.agentName,
    role: eventPatch.role,
    kind: eventPatch.kind,
    title: `${state.providerValue} ${event.kind}`,
    summary,
    searchText: toolBacked
      ? compactSearchText([summary, eventPatch.toolCallId, metadata])
      : compactSearchText([canonicalText, metadata]),
    embeddingText: canonicalText.length > 0 ? canonicalText : undefined,
    sourcePath: eventSourcePath(event, state.sessionPatch.sourcePath),
    sourceRef: { sessionId: state.sessionId, eventId: eventPatch.eventId },
    embeddingEligible: eventEmbeddingEligible(state, eventPatch, canonicalText),
    embeddingSkipReason: eventEmbeddingSkipReason(eventPatch, canonicalText),
    importJobId: state.batch.importJobId,
    importChunkId: state.batch.importChunkId,
    occurredAt: dateMillis(eventPatch.timestamp),
    activeProject: "",
    activeMachine: "",
    activeProvider: "",
    activeKind: "",
    sourceUpdatedAt: state.batch.now,
  };
};

const isToolBackedEvent = (eventPatch: EventPatch) =>
  isToolEventKind(String(eventPatch.kind)) || eventPatch.role === "tool";

const toolMetadata = (value: unknown): unknown => {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "object") {
    const text = typeof value === "string" ? value : String(value);
    return { type: typeof value, length: text.length, hash: wideHash(text) };
  }
  if (Array.isArray(value)) {
    return { type: "array", length: value.length, hash: wideHash(compactSearchText(value)) };
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  const extracted = Object.fromEntries(
    keys
      .filter((key) => /^(name|toolName|path|file|filename|cwd|uri|url|sourcePath|targetPath)$/i.test(key))
      .map((key) => [key, record[key]]),
  );
  return { type: "object", keyCount: keys.length, ...extracted, hash: wideHash(compactSearchText(value)) };
};

const eventContentMetadata = (value: unknown): unknown => {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "object") {
    const text = typeof value === "string" ? value : String(value);
    return { type: typeof value, length: text.length, hash: wideHash(text) };
  }
  if (Array.isArray(value)) {
    return { type: "array", length: value.length, hash: wideHash(compactSearchText(value)) };
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  const extracted = Object.fromEntries(
    keys
      .filter((key) => /^(type|name|toolName|path|file|filename|cwd|uri|url|sourcePath|targetPath)$/i.test(key))
      .map((key) => [key, record[key]]),
  );
  return { type: "object", keyCount: keys.length, ...extracted, hash: wideHash(compactSearchText(value)) };
};

const eventEmbeddingEligible = (
  state: SessionIngestState,
  eventPatch: EventPatch,
  canonicalText: string,
) => {
  if (canonicalText.trim().length === 0) return false;
  if (eventPatch.kind !== "message") return false;
  if (eventPatch.role === "user") return true;
  if (eventPatch.role !== "assistant") return false;
  return isTurnFinalAssistantMessage(state, eventPatch.eventId);
};

const eventEmbeddingSkipReason = (eventPatch: EventPatch, canonicalText: string) => {
  if (canonicalText.trim().length === 0) return "empty_text";
  if (eventPatch.kind === "tool_call" || eventPatch.kind === "tool_result") return "tool_output";
  if (eventPatch.kind === "reasoning" || eventPatch.role === "thinking") return "reasoning";
  if (eventPatch.kind === "message" && eventPatch.role === "assistant") return "assistant_not_turn_final";
  return "policy_default";
};

const isTurnFinalAssistantMessage = (
  state: SessionIngestState,
  eventId: string,
) => {
  const ordered = [...state.events].sort(
    (left, right) => Number(left.sequence ?? 0) - Number(right.sequence ?? 0),
  );
  const index = ordered.findIndex((event) => String(event.id ?? "") === eventId);
  if (index < 0) return false;
  for (const later of ordered.slice(index + 1)) {
    const kind = String(later.kind ?? "unknown");
    const role = String(later.role ?? "unknown");
    if (kind !== "message") continue;
    if (role === "assistant") return false;
    if (role === "user") return true;
  }
  return true;
};

const eventSourcePath = (event: SessionEventBoundary, fallback: string) =>
  event.rawReference.sourcePath || fallback;

export const cleanupMissingSessionRows = async (
  ctx: MutationCtx,
  sessionId: string,
  keepEventIds: Set<string>,
  keepToolCallIds: Set<string>,
): Promise<{ readonly eventsTruncated: boolean; readonly toolsTruncated: boolean }> => {
  const existingEvents = await ctx.db
    .query("sessionEvents")
    .withIndex("by_session_sequence", (q) => q.eq("sessionId", sessionId))
    .take(CLEANUP_SCAN_LIMIT);
  for (const row of existingEvents) {
    if (keepEventIds.has(row.eventId)) continue;
    await deleteSearchDocumentById(ctx, `event:${row.eventId}`);
    await ctx.db.delete(row._id);
  }

  const existingTools = await ctx.db
    .query("toolCalls")
    .withIndex("by_sessionId", (q) => q.eq("sessionId", sessionId))
    .take(CLEANUP_SCAN_LIMIT);
  for (const row of existingTools) {
    if (keepToolCallIds.has(row.toolCallId)) continue;
    await deleteSearchDocumentById(ctx, `tool:${row.toolCallId}`);
    await ctx.db.delete(row._id);
  }
  return {
    eventsTruncated: existingEvents.length >= CLEANUP_SCAN_LIMIT,
    toolsTruncated: existingTools.length >= CLEANUP_SCAN_LIMIT,
  };
};

const CLEANUP_SCAN_LIMIT = 500;
