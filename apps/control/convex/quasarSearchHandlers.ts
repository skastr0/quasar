import type { EntryFilter } from "@convex-dev/rag";
import { Effect } from "effect";

import { internal } from "./_generated/api";
import type { ActionCtx, QueryCtx } from "./_generated/server";
import {
  QUASAR_EMBEDDING_DIMENSIONS,
  QUASAR_RAG_NAMESPACE,
  embedQueryEffect,
  quasarRag,
  serverEmbeddingsConfigured,
  type QuasarRagFilters,
} from "./quasarRag";
import { baseMatch, matchesFilters } from "./quasarSearchDocuments";
import type {
  SearchArgs,
  SearchDocument,
  SearchMatch,
  SearchResult,
} from "./quasarSearchTypes";
import {
  boundedLimit,
  canonicalFilter,
  kindFilter,
  machineFilter,
  providerFilter,
  RRF_K,
} from "./quasarValues";

export const textSearchHandler = async (
  ctx: QueryCtx,
  args: SearchArgs,
): Promise<SearchResult> => {
  const queryText = args.query.trim();
  if (queryText.length === 0) throw new Error("Search query is required.");
  const limit = boundedLimit(args.limit);
  const rows = await textSearchRows(ctx, args, queryText, limit);
  const matches = rows
    .filter((doc) => matchesFilters(doc, args))
    .slice(0, limit)
    .map((doc, index) => baseMatch(doc, 1 / (RRF_K + index + 1)));
  return {
    mode: "text",
    query: queryText,
    limit,
    matches,
    diagnostics: { textSearched: true, semanticSearched: false },
  };
};

const textSearchRows = async (
  ctx: QueryCtx,
  args: SearchArgs,
  queryText: string,
  limit: number,
) => {
  const takeLimit = Math.min(1000, Math.max(200, limit * 20));
  if (args.projectIdentityKey !== undefined) {
    return await ctx.db
      .query("searchDocuments")
      .withSearchIndex("search_text", (q) =>
        q
          .search("searchText", queryText)
          .eq("activeProject", canonicalFilter(args.projectIdentityKey!)),
      )
      .take(takeLimit);
  }
  if (args.machineId !== undefined) {
    return await ctx.db
      .query("searchDocuments")
      .withSearchIndex("search_text", (q) =>
        q.search("searchText", queryText).eq("activeMachine", machineFilter(args.machineId!)),
      )
      .take(takeLimit);
  }
  if (args.provider !== undefined) {
    return await ctx.db
      .query("searchDocuments")
      .withSearchIndex("search_text", (q) =>
        q.search("searchText", queryText).eq("activeProvider", providerFilter(args.provider!)),
      )
      .take(takeLimit);
  }
  if (args.kind !== undefined) {
    return await ctx.db
      .query("searchDocuments")
      .withSearchIndex("search_text", (q) =>
        q.search("searchText", queryText).eq("activeKind", kindFilter(args.kind!)),
      )
      .take(takeLimit);
  }
  return await ctx.db
    .query("searchDocuments")
    .withSearchIndex("search_text", (q) => q.search("searchText", queryText))
    .take(takeLimit);
};

export const semanticSearchHandler = async (
  ctx: ActionCtx,
  args: SearchArgs,
): Promise<SearchResult> => {
  const queryText = args.query.trim();
  const limit = boundedLimit(args.limit);
  if (!serverEmbeddingsConfigured()) {
    return semanticUnavailable(queryText, limit);
  }
  const embedding = await Effect.runPromise(embedQueryEffect(queryText));
  const result = await quasarRag.search(ctx, {
    namespace: QUASAR_RAG_NAMESPACE,
    query: embedding,
    filters: ragFilters(args),
    limit: Math.min(200, limit * 5),
    searchType: "vector",
  });
  const docs = await searchDocumentsForRagEntries(ctx, result.entries);
  const scores = new Map(
    result.results.map((item, index) => [
      String(item.entryId),
      1 / (RRF_K + index + 1),
    ]),
  );
  const matches = docs
    .filter((doc) => matchesFilters(doc, args))
    .slice(0, limit)
    .map((doc, index) =>
      baseMatch(doc, scores.get(doc.ragEntryId ?? "") ?? 1 / (RRF_K + index + 1)),
    );
  return semanticReady(queryText, limit, matches);
};

const semanticUnavailable = (queryText: string, limit: number): SearchResult => ({
  mode: "semantic",
  query: queryText,
  limit,
  matches: [],
  diagnostics: {
    textSearched: false,
    semanticSearched: false,
    semanticStatus: "embedding_provider_unconfigured",
    embeddingDimensions: QUASAR_EMBEDDING_DIMENSIONS,
  },
});

const semanticReady = (
  queryText: string,
  limit: number,
  matches: SearchMatch[],
): SearchResult => ({
  mode: "semantic",
  query: queryText,
  limit,
  matches,
  diagnostics: {
    textSearched: false,
    semanticSearched: true,
    semanticStatus: "ready",
    embeddingDimensions: QUASAR_EMBEDDING_DIMENSIONS,
  },
});

const searchDocumentsForRagEntries = async (
  ctx: ActionCtx,
  entries: readonly { metadata?: unknown }[],
) => {
  const ids = entries
    .map((entry) => (entry.metadata as Record<string, unknown> | undefined)?.searchDocumentId)
    .filter((id): id is string => typeof id === "string");
  return (await ctx.runQuery(internal.quasar.fetchSearchDocumentsInternal, {
    searchDocumentIds: ids,
  })) as SearchDocument[];
};

const ragFilters = (args: {
  readonly projectIdentityKey?: string;
  readonly machineId?: string;
  readonly provider?: string;
}): EntryFilter<QuasarRagFilters>[] => {
  const filters: EntryFilter<QuasarRagFilters>[] = [];
  if (args.projectIdentityKey !== undefined) {
    filters.push({ name: "canonicalProjectIdentityKey", value: args.projectIdentityKey });
  }
  if (args.machineId !== undefined) filters.push({ name: "machineId", value: args.machineId });
  if (args.provider !== undefined) filters.push({ name: "provider", value: args.provider });
  return filters;
};

export const fusionSearchHandler = async (
  ctx: ActionCtx,
  args: SearchArgs,
): Promise<SearchResult> => {
  const text = (await ctx.runQuery(
    internal.quasar.textSearchInternal,
    args,
  )) as SearchResult;
  const semantic = (await ctx.runAction(
    internal.quasar.semanticSearchInternal,
    args,
  )) as SearchResult;
  const byId = new Map<string, SearchMatch>();
  for (const match of [...text.matches, ...semantic.matches]) {
    byId.set(match.searchDocumentId, mergeMatch(byId.get(match.searchDocumentId), match));
  }
  const limit = boundedLimit(args.limit);
  return {
    mode: "fusion",
    query: args.query,
    limit,
    matches: [...byId.values()]
      .sort((left, right) => Number(right.score) - Number(left.score))
      .slice(0, limit),
    diagnostics: {
      textSearched: true,
      semanticSearched: semantic.diagnostics.semanticSearched,
      semanticStatus: semantic.diagnostics.semanticStatus,
      embeddingDimensions: semantic.diagnostics.embeddingDimensions,
    },
  };
};

const mergeMatch = (
  current: SearchMatch | undefined,
  match: SearchMatch,
): SearchMatch => ({
  ...current,
  ...match,
  score: (current?.score ?? 0) + match.score,
});
