import { Command, Options } from "@effect/cli";
import { Effect, Option } from "effect";

import { api } from "../../../../convex/_generated/api";

import { createConvexClient, withRetry } from "../convex-client";
import { CommandInputError } from "../errors";
import { executeJsonCommand } from "../output";

export type SearchMode = "text" | "semantic" | "fusion";

export interface SearchMatchRow {
  readonly sessionId: string;
  readonly seq: number;
  readonly role: string;
  readonly projectKey: string;
  readonly text: string;
  readonly score?: number;
  readonly textRank?: number;
  readonly vectorRank?: number;
}

export interface SearchReport {
  readonly mode: SearchMode;
  readonly query: string;
  readonly limit: number;
  readonly projectKey?: string;
  readonly role?: string;
  readonly matches: readonly SearchMatchRow[];
  readonly diagnostics: {
    readonly textSearched: boolean;
    readonly semanticSearched: boolean;
    readonly semanticStatus?: string;
    readonly embeddingDimensions?: number;
    readonly queryTokens?: number;
  };
}

/** Mirrors the server-side cap on results per call. */
const SEARCH_TAKE_MAX = 20;

const CONVERSATION_ROLES = new Set(["user", "assistant"]);

const runSearch = async (options: {
  readonly query: string;
  readonly mode: SearchMode;
  readonly projectKey?: string;
  readonly role?: string;
  readonly limit?: number;
}): Promise<SearchReport> => {
  const client = createConvexClient();
  const scope = {
    ...(options.projectKey !== undefined ? { projectKey: options.projectKey } : {}),
    ...(options.limit !== undefined ? { limit: options.limit } : {}),
  };

  if (options.mode === "text") {
    const matches = await withRetry(() =>
      client.query(api.quasar.searchMessages, {
        query: options.query,
        ...scope,
        ...(options.role !== undefined
          ? { role: options.role as "user" | "assistant" | "reasoning" }
          : {}),
      }),
    );
    return {
      mode: "text",
      query: options.query,
      limit: options.limit ?? SEARCH_TAKE_MAX,
      ...(options.projectKey !== undefined ? { projectKey: options.projectKey } : {}),
      ...(options.role !== undefined ? { role: options.role } : {}),
      matches,
      diagnostics: { textSearched: true, semanticSearched: false },
    };
  }

  // Semantic and fusion legs embed only conversation roles; reasoning rows
  // are lexical-only by design (and still reachable through fusion's lexical
  // leg when no role filter is set).
  if (options.role !== undefined && !CONVERSATION_ROLES.has(options.role)) {
    throw new CommandInputError({
      field: "role",
      message: `--role ${options.role} is lexical-only; use --mode text, or a conversation role (user, assistant) for ${options.mode}.`,
    });
  }
  const args = {
    query: options.query,
    ...scope,
    ...(options.role !== undefined ? { role: options.role as "user" | "assistant" } : {}),
  };
  return options.mode === "semantic"
    ? await withRetry(() => client.action(api.embed.searchSemantic, args))
    : await withRetry(() => client.action(api.embed.searchFusion, args));
};

const queryOption = Options.text("query").pipe(
  Options.withDescription("Search query text"),
);
const modeOption = Options.choice("mode", ["text", "semantic", "fusion"]).pipe(
  Options.withDescription(
    "Search mode: text (lexical index), semantic (Gemini vector), fusion (RRF merge of both)",
  ),
  Options.withDefault("fusion" as const),
);
const projectOption = Options.text("project").pipe(
  Options.withDescription("Restrict to one projectKey (e.g. git:github.com/org/repo)"),
  Options.optional,
);
const roleOption = Options.choice("role", ["user", "assistant", "reasoning"]).pipe(
  Options.withDescription(
    "Restrict to one message role (reasoning is lexical-only: --mode text)",
  ),
  Options.optional,
);
const limitOption = Options.integer("limit").pipe(
  Options.withDescription(`Maximum matches to return (1..${SEARCH_TAKE_MAX})`),
  Options.optional,
);

export const searchCommand = Command.make(
  "search",
  {
    query: queryOption,
    mode: modeOption,
    project: projectOption,
    role: roleOption,
    limit: limitOption,
  },
  ({ query, mode, project, role, limit }) =>
    executeJsonCommand(
      "search",
      Effect.tryPromise({
        try: () =>
          runSearch({
            query,
            mode,
            projectKey: Option.getOrUndefined(project),
            role: Option.getOrUndefined(role),
            limit: Option.getOrUndefined(limit),
          }),
        catch: (error) => (error instanceof Error ? error : new Error(String(error))),
      }),
    ),
);
