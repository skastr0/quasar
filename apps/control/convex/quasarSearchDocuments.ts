import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";
import { serverEmbeddingsConfigured } from "./quasarRag";
import type {
  SearchArgs,
  SearchDocument,
  SearchDocumentInsert,
  SearchDocumentUpsertInput,
} from "./quasarSearchTypes";
import {
  compactText,
  hashText,
  MAX_SEARCH_TEXT_LENGTH,
  MAX_SUMMARY_LENGTH,
  truncate,
  wideHash,
} from "./quasarText";
import {
  canonicalFilter,
  kindFilter,
  machineFilter,
  parseDateBound,
  providerFilter,
} from "./quasarValues";

export const searchDocumentRagContentHash = (doc: {
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

export const scheduleSearchDocumentRagSync = async (
  ctx: MutationCtx,
  searchDocumentId: Id<"searchDocuments">,
  expectedContentHash: string,
) => {
  if (!serverEmbeddingsConfigured()) return;
  const state = ctx as MutationCtx & { __quasarRagSchedules?: number };
  state.__quasarRagSchedules = state.__quasarRagSchedules ?? 0;
  if (state.__quasarRagSchedules >= 900) return;
  state.__quasarRagSchedules += 1;
  await ctx.scheduler.runAfter(5 * 60_000, internal.quasar.syncSearchDocumentRagInternal, {
    searchDocumentId,
    expectedContentHash,
  });
};

export const upsertSearchDocument = async (
  ctx: MutationCtx,
  input: SearchDocumentUpsertInput,
) => {
  const now = Date.now();
  const searchText = truncate(input.searchText, MAX_SEARCH_TEXT_LENGTH);
  const ragContentHash = searchDocumentRagContentHash({ ...input, searchText });
  const existing = await findSearchDocument(ctx, input.searchDocumentId);
  const patch = searchDocumentPatch(input, searchText, ragContentHash, now);

  if (existing === null) {
    const id = await ctx.db.insert("searchDocuments", { ...patch, createdAt: now });
    await scheduleSearchDocumentRagSync(ctx, id, ragContentHash);
    return id;
  }

  const changed =
    existing.searchTextHash !== patch.searchTextHash ||
    existing.ragContentHash !== ragContentHash;
  await ctx.db.patch(existing._id, patch);
  if (changed || existing.ragSyncState === "pending" || existing.ragSyncState === undefined) {
    await scheduleSearchDocumentRagSync(ctx, existing._id, ragContentHash);
  }
  return existing._id;
};

const findSearchDocument = async (ctx: MutationCtx, searchDocumentId: string) =>
  await ctx.db
    .query("searchDocuments")
    .withIndex("by_searchDocumentId", (q) => q.eq("searchDocumentId", searchDocumentId))
    .unique();

const searchDocumentPatch = (
  input: SearchDocumentUpsertInput,
  searchText: string,
  ragContentHash: string,
  now: number,
): Omit<SearchDocumentInsert, "createdAt"> => ({
  ...input,
  summary:
    input.summary === undefined
      ? undefined
      : truncate(compactText(input.summary), MAX_SUMMARY_LENGTH),
  searchText,
  searchTextHash: hashText(searchText),
  activeProject: canonicalFilter(input.canonicalProjectIdentityKey),
  activeMachine: machineFilter(input.machineId),
  activeProvider:
    input.provider === undefined ? undefined : providerFilter(input.provider),
  activeKind: input.kind === undefined ? undefined : kindFilter(input.kind),
  ragContentHash: serverEmbeddingsConfigured() ? ragContentHash : undefined,
  ragSyncState: serverEmbeddingsConfigured() ? "pending" : "skipped",
  ragError: undefined,
  updatedAt: now,
});

export const deleteSearchDocumentById = async (
  ctx: MutationCtx,
  searchDocumentId: string,
) => {
  const doc = await findSearchDocument(ctx, searchDocumentId);
  if (doc !== null) await ctx.db.delete(doc._id);
};

export const matchesFilters = (doc: SearchDocument, args: SearchArgs) => {
  const from = parseDateBound(args.from, "from");
  const to = parseDateBound(args.to, "to");
  return (
    matchesProject(doc, args.projectIdentityKey) &&
    (args.machineId === undefined || doc.machineId === args.machineId) &&
    (args.provider === undefined || doc.provider === args.provider) &&
    (args.agentName === undefined || doc.agentName === args.agentName) &&
    (args.role === undefined || doc.role === args.role) &&
    (args.kind === undefined || doc.kind === args.kind) &&
    (args.toolName === undefined || doc.toolName === args.toolName) &&
    (from === undefined || (doc.occurredAt !== undefined && doc.occurredAt >= from)) &&
    (to === undefined || (doc.occurredAt !== undefined && doc.occurredAt <= to))
  );
};

const matchesProject = (doc: SearchDocument, projectIdentityKey: string | undefined) =>
  projectIdentityKey === undefined ||
  doc.canonicalProjectIdentityKey === projectIdentityKey ||
  doc.projectIdentityKey === projectIdentityKey;

export const baseMatch = (doc: SearchDocument, score: number) => ({
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
