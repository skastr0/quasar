import { copyFileSync, existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { execFileSync } from "node:child_process";

import type { SessionAdapter } from "./types";
import type { Artifact, ToolCall, UsageRecord } from "../schemas";
import {
  bestEffortToolCall,
  contentFromRecord,
  kindFromRecord,
  nativeIdFromRecord,
  roleFromRecord,
  timestampFromRecord,
  usageFromRecord,
} from "./best-effort";
import {
  artifactIdFor,
  buildSession,
  collectFiles,
  compactText,
  eventIdFor,
  homePath,
  parseJsonString,
  recordFrom,
  sourceRoot,
  type NativeValue,
} from "./common";

type CursorToolCallDraft = Omit<
  ToolCall,
  "sessionId" | "machineId" | "provider" | "agentName" | "projectIdentityKey"
>;
type CursorUsageDraft = Omit<
  UsageRecord,
  "sessionId" | "machineId" | "provider" | "agentName" | "projectIdentityKey"
>;
type CursorArtifactDraft = Omit<
  Artifact,
  "sessionId" | "machineId" | "provider" | "agentName" | "projectIdentityKey"
>;

const maybeDatabase = async (path: string) => {
  try {
    const { Database } = await import("bun:sqlite");
    return new Database(path, { readonly: true });
  } catch {
    return undefined;
  }
};

type CursorDatabase = NonNullable<Awaited<ReturnType<typeof maybeDatabase>>>;

const CURSOR_DENY = /(auth|token|secret|credential|password|api[_-]?key|keychain|oauth|session[_-]?storage)/i;
const CURSOR_DB_ALLOW = /(state\.vscdb|composer|chat|conversation|bubble|history|workspaceStorage|globalStorage)/i;
const CURSOR_TABLE_ALLOW = /(ItemTable|composer|chat|conversation|bubble|message|cursor)/i;
const CURSOR_KEY_ALLOW = /(composer|chat|conversation|bubble|message|ai|aichat|inlinechat|cursor|tool|diff|patch)/i;

const cursorDbLike = (path: string) =>
  /\.(vscdb|sqlite|sqlite3|db)$/i.test(path) && CURSOR_DB_ALLOW.test(path) && !CURSOR_DENY.test(path);

const copyDatabaseForRead = (dbPath: string) => {
  const tempDir = mkdtempSync(join(tmpdir(), "quasar-cursor-"));
  const tempDbPath = join(tempDir, basename(dbPath));
  copyFileSync(dbPath, tempDbPath);
  for (const suffix of ["-wal", "-shm"]) {
    const source = `${dbPath}${suffix}`;
    if (existsSync(source)) copyFileSync(source, `${tempDbPath}${suffix}`);
  }
  return {
    path: tempDbPath,
    cleanup: () => rmSync(tempDir, { recursive: true, force: true }),
  };
};

const tables = (db: CursorDatabase) =>
  (db.query("select name from sqlite_master where type = 'table'").all() as { name: string }[])
    .map((row) => row.name)
    .filter(cursorTableLike);

const tableRows = (db: CursorDatabase, table: string) => {
  try {
    return db.query(`select * from ${quoteIdent(table)} limit 1000`).all() as Record<string, unknown>[];
  } catch {
    return [];
  }
};

const tablesCli = (dbPath: string) =>
  sqliteJson<{ name: string }>(
    dbPath,
    "select name from sqlite_master where type = 'table'",
  )
    .map((row) => row.name)
    .filter(cursorTableLike);

const tableRowsCli = (dbPath: string, table: string) =>
  sqliteJson<Record<string, unknown>>(dbPath, `select * from ${quoteIdent(table)} limit 1000`);

const sqliteJson = <A>(dbPath: string, query: string): A[] => {
  try {
    const output = execFileSync("sqlite3", ["-json", dbPath, query], { encoding: "utf8" });
    return output.trim().length === 0 ? [] : (JSON.parse(output) as A[]);
  } catch {
    return [];
  }
};

const quoteIdent = (identifier: string) => `"${identifier.replaceAll('"', '""')}"`;

const cursorTableLike = (name: string) =>
  !name.startsWith("sqlite_") && CURSOR_TABLE_ALLOW.test(name) && !CURSOR_DENY.test(name);

const cursorRowAllowed = (table: string, row: Record<string, unknown>) => {
  const keyText = [table, row.key, row.name, row.id, row.type]
    .map((value) => String(value ?? ""))
    .join(" ");
  if (CURSOR_DENY.test(keyText)) return false;
  return CURSOR_KEY_ALLOW.test(keyText);
};

const recordsFromRow = (table: string, row: Record<string, unknown>) => {
  if (!cursorRowAllowed(table, row)) return [];
  const parsedValues = Object.entries(row).flatMap(([key, value]) => {
    const parsed = parseJsonString(value);
    return parsed === value ? [] : [{ key, value: parsed }];
  });
  const candidates = parsedValues.length === 0
    ? [{ key: "row", value: row }]
    : parsedValues;
  return candidates.flatMap(({ key, value }) =>
    expandCursorValue(table, key, value, row),
  );
};

const expandCursorValue = (
  table: string,
  key: string,
  value: unknown,
  row: Record<string, unknown>,
): Record<string, unknown>[] => {
  const record = recordFrom(value);
  if (Array.isArray(value)) {
    return value.map(recordFrom).filter(cursorRecordLike).map((item) => ({ ...item, _cursor: { table, key, row } }));
  }
  for (const nestedKey of ["messages", "conversation", "bubbles", "composerMessages", "items"]) {
    if (Array.isArray(record[nestedKey])) {
      return (record[nestedKey] as unknown[])
        .map(recordFrom)
        .filter(cursorRecordLike)
        .map((item) => ({ ...item, _cursor: { table, key, row } }));
    }
  }
  const enriched = { ...record, _cursor: { table, key, row } };
  return cursorRecordLike(enriched) ? [enriched] : [];
};

const cursorRecordLike = (record: Record<string, unknown>) => {
  const cursor = recordFrom(record._cursor);
  const text = [
    cursor.table,
    cursor.key,
    record.type,
    record.kind,
    record.role,
    record.text,
    record.content,
    record.toolName,
    record.tool,
    record.diff,
    record.patch,
  ]
    .map((value) => String(value ?? "").toLowerCase())
    .join(" ");
  return /(chat|composer|bubble|conversation|message|tool|diff|patch|ai|cursor)/.test(text);
};

const artifactFromRecord = (
  machineId: string,
  dbPath: string,
  nativeSessionId: string,
  eventId: string,
  record: Record<string, unknown>,
  index: number,
): CursorArtifactDraft[] => {
  const type = String(record.type ?? record.kind ?? "").toLowerCase();
  const path =
    typeof record.path === "string"
      ? record.path
      : typeof record.filePath === "string"
        ? record.filePath
        : undefined;
  if (!type.includes("diff") && !type.includes("patch") && record.diff === undefined && record.patch === undefined) {
    return [];
  }
  return [
    {
      id: artifactIdFor("cursor", machineId, dbPath, nativeSessionId, [eventId, index, path, type]),
      eventId,
      kind: type.includes("patch") ? "patch" : "diff",
      ...(path !== undefined ? { path } : {}),
      sourcePath: dbPath,
      sourceRef: record._cursor,
      raw: record as NativeValue,
    },
  ];
};

const buildCursorSession = async (
  dbPath: string,
  root: string,
  options: Parameters<SessionAdapter["read"]>[0],
) => {
  const tempDb = copyDatabaseForRead(dbPath);
  const db = await maybeDatabase(tempDb.path);
  let records: Record<string, unknown>[];
  if (db === undefined) {
    records = tablesCli(tempDb.path).flatMap((table) =>
      tableRowsCli(tempDb.path, table).flatMap((row) => recordsFromRow(table, row)),
    );
    tempDb.cleanup();
  } else {
    try {
      records = tables(db).flatMap((table) =>
        tableRows(db, table).flatMap((row) => recordsFromRow(table, row)),
      );
    } finally {
      db.close();
      tempDb.cleanup();
    }
  }
  if (records.length === 0) return undefined;
  const nativeSessionId = `${basename(dirname(dbPath))}:${basename(dbPath)}`;
  const toolCallsById = new Map<string, CursorToolCallDraft>();
  const usageRecords: CursorUsageDraft[] = [];
  const artifacts: CursorArtifactDraft[] = [];
  const events = records.map((record, index) => {
    const nativeEventId = nativeIdFromRecord(record, index);
    const eventId = eventIdFor("cursor", options.machine.machineId, dbPath, index, nativeEventId);
    const toolCall = bestEffortToolCall(
      "cursor",
      options.machine.machineId,
      dbPath,
      nativeSessionId,
      eventId,
      record,
      nativeEventId,
    );
    if (toolCall !== undefined) toolCallsById.set(toolCall.id, toolCall);
    const usageRecord = usageFromRecord(
      "cursor",
      options.machine.machineId,
      dbPath,
      nativeSessionId,
      eventId,
      index,
      record,
      undefined,
    );
    if (usageRecord !== undefined) usageRecords.push(usageRecord);
    artifacts.push(...artifactFromRecord(options.machine.machineId, dbPath, nativeSessionId, eventId, record, index));
    const content = contentFromRecord(record) as NativeValue;
    return {
      id: eventId,
      nativeEventId,
      sequence: index,
      timestamp: timestampFromRecord(record),
      role: roleFromRecord(record),
      kind: kindFromRecord(record),
      contentText: compactText(content),
      content,
      ...(toolCall !== undefined ? { toolCallId: toolCall.id } : {}),
      rawReference: { sourcePath: dbPath, rowId: nativeEventId, nativeType: "sqlite" },
      raw: record,
    };
  });
  return buildSession({
    provider: "cursor",
    agentName: "cursor",
    machine: options.machine,
    nativeSessionId,
    nativeProjectKey: projectPathFromRecords(records),
    sourceRoot: root,
    sourcePath: dbPath,
    projectPath: projectPathFromRecords(records),
    rawMetadata: { dbPath },
    events,
    toolCalls: [...toolCallsById.values()],
    usageRecords,
    artifacts,
  });
};

const projectPathFromRecords = (records: readonly Record<string, unknown>[]) => {
  for (const record of records) {
    if (typeof record.cwd === "string") return record.cwd;
    if (typeof record.workspacePath === "string") return record.workspacePath;
    if (typeof record.projectPath === "string") return record.projectPath;
  }
  return undefined;
};

export const cursorAdapter: SessionAdapter = {
  id: "cursor-sqlite-copied",
  provider: "cursor",
  displayName: "Cursor copied SQLite storage",
  stable: true,
  defaultRoot: () => homePath("Library/Application Support/Cursor/User"),
  read: async (options) => {
    const root = options.roots?.cursor ?? cursorAdapter.defaultRoot();
    if (root === undefined || !existsSync(root)) {
      return {
        sourceRoots: [],
        sessions: [],
        diagnostics: [
          {
            adapterId: cursorAdapter.id,
            provider: "cursor",
            status: "no_data_found",
            parserConfidence: "brittle",
            message: "Cursor User storage root was not found.",
            ...(root !== undefined ? { rootPath: root } : {}),
          },
        ],
      };
    }
    const files = statSync(root).isFile() ? [root] : collectFiles(root, cursorDbLike, options.limit);
    const sessions = (await Promise.all(files.map((path) => buildCursorSession(path, root, options)))).filter(
      (session): session is NonNullable<typeof session> => session !== undefined,
    );
    return {
      sourceRoots: [sourceRoot("cursor", cursorAdapter.id, root, options.machine, options.now)],
      sessions,
      diagnostics: [
        {
          adapterId: cursorAdapter.id,
          provider: "cursor",
          status: sessions.length > 0 ? "available" : "no_data_found",
          parserConfidence: "brittle",
          rootPath: root,
          message: `Discovered ${sessions.length} Cursor SQLite session group(s).`,
          details: { databasesScanned: files.length },
        },
      ],
    };
  },
};
