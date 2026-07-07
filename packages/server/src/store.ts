import { Database } from "bun:sqlite";
import { performance } from "node:perf_hooks";
import { Context, Effect, Layer, Schema } from "effect";

import type { IngestRunRow, MappedSession, MessageRow, ProjectRow, SessionRow, ToolCallRow } from "./model";
import { ensureParentDir, sqlitePath } from "./paths";
import { composeScopedFtsQuery, ftsProjectScopeToken, positiveInt } from "./fts5";
import { decodeFloat16Vector, encodeFloat16Vector, VECTOR_BLOB_ENCODING } from "./vectorBlob";

export class SqliteStoreError extends Schema.TaggedError<SqliteStoreError>()(
  "SqliteStoreError",
  {
    operation: Schema.String,
    message: Schema.String,
    cause: Schema.optional(Schema.Unknown),
  },
) {}

export interface StoreStats {
  readonly projects: number;
  readonly sessions: number;
  readonly messages: number;
  readonly toolCalls: number;
  readonly ingestRuns: number;
}

export interface MessageVectorUpsert {
  readonly model: string;
  readonly modality: "text";
  readonly sessionId: string;
  readonly seq: number;
  readonly role: string;
  readonly projectKey: string;
  readonly provider: string;
  readonly contentHash: string;
  readonly documentHash: string;
  readonly vector: readonly number[];
  readonly now?: string;
}

export interface MessageVectorRow {
  readonly model: string;
  readonly modality: "text";
  readonly sessionId: string;
  readonly seq: number;
  readonly role: string;
  readonly projectKey: string;
  readonly provider: string;
  readonly contentHash: string;
  readonly documentHash: string;
  readonly dimensions: number;
  readonly encoding: typeof VECTOR_BLOB_ENCODING;
  readonly vector: readonly number[];
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface MessageVectorSearchRow extends MessageVectorRow {
  readonly text: string;
}

export interface MessageVectorCoverage {
  readonly model: string;
  readonly searchableMessages: number;
  readonly vectorRows: number;
  readonly vectorlessMessages: number;
  readonly staleVectorRows: number;
}

/** Raw f16 vector blob row for the resident-matrix boot loader (no decode).
 * Carries the rowid because the loader walks the table in rowid order —
 * sequential IO — while slot assignment happens in (session_id, seq) order.
 * Also carries role/projectKey/provider so the matrix can dictionary-encode
 * its per-slot scope filters in this same pass, at zero extra IO cost: pass 2
 * already reads the full row off the page for the vector blob. */
export interface MessageVectorBlobRow {
  readonly rowid: number;
  readonly sessionId: string;
  readonly seq: number;
  readonly role: string;
  readonly projectKey: string;
  readonly provider: string;
  readonly dimensions: number;
  readonly encoding: string;
  readonly vectorBlob: Uint8Array;
}

export interface MessageVectorKey {
  readonly sessionId: string;
  readonly seq: number;
}

/** Fired after every successful message-vector write transaction with the
 * rows sqlite actually accepted, plus a fresh per-model row count so the
 * resident matrix can check watermark parity without owning SQL. */
export interface MessageVectorWriteEvent {
  readonly rows: readonly MessageVectorUpsert[];
  readonly sqliteRowsByModel: Readonly<Record<string, number>>;
}

export interface SearchHit {
  readonly key: string;
  readonly score: number;
  readonly row: Record<string, unknown>;
}

/** Row-level result of a session apply. `changedMessages` carries exactly the
 * inserted+updated message rows so downstream embedding jobs fan out over the
 * delta, never the whole session. */
export interface SessionDiffOutcome {
  readonly messagesInserted: number;
  readonly messagesUpdated: number;
  readonly messagesDeleted: number;
  readonly messagesUnchanged: number;
  readonly toolCallsInserted: number;
  readonly toolCallsUpdated: number;
  readonly toolCallsDeleted: number;
  readonly toolCallsUnchanged: number;
  readonly changedMessages: readonly MessageRow[];
}

export interface LocalStoreService {
  readonly dbPath: string;
  readonly listProjects: (options?: { readonly limit?: number; readonly offset?: number }) => Effect.Effect<readonly ProjectRow[], SqliteStoreError>;
  readonly upsertSession: (session: MappedSession) => Effect.Effect<SessionDiffOutcome, SqliteStoreError>;
  readonly hasSessionFingerprint: (
    sessionId: string,
    sourceFingerprint: string,
  ) => Effect.Effect<boolean, SqliteStoreError>;
  readonly listSessions: (options?: {
    readonly provider?: string;
    readonly projectKey?: string;
    readonly limit?: number;
    readonly offset?: number;
  }) => Effect.Effect<readonly SessionRow[], SqliteStoreError>;
  readonly getMessage: (options: {
    readonly sessionId: string;
    readonly seq: number;
    readonly contentHash: string;
  }) => Effect.Effect<MessageRow | undefined, SqliteStoreError>;
  readonly readMessages: (sessionId: string, limit: number) => Effect.Effect<readonly MessageRow[], SqliteStoreError>;
  readonly listToolCalls: (options: {
    readonly sessionId?: string;
    readonly projectKey?: string;
    readonly provider?: string;
    readonly toolName?: string;
    readonly limit: number;
    readonly offset?: number;
  }) => Effect.Effect<readonly ToolCallRow[], SqliteStoreError>;
  readonly getToolCall: (id: string) => Effect.Effect<ToolCallRow | undefined, SqliteStoreError>;
  readonly recordIngestRun: (run: IngestRunRow) => Effect.Effect<void, SqliteStoreError>;
  readonly getIngestRun: (runId: string) => Effect.Effect<IngestRunRow | undefined, SqliteStoreError>;
  readonly listIngestRuns: (options?: {
    readonly status?: IngestRunRow["status"];
    readonly limit?: number;
    readonly offset?: number;
  }) => Effect.Effect<readonly IngestRunRow[], SqliteStoreError>;
  readonly stats: Effect.Effect<StoreStats, SqliteStoreError>;
  readonly upsertMessageVectors: (rows: readonly MessageVectorUpsert[]) => Effect.Effect<number, SqliteStoreError>;
  readonly listMessagesMissingVector: (options: {
    readonly model: string;
    readonly limit?: number;
  }) => Effect.Effect<readonly MessageRow[], SqliteStoreError>;
  readonly listMessageVectorsBySession: (options: {
    readonly sessionId: string;
    readonly model?: string;
    readonly limit?: number;
  }) => Effect.Effect<readonly MessageVectorRow[], SqliteStoreError>;
  readonly listMessageVectorsForSearch: (options: {
    readonly model: string;
    readonly limit: number;
    readonly offset?: number;
  }) => Effect.Effect<readonly MessageVectorSearchRow[], SqliteStoreError>;
  readonly messageVectorCoverage: (model: string) => Effect.Effect<MessageVectorCoverage, SqliteStoreError>;
  readonly countMessageVectors: (model: string) => Effect.Effect<number, SqliteStoreError>;
  readonly listMessageVectorBlobsByRowidPage: (options: {
    readonly model: string;
    readonly afterRowid: number;
    readonly limit: number;
  }) => Effect.Effect<readonly MessageVectorBlobRow[], SqliteStoreError>;
  /** Unfiltered (session_id, seq) keys for `model`, in canonical
   * (session_id, seq) order: the resident matrix's sole use is boot-pass-1
   * slot assignment. Scope filtering lives in the matrix itself (per-slot
   * dictionary-encoded arrays), not in SQL — there is no filtered variant. */
  readonly listMessageVectorKeys: (options: {
    readonly model: string;
  }) => Effect.Effect<readonly MessageVectorKey[], SqliteStoreError>;
  readonly getMessagesBySessionSeq: (
    pairs: readonly MessageVectorKey[],
  ) => Effect.Effect<readonly MessageRow[], SqliteStoreError>;
  /** Register THE (single, canonical) vector-write listener. Listener failures
   * are contained: they log a named diagnostic and never fail the write. */
  readonly registerMessageVectorWriteListener: (
    listener: (event: MessageVectorWriteEvent) => void,
  ) => void;
  readonly lexicalSearch: (request: {
    readonly query: string;
    readonly projectKey?: string;
    readonly role?: string;
    readonly providers?: readonly string[];
    readonly limit?: number;
  }) => Effect.Effect<readonly SearchHit[], SqliteStoreError>;
  readonly close: Effect.Effect<void>;
}

const trySqlite = <A>(operation: string, run: () => A): Effect.Effect<A, SqliteStoreError> =>
  Effect.try({
    try: run,
    catch: (cause) =>
      new SqliteStoreError({
        operation,
        message: cause instanceof Error ? cause.message : String(cause),
        cause,
      }),
  });

// Scoped-token FTS (D1): the messages_fts `text` column is prefixed with bare
// project/role/provider scope tokens ahead of the raw message text, so a
// serving-path MATCH query can AND-join scope tokens with the user's query
// terms. This whole shape (column + tokenized triggers) is versioned via
// PRAGMA user_version and migrated exactly once — see
// migrateMessagesFtsScopedTokens below — rather than re-created on every
// boot like the rest of migrate()'s idempotent DDL.
const FTS_SCOPED_TOKENS_SCHEMA_VERSION = 1;

const MESSAGES_FTS_CREATE_SQL = `
  CREATE VIRTUAL TABLE messages_fts USING fts5(
    text,
    key UNINDEXED,
    session_id UNINDEXED,
    seq UNINDEXED,
    role UNINDEXED,
    project_key UNINDEXED,
    provider UNINDEXED,
    content_hash UNINDEXED,
    tokenize = 'unicode61'
  );
`;

// Role scope token as a pure-SQL CASE over the fixed searchable-role enum.
// Matches fts5.ts ftsRoleScopeToken byte-for-byte for these three values
// (already lowercase alnum, so 'r' + role is exact) — no SQL UDF needed.
const ROLE_SCOPE_TOKEN_CASE_SQL = `
      CASE NEW.role
        WHEN 'user' THEN 'ruser'
        WHEN 'assistant' THEN 'rassistant'
        WHEN 'reasoning' THEN 'rreasoning'
      END`;

// Provider scope token derived in pure SQL from the session_id prefix before
// the first ':'. Matches fts5.ts ftsProviderScopeToken + providerFromSessionId
// for real session ids, which are always `${provider}:${hash}` (see
// sessionIdFor in packages/cli/src/adapters/common.ts) with providers drawn
// from the fixed lowercase-alnum Provider enum in provider.ts.
const PROVIDER_SCOPE_TOKEN_SQL =
  "('v' || lower(substr(NEW.session_id, 1, instr(NEW.session_id, ':') - 1)))";

const MESSAGES_FTS_TRIGGERS_SQL = `
  CREATE TRIGGER messages_fts_ai
  AFTER INSERT ON messages
  WHEN NEW.role IN ('user', 'assistant', 'reasoning')
  BEGIN
    INSERT INTO messages_fts(text, key, session_id, seq, role, project_key, provider, content_hash)
    VALUES (
      NEW.project_scope_token || ' ' || ${ROLE_SCOPE_TOKEN_CASE_SQL} || ' ' || ${PROVIDER_SCOPE_TOKEN_SQL} || ' ' || NEW.text,
      NEW.session_id || ':' || NEW.seq || ':' || NEW.role,
      NEW.session_id,
      NEW.seq,
      NEW.role,
      NEW.project_key,
      CASE
        WHEN instr(NEW.session_id, ':') > 0 THEN substr(NEW.session_id, 1, instr(NEW.session_id, ':') - 1)
        ELSE NEW.session_id
      END,
      'unembedded:' || NEW.content_hash
    );
  END;
  CREATE TRIGGER messages_fts_ad
  AFTER DELETE ON messages
  BEGIN
    DELETE FROM messages_fts WHERE key = OLD.session_id || ':' || OLD.seq || ':' || OLD.role;
  END;
  CREATE TRIGGER messages_fts_au
  AFTER UPDATE ON messages
  BEGIN
    DELETE FROM messages_fts WHERE key = OLD.session_id || ':' || OLD.seq || ':' || OLD.role;
    INSERT INTO messages_fts(text, key, session_id, seq, role, project_key, provider, content_hash)
    SELECT
      NEW.project_scope_token || ' ' || ${ROLE_SCOPE_TOKEN_CASE_SQL} || ' ' || ${PROVIDER_SCOPE_TOKEN_SQL} || ' ' || NEW.text,
      NEW.session_id || ':' || NEW.seq || ':' || NEW.role,
      NEW.session_id,
      NEW.seq,
      NEW.role,
      NEW.project_key,
      CASE
        WHEN instr(NEW.session_id, ':') > 0 THEN substr(NEW.session_id, 1, instr(NEW.session_id, ':') - 1)
        ELSE NEW.session_id
      END,
      'unembedded:' || NEW.content_hash
    WHERE NEW.role IN ('user', 'assistant', 'reasoning');
  END;
`;

const PROJECT_SCOPE_TOKEN_BACKFILL_BATCH = 5_000;
const MESSAGES_FTS_REBUILD_CHUNK = 10_000;

// Step 2 of migrateMessagesFtsScopedTokens: backfill project_scope_token for
// every pre-existing messages row in JS batches of 5000 rows/txn (sha1 is
// computed in JS via the stage-1 fts5.ts function, not a SQL UDF). Resumable:
// re-running after a crash only touches rows still NULL.
const backfillProjectScopeTokens = (db: Database): number => {
  const selectBatch = db.query(
    "SELECT rowid AS rowid, project_key AS projectKey FROM messages WHERE project_scope_token IS NULL ORDER BY rowid ASC LIMIT ?",
  );
  const updateRow = db.prepare("UPDATE messages SET project_scope_token = ? WHERE rowid = ?");
  const runBatch = db.transaction((rows: readonly { rowid: number; projectKey: string }[]) => {
    for (const row of rows) {
      updateRow.run(ftsProjectScopeToken(row.projectKey), row.rowid);
    }
  });
  let backfilled = 0;
  while (true) {
    const rows = selectBatch.all(PROJECT_SCOPE_TOKEN_BACKFILL_BATCH) as Array<{ rowid: number; projectKey: string }>;
    if (rows.length === 0) break;
    runBatch(rows);
    backfilled += rows.length;
  }
  return backfilled;
};

// Step 3 of migrateMessagesFtsScopedTokens: bulk-rebuild messages_fts from
// messages in chunked (10k row) transactions, computing the same
// token-prefixed text the triggers now write, via the same pure-SQL
// expressions (kept textually identical to MESSAGES_FTS_TRIGGERS_SQL above).
const rebuildMessagesFtsInChunks = (db: Database): number => {
  const selectChunkRowids = db.query(
    `SELECT rowid AS rowid FROM messages
     WHERE role IN ('user', 'assistant', 'reasoning') AND rowid > ?
     ORDER BY rowid ASC LIMIT ?`,
  );
  const insertChunk = db.prepare(`
    INSERT INTO messages_fts(text, key, session_id, seq, role, project_key, provider, content_hash)
    SELECT
      m.project_scope_token || ' ' ||
      CASE m.role
        WHEN 'user' THEN 'ruser'
        WHEN 'assistant' THEN 'rassistant'
        WHEN 'reasoning' THEN 'rreasoning'
      END || ' ' ||
      ('v' || lower(substr(m.session_id, 1, instr(m.session_id, ':') - 1))) || ' ' ||
      m.text,
      m.session_id || ':' || m.seq || ':' || m.role,
      m.session_id,
      m.seq,
      m.role,
      m.project_key,
      CASE
        WHEN instr(m.session_id, ':') > 0 THEN substr(m.session_id, 1, instr(m.session_id, ':') - 1)
        ELSE m.session_id
      END,
      'unembedded:' || m.content_hash
    FROM messages AS m
    WHERE m.rowid >= $startRowid AND m.rowid <= $endRowid
      AND m.role IN ('user', 'assistant', 'reasoning')
  `);
  const runChunk = db.transaction((startRowid: number, endRowid: number) => {
    insertChunk.run({ $startRowid: startRowid, $endRowid: endRowid });
  });

  let lastRowid = 0;
  let rebuilt = 0;
  while (true) {
    const rows = selectChunkRowids.all(lastRowid, MESSAGES_FTS_REBUILD_CHUNK) as Array<{ rowid: number }>;
    if (rows.length === 0) break;
    const startRowid = rows[0]!.rowid;
    const endRowid = rows[rows.length - 1]!.rowid;
    runChunk(startRowid, endRowid);
    rebuilt += rows.length;
    lastRowid = endRowid;
  }
  return rebuilt;
};

// One-time (PRAGMA user_version-gated) migration to scoped-token FTS.
// Idempotent/resumable if interrupted: every DB opened today is version 0
// (see backfillProjectScopeTokens' NULL-guard and the full DROP+rebuild of
// messages_fts below), and user_version only advances once every step below
// has completed. Boot blocks until done.
const migrateMessagesFtsScopedTokens = (db: Database): void => {
  const { user_version: userVersion } = db.query("PRAGMA user_version").get() as { user_version: number };
  if (userVersion >= FTS_SCOPED_TOKENS_SCHEMA_VERSION) return;

  const startedAt = performance.now();

  const messageColumns = new Set(
    (db.query("PRAGMA table_info(messages)").all() as Array<{ name: string }>).map((column) => column.name),
  );
  if (!messageColumns.has("project_scope_token")) {
    db.exec("ALTER TABLE messages ADD COLUMN project_scope_token TEXT");
  }

  const backfilledRows = backfillProjectScopeTokens(db);

  db.exec(`
    DROP TRIGGER IF EXISTS messages_fts_ai;
    DROP TRIGGER IF EXISTS messages_fts_ad;
    DROP TRIGGER IF EXISTS messages_fts_au;
    DROP TABLE IF EXISTS messages_fts;
  `);
  db.exec(MESSAGES_FTS_CREATE_SQL);
  db.exec(MESSAGES_FTS_TRIGGERS_SQL);
  const rebuiltRows = rebuildMessagesFtsInChunks(db);

  db.exec(`PRAGMA user_version = ${FTS_SCOPED_TOKENS_SCHEMA_VERSION}`);

  const elapsedMs = Math.round((performance.now() - startedAt) * 100) / 100;
  console.log(
    JSON.stringify({
      event: "store.migrate.fts_scoped_tokens",
      at: new Date().toISOString(),
      backfilledRows,
      rebuiltRows,
      elapsedMs,
    }),
  );
};

const MESSAGE_VECTORS_MIGRATION_SQL = `
  CREATE TABLE IF NOT EXISTS message_vectors (
    model TEXT NOT NULL,
    modality TEXT NOT NULL,
    session_id TEXT NOT NULL,
    seq INTEGER NOT NULL,
    role TEXT NOT NULL,
    project_key TEXT NOT NULL,
    provider TEXT NOT NULL,
    content_hash TEXT NOT NULL,
    document_hash TEXT NOT NULL,
    dimensions INTEGER NOT NULL,
    encoding TEXT NOT NULL,
    vector_blob BLOB NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (model, session_id, seq)
  );
  CREATE INDEX IF NOT EXISTS message_vectors_by_model ON message_vectors(model, session_id, seq);
  CREATE INDEX IF NOT EXISTS message_vectors_by_message ON message_vectors(session_id, seq);
  CREATE INDEX IF NOT EXISTS message_vectors_by_model_project ON message_vectors(model, project_key, session_id, seq);
  DROP TRIGGER IF EXISTS message_vectors_ad;
  DROP TRIGGER IF EXISTS message_vectors_au;
  CREATE TRIGGER IF NOT EXISTS message_vectors_ad
  AFTER DELETE ON messages
  BEGIN
    DELETE FROM message_vectors WHERE session_id = OLD.session_id AND seq = OLD.seq;
  END;
  CREATE TRIGGER IF NOT EXISTS message_vectors_au
  AFTER UPDATE ON messages
  BEGIN
    DELETE FROM message_vectors WHERE session_id = OLD.session_id AND seq = OLD.seq;
  END;
`;

const MESSAGE_VECTOR_COLUMNS = [
  "model",
  "modality",
  "session_id",
  "seq",
  "role",
  "project_key",
  "provider",
  "content_hash",
  "document_hash",
  "dimensions",
  "encoding",
  "vector_blob",
  "created_at",
  "updated_at",
] as const;

const migrateMessageVectorsTable = (db: Database): void => {
  const existing = db.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'message_vectors'").get() as { name: string } | null;
  if (existing === null) return;
  const columns = db.query("PRAGMA table_info(message_vectors)").all() as Array<{ name: string; pk: number }>;
  const primaryKey = columns
    .filter((column) => column.pk > 0)
    .sort((left, right) => left.pk - right.pk)
    .map((column) => column.name);
  if (primaryKey.join("\0") === "model\0session_id\0seq") return;

  db.exec(`
    DROP TRIGGER IF EXISTS message_vectors_ad;
    DROP TRIGGER IF EXISTS message_vectors_au;
  `);
  const columnNames = new Set(columns.map((column) => column.name));
  const canCopy = MESSAGE_VECTOR_COLUMNS.every((column) => columnNames.has(column));
  if (!canCopy) {
    db.exec("DROP TABLE message_vectors");
    return;
  }

  db.exec(`
    ALTER TABLE message_vectors RENAME TO message_vectors_old;
    CREATE TABLE message_vectors (
      model TEXT NOT NULL,
      modality TEXT NOT NULL,
      session_id TEXT NOT NULL,
      seq INTEGER NOT NULL,
      role TEXT NOT NULL,
      project_key TEXT NOT NULL,
      provider TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      document_hash TEXT NOT NULL,
      dimensions INTEGER NOT NULL,
      encoding TEXT NOT NULL,
      vector_blob BLOB NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (model, session_id, seq)
    );
    INSERT OR IGNORE INTO message_vectors(${MESSAGE_VECTOR_COLUMNS.join(", ")})
    SELECT ${MESSAGE_VECTOR_COLUMNS.join(", ")}
    FROM message_vectors_old;
    DROP TABLE message_vectors_old;
  `);
};

const migrate = (db: Database): void => {
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
    CREATE TABLE IF NOT EXISTS projects (
      project_key TEXT PRIMARY KEY,
      display_name TEXT NOT NULL,
      raw_path TEXT
    );
    CREATE TABLE IF NOT EXISTS sessions (
      session_id TEXT PRIMARY KEY,
      project_key TEXT NOT NULL,
      provider TEXT NOT NULL,
      agent_name TEXT NOT NULL,
      title TEXT,
      started_at TEXT,
      updated_at TEXT,
      source_path TEXT NOT NULL,
      source_fingerprint TEXT NOT NULL,
      host TEXT NOT NULL DEFAULT '',
      identity_scheme_version INTEGER NOT NULL DEFAULT 0,
      parent_session_id TEXT,
      message_count INTEGER NOT NULL,
      tool_call_count INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS sessions_by_project ON sessions(project_key, updated_at);
    CREATE INDEX IF NOT EXISTS sessions_by_provider ON sessions(provider, updated_at);
    CREATE INDEX IF NOT EXISTS sessions_by_source ON sessions(source_path, source_fingerprint);
    CREATE TABLE IF NOT EXISTS messages (
      session_id TEXT NOT NULL,
      seq INTEGER NOT NULL,
      role TEXT NOT NULL,
      text TEXT NOT NULL,
      ts TEXT,
      project_key TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      PRIMARY KEY (session_id, seq)
    );
    CREATE INDEX IF NOT EXISTS messages_by_project ON messages(project_key, session_id, seq);
    CREATE TABLE IF NOT EXISTS tool_calls (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      seq INTEGER NOT NULL,
      tool_name TEXT NOT NULL,
      status TEXT,
      input_text TEXT NOT NULL,
      output_text TEXT NOT NULL,
      started_at TEXT,
      completed_at TEXT,
      project_key TEXT NOT NULL,
      provider TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS tool_calls_by_session ON tool_calls(session_id, seq);
    CREATE INDEX IF NOT EXISTS tool_calls_by_project_tool ON tool_calls(project_key, tool_name, session_id, seq);
    CREATE INDEX IF NOT EXISTS tool_calls_by_tool ON tool_calls(tool_name, session_id);
    CREATE TABLE IF NOT EXISTS ingest_runs (
      run_id TEXT PRIMARY KEY,
      provider TEXT NOT NULL,
      status TEXT NOT NULL,
      started_at TEXT NOT NULL,
      completed_at TEXT,
      sessions_seen INTEGER NOT NULL,
      sessions_written INTEGER NOT NULL,
      sessions_skipped INTEGER NOT NULL,
      sessions_failed INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS ingest_runs_by_status_started ON ingest_runs(status, started_at);
    CREATE TABLE IF NOT EXISTS embedding_cache (
      model TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      dimensions INTEGER NOT NULL,
      text_bytes INTEGER NOT NULL,
      vector_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (model, content_hash)
    );
  `);
  // Idempotent column adds for an existing sessions table predating the
  // host/identity_scheme_version provenance fields (QSR-215). This is an empty
  // -column add (defaults supply existing rows), NOT a data migration — real
  // corpus cleanup stays in QSR-219. Safe to re-run on the live data volume.
  const sessionColumns = new Set(
    (db.query("PRAGMA table_info(sessions)").all() as { name: string }[]).map(
      (column) => column.name,
    ),
  );
  if (!sessionColumns.has("host")) {
    db.exec("ALTER TABLE sessions ADD COLUMN host TEXT NOT NULL DEFAULT ''");
  }
  if (!sessionColumns.has("identity_scheme_version")) {
    db.exec(
      "ALTER TABLE sessions ADD COLUMN identity_scheme_version INTEGER NOT NULL DEFAULT 0",
    );
  }
  // Idempotent column add for parent-session lineage (QSR-220). Nullable, so
  // existing rows default to NULL (root). Empty-column add, not a data migration.
  if (!sessionColumns.has("parent_session_id")) {
    db.exec("ALTER TABLE sessions ADD COLUMN parent_session_id TEXT");
  }
  migrateMessageVectorsTable(db);
  db.exec(MESSAGE_VECTORS_MIGRATION_SQL);
  migrateMessagesFtsScopedTokens(db);
};

const count = (db: Database, table: string): number =>
  (db.query(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count;

const lexicalRankScore = (index: number): number =>
  1 / (index + 1);

export class LocalStore extends Context.Tag("@quasar/LocalStore")<
  LocalStore,
  LocalStoreService
>() {}

export const makeLocalStoreLayer = (path = sqlitePath()): Layer.Layer<LocalStore> =>
  Layer.scoped(
    LocalStore,
    Effect.acquireRelease(
      Effect.sync(() => {
        ensureParentDir(path);
        const db = new Database(path, { create: true });
        migrate(db);
        return db;
      }),
      (db) => Effect.sync(() => db.close()),
    ).pipe(
      Effect.map((db) => {
        const upsertProject = db.prepare(
          `INSERT INTO projects(project_key, display_name, raw_path)
           VALUES ($projectKey, $displayName, $rawPath)
           ON CONFLICT(project_key) DO UPDATE SET display_name = excluded.display_name, raw_path = excluded.raw_path`,
        );
        const upsertSession = db.prepare(
          `INSERT INTO sessions(session_id, project_key, provider, agent_name, title, started_at, updated_at, source_path, source_fingerprint, host, identity_scheme_version, parent_session_id, message_count, tool_call_count)
           VALUES ($sessionId, $projectKey, $provider, $agentName, $title, $startedAt, $updatedAt, $sourcePath, $sourceFingerprint, $host, $identitySchemeVersion, $parentSessionId, $messageCount, $toolCallCount)
           ON CONFLICT(session_id) DO UPDATE SET project_key = excluded.project_key, provider = excluded.provider, agent_name = excluded.agent_name, title = excluded.title, started_at = excluded.started_at, updated_at = excluded.updated_at, source_path = excluded.source_path, source_fingerprint = excluded.source_fingerprint, host = excluded.host, identity_scheme_version = excluded.identity_scheme_version, parent_session_id = excluded.parent_session_id, message_count = excluded.message_count, tool_call_count = excluded.tool_call_count`,
        );
        const insertMessage = db.prepare(
          `INSERT INTO messages(session_id, seq, role, text, ts, project_key, content_hash, project_scope_token)
           VALUES ($sessionId, $seq, $role, $text, $ts, $projectKey, $contentHash, $projectScopeToken)`,
        );
        const insertToolCall = db.prepare(
          `INSERT INTO tool_calls(id, session_id, seq, tool_name, status, input_text, output_text, started_at, completed_at, project_key, provider)
           VALUES ($id, $sessionId, $seq, $toolName, $status, $inputText, $outputText, $startedAt, $completedAt, $projectKey, $provider)`,
        );
        const upsertIngestRun = db.prepare(
          `INSERT INTO ingest_runs(run_id, provider, status, started_at, completed_at, sessions_seen, sessions_written, sessions_skipped, sessions_failed)
           VALUES ($runId, $provider, $status, $startedAt, $completedAt, $sessionsSeen, $sessionsWritten, $sessionsSkipped, $sessionsFailed)
           ON CONFLICT(run_id) DO UPDATE SET provider = excluded.provider, status = excluded.status, started_at = excluded.started_at, completed_at = excluded.completed_at, sessions_seen = excluded.sessions_seen, sessions_written = excluded.sessions_written, sessions_skipped = excluded.sessions_skipped, sessions_failed = excluded.sessions_failed`,
        );
        const selectMessageVectorCreated = db.prepare(
          "SELECT created_at AS createdAt FROM message_vectors WHERE model = ? AND session_id = ? AND seq = ?",
        );
        const upsertMessageVector = db.prepare(
          `INSERT INTO message_vectors(model, modality, session_id, seq, role, project_key, provider, content_hash, document_hash, dimensions, encoding, vector_blob, created_at, updated_at)
           SELECT $model, $modality, m.session_id, m.seq, m.role, m.project_key, $provider, m.content_hash, $documentHash, $dimensions, $encoding, $vectorBlob, $createdAt, $updatedAt
           FROM messages AS m
           WHERE m.session_id = $sessionId
             AND m.seq = $seq
             AND m.role = $role
             AND m.project_key = $projectKey
             AND m.content_hash = $contentHash
           ON CONFLICT(model, session_id, seq) DO UPDATE SET modality = excluded.modality, role = excluded.role, project_key = excluded.project_key, provider = excluded.provider, content_hash = excluded.content_hash, document_hash = excluded.document_hash, dimensions = excluded.dimensions, encoding = excluded.encoding, vector_blob = excluded.vector_blob, updated_at = excluded.updated_at`,
        );
        const replaceMessageVectors = db.transaction((rows: readonly MessageVectorUpsert[]) => {
          const acceptedRows: MessageVectorUpsert[] = [];
          for (const row of rows) {
            const at = row.now ?? new Date().toISOString();
            const existing = selectMessageVectorCreated.get(row.model, row.sessionId, row.seq) as { createdAt: string } | null;
            const result = upsertMessageVector.run({
              $model: row.model,
              $modality: row.modality,
              $sessionId: row.sessionId,
              $seq: row.seq,
              $role: row.role,
              $projectKey: row.projectKey,
              $provider: row.provider,
              $contentHash: row.contentHash,
              $documentHash: row.documentHash,
              $dimensions: row.vector.length,
              $encoding: VECTOR_BLOB_ENCODING,
              $vectorBlob: encodeFloat16Vector(row.vector),
              $createdAt: existing?.createdAt ?? at,
              $updatedAt: at,
            });
            if (result.changes > 0) acceptedRows.push(row);
          }
          return acceptedRows;
        });
        const countMessageVectorsForModel = db.prepare(
          "SELECT COUNT(*) AS count FROM message_vectors WHERE model = ?",
        );
        let messageVectorWriteListener: ((event: MessageVectorWriteEvent) => void) | undefined;
        const notifyMessageVectorWrite = (acceptedRows: readonly MessageVectorUpsert[]): void => {
          if (messageVectorWriteListener === undefined || acceptedRows.length === 0) return;
          const sqliteRowsByModel: Record<string, number> = {};
          for (const row of acceptedRows) {
            if (sqliteRowsByModel[row.model] === undefined) {
              sqliteRowsByModel[row.model] = (countMessageVectorsForModel.get(row.model) as { count: number }).count;
            }
          }
          try {
            messageVectorWriteListener({ rows: acceptedRows, sqliteRowsByModel });
          } catch (cause) {
            console.error(JSON.stringify({
              event: "store.message_vector_write_listener_failed",
              at: new Date().toISOString(),
              diagnostic: cause instanceof Error ? cause.message : String(cause),
            }));
          }
        };
        // --- session diff apply ---
        // A changed session used to be applied as DELETE-all + reinsert-all in
        // one synchronous transaction: O(session length) FTS re-tokenization
        // and vector-trigger churn for what is usually an O(1) append, holding
        // the event loop for the whole rewrite (the receipted 36.5s ingest
        // burst that head-of-line blocked a search to 24.4s). The canonical
        // apply is now a row-level diff: untouched rows are never written,
        // changed rows go through DELETE+INSERT (the proven AD/AI trigger
        // pair), and work commits in small chunk transactions with the event
        // loop yielded between chunks. Clients keep POSTing the full desired
        // session state; convergence is state-based and idempotent, so a crash
        // anywhere mid-apply is healed by the next daemon tick re-sending.
        const INGEST_CHUNK_ROWS = 64;
        const selectMessageDiffRows = db.prepare(
          "SELECT seq, role, content_hash AS contentHash, project_key AS projectKey, ts FROM messages WHERE session_id = ?",
        );
        const selectToolCallDiffRows = db.prepare(
          `SELECT id, seq, tool_name AS toolName, status, started_at AS startedAt, completed_at AS completedAt,
                  project_key AS projectKey, provider,
                  length(CAST(input_text AS BLOB)) AS inputBytes, length(CAST(output_text AS BLOB)) AS outputBytes
           FROM tool_calls WHERE session_id = ?`,
        );
        const deleteMessageRow = db.prepare("DELETE FROM messages WHERE session_id = ? AND seq = ?");
        const deleteToolCallRow = db.prepare("DELETE FROM tool_calls WHERE id = ?");
        const upsertToolCall = db.prepare(
          `INSERT INTO tool_calls(id, session_id, seq, tool_name, status, input_text, output_text, started_at, completed_at, project_key, provider)
           VALUES ($id, $sessionId, $seq, $toolName, $status, $inputText, $outputText, $startedAt, $completedAt, $projectKey, $provider)
           ON CONFLICT(id) DO UPDATE SET session_id = excluded.session_id, seq = excluded.seq, tool_name = excluded.tool_name, status = excluded.status, input_text = excluded.input_text, output_text = excluded.output_text, started_at = excluded.started_at, completed_at = excluded.completed_at, project_key = excluded.project_key, provider = excluded.provider`,
        );
        const stampSessionFingerprint = db.prepare(
          "UPDATE sessions SET source_fingerprint = ? WHERE session_id = ?",
        );

        interface SessionDiffPlan {
          readonly messageUpserts: readonly MessageRow[];
          readonly messageDeleteSeqs: readonly number[];
          readonly messagesInserted: number;
          readonly messagesUpdated: number;
          readonly messagesUnchanged: number;
          readonly toolCallUpserts: readonly ToolCallRow[];
          readonly toolCallDeleteIds: readonly string[];
          readonly toolCallsInserted: number;
          readonly toolCallsUpdated: number;
          readonly toolCallsUnchanged: number;
        }

        const computeSessionDiff = (mapped: MappedSession): SessionDiffPlan => {
          const existingMessages = selectMessageDiffRows.all(mapped.session.sessionId) as Array<{
            seq: number; role: string; contentHash: string; projectKey: string; ts: string | null;
          }>;
          const existingBySeq = new Map(existingMessages.map((row) => [row.seq, row]));
          const incomingSeqs = new Set(mapped.messages.map((row) => row.seq));
          const messageUpserts: MessageRow[] = [];
          let messagesInserted = 0;
          let messagesUpdated = 0;
          let messagesUnchanged = 0;
          for (const message of mapped.messages) {
            const existing = existingBySeq.get(message.seq);
            if (existing === undefined) {
              messagesInserted += 1;
              messageUpserts.push(message);
            } else if (
              existing.contentHash !== message.contentHash
              || existing.role !== message.role
              || existing.projectKey !== message.projectKey
              || existing.ts !== (message.ts ?? null)
            ) {
              messagesUpdated += 1;
              messageUpserts.push(message);
            } else {
              messagesUnchanged += 1;
            }
          }
          const messageDeleteSeqs = existingMessages
            .filter((row) => !incomingSeqs.has(row.seq))
            .map((row) => row.seq);

          const existingToolCalls = selectToolCallDiffRows.all(mapped.session.sessionId) as Array<{
            id: string; seq: number; toolName: string; status: string | null;
            startedAt: string | null; completedAt: string | null;
            projectKey: string; provider: string; inputBytes: number; outputBytes: number;
          }>;
          const existingById = new Map(existingToolCalls.map((row) => [row.id, row]));
          const incomingIds = new Set(mapped.toolCalls.map((row) => row.id));
          const toolCallUpserts: ToolCallRow[] = [];
          let toolCallsInserted = 0;
          let toolCallsUpdated = 0;
          let toolCallsUnchanged = 0;
          for (const toolCall of mapped.toolCalls) {
            const existing = existingById.get(toolCall.id);
            if (existing === undefined) {
              toolCallsInserted += 1;
              toolCallUpserts.push(toolCall);
            } else if (
              // Byte lengths stand in for the input/output text themselves so
              // unchanged tool calls never load their (potentially large)
              // payloads. A same-length in-place content mutation with
              // identical metadata would slip through; harness tool calls are
              // append-only in practice, and a mutated session's messages
              // still carry content hashes that force the session through here.
              existing.seq !== toolCall.seq
              || existing.toolName !== toolCall.toolName
              || existing.status !== (toolCall.status ?? null)
              || existing.startedAt !== (toolCall.startedAt ?? null)
              || existing.completedAt !== (toolCall.completedAt ?? null)
              || existing.projectKey !== toolCall.projectKey
              || existing.provider !== toolCall.provider
              || existing.inputBytes !== Buffer.byteLength(toolCall.inputText, "utf8")
              || existing.outputBytes !== Buffer.byteLength(toolCall.outputText, "utf8")
            ) {
              toolCallsUpdated += 1;
              toolCallUpserts.push(toolCall);
            } else {
              toolCallsUnchanged += 1;
            }
          }
          const toolCallDeleteIds = existingToolCalls
            .filter((row) => !incomingIds.has(row.id))
            .map((row) => row.id);

          return {
            messageUpserts, messageDeleteSeqs, messagesInserted, messagesUpdated, messagesUnchanged,
            toolCallUpserts, toolCallDeleteIds, toolCallsInserted, toolCallsUpdated, toolCallsUnchanged,
          };
        };

        // Fingerprint commit ordering: the session row lands first carrying an
        // `applying:` sentinel and only the final step stamps the real source
        // fingerprint. A crash mid-apply leaves a fingerprint mismatch, the
        // daemon re-sends the full session, and the diff converges on the
        // remainder — no journal or partial-apply bookkeeping needed.
        const applySessionHead = db.transaction((mapped: MappedSession) => {
          upsertProject.run({
            $projectKey: mapped.project.projectKey,
            $displayName: mapped.project.displayName,
            $rawPath: mapped.project.rawPath ?? null,
          });
          upsertSession.run({
            $sessionId: mapped.session.sessionId,
            $projectKey: mapped.session.projectKey,
            $provider: mapped.session.provider,
            $agentName: mapped.session.agentName,
            $title: mapped.session.title ?? null,
            $startedAt: mapped.session.startedAt ?? null,
            $updatedAt: mapped.session.updatedAt ?? null,
            $sourcePath: mapped.session.sourcePath,
            $sourceFingerprint: `applying:${mapped.session.sourceFingerprint}`,
            $host: mapped.session.host,
            $identitySchemeVersion: mapped.session.identitySchemeVersion,
            $parentSessionId: mapped.session.parentSessionId ?? null,
            $messageCount: mapped.session.messageCount,
            $toolCallCount: mapped.session.toolCallCount,
          });
        });
        const applyMessageDeleteChunk = db.transaction((sessionId: string, seqs: readonly number[]) => {
          for (const seq of seqs) deleteMessageRow.run(sessionId, seq);
        });
        const applyMessageUpsertChunk = db.transaction((rows: readonly MessageRow[]) => {
          for (const message of rows) {
            deleteMessageRow.run(message.sessionId, message.seq);
            insertMessage.run({
              $sessionId: message.sessionId,
              $seq: message.seq,
              $role: message.role,
              $text: message.text,
              $ts: message.ts ?? null,
              $projectKey: message.projectKey,
              $contentHash: message.contentHash,
              $projectScopeToken: ftsProjectScopeToken(message.projectKey),
            });
          }
        });
        const applyToolCallDeleteChunk = db.transaction((ids: readonly string[]) => {
          for (const id of ids) deleteToolCallRow.run(id);
        });
        const applyToolCallUpsertChunk = db.transaction((rows: readonly ToolCallRow[]) => {
          for (const toolCall of rows) {
            upsertToolCall.run({
              $id: toolCall.id,
              $sessionId: toolCall.sessionId,
              $seq: toolCall.seq,
              $toolName: toolCall.toolName,
              $status: toolCall.status ?? null,
              $inputText: toolCall.inputText,
              $outputText: toolCall.outputText,
              $startedAt: toolCall.startedAt ?? null,
              $completedAt: toolCall.completedAt ?? null,
              $projectKey: toolCall.projectKey,
              $provider: toolCall.provider,
            });
          }
        });

        const chunked = <A>(rows: readonly A[]): A[][] => {
          const chunks: A[][] = [];
          for (let index = 0; index < rows.length; index += INGEST_CHUNK_ROWS) {
            chunks.push(rows.slice(index, index + INGEST_CHUNK_ROWS));
          }
          return chunks;
        };

        // Effect.sleep (not yieldNow) between chunks: a timer forces a full
        // event-loop turn, so queued HTTP requests — searches — run between
        // write transactions instead of waiting out the whole apply.
        const upsertSessionDiff = (mapped: MappedSession): Effect.Effect<SessionDiffOutcome, SqliteStoreError> =>
          Effect.gen(function* () {
            const plan = yield* trySqlite("upsertSession.plan", () => computeSessionDiff(mapped));
            yield* trySqlite("upsertSession.head", () => applySessionHead(mapped));
            for (const chunk of chunked(plan.messageDeleteSeqs)) {
              yield* trySqlite("upsertSession.deleteMessages", () => applyMessageDeleteChunk(mapped.session.sessionId, chunk));
              yield* Effect.sleep("1 millis");
            }
            for (const chunk of chunked(plan.messageUpserts)) {
              yield* trySqlite("upsertSession.messages", () => applyMessageUpsertChunk(chunk));
              yield* Effect.sleep("1 millis");
            }
            for (const chunk of chunked(plan.toolCallDeleteIds)) {
              yield* trySqlite("upsertSession.deleteToolCalls", () => applyToolCallDeleteChunk(chunk));
              yield* Effect.sleep("1 millis");
            }
            for (const chunk of chunked(plan.toolCallUpserts)) {
              yield* trySqlite("upsertSession.toolCalls", () => applyToolCallUpsertChunk(chunk));
              yield* Effect.sleep("1 millis");
            }
            yield* trySqlite("upsertSession.fingerprint", () =>
              stampSessionFingerprint.run(mapped.session.sourceFingerprint, mapped.session.sessionId));
            return {
              messagesInserted: plan.messagesInserted,
              messagesUpdated: plan.messagesUpdated,
              messagesDeleted: plan.messageDeleteSeqs.length,
              messagesUnchanged: plan.messagesUnchanged,
              toolCallsInserted: plan.toolCallsInserted,
              toolCallsUpdated: plan.toolCallsUpdated,
              toolCallsDeleted: plan.toolCallDeleteIds.length,
              toolCallsUnchanged: plan.toolCallsUnchanged,
              changedMessages: plan.messageUpserts,
            };
          });

        return {
          dbPath: path,
          listProjects: (options = {}) =>
            trySqlite("listProjects", () => {
              const limit = options.limit ?? 100;
              const offset = options.offset ?? 0;
              return db
                .query("SELECT project_key AS projectKey, display_name AS displayName, raw_path AS rawPath FROM projects ORDER BY project_key ASC LIMIT ? OFFSET ?")
                .all(limit, offset) as ProjectRow[];
            }),
          upsertSession: upsertSessionDiff,
          hasSessionFingerprint: (sessionId, sourceFingerprint) =>
            trySqlite("hasSessionFingerprint", () => {
              const row = db
                .query("SELECT source_fingerprint AS sourceFingerprint FROM sessions WHERE session_id = ?")
                .get(sessionId) as { sourceFingerprint: string } | null;
              return row?.sourceFingerprint === sourceFingerprint;
            }),
          listSessions: (options = {}) =>
            trySqlite("listSessions", () => {
              const limit = options.limit ?? 100;
              const offset = options.offset ?? 0;
              const filters: string[] = [];
              const args: Array<string | number> = [];
              if (options.provider !== undefined) {
                filters.push("provider = ?");
                args.push(options.provider);
              }
              if (options.projectKey !== undefined) {
                filters.push("project_key = ?");
                args.push(options.projectKey);
              }
              const where = filters.length > 0 ? ` WHERE ${filters.join(" AND ")}` : "";
              return db
                .query(`SELECT session_id AS sessionId, project_key AS projectKey, provider, agent_name AS agentName, title, started_at AS startedAt, updated_at AS updatedAt, source_path AS sourcePath, source_fingerprint AS sourceFingerprint, host, identity_scheme_version AS identitySchemeVersion, parent_session_id AS parentSessionId, message_count AS messageCount, tool_call_count AS toolCallCount FROM sessions${where} ORDER BY COALESCE(updated_at, started_at, '') DESC LIMIT ? OFFSET ?`)
                .all(...args, limit, offset) as SessionRow[];
            }),
          getMessage: ({ sessionId, seq, contentHash }) =>
            trySqlite("getMessage", () =>
              db
                .query("SELECT session_id AS sessionId, seq, role, text, ts, project_key AS projectKey, content_hash AS contentHash FROM messages WHERE session_id = ? AND seq = ? AND content_hash = ?")
                .get(sessionId, seq, contentHash) as MessageRow | undefined,
            ),
          readMessages: (sessionId, limit) =>
            trySqlite("readMessages", () =>
              db
                .query("SELECT session_id AS sessionId, seq, role, text, ts, project_key AS projectKey, content_hash AS contentHash FROM messages WHERE session_id = ? ORDER BY seq ASC LIMIT ?")
                .all(sessionId, limit) as MessageRow[],
            ),
          listToolCalls: ({ sessionId, projectKey, provider, toolName, limit, offset = 0 }) =>
            trySqlite("listToolCalls", () => {
              const filters: string[] = [];
              const args: Array<string | number> = [];
              if (sessionId !== undefined) {
                filters.push("session_id = ?");
                args.push(sessionId);
              }
              if (projectKey !== undefined) {
                filters.push("project_key = ?");
                args.push(projectKey);
              }
              if (provider !== undefined) {
                filters.push("provider = ?");
                args.push(provider);
              }
              if (toolName !== undefined) {
                filters.push("tool_name = ?");
                args.push(toolName);
              }
              const where = filters.length > 0 ? ` WHERE ${filters.join(" AND ")}` : "";
              return db
                .query(`SELECT id, session_id AS sessionId, seq, tool_name AS toolName, status, input_text AS inputText, output_text AS outputText, started_at AS startedAt, completed_at AS completedAt, project_key AS projectKey, provider FROM tool_calls${where} ORDER BY session_id ASC, seq ASC LIMIT ? OFFSET ?`)
                .all(...args, limit, offset) as ToolCallRow[];
            }),
          getToolCall: (id) =>
            trySqlite("getToolCall", () =>
              db
                .query("SELECT id, session_id AS sessionId, seq, tool_name AS toolName, status, input_text AS inputText, output_text AS outputText, started_at AS startedAt, completed_at AS completedAt, project_key AS projectKey, provider FROM tool_calls WHERE id = ?")
                .get(id) as ToolCallRow | undefined,
            ),
          recordIngestRun: (run) =>
            trySqlite("recordIngestRun", () =>
              upsertIngestRun.run({
                $runId: run.runId,
                $provider: run.provider,
                $status: run.status,
                $startedAt: run.startedAt,
                $completedAt: run.completedAt ?? null,
                $sessionsSeen: run.sessionsSeen,
                $sessionsWritten: run.sessionsWritten,
                $sessionsSkipped: run.sessionsSkipped,
                $sessionsFailed: run.sessionsFailed,
              }),
            ),
          getIngestRun: (runId) =>
            trySqlite("getIngestRun", () =>
              db
                .query("SELECT run_id AS runId, provider, status, started_at AS startedAt, completed_at AS completedAt, sessions_seen AS sessionsSeen, sessions_written AS sessionsWritten, sessions_skipped AS sessionsSkipped, sessions_failed AS sessionsFailed FROM ingest_runs WHERE run_id = ?")
                .get(runId) as IngestRunRow | undefined,
            ),
          listIngestRuns: (options = {}) =>
            trySqlite("listIngestRuns", () => {
              const limit = options.limit ?? 100;
              const offset = options.offset ?? 0;
              if (options.status !== undefined) {
                return db
                  .query("SELECT run_id AS runId, provider, status, started_at AS startedAt, completed_at AS completedAt, sessions_seen AS sessionsSeen, sessions_written AS sessionsWritten, sessions_skipped AS sessionsSkipped, sessions_failed AS sessionsFailed FROM ingest_runs WHERE status = ? ORDER BY started_at DESC LIMIT ? OFFSET ?")
                  .all(options.status, limit, offset) as IngestRunRow[];
              }
              return db
                .query("SELECT run_id AS runId, provider, status, started_at AS startedAt, completed_at AS completedAt, sessions_seen AS sessionsSeen, sessions_written AS sessionsWritten, sessions_skipped AS sessionsSkipped, sessions_failed AS sessionsFailed FROM ingest_runs ORDER BY started_at DESC LIMIT ? OFFSET ?")
                .all(limit, offset) as IngestRunRow[];
            }),
          stats: trySqlite("stats", () => ({
            projects: count(db, "projects"),
            sessions: count(db, "sessions"),
            messages: count(db, "messages"),
            toolCalls: count(db, "tool_calls"),
            ingestRuns: count(db, "ingest_runs"),
          })),
          upsertMessageVectors: (rows) =>
            trySqlite("upsertMessageVectors", () => {
              const acceptedRows = replaceMessageVectors(rows);
              notifyMessageVectorWrite(acceptedRows);
              return acceptedRows.length;
            }),
          listMessagesMissingVector: ({ model, limit }) =>
            trySqlite("listMessagesMissingVector", () =>
              db
                .query(
                  `SELECT
                    m.session_id AS sessionId,
                    m.seq,
                    m.role,
                    m.text,
                    m.ts,
                    m.project_key AS projectKey,
                    m.content_hash AS contentHash
                  FROM messages AS m
                  WHERE m.role IN ('user', 'assistant', 'reasoning')
                    AND NOT EXISTS (
                      SELECT 1
                      FROM message_vectors AS v
                      WHERE v.model = ?
                        AND v.session_id = m.session_id
                        AND v.seq = m.seq
                        AND v.role = m.role
                        AND v.content_hash = m.content_hash
                    )
                  ORDER BY m.session_id ASC, m.seq ASC
                  LIMIT ?`,
                )
                .all(model, positiveInt(limit, 1_000)) as MessageRow[],
            ),
          listMessageVectorsBySession: ({ sessionId, model, limit }) =>
            trySqlite("listMessageVectorsBySession", () => {
              const filters = ["session_id = ?"];
              const args: Array<string | number> = [sessionId];
              if (model !== undefined) {
                filters.push("model = ?");
                args.push(model);
              }
              const rows = db
                .query(
                  `SELECT
                    model,
                    modality,
                    session_id AS sessionId,
                    seq,
                    role,
                    project_key AS projectKey,
                    provider,
                    content_hash AS contentHash,
                    document_hash AS documentHash,
                    dimensions,
                    encoding,
                    vector_blob AS vectorBlob,
                    created_at AS createdAt,
                    updated_at AS updatedAt
                  FROM message_vectors
                  WHERE ${filters.join(" AND ")}
                  ORDER BY model ASC, seq ASC
                  LIMIT ?`,
                )
                .all(...args, positiveInt(limit, 100)) as Array<{
                  model: string;
                  modality: "text";
                  sessionId: string;
                  seq: number;
                  role: string;
                  projectKey: string;
                  provider: string;
                  contentHash: string;
                  documentHash: string;
                  dimensions: number;
                  encoding: typeof VECTOR_BLOB_ENCODING;
                  vectorBlob: Uint8Array;
                  createdAt: string;
                  updatedAt: string;
                }>;
              return rows.map((row) => {
                if (row.encoding !== VECTOR_BLOB_ENCODING) {
                  throw new Error(`unsupported message vector encoding: ${row.encoding}`);
                }
                return {
                  model: row.model,
                  modality: row.modality,
                  sessionId: row.sessionId,
                  seq: row.seq,
                  role: row.role,
                  projectKey: row.projectKey,
                  provider: row.provider,
                  contentHash: row.contentHash,
                  documentHash: row.documentHash,
                  dimensions: row.dimensions,
                  encoding: row.encoding,
                  vector: decodeFloat16Vector(row.vectorBlob, row.dimensions),
                  createdAt: row.createdAt,
                  updatedAt: row.updatedAt,
                };
              });
            }),
          listMessageVectorsForSearch: ({ model, limit, offset }) =>
            trySqlite("listMessageVectorsForSearch", () => {
              const rows = db
                .query(
                  `SELECT
                    v.model,
                    v.modality,
                    v.session_id AS sessionId,
                    v.seq,
                    v.role,
                    v.project_key AS projectKey,
                    v.provider,
                    v.content_hash AS contentHash,
                    v.document_hash AS documentHash,
                    v.dimensions,
                    v.encoding,
                    v.vector_blob AS vectorBlob,
                    v.created_at AS createdAt,
                    v.updated_at AS updatedAt,
                    m.text
                  FROM message_vectors AS v
                  INNER JOIN messages AS m
                    ON m.session_id = v.session_id
                   AND m.seq = v.seq
                   AND m.role = v.role
                   AND m.content_hash = v.content_hash
                  WHERE v.model = ?
                    AND v.document_hash IS NOT NULL
                    AND m.role IN ('user', 'assistant', 'reasoning')
                  ORDER BY v.session_id ASC, v.seq ASC, v.role ASC
                  LIMIT ? OFFSET ?`,
                )
                .all(model, positiveInt(limit, 1_000), Math.max(0, offset ?? 0)) as Array<{
                  model: string;
                  modality: "text";
                  sessionId: string;
                  seq: number;
                  role: string;
                  projectKey: string;
                  provider: string;
                  contentHash: string;
                  documentHash: string;
                  dimensions: number;
                  encoding: typeof VECTOR_BLOB_ENCODING;
                  vectorBlob: Uint8Array;
                  createdAt: string;
                  updatedAt: string;
                  text: string;
                }>;
              return rows.map((row) => {
                if (row.encoding !== VECTOR_BLOB_ENCODING) {
                  throw new Error(`unsupported message vector encoding: ${row.encoding}`);
                }
                return {
                  model: row.model,
                  modality: row.modality,
                  sessionId: row.sessionId,
                  seq: row.seq,
                  role: row.role,
                  projectKey: row.projectKey,
                  provider: row.provider,
                  contentHash: row.contentHash,
                  documentHash: row.documentHash,
                  dimensions: row.dimensions,
                  encoding: row.encoding,
                  vector: decodeFloat16Vector(row.vectorBlob, row.dimensions),
                  createdAt: row.createdAt,
                  updatedAt: row.updatedAt,
                  text: row.text,
                };
              });
            }),
          messageVectorCoverage: (model) =>
            trySqlite("messageVectorCoverage", () => {
              const searchable = db.query(
                "SELECT COUNT(*) AS count FROM messages WHERE role IN ('user', 'assistant', 'reasoning')",
              ).get() as { count: number };
              const matching = db.query(
                `SELECT COUNT(*) AS count
                 FROM messages AS m
                 INNER JOIN message_vectors AS v
                   ON v.model = ?
                  AND v.session_id = m.session_id
                  AND v.seq = m.seq
                  AND v.role = m.role
                  AND v.content_hash = m.content_hash
                  AND v.document_hash IS NOT NULL
                 WHERE m.role IN ('user', 'assistant', 'reasoning')`,
              ).get(model) as { count: number };
              const stale = db.query(
                `SELECT COUNT(*) AS count
                 FROM message_vectors AS v
                 LEFT JOIN messages AS m
                   ON m.session_id = v.session_id
                  AND m.seq = v.seq
                 WHERE v.model = ?
                   AND (
                     m.session_id IS NULL
                     OR m.role != v.role
                     OR m.content_hash != v.content_hash
                   )`,
              ).get(model) as { count: number };
              return {
                model,
                searchableMessages: searchable.count,
                vectorRows: matching.count,
                vectorlessMessages: Math.max(0, searchable.count - matching.count),
                staleVectorRows: stale.count,
              };
            }),
          countMessageVectors: (model) =>
            trySqlite("countMessageVectors", () =>
              (countMessageVectorsForModel.get(model) as { count: number }).count,
            ),
          listMessageVectorBlobsByRowidPage: ({ model, afterRowid, limit }) =>
            trySqlite("listMessageVectorBlobsByRowidPage", () => {
              // NOT INDEXED + rowid keyset: blob pages come off the table
              // b-tree in insertion order (sequential IO). Walking blobs
              // through the (model, session_id, seq) index instead degrades
              // into random table-page reads at corpus scale once the file
              // outgrows the page cache.
              const pageLimit = positiveInt(limit, 8_192);
              return db
                .query(
                  `SELECT rowid, session_id AS sessionId, seq, role, project_key AS projectKey, provider, dimensions, encoding, vector_blob AS vectorBlob
                   FROM message_vectors NOT INDEXED
                   WHERE model = ? AND rowid > ?
                   ORDER BY rowid ASC
                   LIMIT ?`,
                )
                .all(model, afterRowid, pageLimit) as MessageVectorBlobRow[];
            }),
          listMessageVectorKeys: ({ model }) =>
            trySqlite("listMessageVectorKeys", () =>
              db
                .query(
                  `SELECT session_id AS sessionId, seq FROM message_vectors
                   WHERE model = ?
                   ORDER BY session_id ASC, seq ASC`,
                )
                .all(model) as MessageVectorKey[],
            ),
          getMessagesBySessionSeq: (pairs) =>
            trySqlite("getMessagesBySessionSeq", () => {
              const selectMessage = db.prepare(
                "SELECT session_id AS sessionId, seq, role, text, ts, project_key AS projectKey, content_hash AS contentHash FROM messages WHERE session_id = ? AND seq = ?",
              );
              const rows: MessageRow[] = [];
              for (const pair of pairs) {
                const row = selectMessage.get(pair.sessionId, pair.seq) as MessageRow | null;
                if (row !== null) rows.push(row);
              }
              return rows;
            }),
          registerMessageVectorWriteListener: (listener) => {
            messageVectorWriteListener = listener;
          },
          lexicalSearch: ({ query, projectKey, role, providers, limit }) =>
            trySqlite("lexicalSearch", () => {
              // The single-provider case narrows the MATCH itself via the
              // provider scope token (real FTS-index narrowing); a multi-provider
              // allow-list can't be expressed as one AND-ed token, so it falls
              // through to the provider IN (...) backstop below instead.
              const scopedProvider = providers !== undefined && providers.length === 1 ? providers[0] : undefined;
              const ftsQuery = composeScopedFtsQuery({ query, projectKey, role, provider: scopedProvider });
              if (ftsQuery === undefined) return [];
              // Redundant backstop predicates: the scope tokens above narrow the
              // FTS candidate set, but these exact-match column predicates against
              // the messages TRUTH TABLE remain the authoritative filter.
              const filters = ["messages_fts MATCH ?"];
              const args: Array<string | number> = [ftsQuery];
              if (projectKey !== undefined) {
                filters.push("m.project_key = ?");
                args.push(projectKey);
              }
              if (role !== undefined) {
                filters.push("m.role = ?");
                args.push(role);
              }
              if (providers !== undefined && providers.length > 0) {
                filters.push(`messages_fts.provider IN (${providers.map(() => "?").join(", ")})`);
                args.push(...providers);
              }
              const rows = db
                .query(
                  `SELECT
                    messages_fts.key AS key,
                    bm25(messages_fts) AS rank,
                    m.session_id AS sessionId,
                    m.seq AS seq,
                    m.role AS role,
                    m.project_key AS projectKey,
                    messages_fts.provider AS provider,
                    m.text AS text,
                    m.content_hash AS contentHash
                  FROM messages_fts
                  JOIN messages AS m
                    ON m.session_id = messages_fts.session_id
                   AND m.seq = messages_fts.seq
                   AND m.role = messages_fts.role
                  WHERE ${filters.join(" AND ")}
                  ORDER BY rank ASC, messages_fts.key ASC
                  LIMIT ?`,
                )
                .all(...args, positiveInt(limit, 10)) as Array<{
                  key: string;
                  rank: number;
                  sessionId: string;
                  seq: number;
                  role: string;
                  projectKey: string;
                  provider: string;
                  text: string;
                  contentHash: string;
                }>;
              return rows.map((row, index) => ({
                key: row.key,
                score: lexicalRankScore(index),
                row: {
                  key: row.key,
                  sessionId: row.sessionId,
                  seq: row.seq,
                  role: row.role,
                  projectKey: row.projectKey,
                  provider: row.provider,
                  text: row.text,
                  contentHash: row.contentHash,
                },
              }));
            }),
          close: Effect.sync(() => db.close()),
        } satisfies LocalStoreService;
      }),
    ),
  );
