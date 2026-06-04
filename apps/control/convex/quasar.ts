import type { EntryFilter } from "@convex-dev/rag";
import { Effect } from "effect";
import { v } from "convex/values";

import { internalMutation, internalQuery, internalAction } from "./_generated/server";
import type { ActionCtx, MutationCtx, QueryCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import {
  QUASAR_EMBEDDING_DIMENSIONS,
  QUASAR_RAG_NAMESPACE,
  embedDocumentChunksEffect,
  embedQueryEffect,
  quasarRag,
  serverEmbeddingsConfigured,
  type QuasarRagFilters,
} from "./quasarRag";

const MAX_SEARCH_TEXT_LENGTH = 64_000;
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;
const RRF_K = 60;

const provider = v.union(
  v.literal("codex"),
  v.literal("claude"),
  v.literal("opencode"),
  v.literal("grok"),
  v.literal("amp"),
  v.literal("pi"),
  v.literal("kimi"),
  v.literal("droid"),
  v.literal("antigravity"),
  v.literal("cursor"),
  v.literal("gemini"),
  v.literal("unknown"),
);

const role = v.union(
  v.literal("user"),
  v.literal("assistant"),
  v.literal("system"),
  v.literal("tool"),
  v.literal("thinking"),
  v.literal("unknown"),
);

const eventKind = v.union(
  v.literal("message"),
  v.literal("tool_call"),
  v.literal("tool_result"),
  v.literal("reasoning"),
  v.literal("system"),
  v.literal("summary"),
  v.literal("edit"),
  v.literal("snapshot"),
  v.literal("lifecycle"),
  v.literal("unknown"),
);

type SearchDocument = Doc<"searchDocuments">;
type SearchDocumentInsert = Omit<SearchDocument, "_creationTime" | "_id">;
type SearchDocumentUpsertInput = Omit<
  SearchDocumentInsert,
  | "activeKind"
  | "activeMachine"
  | "activeProject"
  | "activeProvider"
  | "createdAt"
  | "ragContentHash"
  | "ragEntryId"
  | "ragError"
  | "ragSyncState"
  | "ragSyncedAt"
  | "searchTextHash"
  | "updatedAt"
> &
  Partial<
    Pick<
      SearchDocumentInsert,
      | "activeKind"
      | "activeMachine"
      | "activeProject"
      | "activeProvider"
      | "ragContentHash"
      | "ragEntryId"
      | "ragError"
      | "ragSyncState"
      | "ragSyncedAt"
      | "searchTextHash"
    >
  >;

const compactText = (value: unknown) => {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return value.replace(/\s+/g, " ").trim();
  try {
    return JSON.stringify(value).replace(/\s+/g, " ").trim();
  } catch {
    return String(value);
  }
};

const REDACTED = "[redacted]";
const SENSITIVE_KEY =
  /(authorization|password|passwd|secret|api[_-]?key|access[_-]?token|refresh[_-]?token|bearer|cookie|credential|private[_-]?key)/i;

const redactString = (value: string) =>
  value
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/g, "Bearer [redacted]")
    .replace(/AIza[0-9A-Za-z_-]{20,}/g, REDACTED)
    .replace(/sk-[A-Za-z0-9_-]{20,}/g, REDACTED);

const redactSensitive = (value: unknown, depth = 0): unknown => {
  if (depth > 8) return "[redacted:depth]";
  if (typeof value === "string") return redactString(value);
  if (value === null || value === undefined) return value;
  if (typeof value !== "object") return value;
  if (Array.isArray(value)) {
    return value.map((item) => redactSensitive(item, depth + 1));
  }
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, item]) => [
      key,
      SENSITIVE_KEY.test(key) ? REDACTED : redactSensitive(item, depth + 1),
    ]),
  );
};

const truncate = (value: string, limit: number) =>
  value.length <= limit ? value : value.slice(0, limit);

const hashText = (value: string) => {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
};

const wideHash = (value: string) =>
  [hashText(`a:${value}`), hashText(`b:${value}`), hashText(`c:${value}`), hashText(`d:${value}`)].join("");

const boundedLimit = (value: number | undefined) => {
  if (value === undefined || !Number.isFinite(value)) return DEFAULT_LIMIT;
  return Math.max(1, Math.min(MAX_LIMIT, Math.trunc(value)));
};

const dateMillis = (value: unknown) => {
  if (typeof value !== "string" || value.trim().length === 0) return undefined;
  const millis = Date.parse(value);
  return Number.isFinite(millis) ? millis : undefined;
};

const parseDateBound = (value: string | undefined, field: string) => {
  if (value === undefined) return undefined;
  const millis = dateMillis(value);
  if (millis === undefined) {
    throw new Error(`${field} must be a valid ISO date or timestamp.`);
  }
  return millis;
};

const canonicalFilter = (key: string) => JSON.stringify(["project", key]);
const machineFilter = (key: string) => JSON.stringify(["machine", key]);
const providerFilter = (value: string) => JSON.stringify(["provider", value]);
const kindFilter = (value: string) => JSON.stringify(["kind", value]);

const searchDocumentRagContentHash = (doc: {
  readonly title: string;
  readonly searchText: string;
  readonly canonicalProjectIdentityKey: string;
  readonly machineId: string;
  readonly provider?: string;
  readonly kind?: string;
  readonly toolName?: string;
}) =>
  `wide:${wideHash(
    [
      "quasar-rag/v1",
      doc.title,
      doc.searchText,
      doc.canonicalProjectIdentityKey,
      doc.machineId,
      doc.provider ?? "",
      doc.kind ?? "",
      doc.toolName ?? "",
    ].join("\u001f"),
  )}`;

const scheduleSearchDocumentRagSync = async (
  ctx: MutationCtx,
  searchDocumentId: Id<"searchDocuments">,
  expectedContentHash: string,
) => {
  if (!serverEmbeddingsConfigured()) return;
  await ctx.scheduler.runAfter(0, internal.quasar.syncSearchDocumentRagInternal, {
    searchDocumentId,
    expectedContentHash,
  });
};

const upsertSearchDocument = async (
  ctx: MutationCtx,
  input: SearchDocumentUpsertInput,
) => {
  const now = Date.now();
  const searchText = truncate(input.searchText, MAX_SEARCH_TEXT_LENGTH);
  const ragContentHash = searchDocumentRagContentHash({
    ...input,
    searchText,
  });
  const existing = await ctx.db
    .query("searchDocuments")
    .withIndex("by_searchDocumentId", (q) =>
      q.eq("searchDocumentId", input.searchDocumentId),
    )
    .unique();
  const patch: Omit<SearchDocumentInsert, "createdAt"> = {
    ...input,
    searchText,
    searchTextHash: hashText(searchText),
    activeProject: canonicalFilter(input.canonicalProjectIdentityKey),
    activeMachine: machineFilter(input.machineId),
    activeProvider:
      input.provider === undefined ? undefined : providerFilter(input.provider),
    activeKind: input.kind === undefined ? undefined : kindFilter(input.kind),
    ragContentHash: serverEmbeddingsConfigured() ? ragContentHash : undefined,
    ragSyncState: serverEmbeddingsConfigured() ? ("pending" as const) : ("skipped" as const),
    ragError: undefined,
    updatedAt: now,
  };
  if (existing === null) {
    const id = await ctx.db.insert("searchDocuments", {
      ...patch,
      createdAt: now,
    });
    await scheduleSearchDocumentRagSync(ctx, id, ragContentHash);
    return id;
  }
  const changed = existing.searchTextHash !== patch.searchTextHash || existing.ragContentHash !== ragContentHash;
  await ctx.db.patch(existing._id, patch);
  if (changed && serverEmbeddingsConfigured()) {
    await scheduleSearchDocumentRagSync(ctx, existing._id, ragContentHash);
  }
  return existing._id;
};

const deleteSearchDocumentById = async (
  ctx: MutationCtx,
  searchDocumentId: string,
) => {
  const doc = await ctx.db
    .query("searchDocuments")
    .withIndex("by_searchDocumentId", (q) =>
      q.eq("searchDocumentId", searchDocumentId),
    )
    .unique();
  if (doc !== null) await ctx.db.delete(doc._id);
};

const extractToolName = (event: { readonly content?: unknown; readonly raw?: unknown; readonly kind: string }) => {
  const candidates = [event.content, event.raw];
  for (const candidate of candidates) {
    if (candidate && typeof candidate === "object") {
      const record = candidate as Record<string, unknown>;
      if (typeof record.toolName === "string") return record.toolName;
      if (typeof record.tool === "string") return record.tool;
      if (typeof record.name === "string") return record.name;
      const nested = record.function ?? record.payload ?? record.data;
      if (nested && typeof nested === "object") {
        const nestedRecord = nested as Record<string, unknown>;
        if (typeof nestedRecord.name === "string") return nestedRecord.name;
        if (typeof nestedRecord.tool === "string") return nestedRecord.tool;
      }
    }
  }
  return event.kind === "tool_result" ? "tool_result" : "tool_call";
};

const normalizeToolCallId = (
  sessionId: string,
  event: Record<string, unknown>,
  eventId: string,
  lastToolCallByName: Map<string, string>,
) => {
  if (typeof event.toolCallId === "string" && event.toolCallId.length > 0) {
    return event.toolCallId;
  }
  const toolName = extractToolName({
    kind: String(event.kind ?? ""),
    content: event.content,
    raw: event.raw,
  });
  if (event.kind === "tool_result") {
    return lastToolCallByName.get(toolName) ?? `tool:${sessionId}:${toolName}`;
  }
  const toolCallId = `tool:${eventId}`;
  lastToolCallByName.set(toolName, toolCallId);
  return toolCallId;
};

const cleanupMissingSessionRows = async (
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

const ensureMachine = async (ctx: MutationCtx, machine: Record<string, unknown>) => {
  const now = Date.now();
  const machineId = String(machine.machineId ?? "");
  const existing = await ctx.db.query("machines").withIndex("by_machineId", (q) => q.eq("machineId", machineId)).unique();
  const patch = {
    machineId,
    hostname: typeof machine.hostname === "string" ? machine.hostname : undefined,
    tailscaleName: typeof machine.tailscaleName === "string" ? machine.tailscaleName : undefined,
    platform: typeof machine.platform === "string" ? machine.platform : undefined,
    updatedAt: now,
  };
  if (existing === null) {
    await ctx.db.insert("machines", { ...patch, createdAt: now });
  } else {
    await ctx.db.patch(existing._id, patch);
  }
};

const ensureAgent = async (
  ctx: MutationCtx,
  providerValue: string,
  agentName: string,
) => {
  const now = Date.now();
  const existing = await ctx.db
    .query("agentDefinitions")
    .withIndex("by_provider_and_agentName", (q) =>
      q.eq("provider", providerValue as never).eq("agentName", agentName),
    )
    .unique();
  if (existing === null) {
    await ctx.db.insert("agentDefinitions", {
      provider: providerValue as never,
      agentName,
      displayName: agentName,
      createdAt: now,
      updatedAt: now,
    });
  } else {
    await ctx.db.patch(existing._id, { updatedAt: now });
  }
};

const upsertProjectIdentity = async (
  ctx: MutationCtx,
  project: Record<string, unknown>,
) => {
  const now = Date.now();
  const key = String(project.projectIdentityKey ?? "");
  const existing = await ctx.db
    .query("projectIdentities")
    .withIndex("by_projectIdentityKey", (q) => q.eq("projectIdentityKey", key))
    .unique();
  const canonicalProjectIdentityKey =
    existing?.canonicalProjectIdentityKey ?? key;
  const patch = {
    projectIdentityKey: key,
    canonicalProjectIdentityKey,
    displayName: String(project.displayName ?? key),
    confidence: project.confidence as never,
    rawPath: typeof project.rawPath === "string" ? project.rawPath : undefined,
    normalizedPath:
      typeof project.normalizedPath === "string"
        ? project.normalizedPath
        : undefined,
    gitRemote: typeof project.gitRemote === "string" ? project.gitRemote : undefined,
    gitRemoteNormalized:
      typeof project.gitRemoteNormalized === "string"
        ? project.gitRemoteNormalized
        : undefined,
    packageName:
      typeof project.packageName === "string" ? project.packageName : undefined,
    signals: Array.isArray(project.signals) ? project.signals : [],
    updatedAt: now,
  };
  if (existing === null) {
    await ctx.db.insert("projectIdentities", { ...patch, createdAt: now });
  } else {
    await ctx.db.patch(existing._id, patch);
  }
  await upsertSearchDocument(ctx, {
    searchDocumentId: `project:${key}`,
    sourceTable: "projectIdentities",
    sourceId: key,
    family: "projectIdentities",
    projectIdentityKey: key,
    canonicalProjectIdentityKey,
    machineId: "project-registry",
    title: patch.displayName,
    summary: patch.normalizedPath ?? patch.gitRemoteNormalized,
    searchText: compactText(project),
    searchTextHash: "",
    sourceRef: { projectIdentityKey: key },
    occurredAt: now,
    activeProject: "",
    activeMachine: "",
    sourceUpdatedAt: now,
  });
  return canonicalProjectIdentityKey;
};

type ParsedIngestBatch = ReturnType<typeof parseIngestBatch>;
type SessionIngestState = Awaited<ReturnType<typeof prepareSessionIngest>>;
type SessionPatch = ReturnType<typeof buildSessionPatch>;
type EventPatch = ReturnType<typeof buildEventPatch>;

const ingestBatchHandler = async (ctx: MutationCtx, args: { batch: unknown }) => {
  const batch = parseIngestBatch(args.batch);
  await ensureMachine(ctx, batch.machine);
  await upsertImportRun(ctx, batch);
  await upsertSourceRoots(ctx, batch);

  for (const session of batch.sessions) {
    await ingestSession(ctx, batch, session);
  }

  return importRunSummary(batch);
};

const parseIngestBatch = (value: unknown) => {
  const batch = value as Record<string, unknown>;
  const machine = batch.machine as Record<string, unknown>;
  const sessions = recordArray(batch.sessions);
  const sourceRoots = recordArray(batch.sourceRoots);
  const diagnostics = recordArray(batch.diagnostics);
  const now = Date.now();
  const importRunId = `import:${wideHash(
    JSON.stringify([machine, batch.generatedAt, sessions.map((s) => s.id)]),
  )}`;
  return {
    machine,
    sessions,
    sourceRoots,
    diagnostics,
    sanitizedDiagnostics: redactSensitive(diagnostics) as unknown[],
    now,
    importRunId,
    eventCount: sumNestedArrayLengths(sessions, "events"),
    toolCallCount: sumNestedArrayLengths(sessions, "toolCalls"),
  };
};

const recordArray = (value: unknown) =>
  Array.isArray(value) ? (value as Record<string, unknown>[]) : [];

const sumNestedArrayLengths = (
  records: Record<string, unknown>[],
  key: string,
) =>
  records.reduce(
    (sum, record) => sum + (Array.isArray(record[key]) ? recordArray(record[key]).length : 0),
    0,
  );

const upsertImportRun = async (ctx: MutationCtx, batch: ParsedIngestBatch) => {
  const existing = await ctx.db
    .query("importRuns")
    .withIndex("by_importRunId", (q) => q.eq("importRunId", batch.importRunId))
    .unique();
  const status = batch.diagnostics.some((diag) => diag.status === "error")
    ? ("partial_failure" as const)
    : ("succeeded" as const);
  const patch = {
    status,
    sourceRootCount: batch.sourceRoots.length,
    sessionCount: batch.sessions.length,
    eventCount: batch.eventCount,
    toolCallCount: batch.toolCallCount,
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
  await cleanupMissingSessionRows(
    ctx,
    state.sessionId,
    state.keepEventIds,
    state.keepToolCallIds,
  );
};

const prepareSessionIngest = async (
  ctx: MutationCtx,
  batch: ParsedIngestBatch,
  sessionValue: Record<string, unknown>,
) => {
  const project = sessionValue.projectIdentity as Record<string, unknown>;
  const canonicalProjectIdentityKey = await upsertProjectIdentity(ctx, project);
  const sessionId = String(sessionValue.id ?? "");
  const providerValue = String(sessionValue.provider ?? "unknown");
  const agentName = String(sessionValue.agentName ?? providerValue);
  await ensureAgent(ctx, providerValue, agentName);
  const events = recordArray(sessionValue.events);
  const declaredToolCalls = recordArray(sessionValue.toolCalls);
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
    sessionPatch,
    keepEventIds: new Set(events.map((event) => String(event.id ?? ""))),
    keepToolCallIds: new Set<string>(declaredIds),
    lastToolCallByName: new Map<string, string>(),
  };
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
}) => ({
  sessionId: input.sessionId,
  nativeSessionId: String(input.sessionValue.nativeSessionId ?? ""),
  provider: input.providerValue as never,
  agentName: input.agentName,
  machineId: String(input.sessionValue.machineId ?? input.batch.machine.machineId ?? ""),
  projectIdentityKey: String(input.project.projectIdentityKey ?? ""),
  canonicalProjectIdentityKey: input.canonicalProjectIdentityKey,
  nativeProjectKey:
    typeof input.sessionValue.nativeProjectKey === "string"
      ? input.sessionValue.nativeProjectKey
      : undefined,
  title: typeof input.sessionValue.title === "string" ? input.sessionValue.title : undefined,
  startedAt:
    typeof input.sessionValue.startedAt === "string" ? input.sessionValue.startedAt : undefined,
  updatedAtNative:
    typeof input.sessionValue.updatedAt === "string" ? input.sessionValue.updatedAt : undefined,
  sourceRoot: String(input.sessionValue.sourceRoot ?? ""),
  sourcePath: String(input.sessionValue.sourcePath ?? ""),
  rawMetadata: redactSensitive(input.sessionValue.rawMetadata),
  eventCount: input.events.length,
  toolCallCount: countToolCallIds(input.sessionId, input.events, input.declaredIds),
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
  searchText: compactText([
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

const upsertSessionEvents = async (ctx: MutationCtx, state: SessionIngestState) => {
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
  const existing = await ctx.db
    .query("sessionEvents")
    .withIndex("by_eventId", (q) => q.eq("eventId", eventId))
    .unique();
  if (existing === null) {
    await ctx.db.insert("sessionEvents", { ...eventPatch, createdAt: state.batch.now });
  } else {
    await ctx.db.patch(existing._id, eventPatch);
  }
  await upsertSearchDocument(ctx, eventSearchDocument(state, event, eventPatch, safeContent));
  if (isToolEventKind(String(eventPatch.kind))) {
    await upsertToolCallFromEvent(ctx, state, event, eventPatch, safeContent);
  }
};

const buildEventPatch = (
  state: SessionIngestState,
  event: Record<string, unknown>,
  eventId: string,
  safeContent: unknown,
  normalizedToolCallId: string | undefined,
) => ({
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
  contentText: typeof event.contentText === "string" ? event.contentText : undefined,
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
): SearchDocumentUpsertInput => ({
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
  summary: eventPatch.contentText,
  searchText: compactText([eventPatch.contentText, safeContent]),
  sourcePath: eventSourcePath(event, state.sessionPatch.sourcePath),
  sourceRef: { sessionId: state.sessionId, eventId: eventPatch.eventId },
  occurredAt: dateMillis(eventPatch.timestamp),
  activeProject: "",
  activeMachine: "",
  activeProvider: "",
  activeKind: "",
  sourceUpdatedAt: state.batch.now,
});

const eventSourcePath = (event: Record<string, unknown>, fallback: string) => {
  const rawReference = event.rawReference as Record<string, unknown> | undefined;
  return typeof rawReference?.sourcePath === "string" ? rawReference.sourcePath : fallback;
};

const upsertToolCallFromEvent = async (
  ctx: MutationCtx,
  state: SessionIngestState,
  event: Record<string, unknown>,
  eventPatch: EventPatch,
  safeContent: unknown,
) => {
  const toolCallId = eventPatch.toolCallId ?? `tool:${eventPatch.eventId}`;
  const toolName = extractToolName({
    kind: String(event.kind ?? ""),
    content: safeContent,
    raw: undefined,
  });
  const existingTool = await ctx.db
    .query("toolCalls")
    .withIndex("by_toolCallId", (q) => q.eq("toolCallId", toolCallId))
    .unique();
  const toolPatch = eventToolPatch(state, eventPatch, toolCallId, toolName, safeContent, existingTool);
  if (existingTool === null) await ctx.db.insert("toolCalls", { ...toolPatch, createdAt: state.batch.now });
  else await ctx.db.patch(existingTool._id, toolPatch);
  await upsertSearchDocument(ctx, toolSearchDocumentFromEvent(state, eventPatch, toolCallId, toolName, safeContent));
};

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
  provider: state.providerValue as never,
  agentName: state.agentName,
  projectIdentityKey: state.sessionPatch.projectIdentityKey,
  canonicalProjectIdentityKey: state.canonicalProjectIdentityKey,
  toolName,
  status: eventPatch.kind === "tool_result" ? "completed" : "started",
  input: eventPatch.kind === "tool_call" ? safeContent : existingTool?.input,
  output: eventPatch.kind === "tool_result" ? safeContent : existingTool?.output,
  startedAt: eventPatch.kind === "tool_call" ? eventPatch.timestamp : existingTool?.startedAt,
  completedAt:
    eventPatch.kind === "tool_result" ? eventPatch.timestamp : existingTool?.completedAt,
  raw: undefined,
  importRunId: state.batch.importRunId,
  updatedAt: state.batch.now,
});

const toolSearchDocumentFromEvent = (
  state: SessionIngestState,
  eventPatch: EventPatch,
  toolCallId: string,
  toolName: string,
  safeContent: unknown,
): SearchDocumentUpsertInput => ({
  searchDocumentId: `tool:${toolCallId}`,
  sourceTable: "toolCalls",
  sourceId: toolCallId,
  family: "toolCalls",
  projectIdentityKey: state.sessionPatch.projectIdentityKey,
  canonicalProjectIdentityKey: state.canonicalProjectIdentityKey,
  machineId: state.sessionPatch.machineId,
  provider: state.providerValue as never,
  agentName: state.agentName,
  toolName,
  title: toolName,
  summary: eventPatch.contentText,
  searchText: compactText([
    toolName,
    eventPatch.contentText,
    eventPatch.kind === "tool_result" ? safeContent : undefined,
  ]),
  sourcePath: state.sessionPatch.sourcePath,
  sourceRef: { sessionId: state.sessionId, eventId: eventPatch.eventId, toolCallId },
  occurredAt: dateMillis(eventPatch.timestamp),
  activeProject: "",
  activeMachine: "",
  activeProvider: "",
  sourceUpdatedAt: state.batch.now,
});

const upsertDeclaredToolCalls = async (
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
  toolCall: Record<string, unknown>,
) => {
  const toolCallId = String(toolCall.id ?? "");
  if (toolCallId.length === 0) return;
  state.keepToolCallIds.add(toolCallId);
  const existingTool = await ctx.db
    .query("toolCalls")
    .withIndex("by_toolCallId", (q) => q.eq("toolCallId", toolCallId))
    .unique();
  const eventId = typeof toolCall.eventId === "string" ? toolCall.eventId : `declared:${toolCallId}`;
  const toolName = typeof toolCall.toolName === "string" ? toolCall.toolName : "tool";
  const toolPatch = declaredToolPatch(state, toolCall, toolCallId, eventId, toolName);
  if (existingTool === null) await ctx.db.insert("toolCalls", { ...toolPatch, createdAt: state.batch.now });
  else await ctx.db.patch(existingTool._id, toolPatch);
  await upsertSearchDocument(ctx, declaredToolSearchDocument(state, toolCall, toolPatch, eventId, toolCallId, toolName));
};

const declaredToolPatch = (
  state: SessionIngestState,
  toolCall: Record<string, unknown>,
  toolCallId: string,
  eventId: string,
  toolName: string,
) => ({
  toolCallId,
  sessionId: state.sessionId,
  eventId,
  machineId: state.sessionPatch.machineId,
  provider: state.providerValue as never,
  agentName: state.agentName,
  projectIdentityKey: state.sessionPatch.projectIdentityKey,
  canonicalProjectIdentityKey: state.canonicalProjectIdentityKey,
  toolName,
  status: typeof toolCall.status === "string" ? toolCall.status : undefined,
  input: redactSensitive(toolCall.input),
  output: redactSensitive(toolCall.output),
  startedAt: typeof toolCall.startedAt === "string" ? toolCall.startedAt : undefined,
  completedAt: typeof toolCall.completedAt === "string" ? toolCall.completedAt : undefined,
  raw: undefined,
  importRunId: state.batch.importRunId,
  updatedAt: state.batch.now,
});

const declaredToolSearchDocument = (
  state: SessionIngestState,
  toolCall: Record<string, unknown>,
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
  provider: state.providerValue as never,
  agentName: state.agentName,
  toolName,
  title: toolName,
  summary: compactText([toolCall.status, toolCall.output]),
  searchText: compactText([toolName, toolPatch.status, toolPatch.output]),
  sourcePath: state.sessionPatch.sourcePath,
  sourceRef: { sessionId: state.sessionId, eventId, toolCallId },
  occurredAt: dateMillis(toolPatch.completedAt) ?? dateMillis(toolPatch.startedAt),
  sourceUpdatedAt: state.batch.now,
});

const isToolEventKind = (kind: string) =>
  kind === "tool_call" || kind === "tool_result";

const importRunSummary = (batch: ParsedIngestBatch) => ({
  importRunId: batch.importRunId,
  status: "succeeded",
  sourceRootCount: batch.sourceRoots.length,
  sessionCount: batch.sessions.length,
  eventCount: batch.eventCount,
  toolCallCount: batch.toolCallCount,
  diagnostics: batch.sanitizedDiagnostics,
});

export const ingestBatchInternal = internalMutation({
  args: { batch: v.any() },
  handler: ingestBatchHandler,
});

export const aliasProjectInternal = internalMutation({
  args: {
    sourceProjectIdentityKey: v.string(),
    targetProjectIdentityKey: v.string(),
    reason: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const now = Date.now();
    const target = await ctx.db
      .query("projectIdentities")
      .withIndex("by_projectIdentityKey", (q) =>
        q.eq("projectIdentityKey", args.targetProjectIdentityKey),
      )
      .unique();
    if (target === null) throw new Error("Target project identity was not found.");
    const targetCanonical = target.canonicalProjectIdentityKey;
    const source = await ctx.db
      .query("projectIdentities")
      .withIndex("by_projectIdentityKey", (q) =>
        q.eq("projectIdentityKey", args.sourceProjectIdentityKey),
      )
      .unique();
    if (source === null) throw new Error("Source project identity was not found.");
    await ctx.db.patch(source._id, {
      canonicalProjectIdentityKey: targetCanonical,
      updatedAt: now,
    });
    const existing = await ctx.db
      .query("projectAliases")
      .withIndex("by_sourceProjectIdentityKey", (q) =>
        q.eq("sourceProjectIdentityKey", args.sourceProjectIdentityKey),
      )
      .unique();
    if (existing === null) {
      await ctx.db.insert("projectAliases", {
        sourceProjectIdentityKey: args.sourceProjectIdentityKey,
        targetProjectIdentityKey: targetCanonical,
        reason: args.reason,
        createdAt: now,
        updatedAt: now,
      });
    } else {
      await ctx.db.patch(existing._id, {
        targetProjectIdentityKey: targetCanonical,
        reason: args.reason,
        updatedAt: now,
      });
    }
    for (const tableName of ["sessions", "sessionEvents", "toolCalls"] as const) {
      const rows = await ctx.db.query(tableName).collect();
      for (const row of rows) {
        if (
          "projectIdentityKey" in row &&
          (row.projectIdentityKey === args.sourceProjectIdentityKey ||
            row.canonicalProjectIdentityKey === args.sourceProjectIdentityKey)
        ) {
          await ctx.db.patch(row._id, {
            canonicalProjectIdentityKey: targetCanonical,
          });
        }
      }
    }
    const searchRows = await ctx.db.query("searchDocuments").collect();
    for (const row of searchRows) {
      if (
        row.projectIdentityKey !== args.sourceProjectIdentityKey &&
        row.canonicalProjectIdentityKey !== args.sourceProjectIdentityKey
      ) {
        continue;
      }
      const nextContentHash = searchDocumentRagContentHash({
        ...row,
        canonicalProjectIdentityKey: targetCanonical,
      });
      await ctx.db.patch(row._id, {
        canonicalProjectIdentityKey: targetCanonical,
        activeProject: canonicalFilter(targetCanonical),
        ragContentHash: serverEmbeddingsConfigured() ? nextContentHash : undefined,
        ragSyncState: serverEmbeddingsConfigured() ? "pending" : "skipped",
        updatedAt: now,
      });
      await scheduleSearchDocumentRagSync(ctx, row._id, nextContentHash);
    }
    return { sourceProjectIdentityKey: args.sourceProjectIdentityKey, targetProjectIdentityKey: targetCanonical };
  },
});

const listProjectsHandler = async (ctx: QueryCtx) => {
    const projects = await ctx.db.query("projectIdentities").collect();
    const sessions = await ctx.db.query("sessions").collect();
    return projects
      .map((project) => ({
        projectIdentityKey: project.projectIdentityKey,
        canonicalProjectIdentityKey: project.canonicalProjectIdentityKey,
        displayName: project.displayName,
        confidence: project.confidence,
        rawPath: project.rawPath,
        gitRemoteNormalized: project.gitRemoteNormalized,
        sessionCount: sessions.filter(
          (session) =>
            session.canonicalProjectIdentityKey ===
            project.canonicalProjectIdentityKey,
        ).length,
        updatedAt: project.updatedAt,
      }))
      .sort((left, right) => right.sessionCount - left.sessionCount || right.updatedAt - left.updatedAt);
  };

export const listProjectsInternal = internalQuery({
  args: {},
  handler: listProjectsHandler,
});

const listImportRunsHandler = async (ctx: QueryCtx) =>
  await ctx.db.query("importRuns").withIndex("by_createdAt").order("desc").take(50);

export const listImportRunsInternal = internalQuery({
  args: {},
  handler: listImportRunsHandler,
});

const listSessionsArgs = {
    projectIdentityKey: v.optional(v.string()),
    machineId: v.optional(v.string()),
    provider: v.optional(provider),
    limit: v.optional(v.number()),
  };

const listSessionsHandler = async (
  ctx: QueryCtx,
  args: {
    projectIdentityKey?: string;
    machineId?: string;
    provider?: Doc<"sessions">["provider"];
    limit?: number;
  },
) => {
    const limit = boundedLimit(args.limit);
    const rows = await ctx.db.query("sessions").collect();
    return rows
      .filter((session) =>
        args.projectIdentityKey === undefined
          ? true
          : session.canonicalProjectIdentityKey === args.projectIdentityKey ||
            session.projectIdentityKey === args.projectIdentityKey,
      )
      .filter((session) =>
        args.machineId === undefined ? true : session.machineId === args.machineId,
      )
      .filter((session) =>
        args.provider === undefined ? true : session.provider === args.provider,
      )
      .sort((left, right) => right.updatedAt - left.updatedAt)
      .slice(0, limit)
      .map((session) => ({
        id: session.sessionId,
        nativeSessionId: session.nativeSessionId,
        title: session.title,
        provider: session.provider,
        agentName: session.agentName,
        machineId: session.machineId,
        projectIdentityKey: session.canonicalProjectIdentityKey,
        eventCount: session.eventCount,
        updatedAt: session.updatedAt,
      }));
  };

export const listSessionsInternal = internalQuery({
  args: listSessionsArgs,
  handler: listSessionsHandler,
});

export const readSessionInternal = internalQuery({
  args: { sessionId: v.string() },
  handler: async (ctx, args) => {
    const session = await ctx.db.query("sessions").withIndex("by_sessionId", (q) => q.eq("sessionId", args.sessionId)).unique();
    if (session === null) return null;
    const events = await ctx.db.query("sessionEvents").withIndex("by_session_sequence", (q) => q.eq("sessionId", args.sessionId)).collect();
    const toolCalls = await ctx.db.query("toolCalls").withIndex("by_sessionId", (q) => q.eq("sessionId", args.sessionId)).collect();
    return { session, events, toolCalls };
  },
});

const listToolCallsArgs = {
    toolCallId: v.optional(v.string()),
    sessionId: v.optional(v.string()),
    limit: v.optional(v.number()),
  };

const listToolCallsHandler = async (
  ctx: QueryCtx,
  args: { toolCallId?: string; sessionId?: string; limit?: number },
) => {
    if (args.toolCallId !== undefined) {
      return await ctx.db
        .query("toolCalls")
        .withIndex("by_toolCallId", (q) => q.eq("toolCallId", args.toolCallId!))
        .collect();
    }
    const rows =
      args.sessionId === undefined
        ? await ctx.db.query("toolCalls").collect()
        : await ctx.db.query("toolCalls").withIndex("by_sessionId", (q) => q.eq("sessionId", args.sessionId!)).collect();
    return rows.sort((left, right) => right.updatedAt - left.updatedAt).slice(0, boundedLimit(args.limit));
  };

export const listToolCallsInternal = internalQuery({
  args: listToolCallsArgs,
  handler: listToolCallsHandler,
});

const matchesFilters = (
  doc: SearchDocument,
  args: {
    readonly projectIdentityKey?: string;
    readonly machineId?: string;
    readonly provider?: string;
    readonly agentName?: string;
	    readonly role?: string;
	    readonly kind?: string;
	    readonly toolName?: string;
	    readonly from?: string;
	    readonly to?: string;
	  },
) => {
  const from = parseDateBound(args.from, "from");
  const to = parseDateBound(args.to, "to");
  return (
    (args.projectIdentityKey === undefined ||
      doc.canonicalProjectIdentityKey === args.projectIdentityKey ||
      doc.projectIdentityKey === args.projectIdentityKey) &&
    (args.machineId === undefined || doc.machineId === args.machineId) &&
    (args.provider === undefined || doc.provider === args.provider) &&
    (args.agentName === undefined || doc.agentName === args.agentName) &&
    (args.role === undefined || doc.role === args.role) &&
    (args.kind === undefined || doc.kind === args.kind) &&
    (args.toolName === undefined || doc.toolName === args.toolName) &&
    (from === undefined ||
      (doc.occurredAt !== undefined && doc.occurredAt >= from)) &&
    (to === undefined || (doc.occurredAt !== undefined && doc.occurredAt <= to))
  );
};

const baseMatch = (doc: SearchDocument, score: number) => ({
  searchDocumentId: doc.searchDocumentId,
  sourceTable: doc.sourceTable,
  sourceId: doc.sourceId,
  family: doc.family,
  title: doc.title,
  summary: doc.summary,
  projectIdentityKey: doc.canonicalProjectIdentityKey,
  machineId: doc.machineId,
  provider: doc.provider,
  agentName: doc.agentName,
  role: doc.role,
  kind: doc.kind,
  toolName: doc.toolName,
  occurredAt: doc.occurredAt,
  sourcePath: doc.sourcePath,
  sourceRef: doc.sourceRef,
  score,
});

type SearchMatch = ReturnType<typeof baseMatch>;
type SearchDiagnostics = {
  readonly textSearched: boolean;
  readonly semanticSearched: boolean;
  readonly semanticStatus?: string;
  readonly embeddingDimensions?: number;
};
type SearchResult = {
  readonly mode: "text" | "semantic" | "fusion";
  readonly query: string;
  readonly limit: number;
  readonly matches: SearchMatch[];
  readonly diagnostics: SearchDiagnostics;
};
type RagSyncResult =
  | { readonly status: "missing" | "stale" | "skipped" | "failed" }
  | { readonly status: "ready"; readonly entryId?: string };

const searchArgs = {
    query: v.string(),
    projectIdentityKey: v.optional(v.string()),
    machineId: v.optional(v.string()),
    provider: v.optional(provider),
    agentName: v.optional(v.string()),
	    role: v.optional(role),
	    kind: v.optional(eventKind),
	    toolName: v.optional(v.string()),
	    from: v.optional(v.string()),
	    to: v.optional(v.string()),
	    limit: v.optional(v.number()),
	  };

type SearchArgs = {
  query: string;
  projectIdentityKey?: string;
  machineId?: string;
  provider?: SearchDocument["provider"];
  agentName?: string;
  role?: SearchDocument["role"];
  kind?: SearchDocument["kind"];
  toolName?: string;
  from?: string;
  to?: string;
  limit?: number;
};

const textSearchHandler = async (
  ctx: QueryCtx,
  args: SearchArgs,
): Promise<SearchResult> => {
    const queryText = args.query.trim();
    if (queryText.length === 0) throw new Error("Search query is required.");
    const limit = boundedLimit(args.limit);
    const takeLimit = Math.min(1000, Math.max(200, limit * 20));
    const rows =
      args.projectIdentityKey !== undefined
        ? await ctx.db
            .query("searchDocuments")
            .withSearchIndex("search_text", (q) =>
              q.search("searchText", queryText).eq("activeProject", canonicalFilter(args.projectIdentityKey!)),
            )
            .take(takeLimit)
        : args.machineId !== undefined
          ? await ctx.db
              .query("searchDocuments")
              .withSearchIndex("search_text", (q) =>
                q.search("searchText", queryText).eq("activeMachine", machineFilter(args.machineId!)),
              )
              .take(takeLimit)
          : args.provider !== undefined
            ? await ctx.db
                .query("searchDocuments")
                .withSearchIndex("search_text", (q) =>
                  q.search("searchText", queryText).eq("activeProvider", providerFilter(args.provider!)),
                )
                .take(takeLimit)
            : args.kind !== undefined
              ? await ctx.db
                  .query("searchDocuments")
                  .withSearchIndex("search_text", (q) =>
                    q.search("searchText", queryText).eq("activeKind", kindFilter(args.kind!)),
                  )
                  .take(takeLimit)
              : await ctx.db
                  .query("searchDocuments")
                  .withSearchIndex("search_text", (q) => q.search("searchText", queryText))
                  .take(takeLimit);
    const matches = rows
      .filter((doc) => matchesFilters(doc, args))
      .slice(0, limit)
      .map((doc, index) => baseMatch(doc, 1 / (RRF_K + index + 1)));
    return {
      mode: "text",
      query: queryText,
      limit,
      matches,
      diagnostics: { textSearched: true, semanticSearched: false },
    };
  };

export const textSearchInternal = internalQuery({
  args: searchArgs,
  handler: textSearchHandler,
});

export const fetchSearchDocumentsInternal = internalQuery({
  args: { searchDocumentIds: v.array(v.string()) },
  handler: async (ctx, args) => {
    const docs: SearchDocument[] = [];
    for (const searchDocumentId of args.searchDocumentIds) {
      const doc = await ctx.db
        .query("searchDocuments")
        .withIndex("by_searchDocumentId", (q) => q.eq("searchDocumentId", searchDocumentId))
        .unique();
      if (doc !== null) docs.push(doc);
    }
    return docs;
  },
});

export const fetchSearchDocumentByIdInternal = internalQuery({
  args: { id: v.id("searchDocuments") },
  handler: async (ctx, args) => await ctx.db.get(args.id),
});

export const patchSearchDocumentRagInternal = internalMutation({
  args: {
    id: v.id("searchDocuments"),
    ragEntryId: v.optional(v.string()),
    ragContentHash: v.optional(v.string()),
    ragSyncState: v.union(v.literal("pending"), v.literal("syncing"), v.literal("ready"), v.literal("skipped"), v.literal("failed")),
    ragError: v.optional(v.string()),
    ragSyncedAt: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.id, {
      ragEntryId: args.ragEntryId,
      ragContentHash: args.ragContentHash,
      ragSyncState: args.ragSyncState,
      ragError: args.ragError,
      ragSyncedAt: args.ragSyncedAt,
    });
  },
});

export const completeSearchDocumentRagInternal = internalMutation({
  args: {
    id: v.id("searchDocuments"),
    expectedContentHash: v.string(),
    ragEntryId: v.string(),
  },
  handler: async (ctx, args) => {
    const doc = await ctx.db.get(args.id);
    if (doc === null) return { status: "missing" };
    if (doc.ragContentHash !== args.expectedContentHash) {
      return { status: "stale" };
    }
    await ctx.db.patch(args.id, {
      ragEntryId: args.ragEntryId,
      ragContentHash: args.expectedContentHash,
      ragSyncState: "ready",
      ragError: undefined,
      ragSyncedAt: Date.now(),
    });
    return { status: "ready" };
  },
});

export const syncSearchDocumentRagInternal = internalAction({
  args: {
    searchDocumentId: v.id("searchDocuments"),
    expectedContentHash: v.string(),
  },
  handler: async (ctx, args): Promise<RagSyncResult> => {
    const doc = (await ctx.runQuery(internal.quasar.fetchSearchDocumentByIdInternal, {
      id: args.searchDocumentId,
    })) as SearchDocument | null;
    if (doc === null) return { status: "missing" };
    if (doc.ragContentHash !== args.expectedContentHash) {
      return { status: "stale" };
    }
    if (!serverEmbeddingsConfigured()) {
      await ctx.runMutation(internal.quasar.patchSearchDocumentRagInternal, {
        id: args.searchDocumentId,
        ragSyncState: "skipped",
      });
      return { status: "skipped" };
    }
      await ctx.runMutation(internal.quasar.patchSearchDocumentRagInternal, {
        id: args.searchDocumentId,
        ragSyncState: "syncing",
        ragContentHash: args.expectedContentHash,
      });
    try {
      const chunks = await Effect.runPromise(
        embedDocumentChunksEffect({ title: doc.title, text: doc.searchText }),
      );
      const result = await quasarRag.add(ctx, {
        namespace: QUASAR_RAG_NAMESPACE,
        key: doc.searchDocumentId,
        title: doc.title,
        chunks,
        contentHash: args.expectedContentHash,
        filterValues: [
          { name: "canonicalProjectIdentityKey", value: doc.canonicalProjectIdentityKey },
          { name: "machineId", value: doc.machineId },
          { name: "provider", value: doc.provider ?? "unknown" },
        ],
        metadata: {
          searchDocumentId: doc.searchDocumentId,
          sourceTable: doc.sourceTable,
          sourceId: doc.sourceId,
        },
      });
      const completion = (await ctx.runMutation(internal.quasar.completeSearchDocumentRagInternal, {
        id: args.searchDocumentId,
        ragEntryId: result.entryId,
        expectedContentHash: args.expectedContentHash,
      })) as RagSyncResult;
      return completion.status === "ready"
        ? { status: "ready", entryId: result.entryId }
        : completion;
    } catch (error) {
      await ctx.runMutation(internal.quasar.patchSearchDocumentRagInternal, {
        id: args.searchDocumentId,
        ragSyncState: "failed",
        ragError: error instanceof Error ? error.message : String(error),
      });
      return { status: "failed" };
    }
  },
});

const ragFilters = (args: {
  readonly projectIdentityKey?: string;
  readonly machineId?: string;
  readonly provider?: string;
}): EntryFilter<QuasarRagFilters>[] => {
  const filters: EntryFilter<QuasarRagFilters>[] = [];
  if (args.projectIdentityKey !== undefined) {
    filters.push({ name: "canonicalProjectIdentityKey", value: args.projectIdentityKey });
  }
  if (args.machineId !== undefined) filters.push({ name: "machineId", value: args.machineId });
  if (args.provider !== undefined) filters.push({ name: "provider", value: args.provider });
  return filters;
};

const semanticSearchHandler = async (
  ctx: ActionCtx,
  args: SearchArgs,
): Promise<SearchResult> => {
    const queryText = args.query.trim();
    const limit = boundedLimit(args.limit);
    if (!serverEmbeddingsConfigured()) {
      return {
        mode: "semantic",
        query: queryText,
        limit,
        matches: [],
        diagnostics: {
          textSearched: false,
          semanticSearched: false,
          semanticStatus: "embedding_provider_unconfigured",
          embeddingDimensions: QUASAR_EMBEDDING_DIMENSIONS,
        },
      };
    }
    const embedding = await Effect.runPromise(embedQueryEffect(queryText));
    const result = await quasarRag.search(ctx, {
      namespace: QUASAR_RAG_NAMESPACE,
      query: embedding,
      filters: ragFilters(args),
      limit: Math.min(200, limit * 5),
      searchType: "vector",
    });
    const ids = result.entries
      .map((entry) => (entry.metadata as Record<string, unknown> | undefined)?.searchDocumentId)
      .filter((id): id is string => typeof id === "string");
    const docs = (await ctx.runQuery(internal.quasar.fetchSearchDocumentsInternal, {
      searchDocumentIds: ids,
    })) as SearchDocument[];
    const scores = new Map(result.results.map((item, index) => [String(item.entryId), 1 / (RRF_K + index + 1)]));
    const matches = docs
      .filter((doc: SearchDocument) => matchesFilters(doc, args))
      .slice(0, limit)
      .map((doc: SearchDocument, index: number) =>
        baseMatch(doc, scores.get(doc.ragEntryId ?? "") ?? 1 / (RRF_K + index + 1)),
      );
    return {
      mode: "semantic",
      query: queryText,
      limit,
      matches,
      diagnostics: {
        textSearched: false,
        semanticSearched: true,
        semanticStatus: "ready",
        embeddingDimensions: QUASAR_EMBEDDING_DIMENSIONS,
      },
    };
  };

export const fusionSearchInternal = internalAction({
  args: searchArgs,
  handler: async (ctx, args): Promise<SearchResult> => {
    const text = (await ctx.runQuery(
      internal.quasar.textSearchInternal,
      args,
    )) as SearchResult;
    const semantic = (await ctx.runAction(
      internal.quasar.semanticSearchInternal,
      args,
    )) as SearchResult;
    const byId = new Map<string, SearchMatch>();
    for (const match of [...text.matches, ...semantic.matches]) {
      const id = match.searchDocumentId;
      const current = byId.get(id);
      byId.set(id, {
        ...current,
        ...match,
        score: (current?.score ?? 0) + match.score,
      });
    }
    const limit = boundedLimit(args.limit);
    return {
      mode: "fusion",
      query: args.query,
      limit,
      matches: [...byId.values()].sort((left, right) => Number(right.score) - Number(left.score)).slice(0, limit),
      diagnostics: {
        textSearched: true,
        semanticSearched: semantic.diagnostics.semanticSearched,
        semanticStatus: semantic.diagnostics.semanticStatus,
        embeddingDimensions: semantic.diagnostics.embeddingDimensions,
      },
    };
  },
});

export const semanticSearchInternal = internalAction({
  args: searchArgs,
  handler: semanticSearchHandler,
});
