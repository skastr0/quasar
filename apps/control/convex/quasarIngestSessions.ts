import type { MutationCtx } from "./_generated/server";
import {
  cleanupMissingSessionRows,
  upsertSessionEvents,
} from "./quasarIngestEvents";
import { upsertDeclaredToolCalls } from "./quasarIngestToolCalls";
import type {
  ParsedIngestBatch,
  SessionIngestState,
  SessionPatch,
} from "./quasarIngestTypes";
import {
  cleanupMissingGraphRows,
  upsertSessionGraphRows,
} from "./quasarIngestGraph";
import {
  decodeBoundarySync,
  type AdapterDiagnosticBoundary,
  IngestBatchBoundary,
  type IngestSessionBoundary,
  type SessionEventBoundary,
  type ToolCallBoundary,
} from "./quasarDomainSchemas";
import { sanitizeIngestBoundaryBatch } from "./quasarIngestContract";
import { ensureAgent, ensureMachine, upsertProjectIdentity } from "./quasarProjectHandlers";
import { upsertSearchDocument } from "./quasarSearchDocuments";
import type { SearchDocumentUpsertInput } from "./quasarSearchTypes";
import { compactSearchText, redactSensitive, wideHash } from "./quasarText";
import { isToolEventKind, normalizeToolCallId } from "./quasarToolExtraction";
import { dateMillis } from "./quasarValues";

type IngestBatchResult = ReturnType<typeof importRunSummary>;

export const ingestBatchHandler = async (
  ctx: MutationCtx,
  args: { batch: unknown; importJobId?: string; importChunkId?: string },
): Promise<IngestBatchResult> => {
  const batch = parseIngestBatch(args.batch, {
    importJobId: args.importJobId,
    importChunkId: args.importChunkId,
  });
  await ensureMachine(ctx, batch.machine);
  await upsertImportRun(ctx, batch);
  await upsertSourceRoots(ctx, batch);

  for (const session of batch.sessions) {
    await ingestSession(ctx, batch, session);
  }

  return importRunSummary(batch);
};

const parseIngestBatch = (
  value: unknown,
  metadata: { importJobId?: string; importChunkId?: string } = {},
): ParsedIngestBatch => {
  const decoded = decodeBoundarySync(IngestBatchBoundary, value, "ingest batch");
  const batch = sanitizeIngestBoundaryBatch(decoded, "ingest batch");
  const machine = batch.machine;
  const sessions = batch.sessions;
  const sourceRoots = batch.sourceRoots;
  const diagnostics = batch.diagnostics;
  const now = Date.now();
  return {
    machine,
    sessions,
    sourceRoots,
    diagnostics,
    sanitizedDiagnostics: redactSensitive(diagnostics) as AdapterDiagnosticBoundary[],
    now,
    importRunId: importRunId(machine, batch.generatedAt, sessions),
    eventCount: sumNestedArrayLengths(sessions, "events"),
    toolCallCount: sumNestedArrayLengths(sessions, "toolCalls"),
    contentBlockCount: sumEventContentBlocks(sessions),
    sessionEdgeCount: sumNestedArrayLengths(sessions, "sessionEdges"),
    usageRecordCount: sumNestedArrayLengths(sessions, "usageRecords"),
    artifactCount: sumNestedArrayLengths(sessions, "artifacts"),
    importJobId: metadata.importJobId,
    importChunkId: metadata.importChunkId,
  };
};

const importRunId = (
  machine: ParsedIngestBatch["machine"],
  generatedAt: unknown,
  sessions: readonly IngestSessionBoundary[],
) => `import:${wideHash(JSON.stringify([machine, generatedAt, sessions.map((s) => s.id)]))}`;

const sumNestedArrayLengths = (
  records: readonly IngestSessionBoundary[],
  key: "events" | "toolCalls" | "sessionEdges" | "usageRecords" | "artifacts",
) => records.reduce((sum, record) => sum + record[key].length, 0);

const sumEventContentBlocks = (sessions: readonly IngestSessionBoundary[]) =>
  sessions.reduce(
    (sum, session) =>
      sum +
      session.events.reduce((eventSum, event) => eventSum + event.contentBlocks.length, 0),
    0,
  );

const upsertImportRun = async (ctx: MutationCtx, batch: ParsedIngestBatch) => {
  const existing = await ctx.db
    .query("importRuns")
    .withIndex("by_importRunId", (q) => q.eq("importRunId", batch.importRunId))
    .unique();
  const status = batch.diagnostics.some((diag) => diag.status === "error")
    ? "partial_failure"
    : "succeeded";
  const patch = {
    status: status as "partial_failure" | "succeeded",
    sourceRootCount: batch.sourceRoots.length,
    sessionCount: batch.sessions.length,
    eventCount: batch.eventCount,
    toolCallCount: batch.toolCallCount,
    contentBlockCount: batch.contentBlockCount,
    sessionEdgeCount: batch.sessionEdgeCount,
    usageRecordCount: batch.usageRecordCount,
    artifactCount: batch.artifactCount,
    diagnostics: batch.sanitizedDiagnostics,
    importJobId: batch.importJobId,
    updatedAt: batch.now,
  };
  if (existing === null) {
    await ctx.db.insert("importRuns", {
      importRunId: batch.importRunId,
      machineId: String(batch.machine.machineId ?? ""),
      ...patch,
      createdAt: batch.now,
    });
  } else {
    await ctx.db.patch(existing._id, patch);
  }
};

const upsertSourceRoots = async (ctx: MutationCtx, batch: ParsedIngestBatch) => {
  for (const root of batch.sourceRoots) {
    const existing = await ctx.db
      .query("sourceRoots")
      .withIndex("by_machine_provider_root", (q) =>
        q
          .eq("machineId", root.machineId)
          .eq("provider", root.provider)
          .eq("rootPath", root.rootPath),
      )
      .unique();
    const patch = {
      provider: root.provider,
      adapterId: root.adapterId,
      rootPath: root.rootPath,
      machineId: root.machineId,
      discoveredAt: root.discoveredAt,
      updatedAt: batch.now,
    };
    if (existing === null) await ctx.db.insert("sourceRoots", { ...patch, createdAt: batch.now });
    else if (!patchMatches(existing, patch, ["updatedAt"])) await ctx.db.patch(existing._id, patch);
  }
};

const ingestSession = async (
  ctx: MutationCtx,
  batch: ParsedIngestBatch,
  sessionValue: IngestSessionBoundary,
) => {
  const state = await prepareSessionIngest(ctx, batch, sessionValue);
  await upsertSessionRecordAndSearch(ctx, state);
  await upsertSessionEvents(ctx, state);
  await upsertDeclaredToolCalls(ctx, state);
  await upsertSessionGraphRows(ctx, state);
  if (sessionValue.partialSession === true || sessionValue.deferCleanup === true) return;
  const sessionCleanup = await cleanupMissingSessionRows(
    ctx,
    state.sessionId,
    state.keepEventIds,
    state.keepToolCallIds,
  );
  const graphCleanup = await cleanupMissingGraphRows(ctx, state);
  if (
    sessionCleanup.eventsTruncated ||
    sessionCleanup.toolsTruncated ||
    graphCleanup.contentBlocksTruncated ||
    graphCleanup.edgesTruncated ||
    graphCleanup.usageTruncated ||
    graphCleanup.artifactsTruncated
  ) {
    const existing = await ctx.db
      .query("sessions")
      .withIndex("by_sessionId", (q) => q.eq("sessionId", state.sessionId))
      .unique();
    if (existing !== null) {
      await ctx.db.patch(existing._id, {
        ingestState: "partial",
        updatedAt: batch.now,
      });
    }
  }
};

const prepareSessionIngest = async (
  ctx: MutationCtx,
  batch: ParsedIngestBatch,
  sessionValue: IngestSessionBoundary,
): Promise<SessionIngestState> => {
  const project = sessionValue.projectIdentity;
  const canonicalProjectIdentityKey = await upsertProjectIdentity(ctx, project);
  const sessionId = sessionValue.id;
  const providerValue = sessionValue.provider;
  const agentName = sessionValue.agentName;
  await ensureAgent(ctx, providerValue, agentName);
  const events = [...sessionValue.events];
  const declaredToolCalls = [...sessionValue.toolCalls];
  const contentBlocksByEvent = collectContentBlocksByEvent(events);
  const sessionEdges = [...sessionValue.sessionEdges];
  const usageRecords = [...sessionValue.usageRecords];
  const artifacts = [...sessionValue.artifacts];
  const declaredIds = declaredToolCallIds(declaredToolCalls);
  const sessionPatch = buildSessionPatch({
    batch,
    sessionValue,
    project,
    canonicalProjectIdentityKey,
    events,
    declaredIds,
    sessionId,
    providerValue,
    agentName,
  });
  return {
    batch,
    sessionValue,
    project,
    canonicalProjectIdentityKey,
    sessionId,
    providerValue,
    agentName,
    events,
    declaredToolCalls,
    contentBlocksByEvent,
    sessionEdges,
    usageRecords,
    artifacts,
    sessionPatch,
    keepEventIds: stringSet(sessionValue.expectedEventIds, events.map((event) => String(event.id ?? ""))),
    keepToolCallIds: stringSet(sessionValue.expectedToolCallIds, declaredIds),
    keepContentBlockIds: stringSet(sessionValue.expectedContentBlockIds, []),
    keepSessionEdgeIds: stringSet(sessionValue.expectedSessionEdgeIds, []),
    keepUsageRecordIds: stringSet(sessionValue.expectedUsageRecordIds, []),
    keepArtifactIds: stringSet(sessionValue.expectedArtifactIds, []),
    lastToolCallByName: new Map<string, string>(),
  };
};

const stringSet = (value: unknown, fallback: string[]) => {
  const items =
    Array.isArray(value)
      ? value.map((item) => String(item)).filter((item) => item.length > 0)
      : fallback;
  return new Set<string>(items);
};

const collectContentBlocksByEvent = (events: SessionEventBoundary[]) => {
  const blocksByEvent = new Map<string, SessionEventBoundary["contentBlocks"]>();
  for (const event of events) {
    const eventId = event.id;
    if (eventId.length === 0) continue;
    blocksByEvent.set(eventId, event.contentBlocks);
  }
  return blocksByEvent;
};

const declaredToolCallIds = (toolCalls: ToolCallBoundary[]) =>
  toolCalls.map((toolCall) => toolCall.id).filter(Boolean);

const buildSessionPatch = (input: {
  batch: ParsedIngestBatch;
  sessionValue: IngestSessionBoundary;
  project: IngestSessionBoundary["projectIdentity"];
  canonicalProjectIdentityKey: string;
  events: SessionEventBoundary[];
  declaredIds: string[];
  sessionId: string;
  providerValue: IngestSessionBoundary["provider"];
  agentName: string;
}): SessionPatch => ({
  sessionId: input.sessionId,
  nativeSessionId: input.sessionValue.nativeSessionId,
  provider: input.providerValue,
  agentName: input.agentName,
  machineId: input.sessionValue.machineId,
  projectIdentityKey: input.project.projectIdentityKey,
  canonicalProjectIdentityKey: input.canonicalProjectIdentityKey,
  nativeProjectKey: stringValue(input.sessionValue.nativeProjectKey),
  title: stringValue(input.sessionValue.title),
  startedAt: stringValue(input.sessionValue.startedAt),
  updatedAtNative: stringValue(input.sessionValue.updatedAt),
  sourceRoot: input.sessionValue.sourceRoot,
  sourcePath: input.sessionValue.sourcePath,
  eventCount: numberValue(input.sessionValue.eventCount) ?? input.events.length,
  toolCallCount:
    numberValue(input.sessionValue.toolCallCount) ??
    countToolCallIds(input.sessionId, input.events, input.declaredIds),
  importRunId: input.batch.importRunId,
  importJobId: input.batch.importJobId,
  importChunkId: input.batch.importChunkId,
  ingestState: input.sessionValue.partialSession === true ? "partial" : "complete",
  updatedAt: input.batch.now,
});

const countToolCallIds = (
  sessionId: string,
  events: SessionEventBoundary[],
  declaredIds: string[],
) => {
  const counted = new Set<string>(declaredIds);
  const byName = new Map<string, string>();
  for (const event of events) {
    const eventId = event.id;
    if (!isToolEventKind(event.kind)) continue;
    counted.add(normalizeToolCallId(sessionId, event, eventId, byName));
  }
  return counted.size;
};

const upsertSessionRecordAndSearch = async (
  ctx: MutationCtx,
  state: SessionIngestState,
) => {
  const existing = await ctx.db
    .query("sessions")
    .withIndex("by_sessionId", (q) => q.eq("sessionId", state.sessionId))
    .unique();
  if (existing === null) {
    await ctx.db.insert("sessions", { ...state.sessionPatch, createdAt: state.batch.now });
  } else {
    await ctx.db.patch(existing._id, state.sessionPatch);
  }
  await upsertSearchDocument(ctx, sessionSearchDocument(state));
};

const sessionSearchDocument = (state: SessionIngestState): SearchDocumentUpsertInput => ({
  searchDocumentId: `session:${state.sessionId}`,
  sourceTable: "sessions",
  sourceId: state.sessionId,
  family: "sessions",
  projectIdentityKey: state.sessionPatch.projectIdentityKey,
  canonicalProjectIdentityKey: state.canonicalProjectIdentityKey,
  machineId: state.sessionPatch.machineId,
  provider: state.providerValue,
  agentName: state.agentName,
  title: state.sessionPatch.title ?? `${state.providerValue} session`,
  summary: state.sessionPatch.nativeProjectKey,
  searchText: compactSearchText([
    state.sessionPatch.title,
    state.sessionPatch.nativeProjectKey,
  ]),
  sourcePath: state.sessionPatch.sourcePath,
  sourceRef: { sessionId: state.sessionId },
  importJobId: state.batch.importJobId,
  importChunkId: state.batch.importChunkId,
  occurredAt:
    dateMillis(state.sessionPatch.updatedAtNative) ??
    dateMillis(state.sessionPatch.startedAt),
  activeProject: "",
  activeMachine: "",
  activeProvider: "",
  sourceUpdatedAt: state.batch.now,
});

const importRunSummary = (batch: ParsedIngestBatch) => ({
  importRunId: batch.importRunId,
  importJobId: batch.importJobId,
  importChunkId: batch.importChunkId,
  status: "succeeded",
  sourceRootCount: batch.sourceRoots.length,
  sessionCount: batch.sessions.length,
  eventCount: batch.eventCount,
  toolCallCount: batch.toolCallCount,
  contentBlockCount: batch.contentBlockCount,
  sessionEdgeCount: batch.sessionEdgeCount,
  usageRecordCount: batch.usageRecordCount,
  artifactCount: batch.artifactCount,
  diagnostics: batch.sanitizedDiagnostics,
});

const stringValue = (value: unknown) =>
  typeof value === "string" ? value : undefined;

const numberValue = (value: unknown) =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;

const patchMatches = (
  existing: Record<string, unknown>,
  patch: Record<string, unknown>,
  ignoredKeys: readonly string[] = [],
) =>
  Object.entries(patch).every(([key, value]) =>
    ignoredKeys.includes(key) ? true : existing[key] === value,
  );
