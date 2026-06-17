import { paginationOptsValidator, type PaginationResult } from "convex/server";
import { v } from "convex/values";

import { internal } from "./_generated/api";
import { internalAction, type ActionCtx } from "./_generated/server";
import {
  EMBEDDABLE_ROLES,
  INDEX_PAGE_SIZE,
  type CurrentMessageForIndex,
  type EmbeddableRole,
} from "./searchPlan";

interface IndexableMessageRow {
  readonly seq: number;
  readonly role: EmbeddableRole;
  readonly text: string;
  readonly projectKey: string;
}

export interface IndexSessionReport {
  readonly status:
    | "missing"
    | "ingest_in_progress"
    | "failed"
    | "skipped"
    | "unconfigured"
    | "indexed";
  readonly messagesSeen: number;
  readonly messagesEmbedded: number;
  readonly messagesReused: number;
  readonly keysDeleted: number;
  readonly embeddingsConfigured: boolean;
  readonly error?: string;
}

const readCurrentMessages = async (
  ctx: ActionCtx,
  sessionId: string,
): Promise<CurrentMessageForIndex[]> => {
  const messages: CurrentMessageForIndex[] = [];
  for (const role of EMBEDDABLE_ROLES) {
    let cursor: string | null = null;
    do {
      const page: PaginationResult<IndexableMessageRow> = await ctx.runQuery(
        internal.searchData.indexableMessages,
        {
          sessionId,
          role,
          paginationOpts: { numItems: INDEX_PAGE_SIZE, cursor },
        },
      );
      for (const row of page.page) {
        messages.push({
          sessionId,
          seq: row.seq,
          role,
          projectKey: row.projectKey,
          text: row.text,
        });
      }
      cursor = page.isDone ? null : page.continueCursor;
    } while (cursor !== null);
  }
  return messages;
};

const indexSessionFor = async (
  ctx: ActionCtx,
  args: { readonly sessionId: string; readonly runId?: string },
): Promise<IndexSessionReport> => {
  const state = await ctx.runQuery(internal.searchData.sessionIndexState, {
    sessionId: args.sessionId,
  });
  if (state === null) {
    return {
      status: "missing" as const,
      messagesSeen: 0,
      messagesEmbedded: 0,
      messagesReused: 0,
      keysDeleted: 0,
      embeddingsConfigured: false,
    };
  }
  if (state.ingestRunId !== undefined && state.ingestRunId !== args.runId) {
    return {
      status: "ingest_in_progress" as const,
      messagesSeen: 0,
      messagesEmbedded: 0,
      messagesReused: 0,
      keysDeleted: 0,
      embeddingsConfigured: false,
    };
  }
  const currentMessages = await readCurrentMessages(ctx, args.sessionId);
  return await ctx.runAction(internal.search.indexSessionRows, {
    sessionId: args.sessionId,
    currentMessages,
  }) as IndexSessionReport;
};

export const indexSession = internalAction({
  args: { sessionId: v.string() },
  handler: async (ctx, args): Promise<IndexSessionReport> => indexSessionFor(ctx, args),
});
