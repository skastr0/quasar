import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

const INGEST_LEDGER_SCHEMA_VERSION = "1";

export type IngestLedgerChunkIdentity = {
  readonly sequence: number;
  readonly payloadHash: string;
  readonly idempotencyKey: string;
};

export type IngestLedgerAttemptInput = {
  readonly sourceIdentityKey: string;
  readonly importJobId: string;
  readonly expectedChunkCount: number;
  readonly generationId?: string;
  readonly status: string;
  readonly now: string;
};

export type IngestLedgerPlanInput = IngestLedgerAttemptInput & {
  readonly chunks: readonly IngestLedgerChunkIdentity[];
};

export type IngestLedgerChunkUpdateInput = {
  readonly sourceIdentityKey: string;
  readonly importJobId: string;
  readonly chunks: readonly IngestLedgerChunkIdentity[];
  readonly now: string;
};

export type IngestLedgerStatusChunk = {
  readonly sequence?: unknown;
  readonly chunkId?: unknown;
  readonly status?: unknown;
  readonly payloadHash?: unknown;
  readonly idempotencyKey?: unknown;
  readonly payloadStored?: unknown;
  readonly error?: unknown;
};

export type IngestLedgerStatusInput = IngestLedgerAttemptInput & {
  readonly chunks?: readonly IngestLedgerStatusChunk[];
};

export type IngestLedgerSummaryInput = {
  readonly sourceIdentityKey: string;
  readonly importJobId: string;
  readonly chunks: readonly IngestLedgerChunkIdentity[];
};

export type IngestLedgerSummary = {
  readonly path: string;
  readonly uploadedPrefixCount: number;
  readonly recordedUploadedChunkCount: number;
};

export class IngestLedger {
  readonly path: string;
  readonly #db: SqliteDatabase;

  constructor(path: string) {
    this.path = path;
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.#db = openSqliteDatabase(path);
    migrateIngestLedger(this.#db);
  }

  close() {
    this.#db.close();
  }

  recordPlan(input: IngestLedgerPlanInput) {
    upsertAttempt(this.#db, input);
    const statement = this.#db.query(`
      insert into ingest_chunks (
        source_identity_key,
        import_job_id,
        sequence,
        payload_hash,
        idempotency_key,
        local_status,
        updated_at
      ) values (?, ?, ?, ?, ?, 'planned', ?)
      on conflict(source_identity_key, import_job_id, sequence) do update set
        payload_hash = excluded.payload_hash,
        idempotency_key = excluded.idempotency_key,
        updated_at = excluded.updated_at
    `);
    const insertMany = this.#db.transaction((chunks: readonly IngestLedgerChunkIdentity[]) => {
      for (const chunk of chunks) {
        statement.run(
          input.sourceIdentityKey,
          input.importJobId,
          chunk.sequence,
          chunk.payloadHash,
          chunk.idempotencyKey,
          input.now,
        );
      }
    });
    insertMany(input.chunks);
  }

  markUploading(input: IngestLedgerChunkUpdateInput) {
    this.#markLocalStatus(input, "uploading");
  }

  markAcknowledged(input: IngestLedgerChunkUpdateInput) {
    this.#markLocalStatus(input, "acknowledged");
  }

  observeStatus(input: IngestLedgerStatusInput) {
    upsertAttempt(this.#db, input);
    if (input.chunks === undefined) return;
    const statement = this.#db.query(`
      update ingest_chunks
      set
        server_chunk_id = coalesce(?, server_chunk_id),
        server_status = coalesce(?, server_status),
        payload_stored = coalesce(?, payload_stored),
        local_status = ?,
        last_error = coalesce(?, last_error),
        acknowledged_at = coalesce(acknowledged_at, ?),
        terminal_at = coalesce(terminal_at, ?),
        updated_at = ?
      where source_identity_key = ?
        and import_job_id = ?
        and sequence = ?
        and payload_hash = ?
        and idempotency_key = ?
    `);
    const updateMany = this.#db.transaction((chunks: readonly IngestLedgerStatusChunk[]) => {
      for (const chunk of chunks) {
        const sequence = integerValue(chunk.sequence);
        const payloadHash = stringValue(chunk.payloadHash);
        const idempotencyKey = stringValue(chunk.idempotencyKey);
        if (sequence === undefined || payloadHash === undefined || idempotencyKey === undefined) {
          continue;
        }
        const status = stringValue(chunk.status);
        const localStatus = localStatusFromServerStatus(status);
        const terminalAt = isTerminalServerChunkStatus(status) ? input.now : null;
        statement.run(
          stringValue(chunk.chunkId) ?? null,
          status ?? null,
          booleanNumberValue(chunk.payloadStored),
          localStatus,
          stringValue(chunk.error) ?? null,
          input.now,
          terminalAt,
          input.now,
          input.sourceIdentityKey,
          input.importJobId,
          sequence,
          payloadHash,
          idempotencyKey,
        );
      }
    });
    updateMany(input.chunks);
  }

  uploadedPrefixCount(input: IngestLedgerSummaryInput) {
    let prefix = 0;
    const statement = this.#db.query(`
      select payload_hash, idempotency_key, local_status
      from ingest_chunks
      where source_identity_key = ?
        and import_job_id = ?
        and sequence = ?
    `);
    for (const chunk of input.chunks) {
      const row = statement.get(
        input.sourceIdentityKey,
        input.importJobId,
        chunk.sequence,
      ) as LedgerChunkRow | null;
      if (
        row === null ||
        !isUploadedLocalStatus(row.local_status) ||
        row.payload_hash !== chunk.payloadHash ||
        row.idempotency_key !== chunk.idempotencyKey
      ) {
        return prefix;
      }
      prefix += 1;
    }
    return prefix;
  }

  summary(input: IngestLedgerSummaryInput): IngestLedgerSummary {
    const row = this.#db.query(`
      select count(*) as count
      from ingest_chunks
      where source_identity_key = ?
        and import_job_id = ?
        and local_status in ('uploaded', 'acknowledged', 'succeeded')
    `).get(input.sourceIdentityKey, input.importJobId) as { count: number } | null;
    return {
      path: this.path,
      uploadedPrefixCount: this.uploadedPrefixCount(input),
      recordedUploadedChunkCount: row?.count ?? 0,
    };
  }

  #markLocalStatus(input: IngestLedgerChunkUpdateInput, status: "uploading" | "acknowledged") {
    const statement = this.#db.query(`
      update ingest_chunks
      set
        local_status = ?,
        uploaded_at = case
          when ? = 'acknowledged' then coalesce(uploaded_at, ?)
          else uploaded_at
        end,
        acknowledged_at = case
          when ? = 'acknowledged' then coalesce(acknowledged_at, ?)
          else acknowledged_at
        end,
        updated_at = ?
      where source_identity_key = ?
        and import_job_id = ?
        and sequence = ?
        and payload_hash = ?
        and idempotency_key = ?
    `);
    const updateMany = this.#db.transaction((chunks: readonly IngestLedgerChunkIdentity[]) => {
      for (const chunk of chunks) {
        statement.run(
          status,
          status,
          input.now,
          status,
          input.now,
          input.now,
          input.sourceIdentityKey,
          input.importJobId,
          chunk.sequence,
          chunk.payloadHash,
          chunk.idempotencyKey,
        );
      }
    });
    updateMany(input.chunks);
  }
}

type LedgerChunkRow = {
  readonly payload_hash: string;
  readonly idempotency_key: string;
  readonly local_status: string;
};

type SqliteDatabase = {
  readonly run: (sql: string) => unknown;
  readonly query: (sql: string) => SqliteStatement;
  readonly transaction: <A extends readonly unknown[], B>(
    callback: (...args: A) => B,
  ) => (...args: A) => B;
  readonly close: () => void;
  readonly script?: (sql: string) => void;
};

type SqliteStatement = {
  readonly run: (...args: unknown[]) => unknown;
  readonly get: (...args: unknown[]) => unknown;
};

const openSqliteDatabase = (path: string): SqliteDatabase => {
  const bunRequire = typeof require === "function"
    ? (require as (specifier: string) => { Database?: new (path: string) => SqliteDatabase })
    : undefined;
  let Database: (new (path: string) => SqliteDatabase) | undefined;
  try {
    Database = bunRequire?.("bun:sqlite").Database;
  } catch {
    Database = undefined;
  }
  if (Database === undefined) return new CliSqliteDatabase(path);
  return new Database(path);
};

class CliSqliteDatabase implements SqliteDatabase {
  #transactionStatements: string[] | undefined;

  constructor(readonly path: string) {}

  run(sql: string) {
    this.execute(sql);
  }

  query(sql: string): SqliteStatement {
    return new CliSqliteStatement(this, sql);
  }

  transaction<A extends readonly unknown[], B>(callback: (...args: A) => B) {
    return (...args: A) => {
      if (this.#transactionStatements !== undefined) return callback(...args);
      this.#transactionStatements = [];
      try {
        const result = callback(...args);
        const statements = this.#transactionStatements;
        if (statements.length > 0) {
          runSqlite(this.path, ["begin immediate", ...statements, "commit"].join(";\n"));
        }
        return result;
      } finally {
        this.#transactionStatements = undefined;
      }
    };
  }

  close() {
    this.#transactionStatements = undefined;
  }

  script(sql: string) {
    runSqlite(this.path, sql);
  }

  execute(sql: string) {
    if (this.#transactionStatements !== undefined) {
      this.#transactionStatements.push(sql);
      return;
    }
    runSqlite(this.path, sql);
  }

  get(sql: string) {
    const output = execFileSync(
      "sqlite3",
      ["-json", this.path, sql],
      { encoding: "utf8" },
    );
    if (output.trim().length === 0) return null;
    const rows = JSON.parse(output) as unknown[];
    return rows[0] ?? null;
  }
}

class CliSqliteStatement implements SqliteStatement {
  constructor(
    readonly db: CliSqliteDatabase,
    readonly sql: string,
  ) {}

  run(...args: unknown[]) {
    this.db.execute(bindSqliteParams(this.sql, args));
  }

  get(...args: unknown[]) {
    return this.db.get(bindSqliteParams(this.sql, args));
  }
}

const runSqlite = (path: string, sql: string) => {
  execFileSync("sqlite3", [path, sql], { stdio: "pipe" });
};

const bindSqliteParams = (sql: string, args: readonly unknown[]) => {
  let index = 0;
  const bound = sql.replace(/\?/g, () => {
    if (index >= args.length) throw new Error("missing sqlite parameter");
    const value = args[index];
    index += 1;
    return sqliteLiteral(value);
  });
  if (index !== args.length) throw new Error("unused sqlite parameter");
  return bound;
};

const sqliteLiteral = (value: unknown): string => {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("cannot bind non-finite sqlite number");
    return String(value);
  }
  if (typeof value === "boolean") return value ? "1" : "0";
  return `'${String(value).replaceAll("'", "''")}'`;
};

const migrateIngestLedger = (db: SqliteDatabase) => {
  const statements = [
    "pragma journal_mode = wal",
    "pragma foreign_keys = on",
    `
    create table if not exists ingest_ledger_meta (
      key text primary key,
      value text not null
    )
  `,
    `
    create table if not exists ingest_attempts (
      source_identity_key text not null,
      import_job_id text not null,
      generation_id text,
      expected_chunk_count integer not null,
      status text not null,
      created_at text not null,
      updated_at text not null,
      last_observed_at text,
      completed_at text,
      primary key (source_identity_key, import_job_id)
    )
  `,
    `
    create index if not exists ingest_attempts_by_source_updated
    on ingest_attempts (source_identity_key, updated_at)
  `,
    `
    create table if not exists ingest_chunks (
      source_identity_key text not null,
      import_job_id text not null,
      sequence integer not null,
      payload_hash text not null,
      idempotency_key text not null,
      local_status text not null,
      server_status text,
      server_chunk_id text,
      payload_stored integer,
      uploaded_at text,
      acknowledged_at text,
      terminal_at text,
      last_error text,
      updated_at text not null,
      primary key (source_identity_key, import_job_id, sequence),
      foreign key (source_identity_key, import_job_id)
        references ingest_attempts (source_identity_key, import_job_id)
        on delete cascade
    )
  `,
    `
    insert into ingest_ledger_meta (key, value)
    values ('schema_version', ${sqliteLiteral(INGEST_LEDGER_SCHEMA_VERSION)})
    on conflict(key) do update set value = excluded.value
  `,
  ];
  if (db.script !== undefined) {
    db.script(statements.join(";\n"));
    return;
  }
  for (const statement of statements) db.run(statement);
};

const upsertAttempt = (db: SqliteDatabase, input: IngestLedgerAttemptInput) => {
  const completedAt = isFinalJobStatus(input.status) ? input.now : null;
  const statement = db.query(`
    insert into ingest_attempts (
      source_identity_key,
      import_job_id,
      generation_id,
      expected_chunk_count,
      status,
      created_at,
      updated_at,
      last_observed_at,
      completed_at
    ) values (?, ?, ?, ?, ?, ?, ?, ?, ?)
    on conflict(source_identity_key, import_job_id) do update set
      generation_id = coalesce(excluded.generation_id, ingest_attempts.generation_id),
      expected_chunk_count = excluded.expected_chunk_count,
      status = excluded.status,
      updated_at = excluded.updated_at,
      last_observed_at = excluded.last_observed_at,
      completed_at = coalesce(ingest_attempts.completed_at, excluded.completed_at)
  `);
  statement.run(
    input.sourceIdentityKey,
    input.importJobId,
    input.generationId ?? null,
    input.expectedChunkCount,
    input.status,
    input.now,
    input.now,
    input.now,
    completedAt,
  );
};

const stringValue = (value: unknown) =>
  typeof value === "string" && value.length > 0 ? value : undefined;

const integerValue = (value: unknown) =>
  typeof value === "number" && Number.isInteger(value) && value >= 0
    ? value
    : undefined;

const booleanNumberValue = (value: unknown) =>
  typeof value === "boolean" ? (value ? 1 : 0) : null;

const localStatusFromServerStatus = (status: string | undefined) => {
  switch (status) {
    case "succeeded":
      return "succeeded";
    case "failed":
    case "dead_letter":
      return "failed";
    case "pending":
    case "running":
      return "acknowledged";
    default:
      return "acknowledged";
  }
};

const isTerminalServerChunkStatus = (status: string | undefined) =>
  status === "succeeded" || status === "failed" || status === "dead_letter";

const isUploadedLocalStatus = (status: string) =>
  status === "uploaded" || status === "acknowledged" || status === "succeeded";

const isFinalJobStatus = (status: string) =>
  status === "succeeded" || status === "partial_failure" || status === "failed";
