import { v } from "convex/values";

import { internal } from "./_generated/api";
import { internalAction, internalMutation, internalQuery } from "./_generated/server";
import {
  decodeBoundarySync,
  decodeEmbeddingChunksSync,
  EmbeddingCachePutInput,
  EmbeddingControlInput,
} from "./quasarDomainSchemas";
import {
  embeddingReadinessForSearchFilters,
  updateEmbeddingReadinessAggregates,
} from "./quasarEmbeddingReadiness";
import {
  cancelImportJobHandler,
  claimImportChunkHandler,
  claimImportJobWorkerHandler,
  enqueueImportChunkHandler,
  listImportJobsHandler,
  markImportChunkFailedHandler,
  markImportChunkSucceededHandler,
  processImportJobChunksHandler,
  readImportJobHandler,
  releaseImportJobWorkerHandler,
  scheduleImportWorkerMutationHandler,
  startImportJobHandler,
  submitImportChunkHandler,
  submitImportChunksHandler,
} from "./quasarIngestJobs";
import { ingestBatchHandler } from "./quasarIngestSessions";
import {
  aliasProjectHandler,
  listProjectsHandler,
} from "./quasarProjectHandlers";
import {
  listImportRunsHandler,
  listSessionsHandler,
  listToolCallsHandler,
  readSessionHandler,
} from "./quasarReadHandlers";
import {
  drainEmbeddingOutboxHandler,
  syncSearchDocumentRagHandler,
} from "./quasarRagSync";
import { QUASAR_EMBEDDING_DIMENSIONS } from "./quasarRag";
import {
  fusionSearchHandler,
  semanticSearchHandler,
  textSearchHandler,
} from "./quasarSearchHandlers";
import type { RagSyncResult, SearchDocument } from "./quasarSearchTypes";
import { requeueSearchDocumentEmbedding } from "./quasarSearchDocuments";
import { provider, searchArgs } from "./quasarValues";

const ragSyncState = v.union(
  v.literal("pending"),
  v.literal("syncing"),
  v.literal("ready"),
  v.literal("skipped"),
  v.literal("failed"),
  v.literal("dead_letter"),
);

const embeddingOutboxStatus = v.union(
  v.literal("pending"),
  v.literal("syncing"),
  v.literal("ready"),
  v.literal("failed"),
  v.literal("skipped"),
  v.literal("dead_letter"),
);

export const ingestBatchInternal = internalMutation({
  args: {
    batch: v.any(),
    importJobId: v.optional(v.string()),
    importChunkId: v.optional(v.string()),
    leaseToken: v.optional(v.string()),
  },
  handler: ingestBatchHandler,
});

export const startImportJobInternal = internalMutation({
  args: { input: v.any() },
  handler: startImportJobHandler,
});

export const submitImportChunkInternal = internalAction({
  args: { input: v.any() },
  handler: submitImportChunkHandler,
});

export const submitImportChunksInternal = internalAction({
  args: { input: v.any() },
  handler: submitImportChunksHandler,
});

export const enqueueImportChunkInternal = internalMutation({
  args: { input: v.any(), scheduleWorker: v.optional(v.boolean()) },
  handler: enqueueImportChunkHandler,
});

export const scheduleImportWorkerInternal = internalMutation({
  args: { importJobId: v.string(), delayMs: v.optional(v.number()) },
  handler: scheduleImportWorkerMutationHandler,
});

export const cancelImportJobInternal = internalMutation({
  args: { importJobId: v.string(), reason: v.optional(v.string()) },
  handler: cancelImportJobHandler,
});

export const processImportJobChunksInternal = internalAction({
  args: {
    importJobId: v.optional(v.string()),
    limit: v.optional(v.number()),
  },
  handler: processImportJobChunksHandler,
});

export const claimImportJobWorkerInternal = internalMutation({
  args: {
    importJobId: v.optional(v.string()),
    now: v.number(),
  },
  handler: claimImportJobWorkerHandler,
});

export const releaseImportJobWorkerInternal = internalMutation({
  args: {
    importJobId: v.optional(v.string()),
    leaseToken: v.string(),
  },
  handler: releaseImportJobWorkerHandler,
});

export const claimImportChunkInternal = internalMutation({
  args: {
    importJobId: v.optional(v.string()),
    now: v.number(),
  },
  handler: claimImportChunkHandler,
});

export const markImportChunkSucceededInternal = internalMutation({
  args: {
    importJobId: v.string(),
    chunkId: v.string(),
    leaseToken: v.string(),
  },
  handler: markImportChunkSucceededHandler,
});

export const markImportChunkFailedInternal = internalMutation({
  args: {
    importJobId: v.string(),
    chunkId: v.string(),
    leaseToken: v.string(),
    error: v.string(),
  },
  handler: markImportChunkFailedHandler,
});

export const readImportJobInternal = internalQuery({
  args: { input: v.any() },
  handler: readImportJobHandler,
});

export const listImportJobsInternal = internalQuery({
  args: { limit: v.optional(v.number()) },
  handler: listImportJobsHandler,
});

export const aliasProjectInternal = internalMutation({
  args: {
    sourceProjectIdentityKey: v.string(),
    targetProjectIdentityKey: v.string(),
    reason: v.optional(v.string()),
  },
  handler: aliasProjectHandler,
});

export const listProjectsInternal = internalQuery({
  args: {
    cursor: v.optional(v.union(v.string(), v.null())),
    limit: v.optional(v.number()),
  },
  handler: listProjectsHandler,
});

export const listImportRunsInternal = internalQuery({
  args: {},
  handler: listImportRunsHandler,
});

export const listSessionsInternal = internalQuery({
  args: {
    projectIdentityKey: v.optional(v.string()),
    machineId: v.optional(v.string()),
    provider: v.optional(provider),
    agentName: v.optional(v.string()),
    cursor: v.optional(v.union(v.string(), v.null())),
    limit: v.optional(v.number()),
  },
  handler: listSessionsHandler,
});

export const readSessionInternal = internalQuery({
  args: {
    sessionId: v.string(),
    view: v.optional(v.union(v.literal("chronological"), v.literal("branch"), v.literal("tool-expanded"))),
    leafEventId: v.optional(v.string()),
    eventCursor: v.optional(v.union(v.string(), v.null())),
    contentBlockCursor: v.optional(v.union(v.string(), v.null())),
    toolCallCursor: v.optional(v.union(v.string(), v.null())),
    edgeCursor: v.optional(v.union(v.string(), v.null())),
    usageCursor: v.optional(v.union(v.string(), v.null())),
    artifactCursor: v.optional(v.union(v.string(), v.null())),
    limit: v.optional(v.number()),
  },
  handler: readSessionHandler,
});

export const listToolCallsInternal = internalQuery({
  args: {
    toolCallId: v.optional(v.string()),
    sessionId: v.optional(v.string()),
    projectIdentityKey: v.optional(v.string()),
    machineId: v.optional(v.string()),
    provider: v.optional(provider),
    agentName: v.optional(v.string()),
    toolName: v.optional(v.string()),
    cursor: v.optional(v.union(v.string(), v.null())),
    limit: v.optional(v.number()),
  },
  handler: listToolCallsHandler,
});

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
    ragSyncState,
    ragError: v.optional(v.string()),
    ragSyncedAt: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const doc = await ctx.db.get(args.id);
    if (doc === null) return;
    const patch = {
      ragEntryId: args.ragEntryId,
      ragContentHash: args.ragContentHash,
      ragSyncState: args.ragSyncState,
      ragError: args.ragError,
      ragSyncedAt: args.ragSyncedAt,
    };
    const next = { ...doc, ...patch };
    await ctx.db.patch(args.id, patch);
    await updateEmbeddingReadinessAggregates(ctx, doc, next);
  },
});

export const completeSearchDocumentRagInternal = internalMutation({
  args: {
    id: v.id("searchDocuments"),
    expectedContentHash: v.string(),
    ragEntryId: v.string(),
  },
  handler: async (ctx, args): Promise<RagSyncResult> => {
    const doc = await ctx.db.get(args.id);
    if (doc === null) return { status: "missing" };
    if (doc.ragContentHash !== args.expectedContentHash) return { status: "stale" };
    const patch = {
      ragEntryId: args.ragEntryId,
      ragContentHash: args.expectedContentHash,
      ragSyncState: "ready",
      ragError: undefined,
      ragSyncedAt: Date.now(),
    } as const;
    const next = { ...doc, ...patch };
    await ctx.db.patch(args.id, patch);
    await updateEmbeddingReadinessAggregates(ctx, doc, next);
    return { status: "ready" };
  },
});

export const syncSearchDocumentRagInternal = internalAction({
  args: {
    searchDocumentId: v.id("searchDocuments"),
    expectedContentHash: v.string(),
  },
  handler: syncSearchDocumentRagHandler,
});

export const readEmbeddingControlInternal = internalQuery({
  args: {},
  handler: async (ctx) =>
    await ctx.db
      .query("embeddingControls")
      .withIndex("by_controlKey", (q) => q.eq("controlKey", "global"))
      .unique(),
});

export const setEmbeddingControlInternal = internalMutation({
  args: { input: v.any() },
  handler: async (ctx, args) => {
    const input = decodeBoundarySync(EmbeddingControlInput, args.input, "embedding control input");
    const now = Date.now();
    const row = await ctx.db
      .query("embeddingControls")
      .withIndex("by_controlKey", (q) => q.eq("controlKey", "global"))
      .unique();
    const paused = input.paused ?? row?.paused ?? false;
    if (row === null) {
      await ctx.db.insert("embeddingControls", {
        controlKey: "global",
        paused,
        activeDrainToken: undefined,
        activeDrainLeaseExpiresAt: undefined,
        updatedAt: now,
      });
    } else {
      await ctx.db.patch(row._id, { paused, updatedAt: now });
    }
    if (!paused) {
      await ctx.scheduler.runAfter(0, internal.quasar.drainEmbeddingOutboxInternal, {
        limit: Math.min(50, Math.max(1, Math.trunc(input.limit ?? 20))),
      });
    }
    return { paused };
  },
});

export const acquireEmbeddingDrainInternal = internalMutation({
  args: { now: v.number(), leaseMs: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const row = await ctx.db
      .query("embeddingControls")
      .withIndex("by_controlKey", (q) => q.eq("controlKey", "global"))
      .unique();
    if (row?.paused === true) return null;
    if (
      row?.activeDrainToken !== undefined &&
      row.activeDrainLeaseExpiresAt !== undefined &&
      row.activeDrainLeaseExpiresAt > args.now
    ) {
      return null;
    }
    const token = `drain:${crypto.randomUUID?.() ?? `${args.now}:${Math.random()}`}`;
    const patch = {
      paused: false,
      activeDrainToken: token,
      activeDrainLeaseExpiresAt: args.now + boundedDrainLeaseMs(args.leaseMs),
      updatedAt: args.now,
    };
    if (row === null) {
      await ctx.db.insert("embeddingControls", {
        controlKey: "global",
        ...patch,
      });
    } else {
      await ctx.db.patch(row._id, patch);
    }
    return { drainToken: token };
  },
});

export const renewEmbeddingDrainInternal = internalMutation({
  args: { drainToken: v.string(), now: v.number(), leaseMs: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const row = await ctx.db
      .query("embeddingControls")
      .withIndex("by_controlKey", (q) => q.eq("controlKey", "global"))
      .unique();
    if (row === null || row.activeDrainToken !== args.drainToken) return { renewed: false };
    await ctx.db.patch(row._id, {
      activeDrainLeaseExpiresAt: args.now + boundedDrainLeaseMs(args.leaseMs),
      updatedAt: args.now,
    });
    return { renewed: true };
  },
});

export const releaseEmbeddingDrainInternal = internalMutation({
  args: { drainToken: v.string() },
  handler: async (ctx, args) => {
    const row = await ctx.db
      .query("embeddingControls")
      .withIndex("by_controlKey", (q) => q.eq("controlKey", "global"))
      .unique();
    if (row === null || row.activeDrainToken !== args.drainToken) return { released: false };
    await ctx.db.patch(row._id, {
      activeDrainToken: undefined,
      activeDrainLeaseExpiresAt: undefined,
      updatedAt: Date.now(),
    });
    return { released: true };
  },
});

export const claimEmbeddingOutboxInternal = internalMutation({
  args: { now: v.number() },
  handler: async (ctx, args) => {
    const control = await ctx.db
      .query("embeddingControls")
      .withIndex("by_controlKey", (q) => q.eq("controlKey", "global"))
      .unique();
    if (control?.paused === true) return null;
    const row =
      (await ctx.db
        .query("embeddingOutbox")
        .withIndex("by_status_nextAttempt", (q) =>
          q.eq("status", "pending").lte("nextAttemptAt", args.now),
        )
        .first()) ??
      (await ctx.db
        .query("embeddingOutbox")
        .withIndex("by_status_lease", (q) =>
          q.eq("status", "syncing").lte("leaseExpiresAt", args.now),
        )
        .first());
    if (row === null) return null;
    const attempts = row.attempts + 1;
    const leaseToken = `outbox:${crypto.randomUUID?.() ?? `${args.now}:${Math.random()}`}`;
    await ctx.db.patch(row._id, {
      status: "syncing",
      attempts,
      leaseExpiresAt: args.now + 5 * 60_000,
      leaseToken,
      updatedAt: args.now,
    });
    return { ...row, attempts, leaseToken };
  },
});

export const completeEmbeddingOutboxInternal = internalMutation({
  args: {
    outboxKey: v.string(),
    leaseToken: v.string(),
    status: embeddingOutboxStatus,
    lastError: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const row = await ctx.db
      .query("embeddingOutbox")
      .withIndex("by_outboxKey", (q) => q.eq("outboxKey", args.outboxKey))
      .unique();
    if (row === null) return;
    if (row.leaseToken !== args.leaseToken || row.status !== "syncing") {
      return { status: "stale" };
    }
    const now = Date.now();
    if (args.status === "failed") {
      const maxAttempts = row.maxAttempts ?? 6;
      const exhausted = row.attempts >= maxAttempts;
      if (exhausted) {
        const doc = await ctx.db.get(row.searchDocumentRowId);
        if (doc !== null) {
          const patch = {
            ragSyncState: "dead_letter" as const,
            ragError: args.lastError,
            updatedAt: now,
          };
          const next = { ...doc, ...patch };
          await ctx.db.patch(doc._id, patch);
          await updateEmbeddingReadinessAggregates(ctx, doc, next);
        }
      }
      await ctx.db.patch(row._id, {
        status: exhausted ? "dead_letter" : "pending",
        lastError: args.lastError,
        leaseExpiresAt: undefined,
        leaseToken: undefined,
        nextAttemptAt: exhausted ? row.nextAttemptAt : now + embeddingRetryDelayMs(row.attempts),
        updatedAt: now,
      });
      if (!exhausted) {
        await ctx.scheduler.runAfter(embeddingRetryDelayMs(row.attempts), internal.quasar.drainEmbeddingOutboxInternal, {
          limit: 20,
        });
      }
      return;
    }
    await ctx.db.patch(row._id, {
      status: args.status,
      lastError: args.lastError,
      leaseExpiresAt: undefined,
      leaseToken: undefined,
      updatedAt: now,
    });
    return { status: args.status };
  },
});

export const retryFailedEmbeddingOutboxInternal = internalMutation({
  args: { limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const limit = Math.min(500, Math.max(1, Math.trunc(args.limit ?? 100)));
    const failed = await ctx.db
      .query("embeddingOutbox")
      .withIndex("by_status_nextAttempt", (q) => q.eq("status", "failed"))
      .take(limit);
    const dead = await ctx.db
      .query("embeddingOutbox")
      .withIndex("by_status_nextAttempt", (q) => q.eq("status", "dead_letter"))
      .take(Math.max(0, limit - failed.length));
    const now = Date.now();
    for (const row of [...failed, ...dead]) {
      await ctx.db.patch(row._id, {
        status: "pending",
        nextAttemptAt: now,
        leaseExpiresAt: undefined,
        leaseToken: undefined,
        lastError: undefined,
        updatedAt: now,
      });
    }
    await ctx.scheduler.runAfter(0, internal.quasar.drainEmbeddingOutboxInternal, {
      limit: 20,
    });
    return { retried: failed.length + dead.length };
  },
});

export const rebuildEmbeddingBackfillInternal = internalMutation({
  args: {
    projectIdentityKey: v.optional(v.string()),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const limit = Math.min(500, Math.max(1, Math.trunc(args.limit ?? 100)));
    const docs: SearchDocument[] = [];
    for (const state of ["pending", "failed", "dead_letter", "skipped"] as const) {
      if (docs.length >= limit) break;
      const page =
        args.projectIdentityKey === undefined
          ? await ctx.db
              .query("searchDocuments")
              .withIndex("by_ragSyncState", (q) => q.eq("ragSyncState", state))
              .take(limit - docs.length)
          : await ctx.db
              .query("searchDocuments")
              .withIndex("by_project_ragSyncState", (q) =>
                q
                  .eq("canonicalProjectIdentityKey", args.projectIdentityKey!)
                  .eq("ragSyncState", state),
              )
              .take(limit - docs.length);
      docs.push(...page);
    }
    let requeued = 0;
    for (const doc of docs) {
      if (doc.ragSyncState === "ready") continue;
      if (await requeueSearchDocumentEmbedding(ctx, doc)) requeued += 1;
    }
    if (requeued > 0) {
      await ctx.scheduler.runAfter(0, internal.quasar.drainEmbeddingOutboxInternal, {
        limit: 20,
      });
    }
    return { requeued };
  },
});

export const fetchEmbeddingCacheInternal = internalQuery({
  args: { embeddingCacheKey: v.string() },
  handler: async (ctx, args) =>
    await ctx.db
      .query("embeddingCache")
      .withIndex("by_embeddingCacheKey", (q) =>
        q.eq("embeddingCacheKey", args.embeddingCacheKey),
      )
      .unique(),
});

export const putEmbeddingCacheInternal = internalMutation({
  args: {
    embeddingCacheKey: v.string(),
    embeddingScopeId: v.string(),
    modelId: v.string(),
    dimensions: v.number(),
    policyVersion: v.string(),
    chunkerVersion: v.string(),
    normalizedChunkHash: v.string(),
    chunks: v.array(v.any()),
  },
  handler: async (ctx, args) => {
    const input = decodeBoundarySync(EmbeddingCachePutInput, args, "embedding cache put input");
    const chunks = decodeEmbeddingChunksSync(input.chunks, QUASAR_EMBEDDING_DIMENSIONS);
    const now = Date.now();
    const existing = await ctx.db
      .query("embeddingCache")
      .withIndex("by_embeddingCacheKey", (q) =>
        q.eq("embeddingCacheKey", input.embeddingCacheKey),
      )
      .unique();
    const patch = { ...input, chunks: [...chunks], updatedAt: now };
    if (existing === null) {
      await ctx.db.insert("embeddingCache", { ...patch, createdAt: now });
    } else {
      await ctx.db.patch(existing._id, patch);
    }
  },
});

export const embeddingReadinessInternal = internalQuery({
  args: {
    importJobId: v.optional(v.string()),
    projectIdentityKey: v.optional(v.string()),
    machineId: v.optional(v.string()),
    provider: v.optional(provider),
    agentName: v.optional(v.string()),
    role: v.optional(v.union(
      v.literal("user"),
      v.literal("assistant"),
      v.literal("developer"),
      v.literal("system"),
      v.literal("tool"),
      v.literal("thinking"),
      v.literal("unknown"),
    )),
    kind: v.optional(v.union(
      v.literal("message"),
      v.literal("tool_call"),
      v.literal("tool_result"),
      v.literal("reasoning"),
      v.literal("preamble"),
      v.literal("system"),
      v.literal("summary"),
      v.literal("edit"),
      v.literal("snapshot"),
      v.literal("lifecycle"),
      v.literal("usage"),
      v.literal("unknown"),
    )),
    toolName: v.optional(v.string()),
    from: v.optional(v.string()),
    to: v.optional(v.string()),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => await embeddingReadinessForSearchFilters(ctx, args),
});

export const drainEmbeddingOutboxInternal = internalAction({
  args: { limit: v.optional(v.number()) },
  handler: drainEmbeddingOutboxHandler,
});

export const semanticSearchInternal = internalAction({
  args: searchArgs,
  handler: semanticSearchHandler,
});

export const fusionSearchInternal = internalAction({
  args: searchArgs,
  handler: fusionSearchHandler,
});

const embeddingRetryDelayMs = (attempts: number) =>
  Math.min(60 * 60_000, 30_000 * 2 ** Math.min(6, attempts));

const boundedDrainLeaseMs = (leaseMs: number | undefined) =>
  Math.min(6 * 60 * 60_000, Math.max(15 * 60_000, Math.trunc(leaseMs ?? 15 * 60_000)));
