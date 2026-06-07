import type { Doc } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";
import type { EventPatch, SessionIngestState } from "./quasarIngestTypes";
import type { SessionEventBoundary, ToolCallBoundary } from "./quasarDomainSchemas";
import { upsertSearchDocument } from "./quasarSearchDocuments";
import type { SearchDocumentUpsertInput } from "./quasarSearchTypes";
import { compactSearchText, redactSensitive, safeSummary, wideHash } from "./quasarText";
import { extractToolName } from "./quasarToolExtraction";
import { dateMillis } from "./quasarValues";

export const upsertToolCallFromEvent = async (
  ctx: MutationCtx,
  state: SessionIngestState,
  event: SessionEventBoundary,
  eventPatch: EventPatch,
  safeContent: unknown,
) => {
  const toolCallId = eventPatch.toolCallId ?? `tool:${eventPatch.eventId}`;
  const toolName = extractToolName({
    kind: event.kind,
    content: safeContent,
    raw: undefined,
  });
  const existingTool = await findToolCall(ctx, toolCallId);
  const toolPatch = eventToolPatch(state, eventPatch, toolCallId, toolName, safeContent, existingTool);
  if (existingTool === null) await ctx.db.insert("toolCalls", { ...toolPatch, createdAt: state.batch.now });
  else await ctx.db.patch(existingTool._id, toolPatch);
  await upsertSearchDocument(
    ctx,
    toolSearchDocumentFromEvent(state, eventPatch, toolCallId, toolName, safeContent),
  );
};

const findToolCall = async (ctx: MutationCtx, toolCallId: string) =>
  await ctx.db
    .query("toolCalls")
    .withIndex("by_toolCallId", (q) => q.eq("toolCallId", toolCallId))
    .unique();

const eventToolPatch = (
  state: SessionIngestState,
  eventPatch: EventPatch,
  toolCallId: string,
  toolName: string,
  safeContent: unknown,
  existingTool: Doc<"toolCalls"> | null,
) => ({
  toolCallId,
  sessionId: state.sessionId,
  eventId: eventPatch.eventId,
  machineId: state.sessionPatch.machineId,
  provider: state.providerValue,
  agentName: state.agentName,
  projectIdentityKey: state.sessionPatch.projectIdentityKey,
  canonicalProjectIdentityKey: state.canonicalProjectIdentityKey,
  toolName,
  status: eventPatch.kind === "tool_result" ? "completed" : "started",
  input: eventPatch.kind === "tool_call" ? safeContent : existingTool?.input,
  output: eventPatch.kind === "tool_result" ? safeContent : existingTool?.output,
  startedAt: eventPatch.kind === "tool_call" ? eventPatch.timestamp : existingTool?.startedAt,
  completedAt: eventPatch.kind === "tool_result" ? eventPatch.timestamp : existingTool?.completedAt,
  raw: undefined,
  importRunId: state.batch.importRunId,
  importJobId: state.batch.importJobId,
  importChunkId: state.batch.importChunkId,
  updatedAt: state.batch.now,
});

const toolSearchDocumentFromEvent = (
  state: SessionIngestState,
  eventPatch: EventPatch,
  toolCallId: string,
  toolName: string,
  safeContent: unknown,
): SearchDocumentUpsertInput => {
  const summary = safeSummary(eventPatch.contentText, safeContent);
  return {
    searchDocumentId: `tool:${toolCallId}`,
    sourceTable: "toolCalls",
    sourceId: toolCallId,
    family: "toolCalls",
    projectIdentityKey: state.sessionPatch.projectIdentityKey,
    canonicalProjectIdentityKey: state.canonicalProjectIdentityKey,
    machineId: state.sessionPatch.machineId,
    provider: state.providerValue,
    agentName: state.agentName,
    toolName,
    title: toolName,
    summary,
    searchText: toolMetadataSearchText({
      toolName,
      status: eventPatch.kind === "tool_result" ? "completed" : "started",
      input: eventPatch.kind === "tool_call" ? safeContent : undefined,
      output: eventPatch.kind === "tool_result" ? safeContent : undefined,
      sourcePath: state.sessionPatch.sourcePath,
    }),
    sourcePath: state.sessionPatch.sourcePath,
    sourceRef: { sessionId: state.sessionId, eventId: eventPatch.eventId, toolCallId },
    embeddingEligible: false,
    embeddingSkipReason: "tool_metadata_only",
    importJobId: state.batch.importJobId,
    importChunkId: state.batch.importChunkId,
    occurredAt: dateMillis(eventPatch.timestamp),
    activeProject: "",
    activeMachine: "",
    activeProvider: "",
    sourceUpdatedAt: state.batch.now,
  };
};

export const upsertDeclaredToolCalls = async (
  ctx: MutationCtx,
  state: SessionIngestState,
) => {
  for (const toolCall of state.declaredToolCalls) {
    await upsertDeclaredToolCall(ctx, state, toolCall);
  }
};

const upsertDeclaredToolCall = async (
  ctx: MutationCtx,
  state: SessionIngestState,
  toolCall: ToolCallBoundary,
) => {
  const toolCallId = toolCall.id;
  if (toolCallId.length === 0) return;
  state.keepToolCallIds.add(toolCallId);
  const eventId = toolCall.eventId ?? `declared:${toolCallId}`;
  const toolName = toolCall.toolName;
  const toolPatch = declaredToolPatch(state, toolCall, toolCallId, eventId, toolName);
  const existingTool = await findToolCall(ctx, toolCallId);
  if (existingTool === null) await ctx.db.insert("toolCalls", { ...toolPatch, createdAt: state.batch.now });
  else await ctx.db.patch(existingTool._id, toolPatch);
  await upsertSearchDocument(
    ctx,
    declaredToolSearchDocument(state, toolCall, toolPatch, eventId, toolCallId, toolName),
  );
};

const declaredToolPatch = (
  state: SessionIngestState,
  toolCall: ToolCallBoundary,
  toolCallId: string,
  eventId: string,
  toolName: string,
) => ({
  toolCallId,
  sessionId: state.sessionId,
  eventId,
  machineId: state.sessionPatch.machineId,
  provider: state.providerValue,
  agentName: state.agentName,
  projectIdentityKey: state.sessionPatch.projectIdentityKey,
  canonicalProjectIdentityKey: state.canonicalProjectIdentityKey,
  toolName,
  status: toolCall.status,
  input: redactSensitive(toolCall.input),
  output: redactSensitive(toolCall.output),
  startedAt: typeof toolCall.startedAt === "string" ? toolCall.startedAt : undefined,
  completedAt: typeof toolCall.completedAt === "string" ? toolCall.completedAt : undefined,
  raw: undefined,
  importRunId: state.batch.importRunId,
  importJobId: state.batch.importJobId,
  importChunkId: state.batch.importChunkId,
  updatedAt: state.batch.now,
});

const declaredToolSearchDocument = (
  state: SessionIngestState,
  toolCall: ToolCallBoundary,
  toolPatch: ReturnType<typeof declaredToolPatch>,
  eventId: string,
  toolCallId: string,
  toolName: string,
): SearchDocumentUpsertInput => ({
  searchDocumentId: `tool:${toolCallId}`,
  sourceTable: "toolCalls",
  sourceId: toolCallId,
  family: "toolCalls",
  projectIdentityKey: state.sessionPatch.projectIdentityKey,
  canonicalProjectIdentityKey: state.canonicalProjectIdentityKey,
  machineId: state.sessionPatch.machineId,
  provider: state.providerValue,
  agentName: state.agentName,
  toolName,
  title: toolName,
  summary: compactSearchText([toolName, toolPatch.status, toolMetadata(toolPatch.input), toolMetadata(toolPatch.output)]),
  searchText: toolMetadataSearchText({
    toolName,
    status: toolPatch.status,
    input: toolPatch.input,
    output: toolPatch.output,
    sourcePath: state.sessionPatch.sourcePath,
  }),
  sourcePath: state.sessionPatch.sourcePath,
  sourceRef: { sessionId: state.sessionId, eventId, toolCallId },
  embeddingEligible: false,
  embeddingSkipReason: "tool_metadata_only",
  importJobId: state.batch.importJobId,
  importChunkId: state.batch.importChunkId,
  occurredAt: dateMillis(toolPatch.completedAt) ?? dateMillis(toolPatch.startedAt),
  sourceUpdatedAt: state.batch.now,
});

const toolMetadataSearchText = (args: {
  readonly toolName: string;
  readonly status?: string;
  readonly input?: unknown;
  readonly output?: unknown;
  readonly sourcePath?: string;
}) =>
  compactSearchText([
    args.toolName,
    args.status,
    args.sourcePath,
    toolMetadata(args.input),
    toolMetadata(args.output),
  ]);

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
      .filter((key) => /^(path|file|filename|cwd|uri|url|sourcePath|targetPath)$/i.test(key))
      .map((key) => [key, record[key]]),
  );
  return {
    type: "object",
    keys,
    ...extracted,
    hash: wideHash(compactSearchText(value)),
  };
};
