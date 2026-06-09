import type { MutationCtx, QueryCtx } from "./_generated/server";
import type {
  ProviderSchema,
  SessionEventKindSchema,
  SessionRoleSchema,
} from "./quasarDomainSchemas";
import type { RagSyncState, SearchArgs, SearchDocument, SearchFamily } from "./quasarSearchTypes";

export type EmbeddingReadinessCounts = {
  readonly total: number;
  readonly pending: number;
  readonly syncing: number;
  readonly ready: number;
  readonly skipped: number;
  readonly failed: number;
  readonly deadLetter: number;
};

type ReadinessDoc = {
  readonly importJobId?: string;
  readonly canonicalProjectIdentityKey: string;
  readonly machineId?: string;
  readonly provider?: ProviderSchema;
  readonly agentName?: string;
  readonly role?: SessionRoleSchema;
  readonly kind?: SessionEventKindSchema;
  readonly toolName?: string;
  readonly family: SearchFamily;
  readonly ragSyncState?: RagSyncState;
};

type ReadinessAggregateRow = ReadinessDoc & {
  readonly ragSyncState: RagSyncState;
  readonly documentCount: number;
};

const EMPTY_COUNTS: EmbeddingReadinessCounts = {
  total: 0,
  pending: 0,
  syncing: 0,
  ready: 0,
  skipped: 0,
  failed: 0,
  deadLetter: 0,
};

export const updateEmbeddingReadinessAggregates = async (
  ctx: MutationCtx,
  before: ReadinessDoc | null,
  after: ReadinessDoc | null,
) => {
  const beforeKey = before === null ? undefined : aggregateKeyFor(before);
  const afterKey = after === null ? undefined : aggregateKeyFor(after);
  if (beforeKey !== undefined && beforeKey === afterKey) return;
  if (before !== null && beforeKey !== undefined) {
    await addToAggregate(ctx, before, -1);
  }
  if (after !== null && afterKey !== undefined) {
    await addToAggregate(ctx, after, 1);
  }
};

export const embeddingReadinessForSearchFilters = async (
  ctx: QueryCtx,
  args: Partial<SearchArgs> & { importJobId?: string },
): Promise<EmbeddingReadinessCounts> => {
  if (args.from !== undefined || args.to !== undefined) {
    return documentReadinessForDateRange(ctx, args);
  }
  const rows = await readinessRows(ctx, args);
  return readinessCounts(
    rows.filter((row) =>
      (args.importJobId === undefined || row.importJobId === args.importJobId) &&
      (args.projectIdentityKey === undefined ||
        row.canonicalProjectIdentityKey === args.projectIdentityKey) &&
      (args.machineId === undefined || row.machineId === args.machineId) &&
      (args.provider === undefined || row.provider === args.provider) &&
      (args.agentName === undefined || row.agentName === args.agentName) &&
      (args.role === undefined || row.role === args.role) &&
      (args.kind === undefined || row.kind === args.kind) &&
      (args.toolName === undefined || row.toolName === args.toolName),
    ),
  );
};

export const readinessCounts = (
  rows: readonly { ragSyncState: string; documentCount: number }[],
): EmbeddingReadinessCounts => {
  const counts = { ...EMPTY_COUNTS };
  for (const row of rows) {
    counts.total += row.documentCount;
    if (row.ragSyncState === "pending") counts.pending += row.documentCount;
    else if (row.ragSyncState === "syncing") counts.syncing += row.documentCount;
    else if (row.ragSyncState === "ready") counts.ready += row.documentCount;
    else if (row.ragSyncState === "skipped") counts.skipped += row.documentCount;
    else if (row.ragSyncState === "failed") counts.failed += row.documentCount;
    else if (row.ragSyncState === "dead_letter") counts.deadLetter += row.documentCount;
  }
  return counts;
};

const readinessRows = async (
  ctx: QueryCtx,
  args: Partial<SearchArgs> & { importJobId?: string },
): Promise<ReadinessAggregateRow[]> => {
  if (args.importJobId !== undefined) {
    return await ctx.db
      .query("embeddingReadiness")
      .withIndex("by_job", (q) => q.eq("importJobId", args.importJobId))
      .take(READINESS_TAKE_LIMIT);
  }
  if (args.projectIdentityKey !== undefined) {
    return await ctx.db
      .query("embeddingReadiness")
      .withIndex("by_project", (q) =>
        q.eq("canonicalProjectIdentityKey", args.projectIdentityKey!),
      )
      .take(READINESS_TAKE_LIMIT);
  }
  if (args.provider !== undefined) {
    return await ctx.db
      .query("embeddingReadiness")
      .withIndex("by_provider", (q) => q.eq("provider", args.provider!))
      .take(READINESS_TAKE_LIMIT);
  }
  const rows: ReadinessAggregateRow[] = [];
  for (const state of ["pending", "syncing", "ready", "skipped", "failed", "dead_letter"] as const) {
    rows.push(
      ...(await ctx.db
        .query("embeddingReadiness")
        .withIndex("by_state", (q) => q.eq("ragSyncState", state))
        .take(READINESS_TAKE_LIMIT)),
    );
  }
  return rows;
};

const documentReadinessForDateRange = async (
  ctx: QueryCtx,
  args: Partial<SearchArgs> & { importJobId?: string },
) => {
  const fromMs = dateBound(args.from);
  const toMs = dateBound(args.to);
  const rows: SearchDocument[] =
    args.projectIdentityKey === undefined
      ? await queryDocumentsByOccurredAt(ctx, fromMs, toMs)
      : await queryProjectDocumentsByOccurredAt(ctx, args.projectIdentityKey, fromMs, toMs);
  return readinessCounts(
    rows
      .filter((row) =>
        (args.importJobId === undefined || row.importJobId === args.importJobId) &&
        (args.projectIdentityKey === undefined ||
          row.canonicalProjectIdentityKey === args.projectIdentityKey) &&
        (args.machineId === undefined || row.machineId === args.machineId) &&
        (args.provider === undefined || row.provider === args.provider) &&
        (args.agentName === undefined || row.agentName === args.agentName) &&
        (args.role === undefined || row.role === args.role) &&
        (args.kind === undefined || row.kind === args.kind) &&
        (args.toolName === undefined || row.toolName === args.toolName),
      )
      .map((row) => ({ ragSyncState: row.ragSyncState ?? "skipped", documentCount: 1 })),
  );
};

const queryDocumentsByOccurredAt = async (
  ctx: QueryCtx,
  fromMs: number | undefined,
  toMs: number | undefined,
) => {
  if (fromMs !== undefined && toMs !== undefined) {
    return await ctx.db
      .query("searchDocuments")
      .withIndex("by_occurredAt", (q) => q.gte("occurredAt", fromMs).lte("occurredAt", toMs))
      .take(READINESS_TAKE_LIMIT);
  }
  if (fromMs !== undefined) {
    return await ctx.db
      .query("searchDocuments")
      .withIndex("by_occurredAt", (q) => q.gte("occurredAt", fromMs))
      .take(READINESS_TAKE_LIMIT);
  }
  if (toMs !== undefined) {
    return await ctx.db
      .query("searchDocuments")
      .withIndex("by_occurredAt", (q) => q.lte("occurredAt", toMs))
      .take(READINESS_TAKE_LIMIT);
  }
  return await ctx.db
    .query("searchDocuments")
    .withIndex("by_occurredAt")
    .take(READINESS_TAKE_LIMIT);
};

const queryProjectDocumentsByOccurredAt = async (
  ctx: QueryCtx,
  projectIdentityKey: string,
  fromMs: number | undefined,
  toMs: number | undefined,
) => {
  if (fromMs !== undefined && toMs !== undefined) {
    return await ctx.db
      .query("searchDocuments")
      .withIndex("by_project_occurredAt", (q) =>
        q
          .eq("canonicalProjectIdentityKey", projectIdentityKey)
          .gte("occurredAt", fromMs)
          .lte("occurredAt", toMs),
      )
      .take(READINESS_TAKE_LIMIT);
  }
  if (fromMs !== undefined) {
    return await ctx.db
      .query("searchDocuments")
      .withIndex("by_project_occurredAt", (q) =>
        q.eq("canonicalProjectIdentityKey", projectIdentityKey).gte("occurredAt", fromMs),
      )
      .take(READINESS_TAKE_LIMIT);
  }
  if (toMs !== undefined) {
    return await ctx.db
      .query("searchDocuments")
      .withIndex("by_project_occurredAt", (q) =>
        q.eq("canonicalProjectIdentityKey", projectIdentityKey).lte("occurredAt", toMs),
      )
      .take(READINESS_TAKE_LIMIT);
  }
  return await ctx.db
    .query("searchDocuments")
    .withIndex("by_project_occurredAt", (q) => q.eq("canonicalProjectIdentityKey", projectIdentityKey))
    .take(READINESS_TAKE_LIMIT);
};

const dateBound = (value: string | undefined) => {
  if (value === undefined) return undefined;
  const millis = Date.parse(value);
  return Number.isFinite(millis) ? millis : undefined;
};

const addToAggregate = async (
  ctx: MutationCtx,
  doc: ReadinessDoc,
  delta: 1 | -1,
) => {
  const key = aggregateKeyFor(doc);
  if (key === undefined) return;
  const existing = await ctx.db
    .query("embeddingReadiness")
    .withIndex("by_aggregateKey", (q) => q.eq("aggregateKey", key))
    .unique();
  const now = Date.now();
  const documentCount = Math.max(0, (existing?.documentCount ?? 0) + delta);
  if (existing === null) {
    if (documentCount === 0) return;
    await ctx.db.insert("embeddingReadiness", {
      aggregateKey: key,
      importJobId: doc.importJobId,
      canonicalProjectIdentityKey: doc.canonicalProjectIdentityKey,
      machineId: doc.machineId,
      provider: doc.provider,
      agentName: doc.agentName,
      role: doc.role,
      kind: doc.kind,
      toolName: doc.toolName,
      family: doc.family,
      ragSyncState: doc.ragSyncState!,
      documentCount,
      updatedAt: now,
    });
  } else {
    await ctx.db.patch(existing._id, { documentCount, updatedAt: now });
  }
};

const aggregateKeyFor = (doc: ReadinessDoc) => {
  if (doc.ragSyncState === undefined) return undefined;
  return [
    doc.importJobId ?? "no-job",
    doc.canonicalProjectIdentityKey,
    doc.machineId ?? "all-machines",
    doc.provider ?? "unknown",
    doc.agentName ?? "all-agents",
    doc.role ?? "all-roles",
    doc.kind ?? "all-kinds",
    doc.toolName ?? "all-tools",
    doc.family,
    doc.ragSyncState,
  ].join("\u001f");
};

const READINESS_TAKE_LIMIT = 5000;
