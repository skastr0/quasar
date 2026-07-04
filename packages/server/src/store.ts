import { Database } from "bun:sqlite";
import { performance } from "node:perf_hooks";
import { Context, Effect, Layer, Schema } from "effect";

import type { DivergenceAggregate, DivergenceRow, IngestRunRow, MappedSession, MessageRow, ProjectRow, SessionRow, SessionVersion, ToolCallRow } from "./model";
import type { IndexProof } from "./verify";
import { messageSearchKey, type SearchHit } from "./lancedb";
import { isSearchableRole, normalizeIndexedContentHash } from "./searchPolicy";
import { ensureParentDir, sqlitePath } from "./paths";
import { fts5QueryForText, ftsProjectScopeToken, positiveInt } from "./fts5";
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

export interface LocalStoreService {
  readonly dbPath: string;
  readonly listProjects: (options?: { readonly limit?: number; readonly offset?: number }) => Effect.Effect<readonly ProjectRow[], SqliteStoreError>;
  readonly upsertSession: (session: MappedSession) => Effect.Effect<void, SqliteStoreError>;
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
  /** Mark a session as having a stale search index. Called in the same transaction as upsertSession. */
  readonly markSessionIndexStale: (sessionId: string) => Effect.Effect<void, SqliteStoreError>;
  /** Stamp a session's index watermark — ONLY with a witnessed IndexProof. There is
   * no (sessionId, isoString) form: you cannot assert "indexed" without a read-back. */
  readonly markSessionIndexed: (proof: IndexProof) => Effect.Effect<void, SqliteStoreError>;
  /** The searchable (key -> normalized contentHash) pairs SQLite expects in the index,
   * built from the same searchable predicate and key function the writer uses. */
  readonly intendedPairs: (sessionId: string) => Effect.Effect<ReadonlyMap<string, string>, SqliteStoreError>;
  /** Cheap (updated_at, message_count) snapshot to guard verifyIndexed against TOCTOU. */
  readonly sessionVersion: (sessionId: string) => Effect.Effect<SessionVersion, SqliteStoreError>;
  /** Record/replace a session's divergence in the divergence-only ledger. */
  readonly putDivergence: (divergence: DivergenceRow) => Effect.Effect<void, SqliteStoreError>;
  /** Clear a session's divergence row once it converges. */
  readonly clearDivergence: (sessionId: string) => Effect.Effect<void, SqliteStoreError>;
  /** O(divergent) roll-up that feeds the readiness gate without scanning the corpus. */
  readonly divergenceAggregate: Effect.Effect<DivergenceAggregate, SqliteStoreError>;
  /** Divergent sessions for the healer, worst-first. */
  readonly divergentSessions: (limit: number) => Effect.Effect<readonly DivergenceRow[], SqliteStoreError>;
  /** Count sessions whose indexed_at is NULL or predates updated_at (diagnostics only, NOT the gate). */
  readonly countStaleIndexSessions: () => Effect.Effect<number, SqliteStoreError>;
  /** Count searchable messages that lack a real vector (contentHash LIKE 'unembedded:%'). */
  readonly countUnembeddedMessages: () => Effect.Effect<number, SqliteStoreError>;
  /** Count searchable messages total. */
  readonly countSearchableMessages: () => Effect.Effect<number, SqliteStoreError>;
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
    CREATE TABLE IF NOT EXISTS index_divergence (
      session_id TEXT PRIMARY KEY,
      expected INTEGER NOT NULL,
      present INTEGER NOT NULL,
      missing_count INTEGER NOT NULL,
      stale_count INTEGER NOT NULL,
      extra_count INTEGER NOT NULL,
      missing_keys TEXT NOT NULL,
      stale_keys TEXT NOT NULL,
      extra_keys TEXT NOT NULL,
      updated_at TEXT NOT NULL
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
  // Idempotent column add for search index watermark (QSR-223). NULL means
  // not-yet-indexed. Set to the ISO timestamp when indexSession last completed.
  // Set to NULL in the same transaction as upsertSession to mark stale immediately.
  if (!sessionColumns.has("indexed_at")) {
    db.exec("ALTER TABLE sessions ADD COLUMN indexed_at TEXT");
    db.exec("CREATE INDEX IF NOT EXISTS sessions_stale_index ON sessions(indexed_at, updated_at)");
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
          let accepted = 0;
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
            accepted += result.changes > 0 ? 1 : 0;
          }
          return accepted;
        });
        const replaceSession = db.transaction((mapped: MappedSession) => {
          upsertProject.run({
            $projectKey: mapped.project.projectKey,
            $displayName: mapped.project.displayName,
            $rawPath: mapped.project.rawPath ?? null,
          });
          db.prepare("DELETE FROM messages WHERE session_id = ?").run(mapped.session.sessionId);
          db.prepare("DELETE FROM tool_calls WHERE session_id = ?").run(mapped.session.sessionId);
          upsertSession.run({
            $sessionId: mapped.session.sessionId,
            $projectKey: mapped.session.projectKey,
            $provider: mapped.session.provider,
            $agentName: mapped.session.agentName,
            $title: mapped.session.title ?? null,
            $startedAt: mapped.session.startedAt ?? null,
            $updatedAt: mapped.session.updatedAt ?? null,
            $sourcePath: mapped.session.sourcePath,
            $sourceFingerprint: mapped.session.sourceFingerprint,
            $host: mapped.session.host,
            $identitySchemeVersion: mapped.session.identitySchemeVersion,
            $parentSessionId: mapped.session.parentSessionId ?? null,
            $messageCount: mapped.session.messageCount,
            $toolCallCount: mapped.session.toolCallCount,
          });
          // Mark search index stale in the same transaction so search sees stale immediately.
          db.prepare("UPDATE sessions SET indexed_at = NULL WHERE session_id = ?").run(mapped.session.sessionId);
          for (const message of mapped.messages) {
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
          for (const toolCall of mapped.toolCalls) {
            insertToolCall.run({
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
          upsertSession: (session) => trySqlite("upsertSession", () => replaceSession(session)),
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
          markSessionIndexStale: (sessionId) =>
            trySqlite("markSessionIndexStale", () => {
              db.prepare("UPDATE sessions SET indexed_at = NULL WHERE session_id = ?").run(sessionId);
            }),
          markSessionIndexed: (proof) =>
            trySqlite("markSessionIndexed", () => {
              db.prepare("UPDATE sessions SET indexed_at = ? WHERE session_id = ?").run(proof.at, proof.sessionId);
            }),
          intendedPairs: (sessionId) =>
            trySqlite("intendedPairs", () => {
              const rows = db
                .query("SELECT seq, role, content_hash AS contentHash FROM messages WHERE session_id = ? ORDER BY seq ASC")
                .all(sessionId) as { seq: number; role: string; contentHash: string }[];
              const pairs = new Map<string, string>();
              for (const row of rows) {
                const role = row.role;
                if (!isSearchableRole(role)) continue;
                const digest = normalizeIndexedContentHash(row.contentHash);
                if (digest === undefined) continue;
                pairs.set(messageSearchKey({ sessionId, seq: row.seq, role }), digest);
              }
              return pairs;
            }),
          sessionVersion: (sessionId) =>
            trySqlite("sessionVersion", () => {
              const row = db
                .query("SELECT updated_at AS updatedAt, message_count AS messageCount FROM sessions WHERE session_id = ?")
                .get(sessionId) as { updatedAt: string | null; messageCount: number } | null;
              return { updatedAt: row?.updatedAt ?? null, messageCount: row?.messageCount ?? 0 };
            }),
          putDivergence: (divergence) =>
            trySqlite("putDivergence", () => {
              db.prepare(
                `INSERT INTO index_divergence(session_id, expected, present, missing_count, stale_count, extra_count, missing_keys, stale_keys, extra_keys, updated_at)
                 VALUES ($sessionId, $expected, $present, $missing, $stale, $extra, $missingKeys, $staleKeys, $extraKeys, $updatedAt)
                 ON CONFLICT(session_id) DO UPDATE SET expected = excluded.expected, present = excluded.present, missing_count = excluded.missing_count, stale_count = excluded.stale_count, extra_count = excluded.extra_count, missing_keys = excluded.missing_keys, stale_keys = excluded.stale_keys, extra_keys = excluded.extra_keys, updated_at = excluded.updated_at`,
              ).run({
                $sessionId: divergence.sessionId,
                $expected: divergence.expected,
                $present: divergence.present,
                $missing: divergence.missingKeys.length,
                $stale: divergence.staleKeys.length,
                $extra: divergence.extraKeys.length,
                $missingKeys: JSON.stringify(divergence.missingKeys),
                $staleKeys: JSON.stringify(divergence.staleKeys),
                $extraKeys: JSON.stringify(divergence.extraKeys),
                $updatedAt: new Date().toISOString(),
              });
            }),
          clearDivergence: (sessionId) =>
            trySqlite("clearDivergence", () => {
              db.prepare("DELETE FROM index_divergence WHERE session_id = ?").run(sessionId);
            }),
          divergenceAggregate: trySqlite("divergenceAggregate", () => {
            const row = db
              .query("SELECT COUNT(*) AS sessions, COALESCE(SUM(missing_count), 0) AS missing, COALESCE(SUM(stale_count), 0) AS stale, COALESCE(SUM(extra_count), 0) AS extra FROM index_divergence")
              .get() as { sessions: number; missing: number; stale: number; extra: number };
            return { sessions: row.sessions, missing: row.missing, stale: row.stale, extra: row.extra };
          }),
          divergentSessions: (limit) =>
            trySqlite("divergentSessions", () => {
              const rows = db
                .query("SELECT session_id AS sessionId, expected, present, missing_keys AS missingKeys, stale_keys AS staleKeys, extra_keys AS extraKeys FROM index_divergence ORDER BY (missing_count + stale_count + extra_count) DESC LIMIT ?")
                .all(limit) as { sessionId: string; expected: number; present: number; missingKeys: string; staleKeys: string; extraKeys: string }[];
              return rows.map((row) => ({
                sessionId: row.sessionId,
                expected: row.expected,
                present: row.present,
                missingKeys: JSON.parse(row.missingKeys) as string[],
                staleKeys: JSON.parse(row.staleKeys) as string[],
                extraKeys: JSON.parse(row.extraKeys) as string[],
              }));
            }),
          countStaleIndexSessions: () =>
            trySqlite("countStaleIndexSessions", () => {
              // A session is stale if indexed_at is NULL or indexed_at < updated_at (ignoring sessions with no updated_at).
              const row = db.query(
                "SELECT COUNT(*) AS count FROM sessions WHERE indexed_at IS NULL OR (updated_at IS NOT NULL AND indexed_at < updated_at)",
              ).get() as { count: number };
              return row.count;
            }),
          countUnembeddedMessages: () =>
            trySqlite("countUnembeddedMessages", () => {
              // Messages that need embedding have roles in the searchable set; count approximated
              // via SQLite: role IN ('user','assistant','reasoning') so we count only indexable messages
              // with placeholder contentHash values (the full unembedded check happens in LanceDB).
              // We count ALL messages here since the contentHash prefix is set for searchable-role messages.
              const row = db.query(
                "SELECT COUNT(*) AS count FROM messages WHERE role IN ('user', 'assistant', 'reasoning') AND content_hash LIKE 'unembedded:%'",
              ).get() as { count: number };
              return row.count;
            }),
          countSearchableMessages: () =>
            trySqlite("countSearchableMessages", () => {
              const row = db.query(
                "SELECT COUNT(*) AS count FROM messages WHERE role IN ('user', 'assistant', 'reasoning')",
              ).get() as { count: number };
              return row.count;
            }),
          upsertMessageVectors: (rows) =>
            trySqlite("upsertMessageVectors", () => replaceMessageVectors(rows)),
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
          lexicalSearch: ({ query, projectKey, role, providers, limit }) =>
            trySqlite("lexicalSearch", () => {
              const ftsQuery = fts5QueryForText(query);
              if (ftsQuery === undefined) return [];
              const filters = ["messages_fts MATCH ?"];
              const args: Array<string | number> = [ftsQuery];
              if (projectKey !== undefined) {
                filters.push("project_key = ?");
                args.push(projectKey);
              }
              if (role !== undefined) {
                filters.push("role = ?");
                args.push(role);
              }
              if (providers !== undefined && providers.length > 0) {
                filters.push(`provider IN (${providers.map(() => "?").join(", ")})`);
                args.push(...providers);
              }
              const rows = db
                .query(
                  `SELECT
                    key,
                    bm25(messages_fts) AS rank,
                    session_id AS sessionId,
                    seq,
                    role,
                    project_key AS projectKey,
                    provider,
                    text,
                    content_hash AS contentHash
                  FROM messages_fts
                  WHERE ${filters.join(" AND ")}
                  ORDER BY rank ASC, key ASC
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
