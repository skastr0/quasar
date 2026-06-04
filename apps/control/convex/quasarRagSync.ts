import { Effect } from "effect";

import { internal } from "./_generated/api";
import type { ActionCtx } from "./_generated/server";
import {
  QUASAR_RAG_NAMESPACE,
  embedDocumentChunksEffect,
  quasarRag,
  serverEmbeddingsConfigured,
} from "./quasarRag";
import type { RagSyncResult, SearchDocument } from "./quasarSearchTypes";

export const syncSearchDocumentRagHandler = async (
  ctx: ActionCtx,
  args: { searchDocumentId: unknown; expectedContentHash: string },
): Promise<RagSyncResult> => {
  const doc = (await ctx.runQuery(internal.quasar.fetchSearchDocumentByIdInternal, {
    id: args.searchDocumentId as never,
  })) as SearchDocument | null;
  if (doc === null) return { status: "missing" };
  if (doc.ragContentHash !== args.expectedContentHash) return { status: "stale" };
  if (process.env.QUASAR_RAG_SYNC_PAUSED === "1") return { status: "skipped" };
  if (!serverEmbeddingsConfigured()) return await markSkipped(ctx, args.searchDocumentId);

  await markSyncing(ctx, args.searchDocumentId, args.expectedContentHash);
  try {
    const entryId = await addRagEntry(ctx, doc, args.expectedContentHash);
    return await completeRagSync(ctx, args.searchDocumentId, args.expectedContentHash, entryId);
  } catch (error) {
    await markFailed(ctx, args.searchDocumentId, error);
    return { status: "failed" };
  }
};

const markSkipped = async (
  ctx: ActionCtx,
  id: unknown,
): Promise<RagSyncResult> => {
  await ctx.runMutation(internal.quasar.patchSearchDocumentRagInternal, {
    id: id as never,
    ragSyncState: "skipped",
  });
  return { status: "skipped" };
};

const markSyncing = async (
  ctx: ActionCtx,
  id: unknown,
  expectedContentHash: string,
) =>
  await ctx.runMutation(internal.quasar.patchSearchDocumentRagInternal, {
    id: id as never,
    ragSyncState: "syncing",
    ragContentHash: expectedContentHash,
  });

const addRagEntry = async (
  ctx: ActionCtx,
  doc: SearchDocument,
  expectedContentHash: string,
) => {
  const chunks = await Effect.runPromise(
    embedDocumentChunksEffect({ title: doc.title, text: doc.searchText }),
  );
  const result = await quasarRag.add(ctx, {
    namespace: QUASAR_RAG_NAMESPACE,
    key: doc.searchDocumentId,
    title: doc.title,
    chunks,
    contentHash: expectedContentHash,
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
  return result.entryId;
};

const completeRagSync = async (
  ctx: ActionCtx,
  id: unknown,
  expectedContentHash: string,
  entryId: string,
): Promise<RagSyncResult> => {
  const completion = (await ctx.runMutation(
    internal.quasar.completeSearchDocumentRagInternal,
    {
      id: id as never,
      ragEntryId: entryId,
      expectedContentHash,
    },
  )) as RagSyncResult;
  return completion.status === "ready"
    ? { status: "ready", entryId }
    : completion;
};

const markFailed = async (ctx: ActionCtx, id: unknown, error: unknown) =>
  await ctx.runMutation(internal.quasar.patchSearchDocumentRagInternal, {
    id: id as never,
    ragSyncState: "failed",
    ragError: error instanceof Error ? error.message : String(error),
  });
