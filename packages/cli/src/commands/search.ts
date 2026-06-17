import { Command, Options } from "@effect/cli";
import { Effect, Option } from "effect";

import { api } from "../../../../convex/_generated/api";

import { configuredActionSecret } from "../config";
import { createConvexClient, withRetry } from "../convex-client";
import { CommandInputError } from "../errors";
import { executeJsonCommand } from "../output";

const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 20;

export type SearchMode = "text" | "semantic" | "fusion";
export type SearchActionReference =
  | typeof api.search.searchLexical
  | typeof api.search.searchSemantic
  | typeof api.search.searchFusion;

export interface SearchActionClient {
  action(reference: SearchActionReference, args: unknown): Promise<unknown>;
}

const queryOption = Options.text("query").pipe(
  Options.withDescription("Search query text"),
);

const modeOption = Options.choice("mode", ["fusion", "text", "semantic"] as const).pipe(
  Options.withDefault("fusion"),
  Options.withDescription("Search mode: text, semantic, or fusion"),
);

const limitOption = Options.integer("limit").pipe(
  Options.withDescription(`Maximum matches to return (1..${MAX_LIMIT})`),
  Options.optional,
);

const projectOption = Options.text("project").pipe(
  Options.withDescription("Restrict to one projectKey"),
  Options.optional,
);

export const checkedSearchLimit = (value: Option.Option<number>): number => {
  const limit = Option.getOrElse(value, () => DEFAULT_LIMIT);
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
    throw new CommandInputError({
      field: "limit",
      message: `limit must be an integer in [1, ${MAX_LIMIT}], got ${limit}`,
    });
  }
  return limit;
};

const requireSearchSecret = (secret: string | undefined): string => {
  if (secret !== undefined && secret.trim().length > 0) return secret.trim();
  throw new CommandInputError({
    field: "QUASAR_ACTION_SECRET",
    message:
      "Search actions require QUASAR_ACTION_SECRET or ~/.config/quasar/local/default/config.json actionSecret.",
  });
};

export const searchActionForMode = (mode: SearchMode): SearchActionReference => {
  switch (mode) {
    case "text":
      return api.search.searchLexical;
    case "semantic":
      return api.search.searchSemantic;
    case "fusion":
      return api.search.searchFusion;
  }
};

export const runSearchQuery = async (options: {
  readonly query: string;
  readonly mode: SearchMode;
  readonly limit: number;
  readonly projectKey?: string;
  readonly actionSecret?: string;
  readonly client?: SearchActionClient;
}): Promise<unknown> => {
  const query = options.query.trim();
  if (query.length === 0) {
    throw new CommandInputError({
      field: "query",
      message: "query must not be empty",
    });
  }
  const secret = requireSearchSecret(options.actionSecret ?? configuredActionSecret());
  const client = options.client ?? createConvexClient();
  return withRetry(() =>
    client.action(searchActionForMode(options.mode), {
      secret,
      query,
      limit: options.limit,
      ...(options.projectKey !== undefined ? { projectKey: options.projectKey } : {}),
    }),
  );
};

export const searchCommand = Command.make(
  "search",
  {
    query: queryOption,
    mode: modeOption,
    project: projectOption,
    limit: limitOption,
  },
  ({ query, mode, project, limit }) =>
    executeJsonCommand(
      "search",
      Effect.tryPromise({
        try: () =>
          runSearchQuery({
            query,
            mode,
            projectKey: Option.getOrUndefined(project),
            limit: checkedSearchLimit(limit),
          }),
        catch: (error) => (error instanceof Error ? error : new Error(String(error))),
      }),
    ),
);
