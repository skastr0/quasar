import { Effect } from "effect";
import { createInterface } from "node:readline";

import {
  GEMINI_EMBEDDING_DIMENSIONS,
  LanceDb,
  MESSAGE_SEARCH_COLUMNS,
  makeLanceDbRuntime,
} from "./index";

const UNEMBEDDED_CONTENT_HASH_PREFIX = "unembedded:";

interface WorkerRequest {
  readonly operation: string;
  readonly payload: unknown;
}

interface WorkerOkResponse {
  readonly ok: true;
  readonly data: unknown;
}

interface WorkerErrorResponse {
  readonly ok: false;
  readonly error: string;
}

type WorkerResponse = WorkerOkResponse | WorkerErrorResponse;

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
  readonly sessionIds?: readonly string[];
  readonly query?: string;
  readonly vector?: readonly number[];
  readonly projectKey?: string;
  readonly limit?: number;
  readonly keys?: readonly string[];
  readonly cleanupOlderThanMs?: number;
  readonly deleteUnverified?: boolean;
}

const searchRuntime = makeLanceDbRuntime();

const projectFilter = (projectKey: string | undefined): string | undefined =>
  projectKey === undefined ? undefined : `projectKey = '${projectKey.replaceAll("'", "''")}'`;

const vectorReadyFilter = (projectKey: string | undefined): string => {
  const clauses = [`contentHash NOT LIKE '${UNEMBEDDED_CONTENT_HASH_PREFIX.replaceAll("'", "''")}%'`];
  const project = projectFilter(projectKey);
  if (project !== undefined) clauses.push(project);
  return clauses.join(" AND ");
};

const sessionIdsFilter = (sessionIds: readonly string[] | undefined): string | undefined => {
  if (sessionIds === undefined || sessionIds.length === 0) {
    return undefined;
  }
  const escaped = sessionIds.map((id) => `'${id.replaceAll("'", "''")}'`).join(", ");
  return `sessionId IN (${escaped})`;
};

const runOperation = async (
  operation: string,
  payload: WorkerPayload,
): Promise<WorkerResponse> => {
  try {
    switch (operation) {
      case "indexMessageRows":
        return {
          ok: true,
          data: await searchRuntime.runPromise(
            Effect.gen(function* () {
              const search = yield* LanceDb;
              yield* search.upsertMessageRows({
                rows: payload.rows ?? [],
              });
              return { indexed: payload.rows?.length ?? 0 };
            }),
          ),
        };
      case "createMissingIndexes":
        return {
          ok: true,
          data: await searchRuntime.runPromise(
            Effect.gen(function* () {
              const search = yield* LanceDb;
              yield* search.createMessageIndexes({
                includeVector: payload.createVectorIndex,
                replace: payload.replaceIndexes,
              });
              return { created: true };
            }),
          ),
        };
      case "optimizeTable":
        return {
          ok: true,
          data: await searchRuntime.runPromise(
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
          ),
        };
      case "tableStats":
        return {
          ok: true,
          data: await searchRuntime.runPromise(
            Effect.gen(function* () {
              const search = yield* LanceDb;
              return yield* search.tableStats({});
            }),
          ),
        };
      case "readMessageRowsBySession":
        return {
          ok: true,
          data: await searchRuntime.runPromise(
            Effect.gen(function* () {
              const search = yield* LanceDb;
              return yield* search.readMessageRowsBySession({
                sessionId: payload.sessionId ?? "",
                select: MESSAGE_SEARCH_COLUMNS,
              });
            }),
          ),
        };
      case "readMessageRowsBySessions":
        return {
          ok: true,
          data: await searchRuntime.runPromise(
            Effect.gen(function* () {
              const search = yield* LanceDb;
              return yield* search.readMessageRowsBySessions({
                sessionIds: payload.sessionIds ?? [],
                select: MESSAGE_SEARCH_COLUMNS,
              });
            }),
          ),
        };
      case "deleteByKeys":
        return {
          ok: true,
          data: await searchRuntime.runPromise(
            Effect.gen(function* () {
              const search = yield* LanceDb;
              const deleted = yield* search.deleteByKeys({ keys: payload.keys ?? [] });
              return { deleted };
            }),
          ),
        };
      case "searchLexical":
        return {
          ok: true,
          data: await searchRuntime.runPromise(
            Effect.gen(function* () {
              const search = yield* LanceDb;
              return yield* search.ftsSearch({
                query: payload.query ?? "",
                limit: payload.limit,
                filter: projectFilter(payload.projectKey),
                select: MESSAGE_SEARCH_COLUMNS,
              });
            }),
          ),
        };
      case "searchSemantic":
        return {
          ok: true,
          data: await searchRuntime.runPromise(
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
          ),
        };
      case "searchFusion":
        return {
          ok: true,
          data: await searchRuntime.runPromise(
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
          ),
        };
      default:
        return { ok: false, error: `Unknown search worker operation: ${operation ?? "<missing>"}` };
    }
  } catch (error) {
    const message = error instanceof Error ? error.stack ?? error.message : String(error);
    return { ok: false, error: message };
  }
};

const run = async () => {
  const rl = createInterface({
    input: process.stdin,
    output: undefined,
    terminal: false,
  });
  try {
    for await (const line of rl) {
      const trimmed = line.trim();
      if (trimmed.length === 0) {
        continue;
      }
      let request: WorkerRequest;
      try {
        request = JSON.parse(trimmed) as WorkerRequest;
      } catch (error) {
        process.stdout.write(
          JSON.stringify({
            ok: false,
            error: `Invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
          } satisfies WorkerErrorResponse) + "\n",
        );
        continue;
      }
      const response = await runOperation(request.operation, (request.payload ?? {}) as WorkerPayload);
      process.stdout.write(JSON.stringify(response) + "\n");
    }
  } finally {
    await searchRuntime.dispose();
  }
};

run().catch((error) => {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  process.stderr.write(message);
  process.exit(1);
});
