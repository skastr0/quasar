"use node";

import { createGoogleGenerativeAI, type GoogleEmbeddingModelOptions } from "@ai-sdk/google";
import { embedMany } from "ai";
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { v } from "convex/values";

import { action, internalAction } from "./_generated/server";
import {
  GEMINI_EMBED_BATCH_MAX,
  GEMINI_EMBEDDING_MODEL_ID,
  GOOGLE_API_KEY_ENV,
  GOOGLE_GENERATIVE_AI_API_KEY_ENV,
  SEARCH_EMBEDDING_DIMS,
  embeddingInputFor,
  fuseMatches,
  lexicalOnlyPlanRows,
  planSessionIndex,
  unembeddedContentHash,
  type CurrentMessageForIndex,
  type ExistingSearchRow,
  type FusedSearchRank,
  type PlannedMessageRow,
} from "./searchPlan";

const workerPath = join(
  process.env.QUASAR_REPO_ROOT ?? process.cwd(),
  "packages",
  "search",
  "src",
  "convex-worker.ts",
);

const messageRoleValidator = v.union(v.literal("user"), v.literal("assistant"));

const messageSearchRowValidator = v.object({
  sessionId: v.string(),
  seq: v.number(),
  role: messageRoleValidator,
  projectKey: v.string(),
  text: v.string(),
  contentHash: v.string(),
  vector: v.array(v.number()),
});

const currentMessageForIndexValidator = v.object({
  sessionId: v.string(),
  seq: v.number(),
  role: messageRoleValidator,
  projectKey: v.string(),
  text: v.string(),
});

const limitValidator = v.optional(v.number());
const projectKeyValidator = v.optional(v.string());
const SEARCH_TAKE_MAX = 20;
const SEARCH_INTERNAL_TAKE_MAX = 128;

interface IndexSessionRowsReport {
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

interface SearchWorkerHit {
  readonly key: string;
  readonly score: number;
  readonly row: Record<string, unknown>;
}

interface SearchMatch {
  readonly key: string;
  readonly sessionId: string;
  readonly seq: number;
  readonly role: string;
  readonly projectKey: string;
  readonly text: string;
  readonly score: number;
  readonly textRank?: number;
  readonly vectorRank?: number;
}

type SemanticStatus = "ready" | "unavailable" | "misconfigured";

interface SearchReport {
  readonly matches: readonly SearchMatch[];
  readonly diagnostics: {
    readonly textSearched: boolean;
    readonly semanticSearched: boolean;
    readonly semanticStatus: SemanticStatus;
    readonly embeddingDimensions?: number;
    readonly error?: string;
  };
}

const configuredGoogleApiKey = (): string | undefined =>
  process.env[GOOGLE_API_KEY_ENV] ?? process.env[GOOGLE_GENERATIVE_AI_API_KEY_ENV];

const serverEmbeddingsConfigured = (): boolean => {
  const apiKey = configuredGoogleApiKey();
  return apiKey !== undefined && apiKey.trim().length > 0;
};

const placeholderVector = (): readonly number[] =>
  Array.from({ length: SEARCH_EMBEDDING_DIMS }, () => 0);

const testQueryVector = (query: string): readonly number[] | undefined => {
  if (process.env.VITEST !== "true" || process.env.QUASAR_TEST_QUERY_EMBEDDINGS !== "1") {
    return undefined;
  }
  embeddingInputFor({ purpose: "retrieval_query", text: query });
  return Array.from({ length: SEARCH_EMBEDDING_DIMS }, (_, index) => (index === 0 ? 1 : 0));
};

const embedRows = async (rows: readonly PlannedMessageRow[]): Promise<readonly number[][]> => {
  const apiKey = configuredGoogleApiKey();
  if (apiKey === undefined || apiKey.trim().length === 0) {
    throw new Error("Gemini embeddings are not configured");
  }
  const google = createGoogleGenerativeAI({ apiKey });
  const embeddings: number[][] = [];
  for (let index = 0; index < rows.length; index += GEMINI_EMBED_BATCH_MAX) {
    const batch = rows.slice(index, index + GEMINI_EMBED_BATCH_MAX);
    const embedded = await embedMany({
      model: google.embedding(GEMINI_EMBEDDING_MODEL_ID),
      values: batch.map((row) =>
        embeddingInputFor({ purpose: "retrieval_document", text: row.text }),
      ),
      maxParallelCalls: 1,
      providerOptions: {
        google: {
          outputDimensionality: SEARCH_EMBEDDING_DIMS,
          taskType: "RETRIEVAL_DOCUMENT",
        } satisfies GoogleEmbeddingModelOptions,
      },
    });
    for (const embedding of embedded.embeddings) {
      if (embedding.length !== SEARCH_EMBEDDING_DIMS) {
        throw new Error(
          `Gemini returned ${embedding.length} dimensions; expected ${SEARCH_EMBEDDING_DIMS}.`,
        );
      }
      embeddings.push(embedding);
    }
  }
  return embeddings;
};

const embedQuery = async (
  query: string,
): Promise<
  | { readonly status: "ready"; readonly vector: readonly number[] }
  | { readonly status: "unavailable" | "misconfigured"; readonly error?: string }
> => {
  try {
    const vector = testQueryVector(query);
    if (vector !== undefined) {
      return { status: "ready", vector };
    }
  } catch (error) {
    return {
      status: "misconfigured",
      error: error instanceof Error ? error.message : String(error),
    };
  }
  const apiKey = configuredGoogleApiKey();
  if (apiKey === undefined || apiKey.trim().length === 0) {
    return { status: "unavailable" };
  }
  try {
    const google = createGoogleGenerativeAI({ apiKey });
    const embedded = await embedMany({
      model: google.embedding(GEMINI_EMBEDDING_MODEL_ID),
      values: [embeddingInputFor({ purpose: "retrieval_query", text: query })],
      maxParallelCalls: 1,
      providerOptions: {
        google: {
          outputDimensionality: SEARCH_EMBEDDING_DIMS,
          taskType: "RETRIEVAL_QUERY",
        } satisfies GoogleEmbeddingModelOptions,
      },
    });
    const vector = embedded.embeddings[0];
    if (vector === undefined || vector.length !== SEARCH_EMBEDDING_DIMS) {
      return {
        status: "misconfigured",
        error: `Gemini returned ${vector?.length ?? 0} dimensions; expected ${SEARCH_EMBEDDING_DIMS}.`,
      };
    }
    return { status: "ready", vector };
  } catch (error) {
    return {
      status: "misconfigured",
      error: error instanceof Error ? error.message : String(error),
    };
  }
};

const actionSecretFromConfig = (): string | undefined => {
  const configPath =
    process.env.QUASAR_LOCAL_CONVEX_CONFIG ??
    join(homedir(), ".config", "quasar", "local", "default", "config.json");
  if (!existsSync(configPath)) {
    return undefined;
  }
  const config = JSON.parse(readFileSync(configPath, "utf8")) as { readonly actionSecret?: string };
  return config.actionSecret;
};

const requireActionSecret = (secret: string) => {
  const expected = process.env.QUASAR_ACTION_SECRET ?? actionSecretFromConfig();
  if (expected === undefined || expected.length === 0 || secret !== expected) {
    throw new Error();
  }
};

const runSearchWorker = <T>(operation: string, payload: unknown): Promise<T> =>
  new Promise((resolve, reject) => {
    const child = spawn(process.env.QUASAR_BUN_BIN ?? "bun", [workerPath, operation], {
      cwd: process.env.QUASAR_REPO_ROOT ?? process.cwd(),
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(stderr.trim() || `search worker exited with code ${code}`));
        return;
      }
      try {
        resolve(JSON.parse(stdout) as T);
      } catch (error) {
        reject(error);
      }
    });
    child.stdin.end(JSON.stringify(payload));
  });

const searchLimit = (limit: number | undefined): number =>
  Math.min(Math.max(1, Math.trunc(limit ?? SEARCH_TAKE_MAX)), SEARCH_TAKE_MAX);

const internalSearchLimit = (limit: number | undefined): number =>
  Math.min(Math.max(searchLimit(limit) * 4, searchLimit(limit)), SEARCH_INTERNAL_TAKE_MAX);

const asNumber = (value: unknown): number => (typeof value === "number" ? value : 0);
const asString = (value: unknown): string => (typeof value === "string" ? value : "");

interface OptimizeReport {
  readonly tableName: string;
  readonly stats: {
    readonly compaction: {
      readonly fragmentsRemoved: number;
      readonly fragmentsAdded: number;
      readonly filesRemoved: number;
      readonly filesAdded: number;
    };
    readonly prune: {
      readonly bytesRemoved: number;
      readonly oldVersionsRemoved: number;
    };
  };
}

interface IndexInfo {
  readonly name: string;
  readonly indexType: string;
  readonly columns: readonly string[];
  readonly numIndexedRows?: number;
  readonly numUnindexedRows?: number;
}

interface DiskSizeBreakdown {
  readonly totalBytes: number;
  readonly dataBytes: number;
  readonly indexBytes: number;
  readonly versionBytes: number;
}

interface TableStatsReport {
  readonly tableName: string;
  readonly rowCount: number;
  readonly versionCount: number;
  readonly disk: DiskSizeBreakdown;
  readonly tableStats: { readonly numRows: number; readonly totalBytes: number; readonly numIndices: number };
  readonly indices: readonly IndexInfo[];
}

interface MaintenanceReport {
  readonly createdIndexes: boolean;
  readonly optimized: boolean;
  readonly optimize?: OptimizeReport;
  readonly stats: TableStatsReport;
}

const toSearchMatch = (
  hit: SearchWorkerHit,
  args: {
    readonly score?: number;
    readonly textRank?: number;
    readonly vectorRank?: number;
  } = {},
): SearchMatch => ({
  key: hit.key,
  sessionId: asString(hit.row.sessionId),
  seq: asNumber(hit.row.seq),
  role: asString(hit.row.role),
  projectKey: asString(hit.row.projectKey),
  text: asString(hit.row.text),
  score: args.score ?? hit.score,
  ...(args.textRank !== undefined ? { textRank: args.textRank } : {}),
  ...(args.vectorRank !== undefined ? { vectorRank: args.vectorRank } : {}),
});

const report = (args: {
  readonly matches: readonly SearchMatch[];
  readonly textSearched: boolean;
  readonly semanticSearched: boolean;
  readonly semanticStatus: SemanticStatus;
  readonly embeddingDimensions?: number;
  readonly error?: string;
}): SearchReport => ({
  matches: args.matches,
  diagnostics: {
    textSearched: args.textSearched,
    semanticSearched: args.semanticSearched,
    semanticStatus: args.semanticStatus,
    ...(args.embeddingDimensions !== undefined
      ? { embeddingDimensions: args.embeddingDimensions }
      : {}),
    ...(args.error !== undefined ? { error: args.error } : {}),
  },
});

const indexCurrentMessages = async (args: {
  readonly sessionId: string;
  readonly currentMessages: readonly CurrentMessageForIndex[];
}): Promise<IndexSessionRowsReport> => {
  try {
    const existingRows = await runSearchWorker<ExistingSearchRow[]>("readMessageRowsBySession", {
      sessionId: args.sessionId,
    });
    const embeddingsConfigured = serverEmbeddingsConfigured();
    const plan = planSessionIndex({
      currentMessages: args.currentMessages,
      existingRows: embeddingsConfigured ? existingRows : lexicalOnlyPlanRows(existingRows),
    });

    let keysDeleted = 0;
    if (plan.keysToDelete.length > 0) {
      const deleted = await runSearchWorker<{ deleted: number }>("deleteByKeys", {
        keys: plan.keysToDelete,
      });
      keysDeleted = deleted.deleted;
    }

    if (plan.rowsToEmbed.length === 0) {
      return {
        status: "skipped" as const,
        messagesSeen: plan.currentRows.length,
        messagesEmbedded: 0,
        messagesReused: plan.messagesReused,
        keysDeleted,
        embeddingsConfigured,
      };
    }
    if (!embeddingsConfigured) {
      const zeroVector = placeholderVector();
      const rows = plan.rowsToEmbed.map((row) => ({
        sessionId: row.sessionId,
        seq: row.seq,
        role: row.role,
        projectKey: row.projectKey,
        text: row.text,
        contentHash: unembeddedContentHash(row.contentHash),
        vector: zeroVector,
      }));
      await runSearchWorker("indexMessageRows", {
        rows,
      });
      return {
        status: "indexed" as const,
        messagesSeen: plan.currentRows.length,
        messagesEmbedded: 0,
        messagesReused: plan.messagesReused,
        keysDeleted,
        embeddingsConfigured: false,
      };
    }
    const embeddings = await embedRows(plan.rowsToEmbed);
    const rows = plan.rowsToEmbed.map((row, index) => ({
      sessionId: row.sessionId,
      seq: row.seq,
      role: row.role,
      projectKey: row.projectKey,
      text: row.text,
      contentHash: row.contentHash,
      vector: embeddings[index]!,
    }));
    await runSearchWorker("indexMessageRows", {
      rows,
    });
    return {
      status: "indexed" as const,
      messagesSeen: plan.currentRows.length,
      messagesEmbedded: rows.length,
      messagesReused: plan.messagesReused,
      keysDeleted,
      embeddingsConfigured: true,
    };
  } catch (error) {
    return {
      status: "failed" as const,
      error: error instanceof Error ? error.message : String(error),
      messagesSeen: 0,
      messagesEmbedded: 0,
      messagesReused: 0,
      keysDeleted: 0,
      embeddingsConfigured: serverEmbeddingsConfigured(),
    };
  }
};

export const indexSessionRows = internalAction({
  args: {
    sessionId: v.string(),
    currentMessages: v.array(currentMessageForIndexValidator),
  },
  handler: async (_ctx, args): Promise<IndexSessionRowsReport> => indexCurrentMessages(args),
});

export const indexSessionForIngest = action({
  args: {
    sessionId: v.string(),
    runId: v.string(),
    secret: v.string(),
    currentMessages: v.array(currentMessageForIndexValidator),
  },
  handler: async (_ctx, args): Promise<IndexSessionRowsReport> => {
    requireActionSecret(args.secret);
    return await indexCurrentMessages({
      sessionId: args.sessionId,
      currentMessages: args.currentMessages,
    });
  },
});

export const indexMessageRows = action({
  args: {
    secret: v.string(),
    rows: v.array(messageSearchRowValidator),
    createIndexes: v.optional(v.boolean()),
  },
  handler: async (_ctx, args) => {
    requireActionSecret(args.secret);
    const { secret: _secret, ...payload } = args;
    return runSearchWorker("indexMessageRows", payload);
  },
});

export const searchLexical = action({
  args: {
    secret: v.string(),
    query: v.string(),
    projectKey: projectKeyValidator,
    limit: limitValidator,
  },
  handler: async (_ctx, args) => {
    requireActionSecret(args.secret);
    const { secret: _secret, ...payload } = args;
    const hits = await runSearchWorker<SearchWorkerHit[]>("searchLexical", {
      ...payload,
      limit: searchLimit(args.limit),
    });
    return report({
      matches: hits.map((hit, index) => toSearchMatch(hit, { textRank: index + 1 })),
      textSearched: true,
      semanticSearched: false,
      semanticStatus: "unavailable",
    });
  },
});

export const searchSemantic = action({
  args: {
    secret: v.string(),
    query: v.string(),
    projectKey: projectKeyValidator,
    limit: limitValidator,
  },
  handler: async (_ctx, args) => {
    requireActionSecret(args.secret);
    const embedded = await embedQuery(args.query);
    if (embedded.status !== "ready") {
      return report({
        matches: [],
        textSearched: false,
        semanticSearched: false,
        semanticStatus: embedded.status,
        error: embedded.error,
      });
    }
    const hits = await runSearchWorker<SearchWorkerHit[]>("searchSemantic", {
      vector: embedded.vector,
      projectKey: args.projectKey,
      limit: searchLimit(args.limit),
    });
    return report({
      matches: hits.map((hit, index) => toSearchMatch(hit, { vectorRank: index + 1 })),
      textSearched: false,
      semanticSearched: true,
      semanticStatus: "ready",
      embeddingDimensions: embedded.vector.length,
    });
  },
});

export const searchFusion = action({
  args: {
    secret: v.string(),
    query: v.string(),
    projectKey: projectKeyValidator,
    limit: limitValidator,
  },
  handler: async (_ctx, args) => {
    requireActionSecret(args.secret);
    const limit = searchLimit(args.limit);
    const internalLimit = internalSearchLimit(args.limit);
    const textHits = await runSearchWorker<SearchWorkerHit[]>("searchLexical", {
      query: args.query,
      projectKey: args.projectKey,
      limit: internalLimit,
    });
    const embedded = await embedQuery(args.query);
    if (embedded.status !== "ready") {
      return report({
        matches: textHits
          .slice(0, limit)
          .map((hit, index) => toSearchMatch(hit, { textRank: index + 1 })),
        textSearched: true,
        semanticSearched: false,
        semanticStatus: embedded.status,
        error: embedded.error,
      });
    }
    const vectorHits = await runSearchWorker<SearchWorkerHit[]>("searchSemantic", {
      vector: embedded.vector,
      projectKey: args.projectKey,
      limit: internalLimit,
    });
    const textByKey = new Map(textHits.map((hit) => [hit.key, hit]));
    const vectorByKey = new Map(vectorHits.map((hit) => [hit.key, hit]));
    const fused = fuseMatches({
      textMatches: textHits,
      vectorMatches: vectorHits,
      limit,
    });
    return report({
      matches: fused.map((rank: FusedSearchRank) =>
        toSearchMatch((textByKey.get(rank.key) ?? vectorByKey.get(rank.key))!, {
          score: rank.score,
          textRank: rank.textRank,
          vectorRank: rank.vectorRank,
        }),
      ),
      textSearched: true,
      semanticSearched: true,
      semanticStatus: "ready",
      embeddingDimensions: embedded.vector.length,
    });
  },
});

export const maintainSearch = action({
  args: {
    secret: v.string(),
    createIndexes: v.optional(v.boolean()),
    createVectorIndex: v.optional(v.boolean()),
    replaceIndexes: v.optional(v.boolean()),
    optimize: v.optional(v.boolean()),
    cleanupOlderThanMs: v.optional(v.number()),
    deleteUnverified: v.optional(v.boolean()),
  },
  handler: async (_ctx, args): Promise<MaintenanceReport> => {
    requireActionSecret(args.secret);
    let createdIndexes = false;
    if (args.createIndexes !== false) {
      await runSearchWorker("createMissingIndexes", {
        createVectorIndex: args.createVectorIndex,
        replaceIndexes: args.replaceIndexes,
      });
      createdIndexes = true;
    }
    let optimizeReport: OptimizeReport | undefined;
    if (args.optimize !== false) {
      optimizeReport = await runSearchWorker<OptimizeReport>("optimizeTable", {
        cleanupOlderThanMs: args.cleanupOlderThanMs,
        deleteUnverified: args.deleteUnverified,
      });
    }
    const stats = await runSearchWorker<TableStatsReport>("tableStats", {});
    return {
      createdIndexes,
      optimized: optimizeReport !== undefined,
      ...(optimizeReport !== undefined ? { optimize: optimizeReport } : {}),
      stats,
    };
  },
});
