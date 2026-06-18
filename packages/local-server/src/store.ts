import { Database } from "bun:sqlite";
import { Context, Effect, Layer, Schema } from "effect";

import type { IngestRunRow, MappedSession, MessageRow, ProjectRow, SessionRow, ToolCallRow } from "./model";
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
  readonly readMessages: (sessionId: string, limit: number) => Effect.Effect<readonly MessageRow[], SqliteStoreError>;
  readonly listToolCalls: (options: {
    readonly sessionId?: string;
    readonly projectKey?: string;
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
          `INSERT INTO sessions(session_id, project_key, provider, agent_name, title, started_at, updated_at, source_path, source_fingerprint, message_count, tool_call_count)
           VALUES ($sessionId, $projectKey, $provider, $agentName, $title, $startedAt, $updatedAt, $sourcePath, $sourceFingerprint, $messageCount, $toolCallCount)
           ON CONFLICT(session_id) DO UPDATE SET project_key = excluded.project_key, provider = excluded.provider, agent_name = excluded.agent_name, title = excluded.title, started_at = excluded.started_at, updated_at = excluded.updated_at, source_path = excluded.source_path, source_fingerprint = excluded.source_fingerprint, message_count = excluded.message_count, tool_call_count = excluded.tool_call_count`,
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
            $messageCount: mapped.session.messageCount,
            $toolCallCount: mapped.session.toolCallCount,
          });
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
                .query(`SELECT session_id AS sessionId, project_key AS projectKey, provider, agent_name AS agentName, title, started_at AS startedAt, updated_at AS updatedAt, source_path AS sourcePath, source_fingerprint AS sourceFingerprint, message_count AS messageCount, tool_call_count AS toolCallCount FROM sessions${where} ORDER BY COALESCE(updated_at, started_at, '') DESC LIMIT ? OFFSET ?`)
                .all(...args, limit, offset) as SessionRow[];
            }),
          readMessages: (sessionId, limit) =>
            trySqlite("readMessages", () =>
              db
                .query("SELECT session_id AS sessionId, seq, role, text, ts, project_key AS projectKey, content_hash AS contentHash FROM messages WHERE session_id = ? ORDER BY seq ASC LIMIT ?")
                .all(sessionId, limit) as MessageRow[],
            ),
          listToolCalls: ({ sessionId, projectKey, toolName, limit, offset = 0 }) =>
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
          close: Effect.sync(() => db.close()),
        } satisfies LocalStoreService;
      }),
    ),
  );
