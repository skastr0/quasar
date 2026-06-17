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
  planSessionIndex,
  type CurrentMessageForIndex,
  type ExistingSearchRow,
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
const vectorValidator = v.array(v.number());

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

const configuredGoogleApiKey = (): string | undefined =>
  process.env[GOOGLE_API_KEY_ENV] ?? process.env[GOOGLE_GENERATIVE_AI_API_KEY_ENV];

const serverEmbeddingsConfigured = (): boolean => {
  const apiKey = configuredGoogleApiKey();
  return apiKey !== undefined && apiKey.trim().length > 0;
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

const indexCurrentMessages = async (args: {
  readonly sessionId: string;
  readonly currentMessages: readonly CurrentMessageForIndex[];
}): Promise<IndexSessionRowsReport> => {
  try {
    const existingRows = await runSearchWorker<ExistingSearchRow[]>("readMessageRowsBySession", {
      sessionId: args.sessionId,
    });
    const plan = planSessionIndex({
      currentMessages: args.currentMessages,
      existingRows,
    });

    if (plan.rowsToEmbed.length > 0 && !serverEmbeddingsConfigured()) {
      return {
        status: "unconfigured" as const,
        messagesSeen: plan.currentRows.length,
        messagesEmbedded: 0,
        messagesReused: plan.messagesReused,
        keysDeleted: 0,
        embeddingsConfigured: false,
      };
    }

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
        embeddingsConfigured: serverEmbeddingsConfigured(),
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
    await runSearchWorker("indexMessageRows", { rows, createIndexes: false });
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
    return runSearchWorker("searchLexical", payload);
  },
});

export const searchSemantic = action({
  args: {
    secret: v.string(),
    vector: vectorValidator,
    projectKey: projectKeyValidator,
    limit: limitValidator,
  },
  handler: async (_ctx, args) => {
    requireActionSecret(args.secret);
    const { secret: _secret, ...payload } = args;
    return runSearchWorker("searchSemantic", payload);
  },
});

export const searchFusion = action({
  args: {
    secret: v.string(),
    query: v.string(),
    vector: vectorValidator,
    projectKey: projectKeyValidator,
    limit: limitValidator,
  },
  handler: async (_ctx, args) => {
    requireActionSecret(args.secret);
    const { secret: _secret, ...payload } = args;
    return runSearchWorker("searchFusion", payload);
  },
});
