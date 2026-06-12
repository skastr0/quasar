import { paginationOptsValidator, type PaginationResult } from "convex/server";
import { v } from "convex/values";
import { defaultChunker, type EntryFilter, type InputChunk } from "@convex-dev/rag";
import { embedMany } from "ai";
import { api, internal } from "./_generated/api";
import {
  action,
  internalMutation,
  internalQuery,
  query,
  type ActionCtx,
} from "./_generated/server";
import {
  combinedProjectRoleValue,
  embeddingInputFor,
  fuseMatches,
  GOOGLE_API_KEY_ENV,
  GOOGLE_GENERATIVE_AI_API_KEY_ENV,
  messageContentHash,
  messageEntryKey,
  quasarEmbeddingModel,
  quasarRag,
  QUASAR_RAG_EMBEDDING_DIMENSIONS,
  QUASAR_RAG_NAMESPACE,
  semanticMatchesFromSearch,
  serverEmbeddingsConfigured,
  type EmbeddableRole,
  type MessageMatch,
  type QuasarRagFilterSchemas,
  type QuasarRagMetadata,
} from "./quasarRag";

/**
 * The embedding pipeline over the conversation surface.
 *
 * Structural purity: everything here reads `messages` exclusively through
 * `by_sessionId_and_role_and_seq` with `role` pinned by the
 * `embeddableRoleValidator` union below — rows outside the two conversation
 * roles are unreachable by construction, and this file never names any other
 * surface (pinned by the convex-lint embedding-surface rule and the purity
 * tests).
 */

/** The only roles the embedding path can express — the structural purity pin. */
const embeddableRoleValidator = v.union(v.literal("user"), v.literal("assistant"));

const EMBEDDABLE_ROLES: readonly EmbeddableRole[] = ["user", "assistant"];

/** Messages per internal page while embedding a session. */
const EMBED_PAGE = 100;

/** Hard upper bound on search results returned in one call (mirrors
 * `searchMessages`). */
const SEARCH_TAKE_MAX = 20;

/** Sessions per `embedQueue` page (single-shot page bound). */
const QUEUE_PAGE_MAX = 500;

// ---------------------------------------------------------------------------
// Internal surface: session state + the role-pinned message walk
// ---------------------------------------------------------------------------

export interface SessionEmbedState {
  readonly sessionId: string;
  readonly projectKey: string;
  readonly sourceFingerprint: string;
  readonly embeddedFingerprint?: string;
  readonly ingestClaimed: boolean;
}

export const sessionEmbedState = internalQuery({
  args: { sessionId: v.string() },
  handler: async (ctx, args): Promise<SessionEmbedState | null> => {
    const session = await ctx.db
      .query("sessions")
      .withIndex("by_sessionId", (q) => q.eq("sessionId", args.sessionId))
      .unique();
    if (session === null) return null;
    return {
      sessionId: session.sessionId,
      projectKey: session.projectKey,
      sourceFingerprint: session.sourceFingerprint,
      ...(session.embeddedFingerprint !== undefined
        ? { embeddedFingerprint: session.embeddedFingerprint }
        : {}),
      ingestClaimed: session.ingestRunId !== undefined,
    };
  },
});

export interface EmbeddableMessageRow {
  readonly seq: number;
  readonly text: string;
  readonly projectKey: string;
}

/**
 * The ONLY read path into `messages` for the embedding pipeline: an index
 * walk with the role pinned to a conversation role by the validator.
 */
export const embeddableMessages = internalQuery({
  args: {
    sessionId: v.string(),
    role: embeddableRoleValidator,
    paginationOpts: paginationOptsValidator,
  },
  handler: async (ctx, args): Promise<PaginationResult<EmbeddableMessageRow>> => {
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
        text: row.text,
        projectKey: row.projectKey,
      })),
    };
  },
});

export interface MarkSessionEmbeddedResult {
  readonly marked: boolean;
  readonly reason?: "missing" | "ingest_in_progress" | "superseded";
}

/**
 * Records a completed embedding pass. Refuses when the session vanished, an
 * ingest claim landed mid-embed, or the source fingerprint moved — the embed
 * run reports the session as superseded and the next `quasar embed` retries.
 */
export const markSessionEmbedded = internalMutation({
  args: { sessionId: v.string(), sourceFingerprint: v.string() },
  handler: async (ctx, args): Promise<MarkSessionEmbeddedResult> => {
    const session = await ctx.db
      .query("sessions")
      .withIndex("by_sessionId", (q) => q.eq("sessionId", args.sessionId))
      .unique();
    if (session === null) return { marked: false, reason: "missing" };
    if (session.ingestRunId !== undefined) {
      return { marked: false, reason: "ingest_in_progress" };
    }
    if (session.sourceFingerprint !== args.sourceFingerprint) {
      return { marked: false, reason: "superseded" };
    }
    await ctx.db.patch(session._id, { embeddedFingerprint: args.sourceFingerprint });
    return { marked: true };
  },
});

// ---------------------------------------------------------------------------
// Public surface: backfill queue + per-session embed action
// ---------------------------------------------------------------------------

export interface EmbedQueueRow {
  readonly sessionId: string;
  readonly projectKey: string;
  readonly provider: string;
  readonly messageCount: number;
  readonly ingestClaimed: boolean;
  readonly pending: boolean;
}

/**
 * Paginated embed-state walk over sessions for the CLI backfill driver. A
 * session is pending exactly when its ingest is committed and its source
 * fingerprint differs from the last embedded fingerprint.
 */
export const embedQueue = query({
  args: { paginationOpts: paginationOptsValidator },
  handler: async (ctx, args): Promise<PaginationResult<EmbedQueueRow>> => {
    if (args.paginationOpts.numItems < 1 || args.paginationOpts.numItems > QUEUE_PAGE_MAX) {
      throw new Error(
        `embedQueue: paginationOpts.numItems must be in [1, ${QUEUE_PAGE_MAX}], got ${args.paginationOpts.numItems}`,
      );
    }
    const page = await ctx.db
      .query("sessions")
      .withIndex("by_sessionId")
      .order("asc")
      .paginate(args.paginationOpts);
    return {
      ...page,
      page: page.page.map((session) => {
        const ingestClaimed = session.ingestRunId !== undefined;
        return {
          sessionId: session.sessionId,
          projectKey: session.projectKey,
          provider: session.provider,
          messageCount: session.messageCount,
          ingestClaimed,
          pending: !ingestClaimed && session.embeddedFingerprint !== session.sourceFingerprint,
        };
      }),
    };
  },
});

export interface EmbedSessionReport {
  readonly status: "embedded" | "skipped" | "ingest_in_progress" | "superseded";
  readonly messagesEmbedded: number;
  readonly messagesReused: number;
  readonly chunksEmbedded: number;
  /** Gemini input tokens spent by this call (provider-reported when
   * available; otherwise a chars/4 estimate flagged by tokensEstimated). */
  readonly tokens: number;
  readonly tokensEstimated: boolean;
}

const EMPTY_EMBED_COUNTS = {
  messagesEmbedded: 0,
  messagesReused: 0,
  chunksEmbedded: 0,
  tokens: 0,
  tokensEstimated: false,
} as const;

interface PendingMessageEntry {
  readonly key: string;
  readonly contentHash: string;
  readonly chunks: readonly string[];
  readonly metadata: QuasarRagMetadata;
}

/**
 * Embeds one session's conversation rows into the RAG namespace: one entry
 * per message row (key `sessionId:seq:role`), chunked by the component's
 * default chunker, embeddings precomputed in batched `embedMany` calls.
 * Unchanged rows (matched by content hash) are reused without re-embedding,
 * so re-embedding a grown session only pays for the new rows.
 */
export const embedSession = action({
  args: { sessionId: v.string(), force: v.optional(v.boolean()) },
  handler: async (ctx, args): Promise<EmbedSessionReport> => {
    const state: SessionEmbedState | null = await ctx.runQuery(
      internal.embed.sessionEmbedState,
      { sessionId: args.sessionId },
    );
    if (state === null) {
      throw new Error(`embedSession: unknown sessionId ${args.sessionId}`);
    }
    if (state.ingestClaimed) {
      return { status: "ingest_in_progress", ...EMPTY_EMBED_COUNTS };
    }
    if (args.force !== true && state.embeddedFingerprint === state.sourceFingerprint) {
      return { status: "skipped", ...EMPTY_EMBED_COUNTS };
    }
    if (!serverEmbeddingsConfigured()) {
      throw new Error(
        `embedSession: ${GOOGLE_API_KEY_ENV} or ${GOOGLE_GENERATIVE_AI_API_KEY_ENV} must be configured on the deployment.`,
      );
    }

    let messagesEmbedded = 0;
    let messagesReused = 0;
    let chunksEmbedded = 0;
    let tokens = 0;
    let tokensEstimated = false;

    for (const role of EMBEDDABLE_ROLES) {
      let cursor: string | null = null;
      do {
        const page: PaginationResult<EmbeddableMessageRow> = await ctx.runQuery(
          internal.embed.embeddableMessages,
          {
            sessionId: args.sessionId,
            role,
            paginationOpts: { numItems: EMBED_PAGE, cursor },
          },
        );

        const pending: PendingMessageEntry[] = [];
        for (const row of page.page) {
          if (row.text.trim().length === 0) continue;
          const key = messageEntryKey({ sessionId: args.sessionId, seq: row.seq, role });
          const contentHash = messageContentHash(row.text);
          const existing = await quasarRag.findEntryByContentHash(ctx, {
            namespace: QUASAR_RAG_NAMESPACE,
            key,
            contentHash,
          });
          if (existing !== null && existing.status === "ready") {
            messagesReused += 1;
            continue;
          }
          const chunks = defaultChunker(row.text).filter(
            (chunk) => chunk.trim().length > 0,
          );
          pending.push({
            key,
            contentHash,
            chunks: chunks.length > 0 ? chunks : [row.text],
            metadata: {
              sessionId: args.sessionId,
              seq: row.seq,
              role,
              projectKey: row.projectKey,
            },
          });
        }

        if (pending.length > 0) {
          const values = pending.flatMap((message) =>
            message.chunks.map((chunk) =>
              embeddingInputFor({ purpose: "retrieval_document", text: chunk }),
            ),
          );
          const embedded = await embedMany({ model: quasarEmbeddingModel, values });
          for (const embedding of embedded.embeddings) {
            if (embedding.length !== QUASAR_RAG_EMBEDDING_DIMENSIONS) {
              throw new Error(
                `embedSession: Gemini returned ${embedding.length} dimensions; expected ${QUASAR_RAG_EMBEDDING_DIMENSIONS}.`,
              );
            }
          }
          const reportedTokens = embedded.usage?.tokens;
          if (typeof reportedTokens === "number" && Number.isFinite(reportedTokens)) {
            tokens += reportedTokens;
          } else {
            tokens += Math.ceil(
              values.reduce((sum, value) => sum + value.length, 0) / 4,
            );
            tokensEstimated = true;
          }

          let offset = 0;
          for (const message of pending) {
            const inputChunks: InputChunk[] = message.chunks.map((text, index) => ({
              text,
              keywords: text,
              embedding: embedded.embeddings[offset + index],
            }));
            offset += message.chunks.length;
            await quasarRag.add(ctx, {
              namespace: QUASAR_RAG_NAMESPACE,
              key: message.key,
              chunks: inputChunks,
              contentHash: message.contentHash,
              filterValues: [
                { name: "projectKey", value: message.metadata.projectKey },
                { name: "role", value: message.metadata.role },
                {
                  name: "projectKeyRole",
                  value: combinedProjectRoleValue(
                    message.metadata.projectKey,
                    message.metadata.role,
                  ),
                },
              ],
              metadata: message.metadata,
            });
            messagesEmbedded += 1;
            chunksEmbedded += message.chunks.length;
          }
        }

        cursor = page.isDone ? null : page.continueCursor;
      } while (cursor !== null);
    }

    const marked: MarkSessionEmbeddedResult = await ctx.runMutation(
      internal.embed.markSessionEmbedded,
      { sessionId: args.sessionId, sourceFingerprint: state.sourceFingerprint },
    );
    return {
      status: marked.marked ? "embedded" : "superseded",
      messagesEmbedded,
      messagesReused,
      chunksEmbedded,
      tokens,
      tokensEstimated,
    };
  },
});

// ---------------------------------------------------------------------------
// Public surface: semantic + fusion search (vector search in actions only)
// ---------------------------------------------------------------------------

export type SemanticStatus = "ready" | "unconfigured" | "empty_namespace";

export interface SearchDiagnostics {
  readonly textSearched: boolean;
  readonly semanticSearched: boolean;
  readonly semanticStatus: SemanticStatus;
  readonly embeddingDimensions: number;
  readonly queryTokens?: number;
}

export interface SearchActionResponse {
  readonly mode: "semantic" | "fusion";
  readonly query: string;
  readonly limit: number;
  readonly projectKey?: string;
  readonly role?: EmbeddableRole;
  readonly matches: MessageMatch[];
  readonly diagnostics: SearchDiagnostics;
}

const validateLimit = (surface: string, limit: number | undefined): number => {
  if (limit === undefined) return SEARCH_TAKE_MAX;
  if (!Number.isInteger(limit) || limit < 1 || limit > SEARCH_TAKE_MAX) {
    throw new Error(
      `${surface}: limit must be an integer in [1, ${SEARCH_TAKE_MAX}], got ${limit}`,
    );
  }
  return limit;
};

const semanticFiltersFor = (
  projectKey: string | undefined,
  role: EmbeddableRole | undefined,
): EntryFilter<QuasarRagFilterSchemas>[] => {
  if (projectKey !== undefined && role !== undefined) {
    return [{ name: "projectKeyRole", value: combinedProjectRoleValue(projectKey, role) }];
  }
  if (projectKey !== undefined) return [{ name: "projectKey", value: projectKey }];
  if (role !== undefined) return [{ name: "role", value: role }];
  return [];
};

interface SemanticOutcome {
  readonly matches: MessageMatch[];
  readonly status: SemanticStatus;
  readonly queryTokens?: number;
}

const runSemanticSearch = async (
  ctx: ActionCtx,
  args: {
    readonly query: string;
    readonly projectKey?: string;
    readonly role?: EmbeddableRole;
    readonly limit: number;
  },
): Promise<SemanticOutcome> => {
  if (!serverEmbeddingsConfigured()) return { matches: [], status: "unconfigured" };
  const namespace = await quasarRag.getNamespace(ctx, {
    namespace: QUASAR_RAG_NAMESPACE,
  });
  if (namespace === null) return { matches: [], status: "empty_namespace" };
  const filters = semanticFiltersFor(args.projectKey, args.role);
  const found = await quasarRag.search(ctx, {
    namespace: QUASAR_RAG_NAMESPACE,
    query: embeddingInputFor({ purpose: "retrieval_query", text: args.query }),
    limit: Math.min(args.limit * 3, 64),
    chunkContext: { before: 0, after: 0 },
    ...(filters.length > 0 ? { filters } : {}),
  });
  const queryTokens = found.usage?.tokens;
  return {
    matches: semanticMatchesFromSearch(found.results, found.entries, args.limit),
    status: "ready",
    ...(typeof queryTokens === "number" && Number.isFinite(queryTokens)
      ? { queryTokens }
      : {}),
  };
};

/**
 * Vector search over the embedded conversation surface: query text in, ranked
 * message rows out (cosine scores). Filters: projectKey and/or conversation
 * role.
 */
export const searchSemantic = action({
  args: {
    query: v.string(),
    projectKey: v.optional(v.string()),
    role: v.optional(embeddableRoleValidator),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args): Promise<SearchActionResponse> => {
    const limit = validateLimit("searchSemantic", args.limit);
    const semantic = await runSemanticSearch(ctx, {
      query: args.query,
      ...(args.projectKey !== undefined ? { projectKey: args.projectKey } : {}),
      ...(args.role !== undefined ? { role: args.role } : {}),
      limit,
    });
    return {
      mode: "semantic",
      query: args.query,
      limit,
      ...(args.projectKey !== undefined ? { projectKey: args.projectKey } : {}),
      ...(args.role !== undefined ? { role: args.role } : {}),
      matches: semantic.matches,
      diagnostics: {
        textSearched: false,
        semanticSearched: semantic.status === "ready",
        semanticStatus: semantic.status,
        embeddingDimensions: QUASAR_RAG_EMBEDDING_DIMENSIONS,
        ...(semantic.queryTokens !== undefined
          ? { queryTokens: semantic.queryTokens }
          : {}),
      },
    };
  },
});

interface LexicalRow {
  readonly sessionId: string;
  readonly seq: number;
  readonly role: string;
  readonly text: string;
  readonly projectKey: string;
}

/**
 * Fusion search: lexical `searchMessages` (the full search surface) and the
 * semantic conversation surface merged by standard RRF (k = 60). When
 * embeddings are unavailable the response degrades to lexical-only and says
 * so in diagnostics. A `role` filter narrows both legs to that conversation
 * role; without it the lexical leg still spans the whole search surface.
 */
export const searchFusion = action({
  args: {
    query: v.string(),
    projectKey: v.optional(v.string()),
    role: v.optional(embeddableRoleValidator),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args): Promise<SearchActionResponse> => {
    const limit = validateLimit("searchFusion", args.limit);
    const lexical: LexicalRow[] = await ctx.runQuery(api.quasar.searchMessages, {
      query: args.query,
      ...(args.projectKey !== undefined ? { projectKey: args.projectKey } : {}),
      ...(args.role !== undefined ? { role: args.role } : {}),
      limit: SEARCH_TAKE_MAX,
    });
    const semantic = await runSemanticSearch(ctx, {
      query: args.query,
      ...(args.projectKey !== undefined ? { projectKey: args.projectKey } : {}),
      ...(args.role !== undefined ? { role: args.role } : {}),
      limit: SEARCH_TAKE_MAX,
    });
    return {
      mode: "fusion",
      query: args.query,
      limit,
      ...(args.projectKey !== undefined ? { projectKey: args.projectKey } : {}),
      ...(args.role !== undefined ? { role: args.role } : {}),
      matches: fuseMatches({ lexical, semantic: semantic.matches, limit }),
      diagnostics: {
        textSearched: true,
        semanticSearched: semantic.status === "ready",
        semanticStatus: semantic.status,
        embeddingDimensions: QUASAR_RAG_EMBEDDING_DIMENSIONS,
        ...(semantic.queryTokens !== undefined
          ? { queryTokens: semantic.queryTokens }
          : {}),
      },
    };
  },
});
