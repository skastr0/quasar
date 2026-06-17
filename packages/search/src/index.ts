import * as lancedb from "@lancedb/lancedb";
import { Effect, Layer, ManagedRuntime, Schema } from "effect";
import { homedir } from "node:os";
import { join } from "node:path";

import type { Connection, Table } from "@lancedb/lancedb";

export const DEFAULT_SEARCH_TABLE = "messages";
export const DEFAULT_VECTOR_COLUMN = "vector";
export const DEFAULT_TEXT_COLUMN = "text";
export const DEFAULT_KEY_COLUMN = "key";
export const DEFAULT_FUSION_K = 60;

export type SearchVector = readonly number[];

export interface SearchRow {
  readonly key: string;
  readonly text: string;
  readonly vector: SearchVector;
  readonly [field: string]: unknown;
}

export interface LanceDbLayerOptions {
  readonly dataDir?: string;
}

export interface TableRequest {
  readonly tableName?: string;
}

export interface EnsureTableRequest extends TableRequest {
  readonly rows: readonly SearchRow[];
  readonly mode?: "create" | "overwrite";
  readonly vectorColumn?: string;
  readonly vectorDimension?: number;
}

export interface UpsertRowsRequest extends TableRequest {
  readonly rows: readonly SearchRow[];
  readonly keyColumn?: string;
  readonly vectorColumn?: string;
  readonly vectorDimension?: number;
}

export interface DeleteByKeysRequest extends TableRequest {
  readonly keys: readonly string[];
  readonly keyColumn?: string;
}

export interface ReadRowsRequest extends TableRequest {
  readonly filter?: string;
  readonly limit?: number;
  readonly select?: readonly string[];
}

export interface VectorSearchRequest extends TableRequest {
  readonly vector: SearchVector;
  readonly vectorColumn?: string;
  readonly vectorDimension?: number;
  readonly limit?: number;
  readonly filter?: string;
  readonly select?: readonly string[];
}

export interface FullTextSearchRequest extends TableRequest {
  readonly query: string;
  readonly textColumn?: string;
  readonly limit?: number;
  readonly filter?: string;
  readonly select?: readonly string[];
}

export interface HybridSearchRequest extends TableRequest {
  readonly query: string;
  readonly vector: SearchVector;
  readonly keyColumn?: string;
  readonly textColumn?: string;
  readonly vectorColumn?: string;
  readonly vectorDimension?: number;
  readonly limit?: number;
  readonly fusionK?: number;
  readonly filter?: string;
  readonly select?: readonly string[];
}

export interface SearchHit {
  readonly key: string;
  readonly score: number;
  readonly row: Record<string, unknown>;
}

export class ConnectionFailed extends Schema.TaggedError<ConnectionFailed>()(
  "ConnectionFailed",
  {
    dataDir: Schema.String,
    operation: Schema.String,
    message: Schema.String,
    cause: Schema.optional(Schema.Unknown),
  },
) {}

export class DimensionMismatch extends Schema.TaggedError<DimensionMismatch>()(
  "DimensionMismatch",
  {
    column: Schema.String,
    expected: Schema.Number,
    actual: Schema.Number,
    message: Schema.String,
  },
) {}

export class IndexNotReady extends Schema.TaggedError<IndexNotReady>()(
  "IndexNotReady",
  {
    tableName: Schema.String,
    indexName: Schema.String,
    operation: Schema.String,
    message: Schema.String,
    cause: Schema.optional(Schema.Unknown),
  },
) {}

export class LanceDbOperationFailed extends Schema.TaggedError<LanceDbOperationFailed>()(
  "LanceDbOperationFailed",
  {
    tableName: Schema.String,
    operation: Schema.String,
    message: Schema.String,
    cause: Schema.optional(Schema.Unknown),
  },
) {}

type LanceDbError =
  | ConnectionFailed
  | DimensionMismatch
  | IndexNotReady
  | LanceDbOperationFailed;

const defaultSearchDataDir = (): string => join(homedir(), ".config", "quasar", "search.lance");

export const searchDataDirFromEnv = (): string =>
  process.env.QUASAR_SEARCH_DATA_DIR?.trim() || defaultSearchDataDir();

const tableNameOrDefault = (tableName: string | undefined): string =>
  tableName?.trim() || DEFAULT_SEARCH_TABLE;

const keyColumnOrDefault = (keyColumn: string | undefined): string =>
  keyColumn?.trim() || DEFAULT_KEY_COLUMN;

const vectorColumnOrDefault = (vectorColumn: string | undefined): string =>
  vectorColumn?.trim() || DEFAULT_VECTOR_COLUMN;

const textColumnOrDefault = (textColumn: string | undefined): string =>
  textColumn?.trim() || DEFAULT_TEXT_COLUMN;

const limitOrDefault = (limit: number | undefined): number =>
  limit !== undefined && Number.isInteger(limit) && limit > 0 ? limit : 10;

const selectOrDefault = (select: readonly string[] | undefined): string[] =>
  select === undefined || select.length === 0 ? [DEFAULT_KEY_COLUMN, DEFAULT_TEXT_COLUMN] : [...select];

const assertIdentifier = (
  tableName: string,
  operation: string,
  identifier: string,
): Effect.Effect<void, LanceDbOperationFailed> =>
  /^[A-Za-z_][A-Za-z0-9_]*$/.test(identifier)
    ? Effect.void
    : Effect.fail(
        new LanceDbOperationFailed({
          tableName,
          operation,
          message: `Invalid SQL identifier: ${identifier}`,
        }),
      );

const escapeSqlString = (value: string): string => `'${value.replaceAll("'", "''")}'`;

const rowsForLance = (rows: readonly SearchRow[]): Record<string, unknown>[] =>
  rows.map((row) =>
    Object.fromEntries(
      Object.entries(row).map(([key, value]) => [key, Array.isArray(value) ? [...value] : value]),
    ),
  );

const detectIndexNotReady = (
  tableName: string,
  indexName: string,
  operation: string,
  cause: unknown,
): IndexNotReady | LanceDbOperationFailed => {
  const message = cause instanceof Error ? cause.message : String(cause);
  if (/index|fts|full.?text|not found|not exist/i.test(message)) {
    return new IndexNotReady({
      tableName,
      indexName,
      operation,
      message,
      cause,
    });
  }
  return new LanceDbOperationFailed({
    tableName,
    operation,
    message,
    cause,
  });
};

const assertVectorDimension = (
  vector: SearchVector,
  vectorColumn: string,
  vectorDimension: number | undefined,
): Effect.Effect<void, DimensionMismatch> =>
  vectorDimension === undefined || vector.length === vectorDimension
    ? Effect.void
    : Effect.fail(
        new DimensionMismatch({
          column: vectorColumn,
          expected: vectorDimension,
          actual: vector.length,
          message: `${vectorColumn} has dimension ${vector.length}; expected ${vectorDimension}`,
        }),
      );

const assertRowsVectorDimension = (
  rows: readonly SearchRow[],
  vectorColumn: string,
  vectorDimension: number | undefined,
): Effect.Effect<void, DimensionMismatch> =>
  Effect.forEach(
    rows,
    (row) => {
      const vector = row[vectorColumn];
      if (!Array.isArray(vector)) {
        return Effect.fail(
          new DimensionMismatch({
            column: vectorColumn,
            expected: vectorDimension ?? 0,
            actual: 0,
            message: `${vectorColumn} must be a numeric vector array`,
          }),
        );
      }
      return assertVectorDimension(vector, vectorColumn, vectorDimension);
    },
    { discard: true },
  );

const makeOperationError = (
  tableName: string,
  operation: string,
  cause: unknown,
): LanceDbOperationFailed => {
  const message = cause instanceof Error ? cause.message : String(cause);
  return new LanceDbOperationFailed({ tableName, operation, message, cause });
};

const connect = (dataDir: string): Effect.Effect<Connection, ConnectionFailed> =>
  Effect.tryPromise({
    try: () => lancedb.connect(dataDir),
    catch: (cause) =>
      new ConnectionFailed({
        dataDir,
        operation: "connect",
        message: cause instanceof Error ? cause.message : String(cause),
        cause,
      }),
  });

const tableNames = (
  connection: Connection,
  tableName: string,
): Effect.Effect<readonly string[], LanceDbOperationFailed> =>
  Effect.tryPromise({
    try: () => connection.tableNames(),
    catch: (cause) => makeOperationError(tableName, "tableNames", cause),
  });

const makeLanceDb = (options: LanceDbLayerOptions = {}) =>
  Effect.gen(function* () {
    const dataDir = options.dataDir?.trim() || searchDataDirFromEnv();
    const connection = yield* Effect.acquireRelease(
      connect(dataDir),
      (activeConnection) => Effect.sync(() => activeConnection.close()),
    );

    const openTable = (request: TableRequest): Effect.Effect<Table, LanceDbOperationFailed> => {
      const tableName = tableNameOrDefault(request.tableName);
      return Effect.tryPromise({
        try: () => connection.openTable(tableName),
        catch: (cause) => makeOperationError(tableName, "openTable", cause),
      });
    };

    const ensureTable = (request: EnsureTableRequest): Effect.Effect<Table, LanceDbError> =>
      Effect.gen(function* () {
        const tableName = tableNameOrDefault(request.tableName);
        const vectorColumn = vectorColumnOrDefault(request.vectorColumn);
        yield* assertRowsVectorDimension(request.rows, vectorColumn, request.vectorDimension);
        const existing = yield* tableNames(connection, tableName);
        if (existing.includes(tableName) && request.mode !== "overwrite") {
          return yield* openTable({ tableName });
        }
        if (request.rows.length === 0) {
          return yield* Effect.fail(
            new LanceDbOperationFailed({
              tableName,
              operation: "ensureTable",
              message: "Cannot create a LanceDB table without seed rows; QSR table schema lands separately.",
            }),
          );
        }
        return yield* Effect.tryPromise({
          try: () =>
            connection.createTable(tableName, rowsForLance(request.rows), {
              mode: request.mode ?? "create",
              existOk: true,
            }),
          catch: (cause) => makeOperationError(tableName, "createTable", cause),
        });
      });

    const upsertRows = (request: UpsertRowsRequest): Effect.Effect<void, LanceDbError> =>
      Effect.gen(function* () {
        if (request.rows.length === 0) {
          return;
        }
        const tableName = tableNameOrDefault(request.tableName);
        const keyColumn = keyColumnOrDefault(request.keyColumn);
        const vectorColumn = vectorColumnOrDefault(request.vectorColumn);
        yield* assertIdentifier(tableName, "upsertRows", keyColumn);
        yield* assertRowsVectorDimension(request.rows, vectorColumn, request.vectorDimension);
        const existing = yield* tableNames(connection, tableName);
        if (!existing.includes(tableName)) {
          yield* ensureTable({
            tableName,
            rows: request.rows,
            vectorColumn,
            vectorDimension: request.vectorDimension,
          });
          return;
        }
        const table = yield* openTable({ tableName });
        yield* Effect.tryPromise({
          try: () =>
            table
              .mergeInsert(keyColumn)
              .whenMatchedUpdateAll()
              .whenNotMatchedInsertAll()
              .execute(rowsForLance(request.rows)),
          catch: (cause) => makeOperationError(tableName, "mergeInsert", cause),
        });
      });

    const deleteByKeys = (request: DeleteByKeysRequest): Effect.Effect<number, LanceDbError> =>
      Effect.gen(function* () {
        if (request.keys.length === 0) {
          return 0;
        }
        const tableName = tableNameOrDefault(request.tableName);
        const keyColumn = keyColumnOrDefault(request.keyColumn);
        yield* assertIdentifier(tableName, "deleteByKeys", keyColumn);
        const table = yield* openTable({ tableName });
        const predicate = `${keyColumn} IN (${request.keys.map(escapeSqlString).join(", ")})`;
        const result = yield* Effect.tryPromise({
          try: () => table.delete(predicate),
          catch: (cause) => makeOperationError(tableName, "delete", cause),
        });
        return result.numDeletedRows;
      });

    const readRows = (request: ReadRowsRequest = {}): Effect.Effect<readonly Record<string, unknown>[], LanceDbError> =>
      Effect.gen(function* () {
        const tableName = tableNameOrDefault(request.tableName);
        const table = yield* openTable({ tableName });
        let query = table.query().limit(limitOrDefault(request.limit));
        if (request.filter !== undefined) {
          query = query.where(request.filter);
        }
        return yield* Effect.tryPromise({
          try: () => query.select(selectOrDefault(request.select)).toArray(),
          catch: (cause) => makeOperationError(tableName, "readRows", cause),
        });
      });

    const vectorSearch = (request: VectorSearchRequest): Effect.Effect<readonly SearchHit[], LanceDbError> =>
      Effect.gen(function* () {
        const tableName = tableNameOrDefault(request.tableName);
        const vectorColumn = vectorColumnOrDefault(request.vectorColumn);
        yield* assertVectorDimension(request.vector, vectorColumn, request.vectorDimension);
        const table = yield* openTable({ tableName });
        let query = table
          .vectorSearch([...request.vector])
          .column(vectorColumn)
          .limit(limitOrDefault(request.limit))
          .select(selectOrDefault(request.select));
        if (request.filter !== undefined) {
          query = query.where(request.filter);
        }
        const rows = yield* Effect.tryPromise({
          try: () => query.toArray(),
          catch: (cause) => detectIndexNotReady(tableName, `${vectorColumn}_idx`, "vectorSearch", cause),
        });
        return rows.map((row, index) => ({
          key: String(row[DEFAULT_KEY_COLUMN] ?? index),
          score: typeof row._distance === "number" ? -row._distance : 1 / (index + 1),
          row,
        }));
      });

    const ftsSearch = (request: FullTextSearchRequest): Effect.Effect<readonly SearchHit[], LanceDbError> =>
      Effect.gen(function* () {
        const tableName = tableNameOrDefault(request.tableName);
        const textColumn = textColumnOrDefault(request.textColumn);
        const table = yield* openTable({ tableName });
        let query = table
          .query()
          .fullTextSearch(request.query, { columns: textColumn })
          .limit(limitOrDefault(request.limit))
          .select(selectOrDefault(request.select));
        if (request.filter !== undefined) {
          query = query.where(request.filter);
        }
        const rows = yield* Effect.tryPromise({
          try: () => query.toArray(),
          catch: (cause) => detectIndexNotReady(tableName, `${textColumn}_idx`, "ftsSearch", cause),
        });
        return rows.map((row, index) => ({
          key: String(row[DEFAULT_KEY_COLUMN] ?? index),
          score: typeof row._score === "number" ? row._score : 1 / (index + 1),
          row,
        }));
      });

    const hybridSearch = (request: HybridSearchRequest): Effect.Effect<readonly SearchHit[], LanceDbError> =>
      Effect.gen(function* () {
        const keyColumn = keyColumnOrDefault(request.keyColumn);
        const limit = limitOrDefault(request.limit);
        const fusionK = request.fusionK ?? DEFAULT_FUSION_K;
        const [lexical, semantic] = yield* Effect.all(
          [
            ftsSearch({ ...request, limit: limit * 2 }),
            vectorSearch({ ...request, limit: limit * 2 }),
          ],
          { concurrency: "unbounded" },
        );
        const fused = new Map<string, SearchHit>();
        for (const source of [lexical, semantic]) {
          for (const [rank, hit] of source.entries()) {
            const key = String(hit.row[keyColumn] ?? hit.key);
            const prior = fused.get(key);
            const score = (prior?.score ?? 0) + 1 / (fusionK + rank + 1);
            fused.set(key, {
              key,
              score,
              row: prior?.row ?? hit.row,
            });
          }
        }
        return [...fused.values()].sort((left, right) => right.score - left.score).slice(0, limit);
      });

    return {
      dataDir,
      connect: Effect.succeed(connection),
      openTable,
      ensureTable,
      upsertRows,
      deleteByKeys,
      readRows,
      vectorSearch,
      ftsSearch,
      hybridSearch,
    } as const;
  });

export class LanceDb extends Effect.Service<LanceDb>()("LanceDb", {
  accessors: true,
  scoped: makeLanceDb,
}) {}

export const LanceDbLive = LanceDb.Default;

export const makeLanceDbLayer = (options: LanceDbLayerOptions = {}): Layer.Layer<LanceDb, ConnectionFailed> =>
  Layer.scoped(
    LanceDb,
    makeLanceDb(options).pipe(Effect.map((service) => LanceDb.make(service))),
  );

export const makeLanceDbRuntime = (options: LanceDbLayerOptions = {}) =>
  ManagedRuntime.make(makeLanceDbLayer(options));
