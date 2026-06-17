"use node";

import { createGoogleGenerativeAI, type GoogleEmbeddingModelOptions } from "@ai-sdk/google";
import { embedMany } from "ai";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { v } from "convex/values";

import { action, internalAction } from "./_generated/server";
import { api, internal } from "./_generated/api";
import type { DataModel } from "./_generated/dataModel";
import { GenericActionCtx } from "convex/server";
import { chunkMessage, type MessageChunk } from "./chunk";
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
  type IndexableChunk,
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

const embedRows = async (
  ctx: GenericActionCtx<DataModel>,
  rows: readonly PlannedMessageRow[],
): Promise<readonly number[][]> => {
  const apiKey = configuredGoogleApiKey();
  if (apiKey === undefined || apiKey.trim().length === 0) {
    throw new Error("Gemini embeddings are not configured");
  }

  const uniqueHashes = [...new Set(rows.map((row) => row.contentHash))];
  const cached = await ctx.runQuery(internal.embedCache.lookup, { contentHashes: uniqueHashes });
  const cachedSet = new Set(Object.keys(cached));

  const missRows = rows.filter((row) => !cachedSet.has(row.contentHash));
  const google = createGoogleGenerativeAI({ apiKey });
  const missEmbeddings: number[][] = [];
  if (missRows.length > 0) {
    for (let index = 0; index < missRows.length; index += GEMINI_EMBED_BATCH_MAX) {
      const batch = missRows.slice(index, index + GEMINI_EMBED_BATCH_MAX);
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
        missEmbeddings.push(embedding);
      }
    }
    await ctx.runMutation(internal.embedCache.store, {
      entries: missRows.map((row, index) => ({
        contentHash: row.contentHash,
        vector: missEmbeddings[index]!,
      })),
    });
  }

  const missByHash = new Map(missRows.map((row, index) => [row.contentHash, missEmbeddings[index]!]));
  return rows.map((row) => {
    const cachedVector = cached[row.contentHash];
    if (cachedVector !== undefined) return [...cachedVector];
    const missVector = missByHash.get(row.contentHash);
    if (missVector !== undefined) return missVector;
    throw new Error(`Missing embedding for content hash ${row.contentHash}`);
  });
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

interface WorkerEnvelope {
  readonly ok: boolean;
  readonly data?: unknown;
  readonly error?: string;
}

class SearchWorkerClient {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly lines: AsyncIterator<string>;
  private readonly stderrBuffer: string[] = [];
  private closed = false;

  constructor() {
    this.child = spawn(process.env.QUASAR_BUN_BIN ?? "bun", [workerPath], {
      cwd: process.env.QUASAR_REPO_ROOT ?? process.cwd(),
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child.stderr.setEncoding("utf8");
    this.child.stderr.on("data", (chunk: string) => {
      this.stderrBuffer.push(chunk);
    });
    const rl = createInterface({
      input: this.child.stdout,
      crlfDelay: Infinity,
    });
    this.lines = rl[Symbol.asyncIterator]();
  }

  async request<T>(operation: string, payload: unknown): Promise<T> {
    if (this.closed) {
      throw new Error("SearchWorkerClient request after close");
    }
    const requestLine = JSON.stringify({ operation, payload }) + "\n";
    await this.writeStdin(requestLine);
    const next = await this.lines.next();
    if (next.done === true) {
      const stderr = this.stderrBuffer.join("").trim();
      throw new Error(stderr || `search worker closed before response for ${operation}`);
    }
    const envelope = this.parseEnvelope(next.value, operation);
    if (envelope.ok !== true) {
      throw new Error(envelope.error ?? `search worker ${operation} failed`);
    }
    return envelope.data as T;
  }

  private writeStdin(line: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const writable = this.child.stdin;
      const onError = (err: Error) => {
        writable.off("error", onError);
        reject(err);
      };
      writable.once("error", onError);
      const flushed = writable.write(line, (err) => {
        if (err) {
          writable.off("error", onError);
          reject(err);
        } else {
          writable.off("error", onError);
          resolve();
        }
      });
      if (!flushed) {
        writable.once("drain", () => {
          writable.off("error", onError);
          resolve();
        });
      }
    });
  }

  private parseEnvelope(line: string, operation: string): WorkerEnvelope {
    try {
      return JSON.parse(line) as WorkerEnvelope;
    } catch (err) {
      throw new Error(
        `search worker ${operation} returned invalid JSON: ${err instanceof Error ? err.message : String(err)}: ${line.slice(0, 200)}`,
      );
    }
  }

  async close(): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.child.stdin.end();
    const deadlineMs = 5_000;
    const start = Date.now();
    await new Promise<void>((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        resolve();
      };
      this.child.on("close", finish);
      const timeout = setTimeout(() => {
        this.child.kill("SIGTERM");
        const remaining = Math.max(0, deadlineMs - (Date.now() - start));
        setTimeout(() => {
          this.child.kill("SIGKILL");
          finish();
        }, remaining);
      }, deadlineMs);
      this.child.on("error", () => {
        clearTimeout(timeout);
        finish();
      });
    });
  }
}

const withSearchWorker = async <T>(fn: (client: SearchWorkerClient) => Promise<T>): Promise<T> => {
  const client = new SearchWorkerClient();
  try {
    return await fn(client);
  } finally {
    await client.close();
  }
};

const runSearchWorker = <T>(operation: string, payload: unknown): Promise<T> =>
  withSearchWorker((client) => client.request<T>(operation, payload));

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

const chunksForMessages = (messages: readonly CurrentMessageForIndex[]): readonly IndexableChunk[] =>
  messages.flatMap((message) => chunkMessage(message));

const indexCurrentMessages = async (
  ctx: GenericActionCtx<DataModel>,
  args: {
    readonly sessionId: string;
    readonly currentMessages: readonly CurrentMessageForIndex[];
  },
): Promise<IndexSessionRowsReport> => {
  try {
    const existingRows = await runSearchWorker<ExistingSearchRow[]>("readMessageRowsBySession", {
      sessionId: args.sessionId,
    });
    const currentChunks = chunksForMessages(args.currentMessages);
    const embeddingsConfigured = serverEmbeddingsConfigured();
    const plan = planSessionIndex({
      currentChunks,
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
        messagesSeen: args.currentMessages.length,
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
        messagesSeen: args.currentMessages.length,
        messagesEmbedded: 0,
        messagesReused: plan.messagesReused,
        keysDeleted,
        embeddingsConfigured: false,
      };
    }
    const embeddings = await embedRows(ctx, plan.rowsToEmbed);
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
      messagesSeen: args.currentMessages.length,
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
  handler: async (ctx, args): Promise<IndexSessionRowsReport> => indexCurrentMessages(ctx, args),
});

export const indexSessionForIngest = action({
  args: {
    sessionId: v.string(),
    runId: v.string(),
    secret: v.string(),
    currentMessages: v.array(currentMessageForIndexValidator),
  },
  handler: async (ctx, args): Promise<IndexSessionRowsReport> => {
    requireActionSecret(args.secret);
    return await indexCurrentMessages(ctx, {
      sessionId: args.sessionId,
      currentMessages: args.currentMessages,
    });
  },
});

interface IndexBatchRowsReport {
  readonly status: "indexed" | "failed";
  readonly sessionsSeen: number;
  readonly messagesSeen: number;
  readonly messagesEmbedded: number;
  readonly messagesReused: number;
  readonly keysDeleted: number;
  readonly embeddingsConfigured: boolean;
  readonly error?: string;
}

const parseMessageKeySessionId = (key: string): string => {
  const parts = key.split(":");
  if (parts.length < 4) {
    // Legacy or malformed key: fall back to the whole key so the row is grouped safely.
    return key;
  }
  parts.pop(); // chunkIndex
  parts.pop(); // role
  parts.pop(); // seq
  return parts.join(":");
};

const MESSAGES_PER_SESSION_LIMIT = 10_000;
const INDEX_READ_CONCURRENCY = 10;

const runInBatches = async <T, R>(
  items: readonly T[],
  batchSize: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> => {
  const results: R[] = [];
  for (let index = 0; index < items.length; index += batchSize) {
    const batch = items.slice(index, index + batchSize);
    results.push(...(await Promise.all(batch.map(fn))));
  }
  return results;
};

const indexBatchMessages = async (
  ctx: GenericActionCtx<DataModel>,
  sessionIds: readonly string[],
): Promise<IndexBatchRowsReport> => {
  try {
    const embeddingsConfigured = serverEmbeddingsConfigured();
    const messagesBySession = new Map<string, readonly CurrentMessageForIndex[]>();
    await runInBatches(sessionIds, INDEX_READ_CONCURRENCY, async (sessionId) => {
      const currentMessages = await ctx.runQuery(internal.ingestQueries.messagesForBatchIndex, { sessionId });
      messagesBySession.set(sessionId, currentMessages);
    });

    return await withSearchWorker(async (client) => {
      const existingRows = await client.request<Record<string, unknown>[]>("readMessageRowsBySessions", {
        sessionIds,
      });
      const existingBySession = new Map<string, ExistingSearchRow[]>();
      for (const row of existingRows) {
        const typed: ExistingSearchRow = {
          key: String(row.key),
          contentHash: row.contentHash === undefined ? undefined : String(row.contentHash),
        };
        const sessionId = parseMessageKeySessionId(typed.key);
        const list = existingBySession.get(sessionId) ?? [];
        list.push(typed);
        existingBySession.set(sessionId, list);
      }

      const keysToDelete: string[] = [];
      const rowsToEmbed: PlannedMessageRow[] = [];
      let messagesSeen = 0;
      let messagesReused = 0;
      for (const sessionId of sessionIds) {
        const currentMessages = messagesBySession.get(sessionId) ?? [];
        messagesSeen += currentMessages.length;
        const currentChunks = chunksForMessages(currentMessages);
        const existingRowsForSession = existingBySession.get(sessionId) ?? [];
        const plan = planSessionIndex({
          currentChunks,
          existingRows: embeddingsConfigured ? existingRowsForSession : lexicalOnlyPlanRows(existingRowsForSession),
        });
        keysToDelete.push(...plan.keysToDelete);
        rowsToEmbed.push(...plan.rowsToEmbed);
        messagesReused += plan.messagesReused;
      }

      let keysDeleted = 0;
      if (keysToDelete.length > 0) {
        const result = await client.request<{ deleted: number }>("deleteByKeys", {
          keys: keysToDelete,
        });
        keysDeleted = result.deleted;
      }

      if (rowsToEmbed.length === 0) {
        return {
          status: "indexed" as const,
          sessionsSeen: sessionIds.length,
          messagesSeen,
          messagesEmbedded: 0,
          messagesReused,
          keysDeleted,
          embeddingsConfigured,
        };
      }

      if (!embeddingsConfigured) {
        const zeroVector = placeholderVector();
        const rows = rowsToEmbed.map((row) => ({
          sessionId: row.sessionId,
          seq: row.seq,
          role: row.role,
          projectKey: row.projectKey,
          text: row.text,
          contentHash: unembeddedContentHash(row.contentHash),
          vector: zeroVector,
        }));
        await client.request("indexMessageRows", { rows });
        return {
          status: "indexed" as const,
          sessionsSeen: sessionIds.length,
          messagesSeen,
          messagesEmbedded: 0,
          messagesReused,
          keysDeleted,
          embeddingsConfigured: false,
        };
      }

      const embeddings = await embedRows(ctx, rowsToEmbed);
      const rows = rowsToEmbed.map((row, index) => ({
        sessionId: row.sessionId,
        seq: row.seq,
        role: row.role,
        projectKey: row.projectKey,
        text: row.text,
        contentHash: row.contentHash,
        vector: embeddings[index]!,
      }));
      await client.request("indexMessageRows", { rows });
      return {
        status: "indexed" as const,
        sessionsSeen: sessionIds.length,
        messagesSeen,
        messagesEmbedded: rows.length,
        messagesReused,
        keysDeleted,
        embeddingsConfigured: true,
      };
    });
  } catch (error) {
    return {
      status: "failed" as const,
      error: error instanceof Error ? error.message : String(error),
      sessionsSeen: sessionIds.length,
      messagesSeen: 0,
      messagesEmbedded: 0,
      messagesReused: 0,
      keysDeleted: 0,
      embeddingsConfigured: serverEmbeddingsConfigured(),
    };
  }
};

export const indexBatchRows = internalAction({
  args: {
    sessionIds: v.array(v.string()),
  },
  handler: async (ctx, args): Promise<IndexBatchRowsReport> => {
    return indexBatchMessages(ctx, args.sessionIds);
  },
});

export const indexBatchForIngest = action({
  args: {
    secret: v.string(),
    sessionIds: v.array(v.string()),
  },
  handler: async (ctx, args): Promise<IndexBatchRowsReport> => {
    requireActionSecret(args.secret);
    return indexBatchMessages(ctx, args.sessionIds);
  },
});

export const indexMessageRows = action({
  args: {
    secret: v.string(),
    rows: v.array(messageSearchRowValidator),
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
