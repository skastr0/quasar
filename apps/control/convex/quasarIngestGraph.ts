import type { MutationCtx } from "./_generated/server";
import type { SessionIngestState } from "./quasarIngestTypes";
import {
  deleteSearchDocumentById,
  upsertSearchDocument,
} from "./quasarSearchDocuments";
import type { SearchDocumentUpsertInput } from "./quasarSearchTypes";
import { compactSearchText, redactSensitive, safeSummary, wideHash } from "./quasarText";
import { dateMillis } from "./quasarValues";

const contentBlockKinds = new Set(["text", "markdown", "thinking", "image", "file", "json"]);
const sessionEdgeKinds = new Set([
  "next",
  "parent",
  "tool_result_for",
  "forked_from",
  "subagent_of",
  "compacted_into",
  "artifact_of",
]);

export const upsertSessionGraphRows = async (
  ctx: MutationCtx,
  state: SessionIngestState,
) => {
  await upsertContentBlocks(ctx, state);
  await upsertSessionEdges(ctx, state);
  await upsertUsageRecords(ctx, state);
  await upsertArtifacts(ctx, state);
};

const upsertContentBlocks = async (
  ctx: MutationCtx,
  state: SessionIngestState,
) => {
  for (const event of state.events) {
    const eventId = String(event.id ?? "");
    if (eventId.length === 0) continue;
    const blocks = state.contentBlocksByEvent.get(eventId) ?? [];
    for (const [index, block] of blocks.entries()) {
      await upsertContentBlock(ctx, state, event, block, index);
    }
  }
};

const upsertContentBlock = async (
  ctx: MutationCtx,
  state: SessionIngestState,
  event: Record<string, unknown>,
  block: Record<string, unknown>,
  fallbackSequence: number,
) => {
  const eventId = String(event.id ?? "");
  const sequence = numberValue(block.sequence) ?? fallbackSequence;
  const blockId = stringValue(block.id) ?? graphScopedId(state, "block", eventId, sequence, block.kind);
  state.keepContentBlockIds.add(blockId);
  const safeBlock = redactSensitive(block) as Record<string, unknown>;
  const patch = {
    blockId,
    eventId,
    sessionId: state.sessionId,
    sequence,
    machineId: state.sessionPatch.machineId,
    provider: state.providerValue as never,
    agentName: state.agentName,
    projectIdentityKey: state.sessionPatch.projectIdentityKey,
    canonicalProjectIdentityKey: state.canonicalProjectIdentityKey,
    kind: blockKind(block.kind) as never,
    text: stringValue(safeBlock.text),
    markdown: stringValue(safeBlock.markdown),
    thinking: stringValue(safeBlock.thinking),
    path: stringValue(safeBlock.path),
    uri: stringValue(safeBlock.uri),
    mediaType: stringValue(safeBlock.mediaType),
    value: safeBlock.value,
    metadata: safeBlock.metadata,
    importRunId: state.batch.importRunId,
    updatedAt: state.batch.now,
  };
  const existing = await ctx.db
    .query("contentBlocks")
    .withIndex("by_blockId", (q) => q.eq("blockId", blockId))
    .unique();
  if (existing === null) await ctx.db.insert("contentBlocks", { ...patch, createdAt: state.batch.now });
  else await ctx.db.patch(existing._id, patch);
  await upsertSearchDocument(ctx, contentBlockSearchDocument(state, event, patch, safeBlock));
};

const contentBlockSearchDocument = (
  state: SessionIngestState,
  event: Record<string, unknown>,
  blockPatch: {
    blockId: string;
    eventId: string;
    sequence: number;
    kind: string;
    text?: string;
    markdown?: string;
    thinking?: string;
    path?: string;
    uri?: string;
    value?: unknown;
    metadata?: unknown;
  },
  safeBlock: Record<string, unknown>,
): SearchDocumentUpsertInput => {
  const blockText = blockSearchText(blockPatch, safeBlock);
  const summary = safeSummary(blockText, safeBlock);
  return {
    searchDocumentId: `block:${blockPatch.blockId}`,
    sourceTable: "contentBlocks",
    sourceId: blockPatch.blockId,
    family: "contentBlocks",
    projectIdentityKey: state.sessionPatch.projectIdentityKey,
    canonicalProjectIdentityKey: state.canonicalProjectIdentityKey,
    machineId: state.sessionPatch.machineId,
    provider: state.providerValue as never,
    agentName: state.agentName,
    role: event.role as never,
    kind: event.kind as never,
    title: `${state.providerValue} ${blockPatch.kind} block`,
    summary,
    searchText: compactSearchText([blockPatch.kind, blockText, safeBlock.value, safeBlock.metadata]),
    sourcePath: stringValue(blockPatch.path) ?? eventSourcePath(event, state.sessionPatch.sourcePath),
    sourceRef: {
      sessionId: state.sessionId,
      eventId: blockPatch.eventId,
      blockId: blockPatch.blockId,
      sequence: blockPatch.sequence,
    },
    occurredAt: dateMillis(stringValue(event.timestamp)),
    activeProject: "",
    activeMachine: "",
    activeProvider: "",
    activeKind: "",
    sourceUpdatedAt: state.batch.now,
  };
};

const blockSearchText = (
  blockPatch: {
    text?: string;
    markdown?: string;
    thinking?: string;
    path?: string;
    uri?: string;
  },
  safeBlock: Record<string, unknown>,
) =>
  compactSearchText([
    blockPatch.text,
    blockPatch.markdown,
    blockPatch.thinking,
    blockPatch.path,
    blockPatch.uri,
    safeBlock.value,
  ]);

const upsertSessionEdges = async (
  ctx: MutationCtx,
  state: SessionIngestState,
) => {
  for (const [index, edge] of state.sessionEdges.entries()) {
    const edgeId =
      stringValue(edge.id) ??
      graphScopedId(
        state,
        "edge",
        edge.kind,
        edge.fromEventId,
        edge.toEventId,
        edge.fromId,
        edge.toId,
        index,
      );
    state.keepSessionEdgeIds.add(edgeId);
    const safeEdge = redactSensitive(edge) as Record<string, unknown>;
    const patch = {
      edgeId,
      sessionId: state.sessionId,
      machineId: state.sessionPatch.machineId,
      provider: state.providerValue as never,
      agentName: state.agentName,
      projectIdentityKey: state.sessionPatch.projectIdentityKey,
      canonicalProjectIdentityKey: state.canonicalProjectIdentityKey,
      kind: edgeKind(edge.kind) as never,
      fromEventId: stringValue(safeEdge.fromEventId),
      toEventId: stringValue(safeEdge.toEventId),
      fromId: stringValue(safeEdge.fromId),
      toId: stringValue(safeEdge.toId),
      rawReference: safeEdge.rawReference,
      metadata: safeEdge.metadata,
      importRunId: state.batch.importRunId,
      updatedAt: state.batch.now,
    };
    const existing = await ctx.db
      .query("sessionEdges")
      .withIndex("by_edgeId", (q) => q.eq("edgeId", edgeId))
      .unique();
    if (existing === null) await ctx.db.insert("sessionEdges", { ...patch, createdAt: state.batch.now });
    else await ctx.db.patch(existing._id, patch);
  }
};

const upsertUsageRecords = async (
  ctx: MutationCtx,
  state: SessionIngestState,
) => {
  for (const [index, usageRecord] of state.usageRecords.entries()) {
    const usageId =
      stringValue(usageRecord.id) ??
      graphScopedId(state, "usage", usageRecord.eventId, usageRecord.timestamp, index);
    state.keepUsageRecordIds.add(usageId);
    const safeUsageRecord = redactSensitive(usageRecord) as Record<string, unknown>;
    const patch = {
      usageId,
      sessionId: state.sessionId,
      eventId: stringValue(safeUsageRecord.eventId),
      machineId: state.sessionPatch.machineId,
      provider: state.providerValue as never,
      agentName: state.agentName,
      projectIdentityKey: state.sessionPatch.projectIdentityKey,
      canonicalProjectIdentityKey: state.canonicalProjectIdentityKey,
      timestamp: stringValue(safeUsageRecord.timestamp),
      model: stringValue(safeUsageRecord.model),
      modelProvider: stringValue(safeUsageRecord.modelProvider),
      inputTokens: numberValue(safeUsageRecord.inputTokens),
      outputTokens: numberValue(safeUsageRecord.outputTokens),
      reasoningTokens: numberValue(safeUsageRecord.reasoningTokens),
      cacheCreationInputTokens: numberValue(safeUsageRecord.cacheCreationInputTokens),
      cacheReadInputTokens: numberValue(safeUsageRecord.cacheReadInputTokens),
      totalTokens: numberValue(safeUsageRecord.totalTokens),
      cost: numberValue(safeUsageRecord.cost),
      currency: stringValue(safeUsageRecord.currency),
      raw: safeUsageRecord.raw,
      importRunId: state.batch.importRunId,
      updatedAt: state.batch.now,
    };
    const existing = await ctx.db
      .query("usageRecords")
      .withIndex("by_usageId", (q) => q.eq("usageId", usageId))
      .unique();
    if (existing === null) await ctx.db.insert("usageRecords", { ...patch, createdAt: state.batch.now });
    else await ctx.db.patch(existing._id, patch);
  }
};

const upsertArtifacts = async (
  ctx: MutationCtx,
  state: SessionIngestState,
) => {
  for (const [index, artifact] of state.artifacts.entries()) {
    const artifactId =
      stringValue(artifact.id) ??
      graphScopedId(state, "artifact", artifact.eventId, artifact.kind, artifact.path, artifact.uri, index);
    state.keepArtifactIds.add(artifactId);
    const safeArtifact = redactSensitive(artifact) as Record<string, unknown>;
    const patch = {
      artifactId,
      sessionId: state.sessionId,
      eventId: stringValue(safeArtifact.eventId),
      machineId: state.sessionPatch.machineId,
      provider: state.providerValue as never,
      agentName: state.agentName,
      projectIdentityKey: state.sessionPatch.projectIdentityKey,
      canonicalProjectIdentityKey: state.canonicalProjectIdentityKey,
      kind: stringValue(safeArtifact.kind) ?? "artifact",
      path: stringValue(safeArtifact.path),
      uri: stringValue(safeArtifact.uri),
      contentHash: stringValue(safeArtifact.contentHash),
      sourcePath: stringValue(safeArtifact.sourcePath),
      sourceRef: safeArtifact.sourceRef,
      metadata: safeArtifact.metadata,
      raw: safeArtifact.raw,
      importRunId: state.batch.importRunId,
      updatedAt: state.batch.now,
    };
    const existing = await ctx.db
      .query("artifacts")
      .withIndex("by_artifactId", (q) => q.eq("artifactId", artifactId))
      .unique();
    if (existing === null) await ctx.db.insert("artifacts", { ...patch, createdAt: state.batch.now });
    else await ctx.db.patch(existing._id, patch);
    await upsertSearchDocument(ctx, artifactSearchDocument(state, patch, safeArtifact));
  }
};

const artifactSearchDocument = (
  state: SessionIngestState,
  artifactPatch: {
    artifactId: string;
    eventId?: string;
    kind: string;
    path?: string;
    uri?: string;
    contentHash?: string;
    sourcePath?: string;
    sourceRef?: unknown;
    metadata?: unknown;
    raw?: unknown;
  },
  safeArtifact: Record<string, unknown>,
): SearchDocumentUpsertInput => ({
  searchDocumentId: `artifact:${artifactPatch.artifactId}`,
  sourceTable: "artifacts",
  sourceId: artifactPatch.artifactId,
  family: "artifacts",
  projectIdentityKey: state.sessionPatch.projectIdentityKey,
  canonicalProjectIdentityKey: state.canonicalProjectIdentityKey,
  machineId: state.sessionPatch.machineId,
  provider: state.providerValue as never,
  agentName: state.agentName,
  title: artifactPatch.kind,
  summary: compactSearchText([artifactPatch.path, artifactPatch.uri, artifactPatch.contentHash]),
  searchText: compactSearchText([
    artifactPatch.kind,
    artifactPatch.path,
    artifactPatch.uri,
    artifactPatch.contentHash,
    artifactPatch.sourceRef,
    artifactPatch.metadata,
    safeArtifact.raw,
  ]),
  sourcePath: artifactPatch.sourcePath ?? artifactPatch.path ?? state.sessionPatch.sourcePath,
  sourceRef: {
    sessionId: state.sessionId,
    eventId: artifactPatch.eventId,
    artifactId: artifactPatch.artifactId,
    sourceRef: artifactPatch.sourceRef,
  },
  occurredAt: artifactEventMillis(state, artifactPatch.eventId),
  activeProject: "",
  activeMachine: "",
  activeProvider: "",
  sourceUpdatedAt: state.batch.now,
});

export const cleanupMissingGraphRows = async (
  ctx: MutationCtx,
  state: SessionIngestState,
) => {
  await cleanupMissingContentBlocks(ctx, state);
  await cleanupMissingEdges(ctx, state);
  await cleanupMissingUsage(ctx, state);
  await cleanupMissingArtifacts(ctx, state);
};

const cleanupMissingContentBlocks = async (ctx: MutationCtx, state: SessionIngestState) => {
  const rows = await ctx.db
    .query("contentBlocks")
    .withIndex("by_session_sequence", (q) => q.eq("sessionId", state.sessionId))
    .collect();
  for (const row of rows) {
    if (state.keepContentBlockIds.has(row.blockId)) continue;
    await deleteSearchDocumentById(ctx, `block:${row.blockId}`);
    await ctx.db.delete(row._id);
  }
};

const cleanupMissingEdges = async (ctx: MutationCtx, state: SessionIngestState) => {
  const rows = await ctx.db
    .query("sessionEdges")
    .withIndex("by_sessionId", (q) => q.eq("sessionId", state.sessionId))
    .collect();
  for (const row of rows) {
    if (state.keepSessionEdgeIds.has(row.edgeId)) continue;
    await ctx.db.delete(row._id);
  }
};

const cleanupMissingUsage = async (ctx: MutationCtx, state: SessionIngestState) => {
  const rows = await ctx.db
    .query("usageRecords")
    .withIndex("by_sessionId", (q) => q.eq("sessionId", state.sessionId))
    .collect();
  for (const row of rows) {
    if (state.keepUsageRecordIds.has(row.usageId)) continue;
    await ctx.db.delete(row._id);
  }
};

const cleanupMissingArtifacts = async (ctx: MutationCtx, state: SessionIngestState) => {
  const rows = await ctx.db
    .query("artifacts")
    .withIndex("by_sessionId", (q) => q.eq("sessionId", state.sessionId))
    .collect();
  for (const row of rows) {
    if (state.keepArtifactIds.has(row.artifactId)) continue;
    await deleteSearchDocumentById(ctx, `artifact:${row.artifactId}`);
    await ctx.db.delete(row._id);
  }
};

const graphScopedId = (
  state: SessionIngestState,
  kind: string,
  ...parts: unknown[]
) => `${state.providerValue}:${kind}:${wideHash(JSON.stringify([state.sessionId, state.sessionPatch.sourcePath, ...parts]))}`;

const blockKind = (value: unknown) => {
  const kind = stringValue(value);
  return kind !== undefined && contentBlockKinds.has(kind) ? kind : "json";
};

const edgeKind = (value: unknown) => {
  const kind = stringValue(value);
  return kind !== undefined && sessionEdgeKinds.has(kind) ? kind : "next";
};

const eventSourcePath = (event: Record<string, unknown>, fallback: string) => {
  const rawReference =
    event.rawReference !== null && typeof event.rawReference === "object"
      ? (event.rawReference as Record<string, unknown>)
      : {};
  return stringValue(rawReference.sourcePath) ?? fallback;
};

const artifactEventMillis = (state: SessionIngestState, eventId: string | undefined) => {
  if (eventId === undefined) return undefined;
  const event = state.events.find((row) => row.id === eventId);
  return event === undefined ? undefined : dateMillis(stringValue(event.timestamp));
};

const stringValue = (value: unknown) =>
  typeof value === "string" && value.length > 0 ? value : undefined;

const numberValue = (value: unknown) =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;
