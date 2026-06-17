import { paginationOptsValidator } from "convex/server";
import { v } from "convex/values";
import { mutation, query, type MutationCtx } from "./_generated/server";

const roleValidator = v.union(
  v.literal("user"),
  v.literal("assistant"),
  v.literal("reasoning"),
);

/** Per-mutation delete batch, within Convex's small-instant-mutation opinion. */
const DELETE_BATCH = 200;

/** Hard upper bound on project rows returned in one client listing. */
const LIST_PROJECTS_MAX = 1000;

/** Default project rows returned by the client discovery command. */
const LIST_PROJECTS_DEFAULT = 100;

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

/**
 * Deletes project rows that no session references. Project identity is
 * derived state: when a mapping change re-keys sessions (e.g. a path-keyed
 * project unifying onto its git-remote key), the abandoned key must vanish —
 * one canonical projectKey per project, delete over deprecate. Bounded work:
 * single-tenant, ~tens of project rows, one indexed `.first()` probe each.
 */
export const pruneEmptyProjects = mutation({
  args: {},
  handler: async (ctx) => {
    const projects = await ctx.db
      .query("projects")
      .withIndex("by_projectKey")
      .take(LIST_PROJECTS_MAX);
    let deleted = 0;
    for (const project of projects) {
      const anySession = await ctx.db
        .query("sessions")
        .withIndex("by_projectKey", (q) => q.eq("projectKey", project.projectKey))
        .first();
      if (anySession === null) {
        await ctx.db.delete(project._id);
        deleted += 1;
      }
    }
    return { deleted };
  },
});

/**
 * Verifies the caller still holds the ingest claim on a session. Turn
 * mutations and the commit run under this check, so a concurrent run that
 * re-claims the session makes the stale run's next mutation fail loudly
 * instead of writing duplicate rows.
 */
const requireIngestClaim = async (ctx: MutationCtx, sessionId: string, runId: string) => {
  const session = await ctx.db
    .query("sessions")
    .withIndex("by_sessionId", (q) => q.eq("sessionId", sessionId))
    .unique();
  if (session === null || session.ingestRunId !== runId) {
    throw new Error(
      `Ingest claim lost for session ${sessionId}: another ingest run claimed it. Do not run concurrent ingests for the same provider.`,
    );
  }
  return session;
};

/**
 * Claims a session for one ingest run. A session is skippable only when its
 * fingerprint is unchanged AND no claim is pending — a crashed run leaves its
 * claim set, so the session is re-ingested instead of permanently skipped.
 * The claim is cleared by commitSessionIngest after all turns have landed.
 */
export const beginSessionIngest = mutation({
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
    runId: v.string(),
    // Re-ingest even when the fingerprint is unchanged — needed after a
    // turn-mapping change, when the rows derived from an unchanged source file
    // are themselves stale.
    force: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const { runId, force, ...session } = args;
    const existing = await ctx.db
      .query("sessions")
      .withIndex("by_sessionId", (q) => q.eq("sessionId", session.sessionId))
      .unique();
    if (
      force !== true &&
      existing !== null &&
      existing.ingestRunId === undefined &&
      existing.sourceFingerprint === session.sourceFingerprint
    ) {
      return { skipped: true };
    }
    if (existing === null) {
      await ctx.db.insert("sessions", { ...session, ingestRunId: runId });
    } else {
      await ctx.db.patch(existing._id, { ...session, ingestRunId: runId });
    }
    return { skipped: false };
  },
});

/**
 * Marks a session's ingest complete by clearing its claim. Only after this
 * runs can an unchanged fingerprint skip the session.
 */
export const commitSessionIngest = mutation({
  args: { sessionId: v.string(), runId: v.string() },
  handler: async (ctx, args) => {
    const session = await requireIngestClaim(ctx, args.sessionId, args.runId);
    await ctx.db.patch(session._id, { ingestRunId: undefined });
    return null;
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
    runId: v.string(),
  },
  handler: async (ctx, args) => {
    for (const sessionId of new Set(args.messages.map((message) => message.sessionId))) {
      await requireIngestClaim(ctx, sessionId, args.runId);
    }
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
    runId: v.string(),
  },
  handler: async (ctx, args) => {
    for (const sessionId of new Set(args.toolCalls.map((toolCall) => toolCall.sessionId))) {
      await requireIngestClaim(ctx, sessionId, args.runId);
    }
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
  args: { sessionId: v.string(), runId: v.string() },
  handler: async (ctx, args) => {
    await requireIngestClaim(ctx, args.sessionId, args.runId);
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
  args: { limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    if (
      args.limit !== undefined &&
      (!Number.isInteger(args.limit) || args.limit < 1 || args.limit > LIST_PROJECTS_MAX)
    ) {
      throw new Error(
        `listProjects: limit must be an integer in [1, ${LIST_PROJECTS_MAX}], got ${args.limit}`,
      );
    }
    const projects = await ctx.db
      .query("projects")
      .withIndex("by_projectKey")
      .order("asc")
      .take(args.limit ?? LIST_PROJECTS_DEFAULT);
    return projects.map((project) => ({
      projectKey: project.projectKey,
      displayName: project.displayName,
      aliasCount: project.aliases.length,
      rawPathCount: project.rawPaths.length,
    }));
  },
});

export const listSessions = query({
  args: {
    projectKey: v.string(),
    provider: v.optional(v.string()),
    paginationOpts: paginationOptsValidator,
  },
  handler: async (ctx, args) => {
    if (args.provider !== undefined) {
      return await ctx.db
        .query("sessions")
        .withIndex("by_projectKey_and_provider", (q) =>
          q.eq("projectKey", args.projectKey).eq("provider", args.provider!),
        )
        .paginate(args.paginationOpts);
    }
    return await ctx.db
      .query("sessions")
      .withIndex("by_projectKey", (q) => q.eq("projectKey", args.projectKey))
      .paginate(args.paginationOpts);
  },
});

export const toolCallsByName = query({
  args: {
    projectKey: v.string(),
    toolName: v.optional(v.string()),
    provider: v.optional(v.string()),
    paginationOpts: paginationOptsValidator,
  },
  handler: async (ctx, args) => {
    if (args.provider !== undefined && args.toolName !== undefined) {
      return await ctx.db
        .query("toolCalls")
        .withIndex("by_projectKey_and_provider_and_toolName", (q) =>
          q
            .eq("projectKey", args.projectKey)
            .eq("provider", args.provider!)
            .eq("toolName", args.toolName!),
        )
        .paginate(args.paginationOpts);
    }
    if (args.provider !== undefined) {
      return await ctx.db
        .query("toolCalls")
        .withIndex("by_projectKey_and_provider", (q) =>
          q.eq("projectKey", args.projectKey).eq("provider", args.provider!),
        )
        .paginate(args.paginationOpts);
    }
    if (args.toolName === undefined) {
      throw new Error("toolCallsByName requires toolName or provider");
    }
    return await ctx.db
      .query("toolCalls")
      .withIndex("by_projectKey_and_toolName", (q) =>
        q.eq("projectKey", args.projectKey).eq("toolName", args.toolName!),
      )
      .paginate(args.paginationOpts);
  },
});
