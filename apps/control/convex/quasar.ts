import { v } from "convex/values";

import { internalAction, internalMutation, internalQuery } from "./_generated/server";
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
import { syncSearchDocumentRagHandler } from "./quasarRagSync";
import {
  fusionSearchHandler,
  semanticSearchHandler,
  textSearchHandler,
} from "./quasarSearchHandlers";
import type { RagSyncResult, SearchDocument } from "./quasarSearchTypes";
import { provider, searchArgs } from "./quasarValues";

const ragSyncState = v.union(
  v.literal("pending"),
  v.literal("syncing"),
  v.literal("ready"),
  v.literal("skipped"),
  v.literal("failed"),
);

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
  handler: aliasProjectHandler,
});

export const listProjectsInternal = internalQuery({
  args: {},
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
    limit: v.optional(v.number()),
  },
  handler: listSessionsHandler,
});

export const readSessionInternal = internalQuery({
  args: { sessionId: v.string() },
  handler: readSessionHandler,
});

export const listToolCallsInternal = internalQuery({
  args: {
    toolCallId: v.optional(v.string()),
    sessionId: v.optional(v.string()),
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
  handler: async (ctx, args): Promise<RagSyncResult> => {
    const doc = await ctx.db.get(args.id);
    if (doc === null) return { status: "missing" };
    if (doc.ragContentHash !== args.expectedContentHash) return { status: "stale" };
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
  handler: syncSearchDocumentRagHandler,
});

export const semanticSearchInternal = internalAction({
  args: searchArgs,
  handler: semanticSearchHandler,
});

export const fusionSearchInternal = internalAction({
  args: searchArgs,
  handler: fusionSearchHandler,
});
