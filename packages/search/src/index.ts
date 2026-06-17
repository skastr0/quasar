import * as lancedb from "@lancedb/lancedb";
import { Field, FixedSizeList, Float32, Int32, Schema as ArrowSchema, Utf8 } from "apache-arrow";
import { Effect, Layer, ManagedRuntime, Schema } from "effect";
import { readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import type {
  Connection,
  IndexConfig,
  IndexStatistics,
  OptimizeStats,
  Table,
  TableStatistics,
} from "@lancedb/lancedb";

export const DEFAULT_SEARCH_TABLE = "messages";
export const DEFAULT_VECTOR_COLUMN = "vector";
export const DEFAULT_TEXT_COLUMN = "text";
export const DEFAULT_KEY_COLUMN = "key";
export const DEFAULT_FUSION_K = 60;
export const GEMINI_EMBEDDING_DIMENSIONS = 1536;
export const MESSAGE_VECTOR_INDEX_NAME = "vector_idx";
export const MESSAGE_TEXT_INDEX_NAME = "text_idx";

export const MESSAGE_SEARCH_COLUMNS = [
  "key",
  "sessionId",
  "seq",
  "role",
  "projectKey",
  "text",
  "contentHash",
] as const;

export type SearchVector = readonly number[];
export type SearchRole = "user" | "assistant";

export interface SearchRow {
  readonly key: string;
  readonly text: string;
  readonly vector: SearchVector;
  readonly [field: string]: unknown;
}

export interface MessageSearchRow {
  readonly sessionId: string;
  readonly seq: number;
  readonly role: SearchRole;
  readonly projectKey: string;
  readonly text: string;
  readonly contentHash: string;
  readonly vector: SearchVector;
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

export interface EnsureMessageTableRequest extends TableRequest {
  readonly rows?: readonly MessageSearchRow[];
  readonly mode?: "create" | "overwrite";
  readonly createIndexes?: boolean;
  readonly includeVectorIndex?: boolean;
}

export interface CreateMessageIndexesRequest extends TableRequest {
  readonly includeVector?: boolean;
  /** If true, replace existing indexes instead of skipping them. Defaults to false (create missing only). */
  readonly replace?: boolean;
}

export interface UpsertRowsRequest extends TableRequest {
  readonly rows: readonly SearchRow[];
  readonly keyColumn?: string;
  readonly vectorColumn?: string;
  readonly vectorDimension?: number;
}

export interface UpsertMessageRowsRequest extends TableRequest {
  readonly rows: readonly MessageSearchRow[];
}

export interface DeleteByKeysRequest extends TableRequest {
  readonly keys: readonly string[];
  readonly keyColumn?: string;
}

export interface ReadMessageRowsBySessionRequest extends TableRequest {
  readonly sessionId: string;
  readonly limit?: number;
  readonly select?: readonly string[];
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

export interface OptimizeTableRequest extends TableRequest {
  /** Remove versions older than this date. Defaults to now (all old versions). */
  readonly cleanupOlderThan?: Date;
  /** Delete unverified files older than cleanupOlderThan. Only set true when no concurrent writers. */
  readonly deleteUnverified?: boolean;
}

export interface TableStatsRequest extends TableRequest {}

export interface IndexInfo {
  readonly name: string;
  readonly indexType: string;
  readonly columns: readonly string[];
  readonly numIndexedRows?: number;
  readonly numUnindexedRows?: number;
  readonly distanceType?: string;
  readonly numIndices?: number;
  readonly loss?: number;
}

export interface DiskSizeBreakdown {
  readonly totalBytes: number;
  readonly dataBytes: number;
  readonly indexBytes: number;
  readonly versionBytes: number;
}

export interface TableStatsReport {
  readonly tableName: string;
  readonly rowCount: number;
  readonly versionCount: number;
  readonly disk: DiskSizeBreakdown;
  readonly tableStats: TableStatistics;
  readonly indices: readonly IndexInfo[];
}

export interface OptimizeTableReport {
  readonly tableName: string;
  readonly stats: OptimizeStats;
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

export const messageSearchKey = (row: Pick<MessageSearchRow, "sessionId" | "seq" | "role">): string =>
  `${row.sessionId}:${row.seq}:${row.role}`;

export const createMessageSearchSchema = (dimensions = GEMINI_EMBEDDING_DIMENSIONS): ArrowSchema =>
  new ArrowSchema([
    new Field(DEFAULT_KEY_COLUMN, new Utf8(), false),
    new Field("sessionId", new Utf8(), false),
    new Field("seq", new Int32(), false),
    new Field("role", new Utf8(), false),
    new Field("projectKey", new Utf8(), false),
    new Field(DEFAULT_TEXT_COLUMN, new Utf8(), false),
    new Field("contentHash", new Utf8(), false),
    new Field(
      DEFAULT_VECTOR_COLUMN,
      new FixedSizeList(dimensions, new Field("item", new Float32(), false)),
      false,
    ),
  ]);

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

const projectRow = (
  row: Record<string, unknown>,
  columns: readonly string[] | undefined,
): Record<string, unknown> => {
  if (columns === undefined || columns.length === 0) {
    return row;
  }
  return Object.fromEntries(columns.filter((column) => column in row).map((column) => [column, row[column]]));
};

const messageRowsForLance = (rows: readonly MessageSearchRow[]): Record<string, unknown>[] =>
  rowsForLance(
    rows.map((row) => ({
      key: messageSearchKey(row),
      sessionId: row.sessionId,
      seq: row.seq,
      role: row.role,
      projectKey: row.projectKey,
      text: row.text,
      contentHash: row.contentHash,
      vector: row.vector,
    })),
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
  rows: readonly object[],
  vectorColumn: string,
  vectorDimension: number | undefined,
): Effect.Effect<void, DimensionMismatch> =>
  Effect.forEach(
    rows,
    (row) => {
      const vector = Object.prototype.hasOwnProperty.call(row, vectorColumn)
        ? (row as { readonly [key: string]: unknown })[vectorColumn]
        : undefined;
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

const tableDirPath = (dataDir: string, tableName: string): string =>
  join(dataDir, `${tableName}.lance`);

const sizeOfDir = async (dir: string): Promise<number> => {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    let total = 0;
    for (const entry of entries) {
      const entryPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        total += await sizeOfDir(entryPath);
      } else if (entry.isFile()) {
        total += (await stat(entryPath)).size;
      }
    }
    return total;
  } catch {
    return 0;
  }
};

const diskSizeBreakdown = async (
  dataDir: string,
  tableName: string,
): Promise<DiskSizeBreakdown> => {
  const tableDir = tableDirPath(dataDir, tableName);
  const totalBytes = await sizeOfDir(tableDir);
  const indexBytes = await sizeOfDir(join(tableDir, "_indices"));
  const versionBytes = await sizeOfDir(join(tableDir, "_versions"));
  const dataBytes = Math.max(0, totalBytes - indexBytes - versionBytes);
  return { totalBytes, dataBytes, indexBytes, versionBytes };
};

const indexInfoFromConfig = (
  config: IndexConfig,
  stats: IndexStatistics | undefined | null,
): IndexInfo => ({
  name: config.name,
  indexType: config.indexType,
  columns: config.columns,
  ...(stats !== undefined && stats !== null
    ? {
        numIndexedRows: stats.numIndexedRows,
        numUnindexedRows: stats.numUnindexedRows,
        distanceType: stats.distanceType,
        numIndices: stats.numIndices,
        loss: stats.loss,
      }
    : {}),
});

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

    const createMessageIndexes = (
      request: CreateMessageIndexesRequest = {},
    ): Effect.Effect<void, LanceDbError> =>
      Effect.gen(function* () {
        const tableName = tableNameOrDefault(request.tableName);
        const table = yield* openTable({ tableName });
        const replace = request.replace === true;
        const existingIndexes = yield* Effect.tryPromise({
          try: () => table.listIndices(),
          catch: (cause) => makeOperationError(tableName, "listIndices", cause),
        });
        const existingIndexNames = new Set(existingIndexes.map((index) => index.name));

        if (replace || !existingIndexNames.has(MESSAGE_TEXT_INDEX_NAME)) {
          yield* Effect.tryPromise({
            try: () =>
              table.createIndex(DEFAULT_TEXT_COLUMN, {
                config: lancedb.Index.fts(),
                name: MESSAGE_TEXT_INDEX_NAME,
                replace,
                waitTimeoutSeconds: 60,
              }),
            catch: (cause) => detectIndexNotReady(tableName, MESSAGE_TEXT_INDEX_NAME, "createFtsIndex", cause),
          });
        }

        if (request.includeVector === false) {
          return;
        }
        if (existingIndexNames.has(MESSAGE_VECTOR_INDEX_NAME) && !replace) {
          return;
        }
        const rows = yield* Effect.tryPromise({
          try: () => table.countRows(),
          catch: (cause) => makeOperationError(tableName, "countRows", cause),
        });
        if (rows === 0) {
          return yield* Effect.fail(
            new IndexNotReady({
              tableName,
              indexName: MESSAGE_VECTOR_INDEX_NAME,
              operation: "createVectorIndex",
              message: "LanceDB cannot train a vector index before rows exist.",
            }),
          );
        }
        yield* Effect.tryPromise({
          try: () =>
            table.createIndex(DEFAULT_VECTOR_COLUMN, {
              config: lancedb.Index.ivfFlat({
                distanceType: "cosine",
                numPartitions: 1,
              }),
              name: MESSAGE_VECTOR_INDEX_NAME,
              replace,
              waitTimeoutSeconds: 60,
            }),
          catch: (cause) => detectIndexNotReady(tableName, MESSAGE_VECTOR_INDEX_NAME, "createVectorIndex", cause),
        });
      });

    const optimizeTable = (request: OptimizeTableRequest = {}): Effect.Effect<OptimizeTableReport, LanceDbError> =>
      Effect.gen(function* () {
        const tableName = tableNameOrDefault(request.tableName);
        const table = yield* openTable({ tableName });
        const cleanupOlderThan = request.cleanupOlderThan ?? new Date();
        const stats = yield* Effect.tryPromise({
          try: () =>
            table.optimize({
              cleanupOlderThan,
              deleteUnverified: request.deleteUnverified ?? false,
            }),
          catch: (cause) => makeOperationError(tableName, "optimize", cause),
        });
        return { tableName, stats };
      });

    const tableStats = (request: TableStatsRequest = {}): Effect.Effect<TableStatsReport, LanceDbError> =>
      Effect.gen(function* () {
        const tableName = tableNameOrDefault(request.tableName);
        const table = yield* openTable({ tableName });
        const {
          rowCount,
          tableStatistics,
          indexConfigs,
          versions,
          disk,
        } = yield* Effect.all(
          {
            rowCount: Effect.tryPromise({
              try: () => table.countRows(),
              catch: (cause) => makeOperationError(tableName, "countRows", cause),
            }),
            tableStatistics: Effect.tryPromise({
              try: () => table.stats(),
              catch: (cause) => makeOperationError(tableName, "stats", cause),
            }),
            indexConfigs: Effect.tryPromise({
              try: () => table.listIndices(),
              catch: (cause) => makeOperationError(tableName, "listIndices", cause),
            }),
            versions: Effect.tryPromise({
              try: () => table.listVersions(),
              catch: (cause) => makeOperationError(tableName, "listVersions", cause),
            }),
            disk: Effect.tryPromise({
              try: () => diskSizeBreakdown(dataDir, tableName),
              catch: (cause) => makeOperationError(tableName, "diskSizeBreakdown", cause),
            }),
          },
          { concurrency: 1 },
        );
        const indexInfos: IndexInfo[] = [];
        for (const config of indexConfigs) {
          const stats = yield* Effect.tryPromise({
            try: () => table.indexStats(config.name),
            catch: (cause) => makeOperationError(tableName, `indexStats(${config.name})`, cause),
          });
          indexInfos.push(indexInfoFromConfig(config, stats));
        }
        return {
          tableName,
          rowCount,
          versionCount: versions.length,
          disk,
          tableStats: tableStatistics,
          indices: indexInfos,
        };
      });

    const ensureMessageTable = (request: EnsureMessageTableRequest = {}): Effect.Effect<Table, LanceDbError> =>
      Effect.gen(function* () {
        const tableName = tableNameOrDefault(request.tableName);
        const rows = request.rows ?? [];
        yield* assertRowsVectorDimension(rows, DEFAULT_VECTOR_COLUMN, GEMINI_EMBEDDING_DIMENSIONS);
        const existing = yield* tableNames(connection, tableName);
        const tableExists = existing.includes(tableName);
        const table =
          tableExists && request.mode !== "overwrite"
            ? yield* openTable({ tableName })
            : yield* Effect.tryPromise({
                try: () =>
                  rows.length === 0
                    ? connection.createEmptyTable(tableName, createMessageSearchSchema(), {
                        mode: request.mode ?? "create",
                        existOk: true,
                      })
                    : connection.createTable(tableName, messageRowsForLance(rows), {
                        mode: request.mode ?? "create",
                        existOk: true,
                        schema: createMessageSearchSchema(),
                      }),
                catch: (cause) => makeOperationError(tableName, "createMessageTable", cause),
              });
        if (tableExists && request.mode !== "overwrite" && rows.length > 0) {
          yield* Effect.tryPromise({
            try: () =>
              table
                .mergeInsert(DEFAULT_KEY_COLUMN)
                .whenMatchedUpdateAll()
                .whenNotMatchedInsertAll()
                .execute(messageRowsForLance(rows)),
            catch: (cause) => makeOperationError(tableName, "mergeInsertMessages", cause),
          });
        }
        if (request.createIndexes === true) {
          yield* createMessageIndexes({
            tableName,
            includeVector: request.includeVectorIndex !== false && rows.length > 0,
          });
        }
        return table;
      });

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

    const upsertMessageRows = (request: UpsertMessageRowsRequest): Effect.Effect<void, LanceDbError> =>
      Effect.gen(function* () {
        if (request.rows.length === 0) {
          return;
        }
        const tableName = tableNameOrDefault(request.tableName);
        yield* assertRowsVectorDimension(request.rows, DEFAULT_VECTOR_COLUMN, GEMINI_EMBEDDING_DIMENSIONS);
        const records = messageRowsForLance(request.rows);
        const existing = yield* tableNames(connection, tableName);
        if (!existing.includes(tableName)) {
          yield* ensureMessageTable({
            tableName,
            rows: request.rows,
            createIndexes: false,
          });
          return;
        }
        const table = yield* openTable({ tableName });
        yield* Effect.tryPromise({
          try: () =>
            table
              .mergeInsert(DEFAULT_KEY_COLUMN)
              .whenMatchedUpdateAll()
              .whenNotMatchedInsertAll()
              .execute(records),
          catch: (cause) => makeOperationError(tableName, "mergeInsertMessages", cause),
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

    const readMessageRowsBySession = (
      request: ReadMessageRowsBySessionRequest,
    ): Effect.Effect<readonly Record<string, unknown>[], LanceDbError> =>
      Effect.gen(function* () {
        const tableName = tableNameOrDefault(request.tableName);
        const existing = yield* tableNames(connection, tableName);
        if (!existing.includes(tableName)) {
          return [];
        }
        const table = yield* openTable({ tableName });
        let query = table.query().where(`sessionId = ${escapeSqlString(request.sessionId)}`);
        if (request.limit !== undefined) {
          query = query.limit(limitOrDefault(request.limit));
        }
        return yield* Effect.tryPromise({
          try: () =>
            query
              .select([...(request.select === undefined ? MESSAGE_SEARCH_COLUMNS : request.select)])
              .toArray(),
          catch: (cause) => makeOperationError(tableName, "readMessageRowsBySession", cause),
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
        const tableName = tableNameOrDefault(request.tableName);
        const vectorColumn = vectorColumnOrDefault(request.vectorColumn);
        const textColumn = textColumnOrDefault(request.textColumn);
        yield* assertVectorDimension(request.vector, vectorColumn, request.vectorDimension);
        const table = yield* openTable({ tableName });
        const reranker = yield* Effect.tryPromise({
          try: () => lancedb.rerankers.RRFReranker.create(fusionK),
          catch: (cause) => detectIndexNotReady(tableName, "rrf", "createReranker", cause),
        });
        let query = table
          .query()
          .nearestTo([...request.vector])
          .column(vectorColumn)
          .fullTextSearch(request.query, { columns: textColumn })
          .rerank(reranker)
          .limit(limit);
        if (request.filter !== undefined) {
          query = query.where(request.filter);
        }
        const rows = yield* Effect.tryPromise({
          try: () => query.toArray(),
          catch: (cause) => detectIndexNotReady(tableName, `${textColumn}_idx/${vectorColumn}_idx`, "hybridSearch", cause),
        });
        return rows.map((row, index) => ({
          key: String(row[keyColumn] ?? row[DEFAULT_KEY_COLUMN] ?? index),
          score:
            typeof row._relevance_score === "number"
              ? row._relevance_score
              : typeof row._score === "number"
                ? row._score
                : 1 / (index + 1),
          row: projectRow(row, request.select),
        }));
      });

    return {
      dataDir,
      connect: Effect.succeed(connection),
      openTable,
      ensureMessageTable,
      createMessageIndexes,
      optimizeTable,
      tableStats,
      ensureTable,
      upsertMessageRows,
      upsertRows,
      deleteByKeys,
      readRows,
      readMessageRowsBySession,
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
