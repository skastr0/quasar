import { Effect } from "effect";

import {
  GEMINI_EMBEDDING_DIMENSIONS,
  LanceDb,
  MESSAGE_SEARCH_COLUMNS,
  makeLanceDbRuntime,
} from "./index";

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
  readonly createIndexes?: boolean;
  readonly sessionId?: string;
  readonly query?: string;
  readonly vector?: readonly number[];
  readonly projectKey?: string;
  readonly limit?: number;
  readonly keys?: readonly string[];
}

const searchRuntime = makeLanceDbRuntime();

const stdin = await Bun.stdin.text();
const payload = JSON.parse(stdin || "{}") as WorkerPayload;
const operation = process.argv[2];

const projectFilter = (projectKey: string | undefined): string | undefined =>
  projectKey === undefined ? undefined : `projectKey = '${projectKey.replaceAll("'", "''")}'`;

const run = async () => {
  switch (operation) {
    case "indexMessageRows":
      return searchRuntime.runPromise(
        Effect.gen(function* () {
          const search = yield* LanceDb;
          yield* search.ensureMessageTable({
            rows: payload.rows ?? [],
            createIndexes: payload.createIndexes,
          });
          return { indexed: payload.rows?.length ?? 0 };
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
            filter: projectFilter(payload.projectKey),
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
            filter: projectFilter(payload.projectKey),
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
