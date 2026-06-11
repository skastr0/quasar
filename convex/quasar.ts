import { paginationOptsValidator } from "convex/server";
import { v } from "convex/values";
import { mutation, query } from "./_generated/server";

const roleValidator = v.union(
  v.literal("user"),
  v.literal("assistant"),
  v.literal("reasoning"),
);

/** Per-mutation delete batch, within Convex's small-instant-mutation opinion. */
const DELETE_BATCH = 200;

/** Hard upper bound on search results returned in one call. */
const SEARCH_TAKE_MAX = 20;

/** Upper bound for the single-shot project listing (single tenant, ~tens of rows). */
const LIST_PROJECTS_MAX = 1000;

// ---------------------------------------------------------------------------
// Mutations
// ---------------------------------------------------------------------------

export const upsertProject = mutation({
  args: {
    projectKey: v.string(),
    displayName: v.string(),
    aliases: v.array(v.string()),
    rawPaths: v.array(v.string()),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("projects")
      .withIndex("by_projectKey", (q) => q.eq("projectKey", args.projectKey))
      .unique();
    if (existing === null) {
      await ctx.db.insert("projects", args);
      return null;
    }
    await ctx.db.patch(existing._id, {
      displayName: args.displayName,
      aliases: [...new Set([...existing.aliases, ...args.aliases])],
      rawPaths: [...new Set([...existing.rawPaths, ...args.rawPaths])],
    });
    return null;
  },
});

export const upsertSession = mutation({
  args: {
    sessionId: v.string(),
    projectKey: v.string(),
    provider: v.string(),
    agentName: v.string(),
    title: v.optional(v.string()),
    startedAt: v.optional(v.string()),
    updatedAt: v.optional(v.string()),
    sourcePath: v.string(),
    sourceFingerprint: v.string(),
    messageCount: v.number(),
    toolCallCount: v.number(),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("sessions")
      .withIndex("by_sessionId", (q) => q.eq("sessionId", args.sessionId))
      .unique();
    if (existing !== null && existing.sourceFingerprint === args.sourceFingerprint) {
      return { skipped: true };
    }
    if (existing === null) {
      await ctx.db.insert("sessions", args);
    } else {
      await ctx.db.patch(existing._id, args);
    }
    return { skipped: false };
  },
});

export const insertMessages = mutation({
  args: {
    messages: v.array(
      v.object({
        sessionId: v.string(),
        seq: v.number(),
        role: roleValidator,
        text: v.string(),
        ts: v.optional(v.string()),
        projectKey: v.string(),
      }),
    ),
  },
  handler: async (ctx, args) => {
    for (const message of args.messages) {
      await ctx.db.insert("messages", message);
    }
    return null;
  },
});

export const insertToolCalls = mutation({
  args: {
    toolCalls: v.array(
      v.object({
        sessionId: v.string(),
        seq: v.number(),
        toolName: v.string(),
        status: v.optional(v.string()),
        inputText: v.string(),
        outputText: v.string(),
        startedAt: v.optional(v.string()),
        completedAt: v.optional(v.string()),
        projectKey: v.string(),
        provider: v.string(),
      }),
    ),
  },
  handler: async (ctx, args) => {
    for (const toolCall of args.toolCalls) {
      await ctx.db.insert("toolCalls", toolCall);
    }
    return null;
  },
});

/**
 * Deletes one batch of a session's turns and reports how many rows it removed.
 * Caller-driven continuation: the ingest engine loops while `deleted` equals a
 * full batch, so delete completion is observable before re-insertion begins.
 * (A scheduler-based continuation would race the subsequent inserts.)
 */
export const deleteSessionTurns = mutation({
  args: { sessionId: v.string() },
  handler: async (ctx, args) => {
    const messages = await ctx.db
      .query("messages")
      .withIndex("by_sessionId_and_seq", (q) => q.eq("sessionId", args.sessionId))
      .take(DELETE_BATCH);
    for (const row of messages) {
      await ctx.db.delete(row._id);
    }
    let deleted = messages.length;
    if (deleted < DELETE_BATCH) {
      const toolCalls = await ctx.db
        .query("toolCalls")
        .withIndex("by_sessionId_and_seq", (q) => q.eq("sessionId", args.sessionId))
        .take(DELETE_BATCH - deleted);
      for (const row of toolCalls) {
        await ctx.db.delete(row._id);
      }
      deleted += toolCalls.length;
    }
    return { deleted, batchSize: DELETE_BATCH };
  },
});

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

export const searchMessages = query({
  args: {
    query: v.string(),
    projectKey: v.optional(v.string()),
    role: v.optional(roleValidator),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    if (
      args.limit !== undefined &&
      (!Number.isInteger(args.limit) || args.limit < 1 || args.limit > SEARCH_TAKE_MAX)
    ) {
      throw new Error(
        `searchMessages: limit must be an integer in [1, ${SEARCH_TAKE_MAX}], got ${args.limit}`,
      );
    }
    const results = await ctx.db
      .query("messages")
      .withSearchIndex("search_text", (q) => {
        let search = q.search("text", args.query);
        if (args.projectKey !== undefined) {
          search = search.eq("projectKey", args.projectKey);
        }
        if (args.role !== undefined) {
          search = search.eq("role", args.role);
        }
        return search;
      })
      .take(args.limit ?? SEARCH_TAKE_MAX);
    return results.map((row) => ({
      sessionId: row.sessionId,
      seq: row.seq,
      role: row.role,
      text: row.text,
    }));
  },
});

export const readSession = query({
  args: { sessionId: v.string(), paginationOpts: paginationOptsValidator },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("messages")
      .withIndex("by_sessionId_and_seq", (q) => q.eq("sessionId", args.sessionId))
      .order("asc")
      .paginate(args.paginationOpts);
  },
});

export const sessionToolCalls = query({
  args: { sessionId: v.string(), paginationOpts: paginationOptsValidator },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("toolCalls")
      .withIndex("by_sessionId_and_seq", (q) => q.eq("sessionId", args.sessionId))
      .order("asc")
      .paginate(args.paginationOpts);
  },
});

export const listProjects = query({
  args: {},
  handler: async (ctx) => {
    return await ctx.db
      .query("projects")
      .withIndex("by_projectKey")
      .order("asc")
      .take(LIST_PROJECTS_MAX);
  },
});

export const listSessions = query({
  args: { projectKey: v.string(), paginationOpts: paginationOptsValidator },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("sessions")
      .withIndex("by_projectKey", (q) => q.eq("projectKey", args.projectKey))
      .paginate(args.paginationOpts);
  },
});

export const toolCallsByName = query({
  args: {
    projectKey: v.string(),
    toolName: v.string(),
    paginationOpts: paginationOptsValidator,
  },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("toolCalls")
      .withIndex("by_projectKey_and_toolName", (q) =>
        q.eq("projectKey", args.projectKey).eq("toolName", args.toolName),
      )
      .paginate(args.paginationOpts);
  },
});
