import { v } from "convex/values";
import { internalQuery } from "./_generated/server";

const MESSAGES_PER_SESSION_LIMIT = 10_000;

export const messagesForBatchIndex = internalQuery({
  args: { sessionId: v.string() },
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query("messages")
      .withIndex("by_sessionId_and_seq", (q) => q.eq("sessionId", args.sessionId))
      .take(MESSAGES_PER_SESSION_LIMIT);
    return rows
      .filter((row) => row.role === "user" || row.role === "assistant")
      .map((row) => ({
        sessionId: row.sessionId,
        seq: row.seq,
        role: row.role as "user" | "assistant",
        projectKey: row.projectKey,
        text: row.text,
      }));
  },
});
