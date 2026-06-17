import { v } from "convex/values";
import { internalMutation, internalQuery } from "./_generated/server";

export const listForHash = internalQuery({
  args: { contentHash: v.string() },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("embeddingCache")
      .withIndex("by_contentHash", (q) => q.eq("contentHash", args.contentHash))
      .collect();
  },
});

export const lookup = internalQuery({
  args: { contentHashes: v.array(v.string()) },
  handler: async (ctx, args): Promise<Readonly<Record<string, readonly number[]>>> => {
    const byHash: Record<string, readonly number[]> = {};
    for (const contentHash of args.contentHashes) {
      const row = await ctx.db
        .query("embeddingCache")
        .withIndex("by_contentHash", (q) => q.eq("contentHash", contentHash))
        .unique();
      if (row !== null) {
        byHash[contentHash] = row.vector;
      }
    }
    return byHash;
  },
});

export const store = internalMutation({
  args: {
    entries: v.array(
      v.object({
        contentHash: v.string(),
        vector: v.array(v.number()),
      }),
    ),
  },
  handler: async (ctx, args) => {
    const now = Date.now();
    for (const entry of args.entries) {
      const existing = await ctx.db
        .query("embeddingCache")
        .withIndex("by_contentHash", (q) => q.eq("contentHash", entry.contentHash))
        .unique();
      if (existing === null) {
        await ctx.db.insert("embeddingCache", {
          contentHash: entry.contentHash,
          vector: entry.vector,
          createdAt: now,
        });
      }
    }
  },
});
