import { Effect } from "effect";
import {
  decodeRecordEnvelope,
  recordContentHash,
  recordId,
  RECORD_LIMITS,
  RECORD_PROTOCOL,
  type IngestRecord,
  type IngestRecordsResponse,
  type RecordEnvelope,
  type TombstoneRecordType,
} from "@skastr0/quasar-core/records";

import type { MutationCtx } from "./_generated/server";
import {
  ensureAgent,
  ensureMachine,
  upsertProjectIdentity,
} from "./quasarProjectHandlers";
import {
  deleteSearchDocumentById,
  upsertSearchDocument,
} from "./quasarSearchDocuments";
import type { SearchDocumentUpsertInput } from "./quasarSearchTypes";
import { compactSearchText, safeSummary } from "./quasarText";
import { dateMillis } from "./quasarValues";

const BACKPRESSURE_OUTBOX_LIMIT = 500;
const BACKPRESSURE_RETRY_AFTER_MS = 5_000;

type LiveRecord = Exclude<IngestRecord, { type: "tombstone" }>;
type LiveRecordType = LiveRecord["type"];
type SearchableRecordType = "session" | "event" | "tool_call";
type ApplyStatus = "applied" | "unchanged" | "tombstoned";
type IndexedRecordTable =
  | "recordStates"
  | "tombstones"
  | "sessions"
  | "sessionEvents"
  | "contentBlocks"
  | "toolCalls"
  | "usageRecords"
  | "artifacts"
  | "sessionEdges"
  | "sourceRoots";

type IndexedDb = {
  query: (table: IndexedRecordTable) => {
    withIndex: (
      indexName: string,
      byIndex: (q: { eq: (field: string, value: string) => unknown }) => unknown,
    ) => { unique: () => Promise<{ _id: unknown } | null> };
  };
  insert: (table: IndexedRecordTable, doc: Record<string, unknown>) => Promise<unknown>;
  patch: (id: unknown, patch: Record<string, unknown>) => Promise<unknown>;
};

const indexedDb = (ctx: MutationCtx) => ctx.db as unknown as IndexedDb;

export const applyRecordEnvelopeHandler = async (
  ctx: MutationCtx,
  input: unknown,
): Promise<IngestRecordsResponse> => {
  const envelope = await decodeEnvelope(input);

  await ensureMachine(ctx, envelope.machine);

  let applied = 0;
  let unchanged = 0;
  let tombstoned = 0;
  for (const item of envelope.records) {
    const status = await applyEnvelopeRecord(ctx, envelope, item);
    if (status === "applied") applied += 1;
    if (status === "unchanged") unchanged += 1;
    if (status === "tombstoned") tombstoned += 1;
  }

  return response(applied, unchanged, tombstoned, await readRecordBackpressure(ctx));
};

const decodeEnvelope = async (input: unknown) => {
  try {
    return await Effect.runPromise(decodeRecordEnvelope(input, RECORD_LIMITS));
  } catch (error) {
    throw new Error(error instanceof Error ? error.message : String(error));
  }
};

const response = (
  applied: number,
  unchanged: number,
  tombstoned: number,
  backpressure: IngestRecordsResponse["backpressure"],
): IngestRecordsResponse => ({
  protocol: RECORD_PROTOCOL,
  applied,
  unchanged,
  tombstoned,
  backpressure,
  limits: RECORD_LIMITS,
});

const readRecordBackpressure = async (
  ctx: MutationCtx,
): Promise<IngestRecordsResponse["backpressure"]> => {
  const outboxDepth = await activeOutboxDepth(ctx, BACKPRESSURE_OUTBOX_LIMIT + 1);
  return {
    outboxDepth,
    retryAfterMs:
      outboxDepth > BACKPRESSURE_OUTBOX_LIMIT ? BACKPRESSURE_RETRY_AFTER_MS : 0,
  };
};

const activeOutboxDepth = async (ctx: MutationCtx, limit: number) => {
  let count = 0;
  for (const status of ["pending", "syncing", "failed"] as const) {
    if (count >= limit) break;
    const entries = await ctx.db
      .query("embeddingOutbox")
      .withIndex("by_status_nextAttempt", (q) => q.eq("status", status))
      .take(limit - count);
    count += entries.length;
  }
  return count;
};

const upsertDocument = async (
  ctx: MutationCtx,
  table: IndexedRecordTable,
  existingId: unknown | null,
  patch: Record<string, unknown>,
  now: number,
) => {
  const db = indexedDb(ctx);
  if (existingId === null) {
    await db.insert(table, { ...patch, createdAt: now });
  } else {
    await db.patch(existingId, patch);
  }
};

const upsertByIndex = async (
  ctx: MutationCtx,
  table: IndexedRecordTable,
  indexName: string,
  idField: string,
  id: string,
  patch: Record<string, unknown>,
  now: number,
) => {
  const existing = await indexedDb(ctx)
    .query(table)
    .withIndex(indexName, (q) => q.eq(idField, id))
    .unique();
  await upsertDocument(ctx, table, existing?._id ?? null, patch, now);
};

const applyEnvelopeRecord = async (
  ctx: MutationCtx,
  envelope: RecordEnvelope,
  item: IngestRecord,
): Promise<ApplyStatus> =>
  item.type === "tombstone"
    ? await applyTombstoneRecord(ctx, envelope, item)
    : await applyLiveRecord(ctx, envelope, item);

const applyLiveRecord = async (
  ctx: MutationCtx,
  envelope: RecordEnvelope,
  item: LiveRecord,
): Promise<ApplyStatus> => {
  const id = recordId(item);
  const key = recordStateKey(item.type, id);
  const contentHash = recordContentHash(item, RECORD_LIMITS);
  const state = await findRecordState(ctx, key);
  if (state !== null && state.contentHash === contentHash && state.tombstoned === false) {
    return "unchanged";
  }

  const now = Date.now();
  await upsertLiveRecord(ctx, item, now);
  await clearTombstone(ctx, key);
  await upsertRecordState(ctx, {
    recordKey: key,
    recordType: item.type,
    recordId: id,
    machineId: machineIdForLiveRecord(item) ?? envelope.machine.machineId,
    contentHash,
    tombstoned: false,
    now,
  });
  return "applied";
};

const applyTombstoneRecord = async (
  ctx: MutationCtx,
  envelope: RecordEnvelope,
  item: Extract<IngestRecord, { type: "tombstone" }>,
): Promise<ApplyStatus> => {
  const key = recordStateKey(item.record.recordType, item.record.recordId);
  const contentHash = recordContentHash(item, RECORD_LIMITS);
  const state = await findRecordState(ctx, key);
  const tombstone = await findTombstone(ctx, key);
  if (
    state !== null &&
    state.contentHash === contentHash &&
    state.tombstoned === true &&
    tombstone !== null
  ) {
    return "unchanged";
  }

  const now = Date.now();
  await deleteSourceRecord(ctx, item.record.recordType, item.record.recordId);
  await deleteSearchDocumentForRecord(ctx, item.record.recordType, item.record.recordId);
  await upsertTombstone(ctx, {
    recordKey: key,
    recordType: item.record.recordType,
    recordId: item.record.recordId,
    machineId: envelope.machine.machineId,
    contentHash,
    now,
  });
  await upsertRecordState(ctx, {
    recordKey: key,
    recordType: item.record.recordType,
    recordId: item.record.recordId,
    machineId: envelope.machine.machineId,
    contentHash,
    tombstoned: true,
    now,
  });
  return "tombstoned";
};

export const recordStateKey = (recordType: LiveRecordType, id: string) =>
  `${recordType}:${id}`;

const findRecordState = async (ctx: MutationCtx, recordKey: string) =>
  await ctx.db
    .query("recordStates")
    .withIndex("by_recordKey", (q) => q.eq("recordKey", recordKey))
    .unique();

const upsertRecordState = async (
  ctx: MutationCtx,
  input: {
    recordKey: string;
    recordType: LiveRecordType;
    recordId: string;
    machineId: string;
    contentHash: string;
    tombstoned: boolean;
    now: number;
  },
) => {
  const patch = {
    recordKey: input.recordKey,
    recordType: input.recordType,
    recordId: input.recordId,
    machineId: input.machineId,
    contentHash: input.contentHash,
    tombstoned: input.tombstoned,
    lastSeenAt: input.now,
    updatedAt: input.now,
  };
  await upsertByIndex(ctx, "recordStates", "by_recordKey", "recordKey", input.recordKey, patch, input.now);
};

const findTombstone = async (ctx: MutationCtx, recordKey: string) =>
  await ctx.db
    .query("tombstones")
    .withIndex("by_recordKey", (q) => q.eq("recordKey", recordKey))
    .unique();

const upsertTombstone = async (
  ctx: MutationCtx,
  input: {
    recordKey: string;
    recordType: TombstoneRecordType;
    recordId: string;
    machineId: string;
    contentHash: string;
    now: number;
  },
) => {
  const patch = {
    recordKey: input.recordKey,
    recordType: input.recordType,
    recordId: input.recordId,
    machineId: input.machineId,
    contentHash: input.contentHash,
    updatedAt: input.now,
  };
  await upsertByIndex(ctx, "tombstones", "by_recordKey", "recordKey", input.recordKey, patch, input.now);
};

const clearTombstone = async (ctx: MutationCtx, recordKey: string) => {
  const existing = await findTombstone(ctx, recordKey);
  if (existing !== null) await ctx.db.delete(existing._id);
};

const upsertLiveRecord = async (
  ctx: MutationCtx,
  item: LiveRecord,
  now: number,
) => {
  switch (item.type) {
    case "session":
      return await upsertSessionRecord(ctx, item.record, now);
    case "event":
      return await upsertEventRecord(ctx, item.record, now);
    case "content_block":
      return await upsertContentBlockRecord(ctx, item.record, now);
    case "tool_call":
      return await upsertToolCallRecord(ctx, item.record, now);
    case "usage":
      return await upsertUsageRecord(ctx, item.record, now);
    case "artifact":
      return await upsertArtifactRecord(ctx, item.record, now);
    case "edge":
      return await upsertEdgeRecord(ctx, item.record, now);
    case "source_root":
      return await upsertSourceRootRecord(ctx, item.record, now);
  }
};

const upsertSessionRecord = async (
  ctx: MutationCtx,
  record: Extract<LiveRecord, { type: "session" }>["record"],
  now: number,
) => {
  await ensureMachine(ctx, { machineId: record.machineId });
  await ensureAgent(ctx, record.provider, record.agentName);
  const canonicalProjectIdentityKey = await upsertProjectIdentity(ctx, record.projectIdentity);
  const patch = {
    sessionId: record.id,
    nativeSessionId: record.nativeSessionId,
    provider: record.provider,
    agentName: record.agentName,
    machineId: record.machineId,
    projectIdentityKey: record.projectIdentity.projectIdentityKey,
    canonicalProjectIdentityKey,
    nativeProjectKey: record.nativeProjectKey,
    title: record.title,
    startedAt: record.startedAt,
    updatedAtNative: record.updatedAt,
    sourceRoot: record.sourceRoot,
    sourcePath: record.sourcePath,
    eventCount: record.eventCount,
    toolCallCount: record.toolCallCount,
    updatedAt: now,
  };
  await upsertByIndex(ctx, "sessions", "by_sessionId", "sessionId", record.id, patch, now);
  await upsertSearchDocument(ctx, sessionSearchDocument(record, canonicalProjectIdentityKey, now));
};

const upsertEventRecord = async (
  ctx: MutationCtx,
  record: Extract<LiveRecord, { type: "event" }>["record"],
  now: number,
) => {
  await ensureMachine(ctx, { machineId: record.machineId });
  await ensureAgent(ctx, record.provider, record.agentName);
  const canonicalProjectIdentityKey = await ensureProjectKey(ctx, record.projectIdentityKey);
  const patch = {
    eventId: record.id,
    sessionId: record.sessionId,
    nativeEventId: record.nativeEventId,
    sequence: record.sequence,
    timestamp: record.timestamp,
    machineId: record.machineId,
    provider: record.provider,
    agentName: record.agentName,
    projectIdentityKey: record.projectIdentityKey,
    canonicalProjectIdentityKey,
    role: record.role,
    kind: record.kind,
    contentText: record.contentText,
    toolCallId: record.toolCallId,
    parentEventId: record.parentEventId,
    rawReference: record.rawReference,
    updatedAt: now,
  };
  await upsertByIndex(ctx, "sessionEvents", "by_eventId", "eventId", record.id, patch, now);
  await upsertSearchDocument(ctx, eventSearchDocument(record, canonicalProjectIdentityKey, now));
};

const upsertContentBlockRecord = async (
  ctx: MutationCtx,
  record: Extract<LiveRecord, { type: "content_block" }>["record"],
  now: number,
) => {
  await ensureMachine(ctx, { machineId: record.machineId });
  await ensureAgent(ctx, record.provider, record.agentName);
  const canonicalProjectIdentityKey = await ensureProjectKey(ctx, record.projectIdentityKey);
  const patch = {
    blockId: record.id,
    eventId: record.eventId,
    sessionId: record.sessionId,
    sequence: record.sequence,
    machineId: record.machineId,
    provider: record.provider,
    agentName: record.agentName,
    projectIdentityKey: record.projectIdentityKey,
    canonicalProjectIdentityKey,
    kind: record.kind,
    text: record.text,
    markdown: record.markdown,
    thinking: record.thinking,
    path: record.path,
    uri: record.uri,
    mediaType: record.mediaType,
    value: record.value,
    metadata: record.metadata,
    updatedAt: now,
  };
  await upsertByIndex(ctx, "contentBlocks", "by_blockId", "blockId", record.id, patch, now);
};

const upsertToolCallRecord = async (
  ctx: MutationCtx,
  record: Extract<LiveRecord, { type: "tool_call" }>["record"],
  now: number,
) => {
  await ensureMachine(ctx, { machineId: record.machineId });
  await ensureAgent(ctx, record.provider, record.agentName);
  const canonicalProjectIdentityKey = await ensureProjectKey(ctx, record.projectIdentityKey);
  const patch = {
    toolCallId: record.id,
    sessionId: record.sessionId,
    eventId: record.eventId,
    machineId: record.machineId,
    provider: record.provider,
    agentName: record.agentName,
    projectIdentityKey: record.projectIdentityKey,
    canonicalProjectIdentityKey,
    toolName: record.toolName,
    status: record.status,
    input: record.input,
    output: record.output,
    startedAt: record.startedAt,
    completedAt: record.completedAt,
    updatedAt: now,
  };
  await upsertByIndex(ctx, "toolCalls", "by_toolCallId", "toolCallId", record.id, patch, now);
  await upsertSearchDocument(ctx, toolCallSearchDocument(record, canonicalProjectIdentityKey, now));
};

const upsertUsageRecord = async (
  ctx: MutationCtx,
  record: Extract<LiveRecord, { type: "usage" }>["record"],
  now: number,
) => {
  await ensureMachine(ctx, { machineId: record.machineId });
  await ensureAgent(ctx, record.provider, record.agentName);
  const canonicalProjectIdentityKey = await ensureProjectKey(ctx, record.projectIdentityKey);
  const patch = {
    usageId: record.id,
    sessionId: record.sessionId,
    eventId: record.eventId,
    machineId: record.machineId,
    provider: record.provider,
    agentName: record.agentName,
    projectIdentityKey: record.projectIdentityKey,
    canonicalProjectIdentityKey,
    timestamp: record.timestamp,
    model: record.model,
    modelProvider: record.modelProvider,
    inputTokens: record.inputTokens,
    outputTokens: record.outputTokens,
    reasoningTokens: record.reasoningTokens,
    cacheCreationInputTokens: record.cacheCreationInputTokens,
    cacheReadInputTokens: record.cacheReadInputTokens,
    totalTokens: record.totalTokens,
    cost: record.cost,
    currency: record.currency,
    updatedAt: now,
  };
  await upsertByIndex(ctx, "usageRecords", "by_usageId", "usageId", record.id, patch, now);
};

const upsertArtifactRecord = async (
  ctx: MutationCtx,
  record: Extract<LiveRecord, { type: "artifact" }>["record"],
  now: number,
) => {
  await ensureMachine(ctx, { machineId: record.machineId });
  await ensureAgent(ctx, record.provider, record.agentName);
  const canonicalProjectIdentityKey = await ensureProjectKey(ctx, record.projectIdentityKey);
  const patch = {
    artifactId: record.id,
    sessionId: record.sessionId,
    eventId: record.eventId,
    machineId: record.machineId,
    provider: record.provider,
    agentName: record.agentName,
    projectIdentityKey: record.projectIdentityKey,
    canonicalProjectIdentityKey,
    kind: record.kind,
    path: record.path,
    uri: record.uri,
    contentHash: record.contentHash,
    sourcePath: record.sourcePath,
    sourceRef: record.sourceRef,
    metadata: record.metadata,
    updatedAt: now,
  };
  await upsertByIndex(ctx, "artifacts", "by_artifactId", "artifactId", record.id, patch, now);
};

const upsertEdgeRecord = async (
  ctx: MutationCtx,
  record: Extract<LiveRecord, { type: "edge" }>["record"],
  now: number,
) => {
  await ensureMachine(ctx, { machineId: record.machineId });
  await ensureAgent(ctx, record.provider, record.agentName);
  const canonicalProjectIdentityKey = await ensureProjectKey(ctx, record.projectIdentityKey);
  const patch = {
    edgeId: record.id,
    sessionId: record.sessionId,
    machineId: record.machineId,
    provider: record.provider,
    agentName: record.agentName,
    projectIdentityKey: record.projectIdentityKey,
    canonicalProjectIdentityKey,
    kind: record.kind,
    fromEventId: record.fromEventId,
    toEventId: record.toEventId,
    fromId: record.fromId,
    toId: record.toId,
    rawReference: record.rawReference,
    metadata: record.metadata,
    updatedAt: now,
  };
  await upsertByIndex(ctx, "sessionEdges", "by_edgeId", "edgeId", record.id, patch, now);
};

const upsertSourceRootRecord = async (
  ctx: MutationCtx,
  record: Extract<LiveRecord, { type: "source_root" }>["record"],
  now: number,
) => {
  await ensureMachine(ctx, { machineId: record.machineId });
  const sourceRootId = recordId({ type: "source_root", record });
  const existing =
    (await ctx.db
      .query("sourceRoots")
      .withIndex("by_sourceRootId", (q) => q.eq("sourceRootId", sourceRootId))
      .unique()) ??
    (await ctx.db
      .query("sourceRoots")
      .withIndex("by_machine_provider_root", (q) =>
        q
          .eq("machineId", record.machineId)
          .eq("provider", record.provider)
          .eq("rootPath", record.rootPath),
      )
      .unique());
  const patch = {
    sourceRootId,
    provider: record.provider,
    adapterId: record.adapterId,
    rootPath: record.rootPath,
    machineId: record.machineId,
    discoveredAt: record.discoveredAt,
    updatedAt: now,
  };
  await upsertDocument(ctx, "sourceRoots", existing?._id ?? null, patch, now);
};

const ensureProjectKey = async (ctx: MutationCtx, projectIdentityKey: string) => {
  const existing = await ctx.db
    .query("projectIdentities")
    .withIndex("by_projectIdentityKey", (q) => q.eq("projectIdentityKey", projectIdentityKey))
    .unique();
  if (existing !== null) return existing.canonicalProjectIdentityKey;
  return await upsertProjectIdentity(ctx, {
    projectIdentityKey,
    displayName: projectIdentityKey,
    confidence: "low",
    signals: [],
  });
};

const sessionSearchDocument = (
  record: Extract<LiveRecord, { type: "session" }>["record"],
  canonicalProjectIdentityKey: string,
  now: number,
): SearchDocumentUpsertInput => ({
  searchDocumentId: searchDocumentIdForRecord("session", record.id),
  sourceTable: "sessions",
  sourceId: record.id,
  family: "sessions",
  projectIdentityKey: record.projectIdentity.projectIdentityKey,
  canonicalProjectIdentityKey,
  machineId: record.machineId,
  provider: record.provider,
  agentName: record.agentName,
  title: titleFrom(record.title, record.nativeSessionId, record.id),
  summary: safeSummary(record.projectIdentity.displayName, record.sourcePath),
  searchText: compactSearchText({
    title: record.title,
    nativeSessionId: record.nativeSessionId,
    project: record.projectIdentity,
    sourcePath: record.sourcePath,
    startedAt: record.startedAt,
    updatedAt: record.updatedAt,
  }),
  sourcePath: record.sourcePath,
  sourceRef: { sessionId: record.id, nativeSessionId: record.nativeSessionId },
  occurredAt: dateMillis(record.startedAt ?? record.updatedAt),
  sourceUpdatedAt: dateMillis(record.updatedAt) ?? now,
});

const eventSearchDocument = (
  record: Extract<LiveRecord, { type: "event" }>["record"],
  canonicalProjectIdentityKey: string,
  now: number,
): SearchDocumentUpsertInput => ({
  searchDocumentId: searchDocumentIdForRecord("event", record.id),
  sourceTable: "sessionEvents",
  sourceId: record.id,
  family: "sessionEvents",
  projectIdentityKey: record.projectIdentityKey,
  canonicalProjectIdentityKey,
  machineId: record.machineId,
  provider: record.provider,
  agentName: record.agentName,
  role: record.role,
  kind: record.kind,
  title: titleFrom(record.contentText, `${record.role} ${record.kind}`, record.id),
  summary: safeSummary(record.contentText, record.rawReference),
  searchText: compactSearchText({
    role: record.role,
    kind: record.kind,
    contentText: record.contentText,
    toolCallId: record.toolCallId,
    rawReference: record.rawReference,
  }),
  sourcePath: record.rawReference.sourcePath,
  sourceRef: record.rawReference,
  occurredAt: dateMillis(record.timestamp),
  sourceUpdatedAt: dateMillis(record.timestamp) ?? now,
});

const toolCallSearchDocument = (
  record: Extract<LiveRecord, { type: "tool_call" }>["record"],
  canonicalProjectIdentityKey: string,
  now: number,
): SearchDocumentUpsertInput => ({
  searchDocumentId: searchDocumentIdForRecord("tool_call", record.id),
  sourceTable: "toolCalls",
  sourceId: record.id,
  family: "toolCalls",
  projectIdentityKey: record.projectIdentityKey,
  canonicalProjectIdentityKey,
  machineId: record.machineId,
  provider: record.provider,
  agentName: record.agentName,
  kind: "tool_call",
  toolName: record.toolName,
  title: titleFrom(record.toolName, record.id),
  summary: safeSummary(record.status, record.output ?? record.input),
  searchText: compactSearchText({
    toolName: record.toolName,
    status: record.status,
    input: record.input,
    output: record.output,
  }),
  sourceRef: { eventId: record.eventId, sessionId: record.sessionId, toolCallId: record.id },
  occurredAt: dateMillis(record.startedAt ?? record.completedAt),
  sourceUpdatedAt: dateMillis(record.completedAt ?? record.startedAt) ?? now,
});

const searchDocumentIdForRecord = (recordType: SearchableRecordType, id: string) => {
  switch (recordType) {
    case "session":
      return `session:${id}`;
    case "event":
      return `event:${id}`;
    case "tool_call":
      return `tool_call:${id}`;
  }
};

const deleteSearchDocumentForRecord = async (
  ctx: MutationCtx,
  recordType: TombstoneRecordType,
  id: string,
) => {
  const searchDocumentId = searchDocumentIdForTombstone(recordType, id);
  if (searchDocumentId !== undefined) await deleteSearchDocumentById(ctx, searchDocumentId);
};

const searchDocumentIdForTombstone = (recordType: TombstoneRecordType, id: string) => {
  switch (recordType) {
    case "session":
    case "event":
    case "tool_call":
      return searchDocumentIdForRecord(recordType, id);
    case "content_block":
    case "usage":
    case "artifact":
    case "edge":
    case "source_root":
      return undefined;
  }
};

const deleteSourceRecord = async (
  ctx: MutationCtx,
  recordType: TombstoneRecordType,
  id: string,
) => {
  switch (recordType) {
    case "session": {
      const doc = await ctx.db
        .query("sessions")
        .withIndex("by_sessionId", (q) => q.eq("sessionId", id))
        .unique();
      if (doc !== null) await ctx.db.delete(doc._id);
      return;
    }
    case "event": {
      const doc = await ctx.db
        .query("sessionEvents")
        .withIndex("by_eventId", (q) => q.eq("eventId", id))
        .unique();
      if (doc !== null) await ctx.db.delete(doc._id);
      return;
    }
    case "content_block": {
      const doc = await ctx.db
        .query("contentBlocks")
        .withIndex("by_blockId", (q) => q.eq("blockId", id))
        .unique();
      if (doc !== null) await ctx.db.delete(doc._id);
      return;
    }
    case "tool_call": {
      const doc = await ctx.db
        .query("toolCalls")
        .withIndex("by_toolCallId", (q) => q.eq("toolCallId", id))
        .unique();
      if (doc !== null) await ctx.db.delete(doc._id);
      return;
    }
    case "usage": {
      const doc = await ctx.db
        .query("usageRecords")
        .withIndex("by_usageId", (q) => q.eq("usageId", id))
        .unique();
      if (doc !== null) await ctx.db.delete(doc._id);
      return;
    }
    case "artifact": {
      const doc = await ctx.db
        .query("artifacts")
        .withIndex("by_artifactId", (q) => q.eq("artifactId", id))
        .unique();
      if (doc !== null) await ctx.db.delete(doc._id);
      return;
    }
    case "edge": {
      const doc = await ctx.db
        .query("sessionEdges")
        .withIndex("by_edgeId", (q) => q.eq("edgeId", id))
        .unique();
      if (doc !== null) await ctx.db.delete(doc._id);
      return;
    }
    case "source_root": {
      const doc = await ctx.db
        .query("sourceRoots")
        .withIndex("by_sourceRootId", (q) => q.eq("sourceRootId", id))
        .unique();
      if (doc !== null) await ctx.db.delete(doc._id);
      return;
    }
  }
};

const machineIdForLiveRecord = (item: LiveRecord) => {
  switch (item.type) {
    case "session":
    case "event":
    case "content_block":
    case "tool_call":
    case "usage":
    case "artifact":
    case "edge":
    case "source_root":
      return item.record.machineId;
  }
};

const titleFrom = (...values: Array<string | undefined>) => {
  for (const value of values) {
    const text = compactSearchText(value);
    if (text.length > 0) return text.slice(0, 180);
  }
  return "Untitled";
};
