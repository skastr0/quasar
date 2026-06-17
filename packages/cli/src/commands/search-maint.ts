import { Command, Options } from "@effect/cli";
import { Effect, Option } from "effect";

import { api } from "../../../../convex/_generated/api";

import { configuredActionSecret } from "../config";
import { createConvexClient, withRetry } from "../convex-client";
import { CommandInputError } from "../errors";
import { executeJsonCommand } from "../output";

const DEFAULT_CLEANUP_OLDER_THAN_MS = 0;

const createIndexesOption = Options.boolean("create-indexes").pipe(
  Options.withDefault(true),
  Options.withDescription("Create missing text and vector indexes before optimizing"),
);

const createVectorIndexOption = Options.boolean("create-vector-index").pipe(
  Options.withDefault(true),
  Options.withDescription("Create the vector index when creating missing indexes"),
);

const replaceIndexesOption = Options.boolean("replace-indexes").pipe(
  Options.withDefault(false),
  Options.withDescription("Replace existing indexes instead of skipping them"),
);

const optimizeOption = Options.boolean("optimize").pipe(
  Options.withDefault(true),
  Options.withDescription("Run table.optimize() to compact and prune old versions"),
);

const cleanupOlderThanMsOption = Options.integer("cleanup-older-than-ms").pipe(
  Options.withDefault(DEFAULT_CLEANUP_OLDER_THAN_MS),
  Options.withDescription(
    "Delete versions older than (now - N ms). 0 means all old versions except current.",
  ),
);

const requireSearchSecret = (secret: string | undefined): string => {
  if (secret !== undefined && secret.trim().length > 0) return secret.trim();
  throw new CommandInputError({
    field: "QUASAR_ACTION_SECRET",
    message:
      "Search maintenance requires QUASAR_ACTION_SECRET or ~/.config/quasar/local/default/config.json actionSecret.",
  });
};

export const runSearchMaintenance = async (options: {
  readonly createIndexes: boolean;
  readonly createVectorIndex: boolean;
  readonly replaceIndexes: boolean;
  readonly optimize: boolean;
  readonly cleanupOlderThanMs: number;
  readonly actionSecret?: string;
}): Promise<unknown> => {
  const secret = requireSearchSecret(options.actionSecret ?? configuredActionSecret());
  const client = createConvexClient();
  return withRetry(() =>
    client.action(api.search.maintainSearch, {
      secret,
      createIndexes: options.createIndexes,
      createVectorIndex: options.createVectorIndex,
      replaceIndexes: options.replaceIndexes,
      optimize: options.optimize,
      cleanupOlderThanMs: options.cleanupOlderThanMs,
    }),
  );
};

export const searchMaintainCommand = Command.make(
  "maintain",
  {
    createIndexes: createIndexesOption,
    createVectorIndex: createVectorIndexOption,
    replaceIndexes: replaceIndexesOption,
    optimize: optimizeOption,
    cleanupOlderThanMs: cleanupOlderThanMsOption,
  },
  ({ createIndexes, createVectorIndex, replaceIndexes, optimize, cleanupOlderThanMs }) =>
    executeJsonCommand(
      "search maintain",
      Effect.tryPromise({
        try: () =>
          runSearchMaintenance({
            createIndexes,
            createVectorIndex,
            replaceIndexes,
            optimize,
            cleanupOlderThanMs,
          }),
        catch: (error) => (error instanceof Error ? error : new Error(String(error))),
      }),
    ),
);
