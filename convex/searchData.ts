import { paginationOptsValidator, type PaginationResult } from "convex/server";
import { v } from "convex/values";

import { internalQuery } from "./_generated/server";
import type { EmbeddableRole } from "./searchPlan";

const embeddableRoleValidator = v.union(v.literal("user"), v.literal("assistant"));

export interface SessionIndexState {
  readonly sessionId: string;
  readonly sourceFingerprint: string;
  readonly ingestRunId?: string;
}

export const sessionIndexState = internalQuery({
  args: { sessionId: v.string() },
  handler: async (ctx, args): Promise<SessionIndexState | null> => {
    const session = await ctx.db
      .query("sessions")
      .withIndex("by_sessionId", (q) => q.eq("sessionId", args.sessionId))
      .unique();
    if (session === null) {
      return null;
    }
    return {
      sessionId: session.sessionId,
      sourceFingerprint: session.sourceFingerprint,
      ...(session.ingestRunId !== undefined ? { ingestRunId: session.ingestRunId } : {}),
    };
  },
});

export interface IndexableMessageRow {
  readonly seq: number;
  readonly role: EmbeddableRole;
  readonly text: string;
  readonly projectKey: string;
}

export const indexableMessages = internalQuery({
  args: {
    sessionId: v.string(),
    role: embeddableRoleValidator,
    paginationOpts: paginationOptsValidator,
  },
  handler: async (ctx, args): Promise<PaginationResult<IndexableMessageRow>> => {
    const page = await ctx.db
      .query("messages")
      .withIndex("by_sessionId_and_role_and_seq", (q) =>
        q.eq("sessionId", args.sessionId).eq("role", args.role),
      )
      .order("asc")
      .paginate(args.paginationOpts);
    return {
      ...page,
      page: page.page.map((row) => ({
        seq: row.seq,
        role: row.role as EmbeddableRole,
        text: row.text,
        projectKey: row.projectKey,
      })),
    };
  },
});
