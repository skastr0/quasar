import type { QueryCtx } from "./_generated/server";
import { boundedLimit } from "./quasarValues";

export const listImportRunsHandler = async (ctx: QueryCtx) =>
  await ctx.db.query("importRuns").withIndex("by_createdAt").order("desc").take(50);

export const listSessionsHandler = async (
  ctx: QueryCtx,
  args: {
    projectIdentityKey?: string;
    machineId?: string;
    provider?: string;
    limit?: number;
  },
) => {
  const limit = boundedLimit(args.limit);
  const rows = await ctx.db.query("sessions").collect();
  return rows
    .filter((session) =>
      args.projectIdentityKey === undefined
        ? true
        : session.canonicalProjectIdentityKey === args.projectIdentityKey ||
          session.projectIdentityKey === args.projectIdentityKey,
    )
    .filter((session) =>
      args.machineId === undefined ? true : session.machineId === args.machineId,
    )
    .filter((session) =>
      args.provider === undefined ? true : session.provider === args.provider,
    )
    .sort((left, right) => right.updatedAt - left.updatedAt)
    .slice(0, limit)
    .map((session) => ({
      id: session.sessionId,
      nativeSessionId: session.nativeSessionId,
      title: session.title,
      provider: session.provider,
      agentName: session.agentName,
      machineId: session.machineId,
      projectIdentityKey: session.canonicalProjectIdentityKey,
      eventCount: session.eventCount,
      updatedAt: session.updatedAt,
    }));
};

export const readSessionHandler = async (
  ctx: QueryCtx,
  args: { sessionId: string },
) => {
  const session = await ctx.db
    .query("sessions")
    .withIndex("by_sessionId", (q) => q.eq("sessionId", args.sessionId))
    .unique();
  if (session === null) return null;
  const events = await ctx.db
    .query("sessionEvents")
    .withIndex("by_session_sequence", (q) => q.eq("sessionId", args.sessionId))
    .collect();
  const toolCalls = await ctx.db
    .query("toolCalls")
    .withIndex("by_sessionId", (q) => q.eq("sessionId", args.sessionId))
    .collect();
  return { session, events, toolCalls };
};

export const listToolCallsHandler = async (
  ctx: QueryCtx,
  args: { toolCallId?: string; sessionId?: string; limit?: number },
) => {
  if (args.toolCallId !== undefined) {
    return await ctx.db
      .query("toolCalls")
      .withIndex("by_toolCallId", (q) => q.eq("toolCallId", args.toolCallId!))
      .collect();
  }
  const rows =
    args.sessionId === undefined
      ? await ctx.db.query("toolCalls").collect()
      : await ctx.db
          .query("toolCalls")
          .withIndex("by_sessionId", (q) => q.eq("sessionId", args.sessionId!))
          .collect();
  return rows
    .sort((left, right) => right.updatedAt - left.updatedAt)
    .slice(0, boundedLimit(args.limit));
};
