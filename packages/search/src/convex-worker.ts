import { Effect } from "effect";

import {
  GEMINI_EMBEDDING_DIMENSIONS,
  LanceDb,
  MESSAGE_SEARCH_COLUMNS,
  makeLanceDbRuntime,
} from "./index";

const UNEMBEDDED_CONTENT_HASH_PREFIX = "unembedded:";

interface WorkerPayload {
  readonly rows?: readonly {
    readonly sessionId: string;
    readonly seq: number;
    readonly role: "user" | "assistant";
    readonly projectKey: string;
    readonly text: string;
    readonly contentHash: string;
    readonly vector: readonly number[];
  }[];
  readonly createVectorIndex?: boolean;
  readonly replaceIndexes?: boolean;
  readonly sessionId?: string;
  readonly query?: string;
  readonly vector?: readonly number[];
  readonly projectKey?: string;
  readonly limit?: number;
  readonly keys?: readonly string[];
  readonly cleanupOlderThanMs?: number;
  readonly deleteUnverified?: boolean;
}

const searchRuntime = makeLanceDbRuntime();

const stdin = await Bun.stdin.text();
const payload = JSON.parse(stdin || "{}") as WorkerPayload;
const operation = process.argv[2];

const projectFilter = (projectKey: string | undefined): string | undefined =>
  projectKey === undefined ? undefined : `projectKey = '${projectKey.replaceAll("'", "''")}'`;

const vectorReadyFilter = (projectKey: string | undefined): string => {
  const clauses = [`contentHash NOT LIKE '${UNEMBEDDED_CONTENT_HASH_PREFIX.replaceAll("'", "''")}%'`];
  const project = projectFilter(projectKey);
  if (project !== undefined) clauses.push(project);
  return clauses.join(" AND ");
};

const run = async () => {
  switch (operation) {
    case "indexMessageRows":
      return searchRuntime.runPromise(
        Effect.gen(function* () {
          const search = yield* LanceDb;
          yield* search.upsertMessageRows({
            rows: payload.rows ?? [],
          });
          return { indexed: payload.rows?.length ?? 0 };
        }),
      );
    case "createMissingIndexes":
      return searchRuntime.runPromise(
        Effect.gen(function* () {
          const search = yield* LanceDb;
          yield* search.createMessageIndexes({
            includeVector: payload.createVectorIndex,
            replace: payload.replaceIndexes,
          });
          return { created: true };
        }),
      );
    case "optimizeTable":
      return searchRuntime.runPromise(
        Effect.gen(function* () {
          const search = yield* LanceDb;
          const cleanupOlderThan =
            payload.cleanupOlderThanMs === undefined
              ? undefined
              : new Date(Date.now() - payload.cleanupOlderThanMs);
          return yield* search.optimizeTable({
            cleanupOlderThan,
            deleteUnverified: payload.deleteUnverified,
          });
        }),
      );
    case "tableStats":
      return searchRuntime.runPromise(
        Effect.gen(function* () {
          const search = yield* LanceDb;
          return yield* search.tableStats({});
        }),
      );
    case "readMessageRowsBySession":
      return searchRuntime.runPromise(
        Effect.gen(function* () {
          const search = yield* LanceDb;
          return yield* search.readMessageRowsBySession({
            sessionId: payload.sessionId ?? "",
            select: MESSAGE_SEARCH_COLUMNS,
          });
        }),
      );
    case "deleteByKeys":
      return searchRuntime.runPromise(
        Effect.gen(function* () {
          const search = yield* LanceDb;
          const deleted = yield* search.deleteByKeys({ keys: payload.keys ?? [] });
          return { deleted };
        }),
      );
    case "searchLexical":
      return searchRuntime.runPromise(
        Effect.gen(function* () {
          const search = yield* LanceDb;
          return yield* search.ftsSearch({
            query: payload.query ?? "",
            limit: payload.limit,
            filter: projectFilter(payload.projectKey),
            select: MESSAGE_SEARCH_COLUMNS,
          });
        }),
      );
    case "searchSemantic":
      return searchRuntime.runPromise(
        Effect.gen(function* () {
          const search = yield* LanceDb;
          return yield* search.vectorSearch({
            vector: payload.vector ?? [],
            vectorDimension: GEMINI_EMBEDDING_DIMENSIONS,
            limit: payload.limit,
            filter: vectorReadyFilter(payload.projectKey),
            select: MESSAGE_SEARCH_COLUMNS,
          });
        }),
      );
    case "searchFusion":
      return searchRuntime.runPromise(
        Effect.gen(function* () {
          const search = yield* LanceDb;
          return yield* search.hybridSearch({
            query: payload.query ?? "",
            vector: payload.vector ?? [],
            vectorDimension: GEMINI_EMBEDDING_DIMENSIONS,
            limit: payload.limit,
            filter: vectorReadyFilter(payload.projectKey),
            select: MESSAGE_SEARCH_COLUMNS,
          });
        }),
      );
    default:
      throw new Error(`Unknown search worker operation: ${operation ?? "<missing>"}`);
  }
};

try {
  process.stdout.write(JSON.stringify(await run()));
} catch (error) {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  process.stderr.write(message);
  process.exit(1);
}
