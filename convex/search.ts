"use node";

import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { v } from "convex/values";

import { action } from "./_generated/server";

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

const limitValidator = v.optional(v.number());
const projectKeyValidator = v.optional(v.string());
const vectorValidator = v.array(v.number());

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
