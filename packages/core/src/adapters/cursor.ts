import { copyFileSync, existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { execFileSync } from "node:child_process";

import type { SessionAdapter } from "./types";
import type { Artifact, NormalizedSession, ToolCall, UsageRecord } from "../schemas";
import {
  bestEffortToolCall,
  contentFromRecord,
  kindFromRecord,
  nativeIdFromRecord,
  roleFromRecord,
  timestampFromRecord,
  toolNameFromRecord,
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
  projectToolPayloadNativeValue,
  recordFrom,
  sourceRoot,
  stringValue,
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
type CursorColumnRow = { name: string };

const CURSOR_DENY = /(auth|token|secret|credential|password|api[_-]?key|keychain|oauth|session[_-]?storage)/i;
const CURSOR_DB_ALLOW = /(state\.vscdb|composer|chat|conversation|bubble|history|workspaceStorage|globalStorage)/i;
const CURSOR_TABLE_ALLOW = /(ItemTable|composer|chat|conversation|bubble|message|cursor)/i;
const CURSOR_KEY_ALLOW = /(composer|chat|conversation|bubble|message|ai|aichat|inlinechat|cursor|tool)/i;
const CURSOR_MAX_SQL_CELL_BYTES = 128 * 1024;

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

const tableColumns = (db: CursorDatabase, table: string) =>
  (db.query(`pragma table_info(${quoteIdent(table)})`).all() as CursorColumnRow[])
    .map((row) => row.name)
    .filter((name) => name.length > 0);

const tableRows = (db: CursorDatabase, table: string) => {
  try {
    const columns = tableColumns(db, table);
    if (columns.length === 0) return [];
    return db
      .query(`select ${cursorColumnProjection(columns)} from ${quoteIdent(table)} limit 1000`)
      .all() as Record<string, unknown>[];
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

const tableColumnsCli = (dbPath: string, table: string) =>
  sqliteJson<CursorColumnRow>(dbPath, `pragma table_info(${quoteIdent(table)})`)
    .map((row) => row.name)
    .filter((name) => name.length > 0);

const tableRowsCli = (dbPath: string, table: string) => {
  const columns = tableColumnsCli(dbPath, table);
  if (columns.length === 0) return [];
  return sqliteJson<Record<string, unknown>>(
    dbPath,
    `select ${cursorColumnProjection(columns)} from ${quoteIdent(table)} limit 1000`,
  );
};

const sqliteJson = <A>(dbPath: string, query: string): A[] => {
  try {
    const output = execFileSync("sqlite3", ["-json", dbPath, query], { encoding: "utf8" });
    return output.trim().length === 0 ? [] : (JSON.parse(output) as A[]);
  } catch {
    return [];
  }
};

const quoteIdent = (identifier: string) => `"${identifier.replaceAll('"', '""')}"`;

const cursorColumnProjection = (columns: readonly string[]) =>
  columns
    .map((column) => {
      const quoted = quoteIdent(column);
      return [
        "case",
        `when typeof(${quoted}) = 'text' and length(${quoted}) > ${CURSOR_MAX_SQL_CELL_BYTES} then '[omitted:large_cursor_cell bytes=' || length(${quoted}) || ']'`,
        `when typeof(${quoted}) = 'blob' then '[omitted:cursor_blob bytes=' || length(${quoted}) || ']'`,
        `else ${quoted} end as ${quoted}`,
      ].join(" ");
    })
    .join(", ");

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
  const ref = cursorReference(table, key, row);
  if (Array.isArray(value)) {
    return value
      .map(recordFrom)
      .map((item) => ({ ...item, _cursor: ref }))
      .filter(cursorRecordLike);
  }
  for (const nestedKey of ["messages", "conversation", "bubbles", "composerMessages", "items"]) {
    if (Array.isArray(record[nestedKey])) {
      return (record[nestedKey] as unknown[])
        .map(recordFrom)
        .map((item) => ({ ...item, _cursor: ref }))
        .filter(cursorRecordLike);
    }
  }
  const enriched = { ...record, _cursor: ref };
  return cursorRecordLike(enriched) ? [enriched] : [];
};

const cursorReference = (table: string, key: string, row: Record<string, unknown>) => ({
  table,
  key: stringValue(row.key) ?? stringValue(row.name) ?? key,
  rowId:
    stringValue(row.id) ??
    stringValue(row._id) ??
    stringValue(row.key) ??
    stringValue(row.name) ??
    stringValue(row.type),
});

const cursorRecordLike = (record: Record<string, unknown>) => {
  const type = String(record.type ?? record.kind ?? "").toLowerCase();
  const role = String(record.role ?? "").toLowerCase();
  const hasMessageRole = /^(user|assistant|developer|system|tool|thinking)$/.test(role);
  const hasContent = record.content !== undefined || record.text !== undefined || record.message !== undefined;
  const path =
    stringValue(record.path) ??
    stringValue(record.filePath) ??
    stringValue(record.file_path);
  const explicitPatchArtifact = /(diff|patch)/.test(type) && path !== undefined;
  return (hasMessageRole && hasContent) || toolNameFromRecord(record) !== undefined || explicitPatchArtifact;
};

const cursorContentFromRecord = (record: Record<string, unknown>): NativeValue | undefined => {
  const direct = contentFromRecord(record);
  if (direct !== undefined) return direct as NativeValue;

  const toolName = toolNameFromRecord(record);
  if (toolName !== undefined || record.input !== undefined || record.output !== undefined) {
    const input = projectToolPayloadNativeValue(record.input) as NativeValue | undefined;
    const output = projectToolPayloadNativeValue(record.output) as NativeValue | undefined;
    return {
      type: "tool",
      ...(toolName !== undefined ? { toolName } : {}),
      ...(input !== undefined ? { input } : {}),
      ...(output !== undefined ? { output } : {}),
    };
  }

  return undefined;
};

const cursorRecordId = (record: Record<string, unknown>, fallback: unknown) => {
  const cursor = recordFrom(record._cursor);
  return nativeIdFromRecord(record, stringValue(cursor.rowId) ?? fallback);
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
  if (!type.includes("diff") && !type.includes("patch")) {
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
    const nativeEventId = cursorRecordId(record, index);
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
    const content = cursorContentFromRecord(record);
    return {
      id: eventId,
      nativeEventId,
      sequence: index,
      timestamp: timestampFromRecord(record),
      role: roleFromRecord(record),
      kind: kindFromRecord(record),
      contentText: compactText(content),
      contentSource: content,
      ...(toolCall !== undefined ? { toolCallId: toolCall.id } : {}),
      rawReference: { sourcePath: dbPath, rowId: nativeEventId, nativeType: "sqlite" },
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
    const files = statSync(root).isFile()
      ? [root]
      : collectFiles(root, cursorDbLike, options.limit, options.skip);
    const sessions: NormalizedSession[] = [];
    for (const path of files) {
      const session = await buildCursorSession(path, root, options);
      if (session !== undefined) sessions.push(session);
    }
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
