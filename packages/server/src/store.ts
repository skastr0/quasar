import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import { Cause, Context, Effect, Layer, Schema } from "effect";

import type {
  ArtifactRow,
  ExecutionContextRow,
  IngestRunRow,
  MappedSession,
  MessageRow,
  Page,
  PageWindow,
  ProjectRow,
  QueryMessageRow,
  QuerySessionRow,
  QueryToolCallRow,
  SessionDetail,
  SessionDetailPageOptions,
  SessionEdgeRow,
  SessionEventRow,
  SessionRow,
  ToolCallRow,
  UsageRecordRow,
} from "./model";
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

export interface MessageVectorDelete extends MessageVectorKey {
  readonly model: string;
}

/** Fired after every successful vector mutation. Upserts carry the rows
 * SQLite accepted plus exact per-model counts. Deletes carry the model/key
 * rows observed immediately before the messages trigger removed them, so a
 * resident matrix can invalidate without rescanning SQLite or rebooting. */
export interface MessageVectorMutationEvent {
  readonly upserts: readonly MessageVectorUpsert[];
  readonly deletes: readonly MessageVectorDelete[];
  readonly sqliteRowsByModel: Readonly<Record<string, number>>;
}

export interface SearchHit {
  readonly key: string;
  readonly score: number;
  readonly row: Record<string, unknown>;
}

/** Row-level result of a staged session apply. `changedMessages` carries
 * exactly the inserted+updated message rows so downstream embedding jobs fan
 * out over the delta. `requiresDownstreamReplay` is true after an interrupted
 * prior apply: callers must then replay every desired downstream job because
 * some already-written rows may never have reached the durable queue. */
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
  readonly requiresDownstreamReplay: boolean;
  /** Message keys whose prior resident-vector slots may now be stale. The
   * store's SQL triggers delete their vector rows; the matrix consumer uses
   * this explicit structural receipt to invalidate the corresponding slots. */
  readonly invalidatedVectorKeys: readonly MessageVectorKey[];
}

export interface LocalStoreService {
  readonly dbPath: string;
  readonly listProjects: (options?: { readonly limit?: number; readonly offset?: number }) => Effect.Effect<readonly ProjectRow[], SqliteStoreError>;
  /** Stage the desired session rows under an `applying:` fingerprint. The
   * fingerprint remains intentionally stale until `finalizeSessionIngest`
   * proves that downstream work is durable. */
  readonly upsertSession: (session: MappedSession) => Effect.Effect<SessionDiffOutcome, SqliteStoreError>;
  readonly finalizeSessionIngest: (
    sessionId: string,
    sourceFingerprint: string,
    normalizationVersion: number,
  ) => Effect.Effect<void, SqliteStoreError>;
  readonly hasSessionFingerprint: (
    sessionId: string,
    sourceFingerprint: string,
    normalizationVersion: number,
  ) => Effect.Effect<boolean, SqliteStoreError>;
  readonly listSessions: (options?: {
    readonly provider?: string;
    readonly projectKey?: string;
    readonly model?: string;
    readonly modelProvider?: string;
    readonly assignmentRole?: string;
    readonly limit?: number;
    readonly offset?: number;
  }) => Effect.Effect<readonly SessionRow[], SqliteStoreError>;
  readonly querySessions: (options: {
    readonly projectKey?: string;
    readonly providers?: readonly string[];
    readonly sessionId?: string;
    readonly agentName?: string;
    readonly agentRole?: string;
    readonly model?: string;
    readonly modelProvider?: string;
    readonly limit: number;
    readonly offset: number;
  }) => Effect.Effect<readonly QuerySessionRow[], SqliteStoreError>;
  readonly querySessionIds: (options: {
    readonly projectKey?: string;
    readonly providers?: readonly string[];
    readonly sessionId?: string;
    readonly agentName?: string;
    readonly agentRole?: string;
    readonly model?: string;
    readonly modelProvider?: string;
  }) => Effect.Effect<readonly string[], SqliteStoreError>;
  readonly queryMessages: (options: {
    readonly sessionId: string;
    readonly role?: string;
    readonly model?: string;
    readonly modelProvider?: string;
    readonly limit: number;
    readonly offset: number;
  }) => Effect.Effect<readonly QueryMessageRow[], SqliteStoreError>;
  readonly queryToolCalls: (options: {
    readonly projectKey?: string;
    readonly providers?: readonly string[];
    readonly sessionId?: string;
    readonly toolCallId?: string;
    readonly toolName?: string;
    readonly agentName?: string;
    readonly agentRole?: string;
    readonly model?: string;
    readonly modelProvider?: string;
    readonly includeInput: boolean;
    readonly includeOutput: boolean;
    readonly limit: number;
    readonly offset: number;
  }) => Effect.Effect<readonly QueryToolCallRow[], SqliteStoreError>;
  readonly queryMessagesBySessionSeq: (options: {
    readonly pairs: readonly MessageVectorKey[];
    readonly sessionId?: string;
    readonly agentName?: string;
    readonly agentRole?: string;
    readonly model?: string;
    readonly modelProvider?: string;
  }) => Effect.Effect<readonly QueryMessageRow[], SqliteStoreError>;
  readonly readSessionDetail: (
    sessionId: string,
    pages: SessionDetailPageOptions,
  ) => Effect.Effect<SessionDetail | undefined, SqliteStoreError>;
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
  /** Register THE (single, canonical) vector-mutation listener. Listener
   * failures are contained: they log a named diagnostic and never fail the
   * committed SQLite mutation. */
  readonly registerMessageVectorMutationListener: (
    listener: (event: MessageVectorMutationEvent) => Effect.Effect<void>,
  ) => void;
  readonly lexicalSearch: (request: {
    readonly query: string;
    readonly projectKey?: string;
    readonly role?: string;
    readonly providers?: readonly string[];
    readonly sessionId?: string;
    readonly agentName?: string;
    readonly agentRole?: string;
    readonly model?: string;
    readonly modelProvider?: string;
    readonly limit?: number;
    readonly offset?: number;
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
// PRAGMA user_version and migrated exactly once per schema version — see
// migrateMessagesFtsScopedTokens below — rather than re-created on every
// boot like the rest of migrate()'s idempotent DDL.
const FTS_SCHEMA_VERSION = 2;

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
  CREATE TABLE messages_fts_keys (
    fts_rowid INTEGER PRIMARY KEY,
    session_id TEXT NOT NULL,
    seq INTEGER NOT NULL,
    UNIQUE(session_id, seq)
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
  BEGIN
    INSERT INTO messages_fts_keys(session_id, seq)
    VALUES (NEW.session_id, NEW.seq);
    INSERT INTO messages_fts(rowid, text, key, session_id, seq, role, project_key, provider, content_hash)
    SELECT
      k.fts_rowid,
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
    FROM messages_fts_keys AS k
    WHERE k.session_id = NEW.session_id
      AND k.seq = NEW.seq
      AND NEW.role IN ('user', 'assistant', 'reasoning');
  END;
  CREATE TRIGGER messages_fts_ad
  AFTER DELETE ON messages
  BEGIN
    DELETE FROM messages_fts
    WHERE rowid = (
      SELECT fts_rowid
      FROM messages_fts_keys
      WHERE session_id = OLD.session_id AND seq = OLD.seq
    );
    DELETE FROM messages_fts_keys
    WHERE session_id = OLD.session_id AND seq = OLD.seq;
  END;
  CREATE TRIGGER messages_fts_au
  AFTER UPDATE ON messages
  BEGIN
    DELETE FROM messages_fts
    WHERE rowid = (
      SELECT fts_rowid
      FROM messages_fts_keys
      WHERE session_id = OLD.session_id AND seq = OLD.seq
    );
    UPDATE messages_fts_keys
    SET session_id = NEW.session_id, seq = NEW.seq
    WHERE session_id = OLD.session_id AND seq = OLD.seq;
    INSERT INTO messages_fts(rowid, text, key, session_id, seq, role, project_key, provider, content_hash)
    SELECT
      k.fts_rowid,
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
    FROM messages_fts_keys AS k
    WHERE k.session_id = NEW.session_id
      AND k.seq = NEW.seq
      AND NEW.role IN ('user', 'assistant', 'reasoning');
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
    INSERT INTO messages_fts(rowid, text, key, session_id, seq, role, project_key, provider, content_hash)
    SELECT
      k.fts_rowid,
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
    INNER JOIN messages_fts_keys AS k
      ON k.session_id = m.session_id AND k.seq = m.seq
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

const rebuildMessagesFtsKeys = (db: Database): void => {
  db.exec(`
    INSERT INTO messages_fts_keys(fts_rowid, session_id, seq)
    SELECT rowid, session_id, seq
    FROM messages
    ORDER BY rowid ASC
  `);
};

// PRAGMA user_version-gated migration to scoped-token FTS with canonical
// persistent rowid identity. Version 2 rebuilds version-1 stores once and
// records every message's FTS rowid in messages_fts_keys. Mutations address
// the virtual table by that INTEGER PRIMARY KEY instead of scanning every
// UNINDEXED key. Unlike SQLite's hidden messages.rowid, the explicit key
// survives VACUUM/VACUUM INTO unchanged. The NULL-guarded backfill and full
// DROP+rebuild make an interrupted run safe to retry, and user_version
// advances only after every step completes. Boot blocks until done.
interface StoreMigrationLog {
  readonly event: string;
  readonly at: string;
  readonly backfilledRows: number;
  readonly rebuiltRows: number;
  readonly elapsedMs: number;
}

const migrateMessagesFtsScopedTokens = (db: Database): StoreMigrationLog | undefined => {
  const { user_version: userVersion } = db.query("PRAGMA user_version").get() as { user_version: number };
  if (userVersion >= FTS_SCHEMA_VERSION) return undefined;

  const startedAt = performance.now();
  // Negative means "derived FTS rebuild in progress". Both this binary and
  // the previous v1 binary treat it as stale and rebuild from messages, so a
  // crash never makes either version accept a partial virtual index.
  db.exec(`PRAGMA user_version = -${FTS_SCHEMA_VERSION}`);

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
    DROP TABLE IF EXISTS messages_fts_keys;
  `);
  db.exec(MESSAGES_FTS_CREATE_SQL);
  db.exec(MESSAGES_FTS_TRIGGERS_SQL);
  rebuildMessagesFtsKeys(db);
  const rebuiltRows = rebuildMessagesFtsInChunks(db);

  db.exec(`PRAGMA user_version = ${FTS_SCHEMA_VERSION}`);

  return {
    event: "store.migrate.fts_scoped_tokens",
    at: new Date().toISOString(),
    backfilledRows,
    rebuiltRows,
    elapsedMs: Math.round((performance.now() - startedAt) * 100) / 100,
  };
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

const migrate = (db: Database): readonly StoreMigrationLog[] => {
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
      normalization_version INTEGER NOT NULL DEFAULT 0,
      model TEXT,
      model_provider TEXT,
      assignment_nickname TEXT,
      assignment_role TEXT,
      assignment_path TEXT,
      assignment_depth INTEGER,
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
      event_id TEXT,
      seq INTEGER NOT NULL,
      tool_name TEXT NOT NULL,
      status TEXT,
      input_text TEXT NOT NULL,
      output_text TEXT NOT NULL,
      input_hash TEXT NOT NULL,
      output_hash TEXT NOT NULL,
      started_at TEXT,
      completed_at TEXT,
      project_key TEXT NOT NULL,
      provider TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS tool_calls_by_session ON tool_calls(session_id, seq);
    CREATE INDEX IF NOT EXISTS tool_calls_by_project_tool ON tool_calls(project_key, tool_name, session_id, seq);
    CREATE INDEX IF NOT EXISTS tool_calls_by_tool ON tool_calls(tool_name, session_id);
    CREATE INDEX IF NOT EXISTS tool_calls_by_provider_order ON tool_calls(provider, session_id, seq, id);
    CREATE INDEX IF NOT EXISTS tool_calls_by_project_order ON tool_calls(project_key, session_id, seq, id);
    CREATE INDEX IF NOT EXISTS tool_calls_by_tool_order ON tool_calls(tool_name, session_id, seq, id);
    CREATE TABLE IF NOT EXISTS session_events (
      session_id TEXT NOT NULL,
      id TEXT NOT NULL,
      sequence INTEGER NOT NULL,
      fact_hash TEXT NOT NULL,
      event_json TEXT NOT NULL,
      PRIMARY KEY (session_id, id)
    );
    CREATE INDEX IF NOT EXISTS session_events_by_session_sequence ON session_events(session_id, sequence, id);
    CREATE TABLE IF NOT EXISTS usage_records (
      session_id TEXT NOT NULL,
      id TEXT NOT NULL,
      order_index INTEGER NOT NULL,
      timestamp TEXT,
      fact_hash TEXT NOT NULL,
      record_json TEXT NOT NULL,
      PRIMARY KEY (session_id, id)
    );
    CREATE INDEX IF NOT EXISTS usage_records_by_session_order ON usage_records(session_id, order_index, id);
    CREATE TABLE IF NOT EXISTS session_edges (
      session_id TEXT NOT NULL,
      id TEXT NOT NULL,
      order_index INTEGER NOT NULL,
      fact_hash TEXT NOT NULL,
      edge_json TEXT NOT NULL,
      PRIMARY KEY (session_id, id)
    );
    CREATE INDEX IF NOT EXISTS session_edges_by_session_order ON session_edges(session_id, order_index, id);
    CREATE TABLE IF NOT EXISTS session_artifacts (
      session_id TEXT NOT NULL,
      id TEXT NOT NULL,
      order_index INTEGER NOT NULL,
      fact_hash TEXT NOT NULL,
      artifact_json TEXT NOT NULL,
      PRIMARY KEY (session_id, id)
    );
    CREATE INDEX IF NOT EXISTS session_artifacts_by_session_order ON session_artifacts(session_id, order_index, id);
    CREATE TABLE IF NOT EXISTS execution_contexts (
      session_id TEXT NOT NULL,
      id TEXT NOT NULL,
      sequence INTEGER NOT NULL,
      fact_hash TEXT NOT NULL,
      context_json TEXT NOT NULL,
      PRIMARY KEY (session_id, id)
    );
    CREATE INDEX IF NOT EXISTS execution_contexts_by_session_sequence ON execution_contexts(session_id, sequence, id);
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
  if (!sessionColumns.has("normalization_version")) {
    db.exec(
      "ALTER TABLE sessions ADD COLUMN normalization_version INTEGER NOT NULL DEFAULT 0",
    );
  }
  if (!sessionColumns.has("model")) {
    db.exec("ALTER TABLE sessions ADD COLUMN model TEXT");
  }
  if (!sessionColumns.has("model_provider")) {
    db.exec("ALTER TABLE sessions ADD COLUMN model_provider TEXT");
  }
  if (!sessionColumns.has("assignment_nickname")) {
    db.exec("ALTER TABLE sessions ADD COLUMN assignment_nickname TEXT");
  }
  if (!sessionColumns.has("assignment_role")) {
    db.exec("ALTER TABLE sessions ADD COLUMN assignment_role TEXT");
  }
  if (!sessionColumns.has("assignment_path")) {
    db.exec("ALTER TABLE sessions ADD COLUMN assignment_path TEXT");
  }
  if (!sessionColumns.has("assignment_depth")) {
    db.exec("ALTER TABLE sessions ADD COLUMN assignment_depth INTEGER");
  }
  // Idempotent column add for parent-session lineage (QSR-220). Nullable, so
  // existing rows default to NULL (root). Empty-column add, not a data migration.
  if (!sessionColumns.has("parent_session_id")) {
    db.exec("ALTER TABLE sessions ADD COLUMN parent_session_id TEXT");
  }
  const toolCallColumns = new Set(
    (db.query("PRAGMA table_info(tool_calls)").all() as { name: string }[]).map(
      (column) => column.name,
    ),
  );
  if (!toolCallColumns.has("event_id")) {
    db.exec("ALTER TABLE tool_calls ADD COLUMN event_id TEXT");
  }
  const missingToolPayloadHashes = !toolCallColumns.has("input_hash")
    || !toolCallColumns.has("output_hash");
  if (!toolCallColumns.has("input_hash")) {
    db.exec("ALTER TABLE tool_calls ADD COLUMN input_hash TEXT NOT NULL DEFAULT ''");
  }
  if (!toolCallColumns.has("output_hash")) {
    db.exec("ALTER TABLE tool_calls ADD COLUMN output_hash TEXT NOT NULL DEFAULT ''");
  }
  if (missingToolPayloadHashes) {
    // Do not scan the potentially large payload columns during migration.
    // Empty hashes deliberately compare unequal on the next canonical normalization
    // replay. Lowering only sessions that own tool calls makes the fingerprint
    // probe request that one idempotent refresh, after which the normal session
    // head restores the current version and every row carries exact hashes.
    db.exec(`
      UPDATE sessions
      SET normalization_version = 2
      WHERE normalization_version >= 3
        AND session_id IN (SELECT DISTINCT session_id FROM tool_calls)
    `);
  }
  // Source-fact hashes make the full desired-state payload cheap to converge:
  // appends write only new/changed rows, while normalization replays can still
  // delete facts that disappeared. Empty hashes force one safe refresh for a
  // database opened by an earlier build that created these tables first.
  for (const table of [
    "session_events",
    "usage_records",
    "session_edges",
    "session_artifacts",
    "execution_contexts",
  ] as const) {
    const columns = new Set(
      (db.query(`PRAGMA table_info(${table})`).all() as { name: string }[]).map(
        (column) => column.name,
      ),
    );
    if (!columns.has("fact_hash")) {
      db.exec(`ALTER TABLE ${table} ADD COLUMN fact_hash TEXT NOT NULL DEFAULT ''`);
    }
  }
  migrateMessageVectorsTable(db);
  db.exec(MESSAGE_VECTORS_MIGRATION_SQL);
  const ftsMigration = migrateMessagesFtsScopedTokens(db);
  return ftsMigration === undefined ? [] : [ftsMigration];
};

const count = (db: Database, table: string): number =>
  (db.query(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count;

const lexicalRankScore = (index: number): number =>
  1 / (index + 1);

const sha256Text = (text: string): string =>
  createHash("sha256").update(text).digest("hex");

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
        const migrationLogs = migrate(db);
        return { db, migrationLogs };
      }),
      ({ db }) => Effect.sync(() => db.close()),
    ).pipe(
      Effect.tap(({ migrationLogs }) =>
        Effect.forEach(
          migrationLogs,
          (fields) =>
            Effect.logInfo(fields.event).pipe(
              Effect.annotateLogs({ ...fields }),
            ),
          { discard: true },
        ),
      ),
      Effect.map(({ db }) => {
        const upsertProject = db.prepare(
          `INSERT INTO projects(project_key, display_name, raw_path)
           VALUES ($projectKey, $displayName, $rawPath)
           ON CONFLICT(project_key) DO UPDATE SET display_name = excluded.display_name, raw_path = excluded.raw_path`,
        );
        const upsertSession = db.prepare(
          `INSERT INTO sessions(session_id, project_key, provider, agent_name, title, started_at, updated_at, source_path, source_fingerprint, host, identity_scheme_version, normalization_version, model, model_provider, assignment_nickname, assignment_role, assignment_path, assignment_depth, parent_session_id, message_count, tool_call_count)
           VALUES ($sessionId, $projectKey, $provider, $agentName, $title, $startedAt, $updatedAt, $sourcePath, $sourceFingerprint, $host, $identitySchemeVersion, $normalizationVersion, $model, $modelProvider, $assignmentNickname, $assignmentRole, $assignmentPath, $assignmentDepth, $parentSessionId, $messageCount, $toolCallCount)
           ON CONFLICT(session_id) DO UPDATE SET project_key = excluded.project_key, provider = excluded.provider, agent_name = excluded.agent_name, title = excluded.title, started_at = excluded.started_at, updated_at = excluded.updated_at, source_path = excluded.source_path, source_fingerprint = excluded.source_fingerprint, host = excluded.host, identity_scheme_version = excluded.identity_scheme_version, normalization_version = excluded.normalization_version, model = excluded.model, model_provider = excluded.model_provider, assignment_nickname = excluded.assignment_nickname, assignment_role = excluded.assignment_role, assignment_path = excluded.assignment_path, assignment_depth = excluded.assignment_depth, parent_session_id = excluded.parent_session_id, message_count = excluded.message_count, tool_call_count = excluded.tool_call_count`,
        );
        const insertMessage = db.prepare(
          `INSERT INTO messages(session_id, seq, role, text, ts, project_key, content_hash, project_scope_token)
           VALUES ($sessionId, $seq, $role, $text, $ts, $projectKey, $contentHash, $projectScopeToken)`,
        );
        const deleteSessionEvent = db.prepare("DELETE FROM session_events WHERE session_id = ? AND id = ?");
        const upsertSessionEvent = db.prepare(
          `INSERT INTO session_events(session_id, id, sequence, fact_hash, event_json) VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(session_id, id) DO UPDATE SET sequence = excluded.sequence, fact_hash = excluded.fact_hash, event_json = excluded.event_json`,
        );
        const deleteUsageRecord = db.prepare("DELETE FROM usage_records WHERE session_id = ? AND id = ?");
        const upsertUsageRecord = db.prepare(
          `INSERT INTO usage_records(session_id, id, order_index, timestamp, fact_hash, record_json) VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT(session_id, id) DO UPDATE SET order_index = excluded.order_index, timestamp = excluded.timestamp, fact_hash = excluded.fact_hash, record_json = excluded.record_json`,
        );
        const deleteSessionEdge = db.prepare("DELETE FROM session_edges WHERE session_id = ? AND id = ?");
        const upsertSessionEdge = db.prepare(
          `INSERT INTO session_edges(session_id, id, order_index, fact_hash, edge_json) VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(session_id, id) DO UPDATE SET order_index = excluded.order_index, fact_hash = excluded.fact_hash, edge_json = excluded.edge_json`,
        );
        const deleteSessionArtifact = db.prepare("DELETE FROM session_artifacts WHERE session_id = ? AND id = ?");
        const upsertSessionArtifact = db.prepare(
          `INSERT INTO session_artifacts(session_id, id, order_index, fact_hash, artifact_json) VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(session_id, id) DO UPDATE SET order_index = excluded.order_index, fact_hash = excluded.fact_hash, artifact_json = excluded.artifact_json`,
        );
        const deleteExecutionContext = db.prepare("DELETE FROM execution_contexts WHERE session_id = ? AND id = ?");
        const upsertExecutionContext = db.prepare(
          `INSERT INTO execution_contexts(session_id, id, sequence, fact_hash, context_json) VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(session_id, id) DO UPDATE SET sequence = excluded.sequence, fact_hash = excluded.fact_hash, context_json = excluded.context_json`,
        );
        const upsertIngestRun = db.prepare(
          `INSERT INTO ingest_runs(run_id, provider, status, started_at, completed_at, sessions_seen, sessions_written, sessions_skipped, sessions_failed)
           VALUES ($runId, $provider, $status, $startedAt, $completedAt, $sessionsSeen, $sessionsWritten, $sessionsSkipped, $sessionsFailed)
           ON CONFLICT(run_id) DO UPDATE SET provider = excluded.provider, status = excluded.status, started_at = excluded.started_at, completed_at = excluded.completed_at, sessions_seen = excluded.sessions_seen, sessions_written = excluded.sessions_written, sessions_skipped = excluded.sessions_skipped, sessions_failed = excluded.sessions_failed`,
        );
        const selectMessageVectorCreated = db.prepare(
          "SELECT created_at AS createdAt FROM message_vectors WHERE model = ? AND session_id = ? AND seq = ?",
        );
        const selectMessageVectorModels = db.prepare(
          "SELECT model FROM message_vectors WHERE session_id = ? AND seq = ? ORDER BY model ASC",
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
        let messageVectorMutationListener:
          ((event: MessageVectorMutationEvent) => Effect.Effect<void>) | undefined;
        const notifyMessageVectorMutation = (event: {
          readonly upserts?: readonly MessageVectorUpsert[];
          readonly deletes?: readonly MessageVectorDelete[];
        }): Effect.Effect<void> => {
          const upserts = event.upserts ?? [];
          const deletes = event.deletes ?? [];
          if (messageVectorMutationListener === undefined || (upserts.length === 0 && deletes.length === 0)) {
            return Effect.void;
          }
          const sqliteRowsByModel: Record<string, number> = {};
          for (const row of upserts) {
            if (sqliteRowsByModel[row.model] === undefined) {
              sqliteRowsByModel[row.model] = (countMessageVectorsForModel.get(row.model) as { count: number }).count;
            }
          }
          return messageVectorMutationListener({ upserts, deletes, sqliteRowsByModel }).pipe(
            Effect.catchAllCause((cause) =>
              Effect.logError("store.message_vector_mutation_listener_failed").pipe(
                Effect.annotateLogs({
                  event: "store.message_vector_mutation_listener_failed",
                  at: new Date().toISOString(),
                  diagnostic: Cause.pretty(cause, { renderErrorCause: true }),
                }),
              ),
            ),
          );
        };
        const vectorDeletesFor = (keys: readonly MessageVectorKey[]): MessageVectorDelete[] =>
          keys.flatMap(({ sessionId, seq }) =>
            (selectMessageVectorModels.all(sessionId, seq) as Array<{ readonly model: string }>).map(
              ({ model }) => ({ model, sessionId, seq }),
            ),
          );
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
          `SELECT id, event_id AS eventId, seq, tool_name AS toolName, status, started_at AS startedAt, completed_at AS completedAt,
                  project_key AS projectKey, provider,
                  input_hash AS inputHash, output_hash AS outputHash
           FROM tool_calls WHERE session_id = ?`,
        );
        const selectSessionEventDiffRows = db.prepare(
          "SELECT id, sequence AS position, fact_hash AS factHash FROM session_events WHERE session_id = ?",
        );
        const selectUsageRecordDiffRows = db.prepare(
          "SELECT id, order_index AS position, fact_hash AS factHash FROM usage_records WHERE session_id = ?",
        );
        const selectSessionEdgeDiffRows = db.prepare(
          "SELECT id, order_index AS position, fact_hash AS factHash FROM session_edges WHERE session_id = ?",
        );
        const selectSessionArtifactDiffRows = db.prepare(
          "SELECT id, order_index AS position, fact_hash AS factHash FROM session_artifacts WHERE session_id = ?",
        );
        const selectExecutionContextDiffRows = db.prepare(
          "SELECT id, sequence AS position, fact_hash AS factHash FROM execution_contexts WHERE session_id = ?",
        );
        const selectSessionApplyState = db.prepare(
          "SELECT source_fingerprint AS sourceFingerprint FROM sessions WHERE session_id = ?",
        );
        const deleteMessageRow = db.prepare("DELETE FROM messages WHERE session_id = ? AND seq = ?");
        const deleteToolCallRow = db.prepare("DELETE FROM tool_calls WHERE id = ?");
        const upsertToolCall = db.prepare(
          `INSERT INTO tool_calls(id, session_id, event_id, seq, tool_name, status, input_text, output_text, input_hash, output_hash, started_at, completed_at, project_key, provider)
           VALUES ($id, $sessionId, $eventId, $seq, $toolName, $status, $inputText, $outputText, $inputHash, $outputHash, $startedAt, $completedAt, $projectKey, $provider)
           ON CONFLICT(id) DO UPDATE SET session_id = excluded.session_id, event_id = excluded.event_id, seq = excluded.seq, tool_name = excluded.tool_name, status = excluded.status, input_text = excluded.input_text, output_text = excluded.output_text, input_hash = excluded.input_hash, output_hash = excluded.output_hash, started_at = excluded.started_at, completed_at = excluded.completed_at, project_key = excluded.project_key, provider = excluded.provider`,
        );
        const finalizeSessionFingerprint = db.prepare(
          `UPDATE sessions
           SET source_fingerprint = ?
           WHERE session_id = ?
             AND source_fingerprint = ?
             AND normalization_version = ?`,
        );

        interface StoredSourceFact {
          readonly id: string;
          readonly position: number;
          readonly factHash: string;
        }

        interface SourceFactWrite {
          readonly id: string;
          readonly position: number;
          readonly timestamp: string | null;
          readonly factHash: string;
          readonly json: string;
        }

        interface SourceFactDiff {
          readonly upserts: readonly SourceFactWrite[];
          readonly deleteIds: readonly string[];
        }

        const sourceFactHash = sha256Text;

        const diffSourceFacts = <A extends { readonly id: string }>(
          incoming: readonly A[],
          existing: readonly StoredSourceFact[],
          positionFor: (row: A, index: number) => number,
          timestampFor: (row: A) => string | undefined = () => undefined,
        ): SourceFactDiff => {
          const existingById = new Map(existing.map((row) => [row.id, row]));
          const incomingIds = new Set<string>();
          const upserts: SourceFactWrite[] = [];
          for (const [index, row] of incoming.entries()) {
            incomingIds.add(row.id);
            const position = positionFor(row, index);
            const json = JSON.stringify(row);
            const factHash = sourceFactHash(json);
            const current = existingById.get(row.id);
            if (current?.position !== position || current.factHash !== factHash) {
              upserts.push({
                id: row.id,
                position,
                timestamp: timestampFor(row) ?? null,
                factHash,
                json,
              });
            }
          }
          return {
            upserts,
            deleteIds: existing.filter((row) => !incomingIds.has(row.id)).map((row) => row.id),
          };
        };

        interface SessionDiffPlan {
          readonly requiresDownstreamReplay: boolean;
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
          readonly events: SourceFactDiff;
          readonly usageRecords: SourceFactDiff;
          readonly sessionEdges: SourceFactDiff;
          readonly artifacts: SourceFactDiff;
          readonly executionContexts: SourceFactDiff;
        }

        const computeSessionDiff = (mapped: MappedSession): SessionDiffPlan => {
          const applyState = selectSessionApplyState.get(mapped.session.sessionId) as {
            readonly sourceFingerprint: string;
          } | null;
          const requiresDownstreamReplay = applyState?.sourceFingerprint.startsWith("applying:") ?? false;
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
            id: string; eventId: string | null; seq: number; toolName: string; status: string | null;
            startedAt: string | null; completedAt: string | null;
            projectKey: string; provider: string; inputHash: string; outputHash: string;
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
              existing.seq !== toolCall.seq
              || existing.eventId !== (toolCall.eventId ?? null)
              || existing.toolName !== toolCall.toolName
              || existing.status !== (toolCall.status ?? null)
              || existing.startedAt !== (toolCall.startedAt ?? null)
              || existing.completedAt !== (toolCall.completedAt ?? null)
              || existing.projectKey !== toolCall.projectKey
              || existing.provider !== toolCall.provider
              || existing.inputHash !== sha256Text(toolCall.inputText)
              || existing.outputHash !== sha256Text(toolCall.outputText)
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

          const sourceFacts = (statement: ReturnType<Database["prepare"]>): StoredSourceFact[] =>
            statement.all(mapped.session.sessionId) as StoredSourceFact[];
          const events = diffSourceFacts(
            mapped.events,
            sourceFacts(selectSessionEventDiffRows),
            (event) => event.sequence,
          );
          const usageRecords = diffSourceFacts(
            mapped.usageRecords,
            sourceFacts(selectUsageRecordDiffRows),
            (_record, index) => index,
            (record) => record.timestamp,
          );
          const sessionEdges = diffSourceFacts(
            mapped.sessionEdges,
            sourceFacts(selectSessionEdgeDiffRows),
            (_edge, index) => index,
          );
          const artifacts = diffSourceFacts(
            mapped.artifacts,
            sourceFacts(selectSessionArtifactDiffRows),
            (_artifact, index) => index,
          );
          const executionContexts = diffSourceFacts(
            mapped.executionContexts,
            sourceFacts(selectExecutionContextDiffRows),
            (context) => context.sequence,
          );

          return {
            requiresDownstreamReplay,
            messageUpserts, messageDeleteSeqs, messagesInserted, messagesUpdated, messagesUnchanged,
            toolCallUpserts, toolCallDeleteIds, toolCallsInserted, toolCallsUpdated, toolCallsUnchanged,
            events, usageRecords, sessionEdges, artifacts, executionContexts,
          };
        };

        // Fingerprint commit ordering: the session row lands first carrying an
        // `applying:` sentinel. The ingest boundary stamps the real source
        // fingerprint only after all downstream jobs are durable. A crash
        // anywhere before that leaves a mismatch; the daemon re-sends the full
        // desired session and idempotent row/queue writes converge.
        const applySessionHead = db.transaction((mapped: MappedSession, plan: SessionDiffPlan) => {
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
            $normalizationVersion: mapped.session.normalizationVersion,
            $model: mapped.session.model ?? null,
            $modelProvider: mapped.session.modelProvider ?? null,
            $assignmentNickname: mapped.assignment?.nickname ?? null,
            $assignmentRole: mapped.assignment?.role ?? mapped.session.assignmentRole ?? null,
            $assignmentPath: mapped.assignment?.path ?? null,
            $assignmentDepth: mapped.assignment?.depth ?? null,
            $parentSessionId: mapped.session.parentSessionId ?? null,
            $messageCount: mapped.session.messageCount,
            $toolCallCount: mapped.session.toolCallCount,
          });
          const sessionId = mapped.session.sessionId;
          for (const id of plan.events.deleteIds) deleteSessionEvent.run(sessionId, id);
          for (const event of plan.events.upserts) {
            upsertSessionEvent.run(sessionId, event.id, event.position, event.factHash, event.json);
          }
          for (const id of plan.usageRecords.deleteIds) deleteUsageRecord.run(sessionId, id);
          for (const record of plan.usageRecords.upserts) {
            upsertUsageRecord.run(
              sessionId,
              record.id,
              record.position,
              record.timestamp,
              record.factHash,
              record.json,
            );
          }
          for (const id of plan.sessionEdges.deleteIds) deleteSessionEdge.run(sessionId, id);
          for (const edge of plan.sessionEdges.upserts) {
            upsertSessionEdge.run(sessionId, edge.id, edge.position, edge.factHash, edge.json);
          }
          for (const id of plan.artifacts.deleteIds) deleteSessionArtifact.run(sessionId, id);
          for (const artifact of plan.artifacts.upserts) {
            upsertSessionArtifact.run(
              sessionId,
              artifact.id,
              artifact.position,
              artifact.factHash,
              artifact.json,
            );
          }
          for (const id of plan.executionContexts.deleteIds) deleteExecutionContext.run(sessionId, id);
          for (const context of plan.executionContexts.upserts) {
            upsertExecutionContext.run(
              sessionId,
              context.id,
              context.position,
              context.factHash,
              context.json,
            );
          }
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
              $eventId: toolCall.eventId ?? null,
              $seq: toolCall.seq,
              $toolName: toolCall.toolName,
              $status: toolCall.status ?? null,
              $inputText: toolCall.inputText,
              $outputText: toolCall.outputText,
              $inputHash: sha256Text(toolCall.inputText),
              $outputHash: sha256Text(toolCall.outputText),
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
        // Stage-level spans only (per-session apply + per-chunk transactions) —
        // never per-row inside a chunk.
        const upsertSessionDiff = (mapped: MappedSession): Effect.Effect<SessionDiffOutcome, SqliteStoreError> =>
          Effect.gen(function* () {
            const plan = yield* trySqlite("upsertSession.plan", () => computeSessionDiff(mapped)).pipe(
              Effect.withSpan("ingest.diffPlan"),
            );
            yield* trySqlite("upsertSession.head", () => applySessionHead(mapped, plan)).pipe(
              Effect.withSpan("ingest.diffHead"),
            );
            for (const chunk of chunked(plan.messageDeleteSeqs)) {
              const keys = chunk.map((seq) => ({ sessionId: mapped.session.sessionId, seq }));
              const vectorDeletes = yield* trySqlite(
                "upsertSession.selectVectorDeletes",
                () => vectorDeletesFor(keys),
              );
              yield* trySqlite("upsertSession.deleteMessages", () => applyMessageDeleteChunk(mapped.session.sessionId, chunk)).pipe(
                Effect.withSpan("ingest.chunk", {
                  attributes: { kind: "messageDelete", rows: chunk.length },
                }),
              );
              yield* notifyMessageVectorMutation({ deletes: vectorDeletes });
              yield* Effect.sleep("1 millis");
            }
            for (const chunk of chunked(plan.messageUpserts)) {
              const keys = chunk.map(({ sessionId, seq }) => ({ sessionId, seq }));
              const vectorDeletes = yield* trySqlite(
                "upsertSession.selectVectorDeletes",
                () => vectorDeletesFor(keys),
              );
              yield* trySqlite("upsertSession.messages", () => applyMessageUpsertChunk(chunk)).pipe(
                Effect.withSpan("ingest.chunk", {
                  attributes: { kind: "messageUpsert", rows: chunk.length },
                }),
              );
              yield* notifyMessageVectorMutation({ deletes: vectorDeletes });
              yield* Effect.sleep("1 millis");
            }
            for (const chunk of chunked(plan.toolCallDeleteIds)) {
              yield* trySqlite("upsertSession.deleteToolCalls", () => applyToolCallDeleteChunk(chunk)).pipe(
                Effect.withSpan("ingest.chunk", {
                  attributes: { kind: "toolCallDelete", rows: chunk.length },
                }),
              );
              yield* Effect.sleep("1 millis");
            }
            for (const chunk of chunked(plan.toolCallUpserts)) {
              yield* trySqlite("upsertSession.toolCalls", () => applyToolCallUpsertChunk(chunk)).pipe(
                Effect.withSpan("ingest.chunk", {
                  attributes: { kind: "toolCallUpsert", rows: chunk.length },
                }),
              );
              yield* Effect.sleep("1 millis");
            }
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
              requiresDownstreamReplay: plan.requiresDownstreamReplay,
              invalidatedVectorKeys: [
                ...plan.messageUpserts.map((row) => ({ sessionId: row.sessionId, seq: row.seq })),
                ...plan.messageDeleteSeqs.map((seq) => ({ sessionId: mapped.session.sessionId, seq })),
              ],
            };
          }).pipe(
            Effect.withSpan("ingest.diffApply", {
              attributes: { sessionId: mapped.session.sessionId },
            }),
          );

        interface SessionDetailHeadRow {
          readonly sessionId: string;
          readonly projectKey: string;
          readonly provider: SessionRow["provider"];
          readonly agentName: string;
          readonly title: string | null;
          readonly startedAt: string | null;
          readonly updatedAt: string | null;
          readonly sourcePath: string;
          readonly sourceFingerprint: string;
          readonly host: string;
          readonly identitySchemeVersion: number;
          readonly normalizationVersion: number;
          readonly model: string | null;
          readonly modelProvider: string | null;
          readonly assignmentNickname: string | null;
          readonly assignmentRole: string | null;
          readonly assignmentPath: string | null;
          readonly assignmentDepth: number | null;
          readonly parentSessionId: string | null;
          readonly messageCount: number;
          readonly toolCallCount: number;
        }

        const selectSessionDetailHead = db.prepare(`
          SELECT session_id AS sessionId, project_key AS projectKey, provider,
            agent_name AS agentName, title, started_at AS startedAt,
            updated_at AS updatedAt, source_path AS sourcePath,
            source_fingerprint AS sourceFingerprint, host,
            identity_scheme_version AS identitySchemeVersion,
            normalization_version AS normalizationVersion, model,
            model_provider AS modelProvider,
            assignment_nickname AS assignmentNickname,
            assignment_role AS assignmentRole,
            assignment_path AS assignmentPath,
            assignment_depth AS assignmentDepth,
            parent_session_id AS parentSessionId,
            message_count AS messageCount, tool_call_count AS toolCallCount
          FROM sessions WHERE session_id = ?
        `);
        const countMessagesBySession = db.prepare("SELECT COUNT(*) AS count FROM messages WHERE session_id = ?");
        const countToolCallsBySession = db.prepare("SELECT COUNT(*) AS count FROM tool_calls WHERE session_id = ?");
        const countEventsBySession = db.prepare("SELECT COUNT(*) AS count FROM session_events WHERE session_id = ?");
        const countUsageBySession = db.prepare("SELECT COUNT(*) AS count FROM usage_records WHERE session_id = ?");
        const countEdgesBySession = db.prepare("SELECT COUNT(*) AS count FROM session_edges WHERE session_id = ?");
        const countArtifactsBySession = db.prepare("SELECT COUNT(*) AS count FROM session_artifacts WHERE session_id = ?");
        const countContextsBySession = db.prepare("SELECT COUNT(*) AS count FROM execution_contexts WHERE session_id = ?");

        const page = <A>(window: PageWindow, total: number, rows: readonly A[]): Page<A> => ({
          ...window,
          total,
          hasMore: window.offset + rows.length < total,
          rows,
        });
        const countRows = (statement: ReturnType<Database["prepare"]>, sessionId: string): number =>
          (statement.get(sessionId) as { count: number }).count;
        const parseFact = <A>(row: { readonly json: string }): A => JSON.parse(row.json) as A;

        const readSessionDetail = (
          sessionId: string,
          pages: SessionDetailPageOptions,
        ): SessionDetail | undefined => {
          const head = selectSessionDetailHead.get(sessionId) as SessionDetailHeadRow | null;
          if (head === null) return undefined;
          const session: SessionRow = {
            sessionId: head.sessionId,
            projectKey: head.projectKey,
            provider: head.provider,
            agentName: head.agentName,
            ...(head.title !== null ? { title: head.title } : {}),
            ...(head.startedAt !== null ? { startedAt: head.startedAt } : {}),
            ...(head.updatedAt !== null ? { updatedAt: head.updatedAt } : {}),
            sourcePath: head.sourcePath,
            sourceFingerprint: head.sourceFingerprint,
            host: head.host,
            identitySchemeVersion: head.identitySchemeVersion,
            normalizationVersion: head.normalizationVersion,
            ...(head.model !== null ? { model: head.model } : {}),
            ...(head.modelProvider !== null ? { modelProvider: head.modelProvider } : {}),
            ...(head.assignmentRole !== null ? { assignmentRole: head.assignmentRole } : {}),
            ...(head.parentSessionId !== null ? { parentSessionId: head.parentSessionId } : {}),
            messageCount: head.messageCount,
            toolCallCount: head.toolCallCount,
          };
          const assignment = head.assignmentNickname !== null
            || head.assignmentRole !== null
            || head.assignmentPath !== null
            || head.assignmentDepth !== null
            ? {
              ...(head.assignmentNickname !== null ? { nickname: head.assignmentNickname } : {}),
              ...(head.assignmentRole !== null ? { role: head.assignmentRole } : {}),
              ...(head.assignmentPath !== null ? { path: head.assignmentPath } : {}),
              ...(head.assignmentDepth !== null ? { depth: head.assignmentDepth } : {}),
            }
            : undefined;
          const messageRows = db.query(
            "SELECT session_id AS sessionId, seq, role, text, ts, project_key AS projectKey, content_hash AS contentHash FROM messages WHERE session_id = ? ORDER BY seq ASC LIMIT ? OFFSET ?",
          ).all(sessionId, pages.messages.limit, pages.messages.offset) as MessageRow[];
          const toolCallRows = db.query(
            "SELECT id, session_id AS sessionId, event_id AS eventId, seq, tool_name AS toolName, status, input_text AS inputText, output_text AS outputText, started_at AS startedAt, completed_at AS completedAt, project_key AS projectKey, provider FROM tool_calls WHERE session_id = ? ORDER BY seq ASC, id ASC LIMIT ? OFFSET ?",
          ).all(sessionId, pages.toolCalls.limit, pages.toolCalls.offset) as ToolCallRow[];
          const eventRows = (db.query(
            "SELECT event_json AS json FROM session_events WHERE session_id = ? ORDER BY sequence ASC, id ASC LIMIT ? OFFSET ?",
          ).all(sessionId, pages.events.limit, pages.events.offset) as Array<{ json: string }>).map(parseFact<SessionEventRow>);
          const usageRows = (db.query(
            "SELECT record_json AS json FROM usage_records WHERE session_id = ? ORDER BY order_index ASC, id ASC LIMIT ? OFFSET ?",
          ).all(sessionId, pages.usageRecords.limit, pages.usageRecords.offset) as Array<{ json: string }>).map(parseFact<UsageRecordRow>);
          const edgeRows = (db.query(
            "SELECT edge_json AS json FROM session_edges WHERE session_id = ? ORDER BY order_index ASC, id ASC LIMIT ? OFFSET ?",
          ).all(sessionId, pages.sessionEdges.limit, pages.sessionEdges.offset) as Array<{ json: string }>).map(parseFact<SessionEdgeRow>);
          const artifactRows = (db.query(
            "SELECT artifact_json AS json FROM session_artifacts WHERE session_id = ? ORDER BY order_index ASC, id ASC LIMIT ? OFFSET ?",
          ).all(sessionId, pages.artifacts.limit, pages.artifacts.offset) as Array<{ json: string }>).map(parseFact<ArtifactRow>);
          const contextRows = (db.query(
            "SELECT context_json AS json FROM execution_contexts WHERE session_id = ? ORDER BY sequence ASC, id ASC LIMIT ? OFFSET ?",
          ).all(sessionId, pages.executionContexts.limit, pages.executionContexts.offset) as Array<{ json: string }>).map(parseFact<ExecutionContextRow>);
          return {
            session,
            ...(assignment !== undefined ? { assignment } : {}),
            messages: page(pages.messages, countRows(countMessagesBySession, sessionId), messageRows),
            toolCalls: page(pages.toolCalls, countRows(countToolCallsBySession, sessionId), toolCallRows),
            events: page(pages.events, countRows(countEventsBySession, sessionId), eventRows),
            usageRecords: page(pages.usageRecords, countRows(countUsageBySession, sessionId), usageRows),
            sessionEdges: page(pages.sessionEdges, countRows(countEdgesBySession, sessionId), edgeRows),
            artifacts: page(pages.artifacts, countRows(countArtifactsBySession, sessionId), artifactRows),
            executionContexts: page(pages.executionContexts, countRows(countContextsBySession, sessionId), contextRows),
          };
        };

        const querySessionColumns = `
          s.session_id AS sessionId,
          s.project_key AS projectKey,
          s.provider,
          s.title,
          s.started_at AS startedAt,
          s.updated_at AS endedAt,
          s.agent_name AS agentName,
          s.model,
          s.model_provider AS modelProvider,
          s.message_count AS messageCount,
          s.tool_call_count AS toolCallCount,
          s.parent_session_id AS parentSessionId,
          s.assignment_role AS agentRole,
          s.assignment_path AS agentPath,
          s.assignment_depth AS agentDepth,
          s.source_path AS sourcePath,
          s.source_fingerprint AS sourceFingerprint,
          s.host,
          s.identity_scheme_version AS identitySchemeVersion,
          s.normalization_version AS normalizationVersion
        `;
        const queryMessageColumns = `
          m.session_id || ':' || CAST(m.seq AS TEXT) AS messageId,
          m.session_id AS sessionId,
          m.seq AS sequence,
          m.role,
          m.text,
          m.ts AS timestamp,
          m.project_key AS projectKey,
          s.provider,
          s.title,
          s.agent_name AS agentName,
          s.assignment_role AS agentRole,
          s.model,
          s.model_provider AS modelProvider
        `;
        const pushProviderFilter = (
          filters: string[],
          args: Array<string | number>,
          column: string,
          providers: readonly string[] | undefined,
        ) => {
          if (providers === undefined) return;
          filters.push(`${column} IN (${providers.map(() => "?").join(", ")})`);
          args.push(...providers);
        };

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
          finalizeSessionIngest: (sessionId, sourceFingerprint, normalizationVersion) =>
            trySqlite("finalizeSessionIngest", () => {
              const applyingFingerprint = `applying:${sourceFingerprint}`;
              const result = finalizeSessionFingerprint.run(
                sourceFingerprint,
                sessionId,
                applyingFingerprint,
                normalizationVersion,
              );
              if (result.changes !== 1) {
                throw new Error(
                  `session ${sessionId} is not staged at fingerprint ${applyingFingerprint} `
                  + `and normalization version ${normalizationVersion}`,
                );
              }
            }),
          readSessionDetail: (sessionId, pages) =>
            trySqlite("readSessionDetail", () => readSessionDetail(sessionId, pages)),
          hasSessionFingerprint: (sessionId, sourceFingerprint, normalizationVersion) =>
            trySqlite("hasSessionFingerprint", () => {
              const row = db
                .query("SELECT source_fingerprint AS sourceFingerprint, normalization_version AS normalizationVersion FROM sessions WHERE session_id = ?")
                .get(sessionId) as { sourceFingerprint: string; normalizationVersion: number } | null;
              return row?.sourceFingerprint === sourceFingerprint
                && row.normalizationVersion === normalizationVersion;
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
              if (options.model !== undefined) {
                filters.push("model = ?");
                args.push(options.model);
              }
              if (options.modelProvider !== undefined) {
                filters.push("model_provider = ?");
                args.push(options.modelProvider);
              }
              if (options.assignmentRole !== undefined) {
                filters.push("assignment_role = ?");
                args.push(options.assignmentRole);
              }
              const where = filters.length > 0 ? ` WHERE ${filters.join(" AND ")}` : "";
              return db
                .query(`SELECT session_id AS sessionId, project_key AS projectKey, provider, agent_name AS agentName, title, started_at AS startedAt, updated_at AS updatedAt, source_path AS sourcePath, source_fingerprint AS sourceFingerprint, host, identity_scheme_version AS identitySchemeVersion, normalization_version AS normalizationVersion, model, model_provider AS modelProvider, assignment_role AS assignmentRole, parent_session_id AS parentSessionId, message_count AS messageCount, tool_call_count AS toolCallCount FROM sessions${where} ORDER BY COALESCE(updated_at, started_at, '') DESC LIMIT ? OFFSET ?`)
                .all(...args, limit, offset) as SessionRow[];
            }),
          querySessions: (options) =>
            trySqlite("querySessions", () => {
              const filters: string[] = [];
              const args: Array<string | number> = [];
              if (options.projectKey !== undefined) {
                filters.push("s.project_key = ?");
                args.push(options.projectKey);
              }
              pushProviderFilter(filters, args, "s.provider", options.providers);
              if (options.sessionId !== undefined) {
                filters.push("s.session_id = ?");
                args.push(options.sessionId);
              }
              if (options.agentName !== undefined) {
                filters.push("s.agent_name = ?");
                args.push(options.agentName);
              }
              if (options.agentRole !== undefined) {
                filters.push("s.assignment_role = ?");
                args.push(options.agentRole);
              }
              if (options.model !== undefined) {
                filters.push("s.model = ?");
                args.push(options.model);
              }
              if (options.modelProvider !== undefined) {
                filters.push("s.model_provider = ?");
                args.push(options.modelProvider);
              }
              const where = filters.length === 0 ? "" : `WHERE ${filters.join(" AND ")}`;
              return db.query(`
                SELECT ${querySessionColumns}
                FROM sessions AS s
                ${where}
                ORDER BY COALESCE(s.updated_at, s.started_at, '') DESC, s.session_id ASC
                LIMIT ? OFFSET ?
              `).all(...args, options.limit, options.offset) as QuerySessionRow[];
            }),
          querySessionIds: (options) =>
            trySqlite("querySessionIds", () => {
              const filters: string[] = [];
              const args: Array<string | number> = [];
              if (options.projectKey !== undefined) {
                filters.push("s.project_key = ?");
                args.push(options.projectKey);
              }
              pushProviderFilter(filters, args, "s.provider", options.providers);
              if (options.sessionId !== undefined) {
                filters.push("s.session_id = ?");
                args.push(options.sessionId);
              }
              if (options.agentName !== undefined) {
                filters.push("s.agent_name = ?");
                args.push(options.agentName);
              }
              if (options.agentRole !== undefined) {
                filters.push("s.assignment_role = ?");
                args.push(options.agentRole);
              }
              if (options.model !== undefined) {
                filters.push("s.model = ?");
                args.push(options.model);
              }
              if (options.modelProvider !== undefined) {
                filters.push("s.model_provider = ?");
                args.push(options.modelProvider);
              }
              const where = filters.length === 0 ? "" : `WHERE ${filters.join(" AND ")}`;
              const rows = db.query(`
                SELECT s.session_id AS sessionId
                FROM sessions AS s
                ${where}
                ORDER BY s.session_id ASC
              `).all(...args) as Array<{ readonly sessionId: string }>;
              return rows.map(({ sessionId }) => sessionId);
            }),
          queryMessages: (options) =>
            trySqlite("queryMessages", () => {
              const filters = ["m.session_id = ?"];
              const args: Array<string | number> = [options.sessionId];
              if (options.role !== undefined) {
                filters.push("m.role = ?");
                args.push(options.role);
              }
              if (options.model !== undefined) {
                filters.push("s.model = ?");
                args.push(options.model);
              }
              if (options.modelProvider !== undefined) {
                filters.push("s.model_provider = ?");
                args.push(options.modelProvider);
              }
              return db.query(`
                SELECT ${queryMessageColumns}
                FROM messages AS m
                JOIN sessions AS s ON s.session_id = m.session_id
                WHERE ${filters.join(" AND ")}
                ORDER BY m.seq ASC
                LIMIT ? OFFSET ?
              `).all(...args, options.limit, options.offset) as QueryMessageRow[];
            }),
          queryToolCalls: (options) =>
            trySqlite("queryToolCalls", () => {
              const filters: string[] = [];
              const args: Array<string | number> = [];
              if (options.projectKey !== undefined) {
                filters.push("t.project_key = ?");
                args.push(options.projectKey);
              }
              pushProviderFilter(filters, args, "t.provider", options.providers);
              if (options.sessionId !== undefined) {
                filters.push("t.session_id = ?");
                args.push(options.sessionId);
              }
              if (options.toolCallId !== undefined) {
                filters.push("t.id = ?");
                args.push(options.toolCallId);
              }
              if (options.toolName !== undefined) {
                filters.push("t.tool_name = ?");
                args.push(options.toolName);
              }
              if (options.agentName !== undefined) {
                filters.push("s.agent_name = ?");
                args.push(options.agentName);
              }
              if (options.agentRole !== undefined) {
                filters.push("s.assignment_role = ?");
                args.push(options.agentRole);
              }
              if (options.model !== undefined) {
                filters.push("s.model = ?");
                args.push(options.model);
              }
              if (options.modelProvider !== undefined) {
                filters.push("s.model_provider = ?");
                args.push(options.modelProvider);
              }
              const where = filters.length === 0 ? "" : `WHERE ${filters.join(" AND ")}`;
              const payloadColumns = [
                ...(options.includeInput ? ["t.input_text AS inputText"] : []),
                ...(options.includeOutput ? ["t.output_text AS outputText"] : []),
              ];
              return db.query(`
                SELECT
                  t.id AS toolCallId,
                  t.session_id AS sessionId,
                  t.project_key AS projectKey,
                  t.provider,
                  t.seq AS sequence,
                  t.tool_name AS toolName,
                  COALESCE(t.started_at, t.completed_at) AS timestamp,
                  t.status,
                  t.started_at AS startedAt,
                  t.completed_at AS completedAt,
                  length(CAST(t.input_text AS BLOB)) AS inputBytes,
                  length(CAST(t.output_text AS BLOB)) AS outputBytes,
                  s.agent_name AS agentName,
                  s.assignment_role AS agentRole,
                  s.model,
                  s.model_provider AS modelProvider
                  ${payloadColumns.length === 0 ? "" : `, ${payloadColumns.join(", ")}`}
                FROM tool_calls AS t
                JOIN sessions AS s ON s.session_id = t.session_id
                ${where}
                ORDER BY t.session_id ASC, t.seq ASC, t.id ASC
                LIMIT ? OFFSET ?
              `).all(...args, options.limit, options.offset) as QueryToolCallRow[];
            }),
          queryMessagesBySessionSeq: (options) =>
            trySqlite("queryMessagesBySessionSeq", () => {
              const filters = ["m.session_id = ?", "m.seq = ?"];
              const trailingArgs: string[] = [];
              if (options.sessionId !== undefined) {
                filters.push("m.session_id = ?");
                trailingArgs.push(options.sessionId);
              }
              if (options.agentName !== undefined) {
                filters.push("s.agent_name = ?");
                trailingArgs.push(options.agentName);
              }
              if (options.agentRole !== undefined) {
                filters.push("s.assignment_role = ?");
                trailingArgs.push(options.agentRole);
              }
              if (options.model !== undefined) {
                filters.push("s.model = ?");
                trailingArgs.push(options.model);
              }
              if (options.modelProvider !== undefined) {
                filters.push("s.model_provider = ?");
                trailingArgs.push(options.modelProvider);
              }
              const statement = db.prepare(`
                SELECT ${queryMessageColumns}
                FROM messages AS m
                JOIN sessions AS s ON s.session_id = m.session_id
                WHERE ${filters.join(" AND ")}
              `);
              const rows: QueryMessageRow[] = [];
              for (const pair of options.pairs) {
                const row = statement.get(
                  pair.sessionId,
                  pair.seq,
                  ...trailingArgs,
                ) as QueryMessageRow | null;
                if (row !== null) rows.push(row);
              }
              return rows;
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
                .query(`SELECT id, session_id AS sessionId, event_id AS eventId, seq, tool_name AS toolName, status, input_text AS inputText, output_text AS outputText, started_at AS startedAt, completed_at AS completedAt, project_key AS projectKey, provider FROM tool_calls${where} ORDER BY session_id ASC, seq ASC LIMIT ? OFFSET ?`)
                .all(...args, limit, offset) as ToolCallRow[];
            }),
          getToolCall: (id) =>
            trySqlite("getToolCall", () =>
              db
                .query("SELECT id, session_id AS sessionId, event_id AS eventId, seq, tool_name AS toolName, status, input_text AS inputText, output_text AS outputText, started_at AS startedAt, completed_at AS completedAt, project_key AS projectKey, provider FROM tool_calls WHERE id = ?")
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
            Effect.gen(function* () {
              const acceptedRows = yield* trySqlite("upsertMessageVectors", () => replaceMessageVectors(rows));
              yield* notifyMessageVectorMutation({ upserts: acceptedRows });
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
          registerMessageVectorMutationListener: (listener) => {
            messageVectorMutationListener = listener;
          },
          lexicalSearch: ({
            query,
            projectKey,
            role,
            providers,
            sessionId,
            agentName,
            agentRole,
            model,
            modelProvider,
            limit,
            offset,
          }) =>
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
                filters.push(`s.provider IN (${providers.map(() => "?").join(", ")})`);
                args.push(...providers);
              }
              if (sessionId !== undefined) {
                filters.push("s.session_id = ?");
                args.push(sessionId);
              }
              if (agentName !== undefined) {
                filters.push("s.agent_name = ?");
                args.push(agentName);
              }
              if (agentRole !== undefined) {
                filters.push("s.assignment_role = ?");
                args.push(agentRole);
              }
              if (model !== undefined) {
                filters.push("s.model = ?");
                args.push(model);
              }
              if (modelProvider !== undefined) {
                filters.push("s.model_provider = ?");
                args.push(modelProvider);
              }
              const rowOffset = Number.isInteger(offset) && offset !== undefined && offset >= 0
                ? offset
                : 0;
              const rows = db
                .query(
                  `SELECT
                    messages_fts.key AS key,
                    bm25(messages_fts) AS rank,
                    m.session_id AS sessionId,
                    m.seq AS seq,
                    m.role AS role,
                    m.project_key AS projectKey,
                    s.provider AS provider,
                    m.text AS text,
                    m.content_hash AS contentHash,
                    s.title,
                    s.agent_name AS agentName,
                    s.assignment_role AS agentRole,
                    s.model,
                    s.model_provider AS modelProvider,
                    m.ts AS timestamp
                  FROM messages_fts
                  JOIN messages AS m
                    ON m.session_id = messages_fts.session_id
                   AND m.seq = messages_fts.seq
                   AND m.role = messages_fts.role
                  JOIN sessions AS s
                    ON s.session_id = m.session_id
                  WHERE ${filters.join(" AND ")}
                  ORDER BY rank ASC, messages_fts.key ASC
                  LIMIT ? OFFSET ?`,
                )
                .all(...args, positiveInt(limit, 10), rowOffset) as Array<{
                  key: string;
                  rank: number;
                  sessionId: string;
                  seq: number;
                  role: string;
                  projectKey: string;
                  provider: string;
                  text: string;
                  contentHash: string;
                  title: string | null;
                  agentName: string;
                  agentRole: string | null;
                  model: string | null;
                  modelProvider: string | null;
                  timestamp: string | null;
                }>;
              return rows.map((row, index) => ({
                key: row.key,
                score: lexicalRankScore(rowOffset + index),
                row: {
                  key: row.key,
                  messageId: `${row.sessionId}:${row.seq}`,
                  sessionId: row.sessionId,
                  seq: row.seq,
                  sequence: row.seq,
                  role: row.role,
                  projectKey: row.projectKey,
                  provider: row.provider,
                  text: row.text,
                  contentHash: row.contentHash,
                  title: row.title,
                  agentName: row.agentName,
                  agentRole: row.agentRole,
                  model: row.model,
                  modelProvider: row.modelProvider,
                  timestamp: row.timestamp,
                },
              }));
            }),
          close: Effect.sync(() => db.close()),
        } satisfies LocalStoreService;
      }),
    ),
  );
