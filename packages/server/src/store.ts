import { Database } from "bun:sqlite";
import { Context, Effect, Layer, Schema } from "effect";

import type { DivergenceAggregate, DivergenceRow, IngestRunRow, MappedSession, MessageRow, ProjectRow, SessionRow, SessionVersion, ToolCallRow } from "./model";
import type { IndexProof } from "./verify";
import { messageSearchKey } from "./lancedb";
import { isSearchableRole, normalizeIndexedContentHash } from "./searchPolicy";
import { ensureParentDir, sqlitePath } from "./paths";

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
};

const count = (db: Database, table: string): number =>
  (db.query(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count;

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
          `INSERT INTO messages(session_id, seq, role, text, ts, project_key, content_hash)
           VALUES ($sessionId, $seq, $role, $text, $ts, $projectKey, $contentHash)`,
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
          close: Effect.sync(() => db.close()),
        } satisfies LocalStoreService;
      }),
    ),
  );
