import { Effect } from "effect";
import type { InputChunk } from "@convex-dev/rag";

import { internal } from "./_generated/api";
import type { ActionCtx } from "./_generated/server";
import {
  QUASAR_RAG_NAMESPACE,
  embedDocumentChunksEffect,
  QUASAR_EMBEDDING_DIMENSIONS,
  QUASAR_EMBEDDING_MODEL_ID,
  quasarRag,
  serverEmbeddingsConfigured,
} from "./quasarRag";
import {
  decodeEmbeddingChunksSync,
} from "./quasarDomainSchemas";
import {
  EMBEDDING_CHUNKER_VERSION,
  EMBEDDING_POLICY_VERSION,
} from "./quasarSearchDocuments";
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
    return { status: "failed" };
  }
};

export const drainEmbeddingOutboxHandler = async (
  ctx: ActionCtx,
  args: { limit?: number },
) => {
  const limit = Math.max(1, Math.min(50, Math.trunc(args.limit ?? 20)));
  const leaseMs = Math.max(15 * 60_000, limit * 5 * 60_000);
  const drain = (await ctx.runMutation(internal.quasar.acquireEmbeddingDrainInternal, {
    now: Date.now(),
    leaseMs,
  })) as { drainToken: string } | null;
  if (drain === null) return { processed: 0, skipped: "active_drain" };
  let processed = 0;

  try {
    for (let index = 0; index < limit; index += 1) {
      const renewal = (await ctx.runMutation(internal.quasar.renewEmbeddingDrainInternal, {
        drainToken: drain.drainToken,
        now: Date.now(),
        leaseMs,
      })) as { renewed: boolean };
      if (!renewal.renewed) break;
      const row = (await ctx.runMutation(internal.quasar.claimEmbeddingOutboxInternal, {
        now: Date.now(),
      })) as
        | {
            outboxKey: string;
            searchDocumentRowId: unknown;
            expectedContentHash: string;
            attempts: number;
            leaseToken: string;
          }
        | null;
      if (row === null) break;
      processed += 1;
      try {
        const result = await syncSearchDocumentRagHandler(ctx, {
          searchDocumentId: row.searchDocumentRowId,
          expectedContentHash: row.expectedContentHash,
        });
        await ctx.runMutation(internal.quasar.completeEmbeddingOutboxInternal, {
          outboxKey: row.outboxKey,
          leaseToken: row.leaseToken,
          status: outboxStatusFor(result.status),
          lastError: result.status === "failed" ? "embedding sync failed" : undefined,
        });
      } catch (error) {
        await ctx.runMutation(internal.quasar.completeEmbeddingOutboxInternal, {
          outboxKey: row.outboxKey,
          leaseToken: row.leaseToken,
          status: "failed",
          lastError: error instanceof Error ? error.message : String(error),
        });
      }
      const completionRenewal = (await ctx.runMutation(internal.quasar.renewEmbeddingDrainInternal, {
        drainToken: drain.drainToken,
        now: Date.now(),
        leaseMs,
      })) as { renewed: boolean };
      if (!completionRenewal.renewed) break;
    }
  } finally {
    await ctx.runMutation(internal.quasar.releaseEmbeddingDrainInternal, {
      drainToken: drain.drainToken,
    });
  }

  if (processed === limit) {
    await ctx.scheduler.runAfter(30_000, internal.quasar.drainEmbeddingOutboxInternal, {
      limit,
    });
  }
  return { processed };
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
  const chunks = await embeddingChunksFor(ctx, doc);
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

const embeddingChunksFor = async (
  ctx: ActionCtx,
  doc: SearchDocument,
) => {
  if (doc.embeddingCacheKey !== undefined) {
    const cached = (await ctx.runQuery(internal.quasar.fetchEmbeddingCacheInternal, {
      embeddingCacheKey: doc.embeddingCacheKey,
    })) as { chunks: unknown[] } | null;
    if (cached !== null) {
      return decodeEmbeddingChunksSync(cached.chunks, QUASAR_EMBEDDING_DIMENSIONS) as InputChunk[];
    }
  }
  const text = doc.embeddingText ?? doc.searchText;
  const chunks = await Effect.runPromise(
    embedDocumentChunksEffect({ title: doc.title, text }),
  );
  if (doc.embeddingCacheKey !== undefined && doc.embeddingScopeId !== undefined) {
    await ctx.runMutation(internal.quasar.putEmbeddingCacheInternal, {
      embeddingCacheKey: doc.embeddingCacheKey,
      embeddingScopeId: doc.embeddingScopeId,
      modelId: QUASAR_EMBEDDING_MODEL_ID,
      dimensions: QUASAR_EMBEDDING_DIMENSIONS,
      policyVersion: doc.embeddingPolicyVersion ?? EMBEDDING_POLICY_VERSION,
      chunkerVersion: EMBEDDING_CHUNKER_VERSION,
      normalizedChunkHash: doc.ragContentHash ?? "",
      chunks,
    });
  }
  return chunks;
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

const outboxStatusFor = (status: RagSyncResult["status"]) =>
  status === "ready" || status === "failed" || status === "skipped"
    ? status
    : "skipped";
