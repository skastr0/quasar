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
import { ensureAgent, ensureMachine, upsertProjectIdentity } from "./quasarProjectHandlers";
import { upsertSearchDocument } from "./quasarSearchDocuments";
import type { SearchDocumentUpsertInput } from "./quasarSearchTypes";
import { compactSearchText, redactSensitive, wideHash } from "./quasarText";
import { isToolEventKind, normalizeToolCallId } from "./quasarToolExtraction";
import { dateMillis } from "./quasarValues";

export const ingestBatchHandler = async (
  ctx: MutationCtx,
  args: { batch: unknown },
) => {
  const batch = parseIngestBatch(args.batch);
  await ensureMachine(ctx, batch.machine);
  await upsertImportRun(ctx, batch);
  await upsertSourceRoots(ctx, batch);

  for (const session of batch.sessions) {
    await ingestSession(ctx, batch, session);
  }

  return importRunSummary(batch);
};

const parseIngestBatch = (value: unknown): ParsedIngestBatch => {
  const batch = value as Record<string, unknown>;
  const machine = batch.machine as Record<string, unknown>;
  const sessions = recordArray(batch.sessions);
  const sourceRoots = recordArray(batch.sourceRoots);
  const diagnostics = recordArray(batch.diagnostics);
  const now = Date.now();
  return {
    machine,
    sessions,
    sourceRoots,
    diagnostics,
    sanitizedDiagnostics: redactSensitive(diagnostics) as unknown[],
    now,
    importRunId: importRunId(machine, batch.generatedAt, sessions),
    eventCount: sumNestedArrayLengths(sessions, "events"),
    toolCallCount: sumNestedArrayLengths(sessions, "toolCalls"),
    contentBlockCount: sumEventContentBlocks(sessions),
    sessionEdgeCount: sumNestedArrayLengths(sessions, "sessionEdges"),
    usageRecordCount: sumNestedArrayLengths(sessions, "usageRecords"),
    artifactCount: sumNestedArrayLengths(sessions, "artifacts"),
  };
};

const importRunId = (
  machine: Record<string, unknown>,
  generatedAt: unknown,
  sessions: Record<string, unknown>[],
) => `import:${wideHash(JSON.stringify([machine, generatedAt, sessions.map((s) => s.id)]))}`;

const recordArray = (value: unknown) =>
  Array.isArray(value) ? (value as Record<string, unknown>[]) : [];

const sumNestedArrayLengths = (records: Record<string, unknown>[], key: string) =>
  records.reduce(
    (sum, record) => sum + (Array.isArray(record[key]) ? recordArray(record[key]).length : 0),
    0,
  );

const sumEventContentBlocks = (sessions: Record<string, unknown>[]) =>
  sessions.reduce(
    (sum, session) =>
      sum +
      recordArray(session.events).reduce(
        (eventSum, event) =>
          eventSum +
          (Array.isArray(event.contentBlocks) ? recordArray(event.contentBlocks).length : 0),
        0,
      ),
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
          .eq("machineId", String(root.machineId ?? ""))
          .eq("provider", root.provider as never)
          .eq("rootPath", String(root.rootPath ?? "")),
      )
      .unique();
    const patch = {
      provider: root.provider as never,
      adapterId: String(root.adapterId ?? ""),
      rootPath: String(root.rootPath ?? ""),
      machineId: String(root.machineId ?? ""),
      discoveredAt: String(root.discoveredAt ?? ""),
      updatedAt: batch.now,
    };
    if (existing === null) await ctx.db.insert("sourceRoots", { ...patch, createdAt: batch.now });
    else await ctx.db.patch(existing._id, patch);
  }
};

const ingestSession = async (
  ctx: MutationCtx,
  batch: ParsedIngestBatch,
  sessionValue: Record<string, unknown>,
) => {
  const state = await prepareSessionIngest(ctx, batch, sessionValue);
  await upsertSessionRecordAndSearch(ctx, state);
  await upsertSessionEvents(ctx, state);
  await upsertDeclaredToolCalls(ctx, state);
  await upsertSessionGraphRows(ctx, state);
  if (sessionValue.partialSession === true) return;
  await cleanupMissingSessionRows(
    ctx,
    state.sessionId,
    state.keepEventIds,
    state.keepToolCallIds,
  );
  await cleanupMissingGraphRows(ctx, state);
};

const prepareSessionIngest = async (
  ctx: MutationCtx,
  batch: ParsedIngestBatch,
  sessionValue: Record<string, unknown>,
): Promise<SessionIngestState> => {
  const project = sessionValue.projectIdentity as Record<string, unknown>;
  const canonicalProjectIdentityKey = await upsertProjectIdentity(ctx, project);
  const sessionId = String(sessionValue.id ?? "");
  const providerValue = String(sessionValue.provider ?? "unknown");
  const agentName = String(sessionValue.agentName ?? providerValue);
  await ensureAgent(ctx, providerValue, agentName);
  const events = recordArray(sessionValue.events);
  const declaredToolCalls = recordArray(sessionValue.toolCalls);
  const contentBlocksByEvent = collectContentBlocksByEvent(events);
  const sessionEdges = recordArray(sessionValue.sessionEdges);
  const usageRecords = recordArray(sessionValue.usageRecords);
  const artifacts = recordArray(sessionValue.artifacts);
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

const collectContentBlocksByEvent = (events: Record<string, unknown>[]) => {
  const blocksByEvent = new Map<string, Record<string, unknown>[]>();
  for (const event of events) {
    const eventId = String(event.id ?? "");
    if (eventId.length === 0) continue;
    blocksByEvent.set(eventId, recordArray(event.contentBlocks));
  }
  return blocksByEvent;
};

const declaredToolCallIds = (toolCalls: Record<string, unknown>[]) =>
  toolCalls.map((toolCall) => String(toolCall.id ?? "")).filter(Boolean);

const buildSessionPatch = (input: {
  batch: ParsedIngestBatch;
  sessionValue: Record<string, unknown>;
  project: Record<string, unknown>;
  canonicalProjectIdentityKey: string;
  events: Record<string, unknown>[];
  declaredIds: string[];
  sessionId: string;
  providerValue: string;
  agentName: string;
}): SessionPatch => ({
  sessionId: input.sessionId,
  nativeSessionId: String(input.sessionValue.nativeSessionId ?? ""),
  provider: input.providerValue as never,
  agentName: input.agentName,
  machineId: String(input.sessionValue.machineId ?? input.batch.machine.machineId ?? ""),
  projectIdentityKey: String(input.project.projectIdentityKey ?? ""),
  canonicalProjectIdentityKey: input.canonicalProjectIdentityKey,
  nativeProjectKey: stringValue(input.sessionValue.nativeProjectKey),
  title: stringValue(input.sessionValue.title),
  startedAt: stringValue(input.sessionValue.startedAt),
  updatedAtNative: stringValue(input.sessionValue.updatedAt),
  sourceRoot: String(input.sessionValue.sourceRoot ?? ""),
  sourcePath: String(input.sessionValue.sourcePath ?? ""),
  rawMetadata: redactSensitive(input.sessionValue.rawMetadata),
  eventCount: numberValue(input.sessionValue.eventCount) ?? input.events.length,
  toolCallCount:
    numberValue(input.sessionValue.toolCallCount) ??
    countToolCallIds(input.sessionId, input.events, input.declaredIds),
  importRunId: input.batch.importRunId,
  updatedAt: input.batch.now,
});

const countToolCallIds = (
  sessionId: string,
  events: Record<string, unknown>[],
  declaredIds: string[],
) => {
  const counted = new Set<string>(declaredIds);
  const byName = new Map<string, string>();
  for (const event of events) {
    const eventId = String(event.id ?? "");
    if (!isToolEventKind(String(event.kind ?? "unknown"))) continue;
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
  provider: state.providerValue as never,
  agentName: state.agentName,
  title: state.sessionPatch.title ?? `${state.providerValue} session`,
  summary: state.sessionPatch.nativeProjectKey,
  searchText: compactSearchText([
    state.sessionPatch.title,
    state.sessionPatch.nativeProjectKey,
    state.sessionPatch.rawMetadata,
  ]),
  sourcePath: state.sessionPatch.sourcePath,
  sourceRef: { sessionId: state.sessionId },
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
