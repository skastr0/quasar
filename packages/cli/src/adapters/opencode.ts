import { copyFileSync, existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { execFileSync } from "node:child_process";

import type {
  AdapterReadResult,
  AdapterStreamItem,
  SessionAdapter,
  UnitFingerprint,
} from "./types";
import { OpenCodeSessionId, type SessionId } from "../core/identity";
import type { Artifact, SessionEdge, SessionRole, ToolCall, UsageRecord } from "../core/schemas";
import {
  artifactIdFor,
  buildSession,
  compactText,
  edgeIdFor,
  eventIdFor,
  homePath,
  logicalRootFor,
  numberValue,
  projectToolPayloadNativeValue,
  recordFrom,
  scopedId,
  sessionIdFor,
  sourceRoot,
  type NativeValue,
  usageIdFor,
} from "./common";

const maybeDatabase = async (path: string) => {
  try {
    const { Database } = await import("bun:sqlite");
    return new Database(path);
  } catch {
    return undefined;
  }
};

type AdapterOptions = Parameters<SessionAdapter["read"]>[0];
type OpenCodeDatabase = NonNullable<Awaited<ReturnType<typeof maybeDatabase>>>;
type OpenCodeSessionRow = {
  id: string;
  title: string;
  directory: string;
  path: string | null;
  time_created: number;
  time_updated: number;
};
type OpenCodeMessageRow = {
  id: string;
  time_created: number;
  data: string;
  /** Pre-prune byte length of the raw `message.data` blob. */
  raw_bytes?: number;
};
type OpenCodePartRow = {
  id: string;
  message_id: string;
  time_created: number;
  data: string;
};
type SQLiteColumnRow = { name: string };
type SQLiteCountRow = { count: number };

// Machinery-key pruning only — never byte caps. Provider garbage surfaces as
// named diagnostics at the ingest layer.
const OPENCODE_PRUNED_MESSAGE_DATA_SQL = [
  "case",
  "when json_valid(data) then",
  "json_remove(",
  "data,",
  "'$.summary.diffs',",
  "'$.summary.diff',",
  "'$.summary.patches',",
  "'$.summary.snapshots',",
  "'$.summary.cache',",
  "'$.summary.state',",
  "'$.summary.providerCache',",
  "'$.summary.providerState',",
  "'$.summary.viewState',",
  "'$.summary.uiState',",
  "'$.summary.providerUi',",
  "'$.workspace.diffs',",
  "'$.workspace.diff',",
  "'$.workspace.patch',",
  "'$.workspace.patches',",
  "'$.workspace.cache',",
  "'$.workspace.state',",
  "'$.workspace.providerCache',",
  "'$.workspace.providerState',",
  "'$.workspace.viewState',",
  "'$.workspace.uiState',",
  "'$.workspace.providerUi',",
  "'$.workspace.snapshot',",
  "'$.workspace.snapshots',",
  "'$.workspaceDiff',",
  "'$.workspaceSnapshot',",
  "'$.checkpoint',",
  "'$.checkpoints',",
  "'$.snapshot',",
  "'$.snapshots',",
  "'$.diff',",
  "'$.diffs',",
  "'$.patch',",
  "'$.patches'",
  ")",
  "else data end",
].join(" ");

/**
 * Pre-prune byte length of the raw row — measured in SQL because the pruning
 * guards run before the data ever reaches this process. The ingest boundary
 * uses it to surface pruned-away provider garbage (e.g. a 105 MB
 * `summary.diffs` blob) as a named diagnostic instead of silently omitting it.
 */
const OPENCODE_RAW_BYTES_SQL = "length(cast(data as blob))";

const OPENCODE_PRUNED_PART_DATA_SQL = [
  "case",
  "when json_valid(data) then",
  "json_remove(",
  "data,",
  "'$.summary.diffs',",
  "'$.summary.diff',",
  "'$.summary.patches',",
  "'$.summary.snapshots',",
  "'$.summary.cache',",
  "'$.summary.state',",
  "'$.summary.providerCache',",
  "'$.summary.providerState',",
  "'$.summary.viewState',",
  "'$.summary.uiState',",
  "'$.summary.providerUi',",
  "'$.workspace.diffs',",
  "'$.workspace.diff',",
  "'$.workspace.patch',",
  "'$.workspace.patches',",
  "'$.workspace.cache',",
  "'$.workspace.state',",
  "'$.workspace.providerCache',",
  "'$.workspace.providerState',",
  "'$.workspace.viewState',",
  "'$.workspace.uiState',",
  "'$.workspace.providerUi',",
  "'$.workspace.snapshot',",
  "'$.workspace.snapshots',",
  "'$.workspaceDiff',",
  "'$.workspaceSnapshot',",
  "'$.checkpoint',",
  "'$.checkpoints',",
  "'$.snapshot',",
  "'$.snapshots',",
  "'$.diff',",
  "'$.diffs',",
  "'$.patch',",
  "'$.patches'",
  ")",
  "else data end",
].join(" ");

const toolNameFromPart = (part: unknown) => {
  if (part === null || typeof part !== "object") return undefined;
  const record = part as Record<string, unknown>;
  const type = typeof record.type === "string" ? record.type.toLowerCase() : "";
  if (!type.includes("tool") && record.tool === undefined && record.toolName === undefined) {
    return undefined;
  }
  if (typeof record.toolName === "string") return record.toolName;
  if (typeof record.tool === "string") return record.tool;
  if (typeof record.name === "string") return record.name;
  const nested = record.function ?? record.call ?? record.metadata;
  if (nested !== null && typeof nested === "object") {
    const nestedRecord = nested as Record<string, unknown>;
    if (typeof nestedRecord.name === "string") return nestedRecord.name;
  }
  return "opencode-tool";
};

type OpenCodeToolCallDraft = Omit<
  ToolCall,
  "sessionId" | "machineId" | "provider" | "agentName" | "projectIdentityKey"
>;
type OpenCodeUsageDraft = Omit<
  UsageRecord,
  "sessionId" | "machineId" | "provider" | "agentName" | "projectIdentityKey"
>;
type OpenCodeEdgeDraft = Omit<
  SessionEdge,
  "sessionId" | "machineId" | "provider" | "agentName" | "projectIdentityKey"
>;
type OpenCodeArtifactDraft = Omit<
  Artifact,
  "sessionId" | "machineId" | "provider" | "agentName" | "projectIdentityKey"
>;

const OPENCODE_DB_FILENAMES = ["opencode-local.db", "opencode.db"] as const;

const missingDatabaseResult = (root: string | undefined) => ({
  sourceRoots: [],
  sessions: [],
  diagnostics: [
    {
      adapterId: opencodeAdapter.id,
      provider: "opencode" as const,
      status: "no_data_found" as const,
      parserConfidence: "observed" as const,
      message: "OpenCode database was not found.",
      ...(root !== undefined ? { rootPath: root } : {}),
    },
  ],
});

const unsupportedRuntimeResult = (dbPath: string) => ({
  sourceRoots: [],
  sessions: [],
  diagnostics: [
    {
      adapterId: opencodeAdapter.id,
      provider: "opencode" as const,
      status: "unsupported" as const,
      parserConfidence: "observed" as const,
      rootPath: dbPath,
      message: "OpenCode SQLite import requires Bun's sqlite runtime.",
    },
  ],
});

export const opencodeSessionWindowLimit = (limit: number | undefined) =>
  limit === undefined ? -1 : Math.max(1, Math.floor(limit));
const sessionWindowSkip = (skip: number | undefined) => Math.max(0, Math.floor(skip ?? 0));

const readSessionRows = (
  db: OpenCodeDatabase,
  limit: number | undefined,
  skip: number | undefined,
) =>
  db
    .query(
      `select id, title, directory, ${sessionPathProjection(db)} as path, time_created, time_updated from session order by time_updated desc, id desc limit ? offset ?`,
    )
    .all(opencodeSessionWindowLimit(limit), sessionWindowSkip(skip)) as OpenCodeSessionRow[];

const readMessages = (db: OpenCodeDatabase, sessionId: string) =>
  db
    .query(
      `select id, time_created, ${OPENCODE_RAW_BYTES_SQL} as raw_bytes, ${OPENCODE_PRUNED_MESSAGE_DATA_SQL} as data from message where session_id = ? order by time_created, id`,
    )
    .all(sessionId) as OpenCodeMessageRow[];

const readPartsByMessage = (db: OpenCodeDatabase, sessionId: string) => {
  const rows = db
    .query(
      `select id, message_id, time_created, ${OPENCODE_PRUNED_PART_DATA_SQL} as data from part where session_id = ? order by time_created, id`,
    )
    .all(sessionId) as OpenCodePartRow[];
  const partsByMessage = new Map<string, NativeValue[]>();
  for (const part of rows) {
    const list = partsByMessage.get(part.message_id) ?? [];
    list.push(parsePartData(part.data));
    partsByMessage.set(part.message_id, list);
  }
  return partsByMessage;
};

const readSessionRowsCli = (
  dbPath: string,
  limit: number | undefined,
  skip: number | undefined,
) =>
  sqliteJson<OpenCodeSessionRow>(
    dbPath,
    `select id, title, directory, ${sessionPathProjectionCli(dbPath)} as path, time_created, time_updated from session order by time_updated desc, id desc limit ${opencodeSessionWindowLimit(limit)} offset ${sessionWindowSkip(skip)}`,
  );

export const readOpenCodeSessionRowsForWindow = (
  dbPath: string,
  limit?: number,
  skip?: number,
) => readSessionRowsCli(dbPath, limit, skip);

const readMessagesCli = (dbPath: string, sessionId: string) =>
  sqliteJson<OpenCodeMessageRow>(
    dbPath,
    `select id, time_created, ${OPENCODE_RAW_BYTES_SQL} as raw_bytes, ${OPENCODE_PRUNED_MESSAGE_DATA_SQL} as data from message where session_id = ${sql(sessionId)} order by time_created, id`,
  );

const readPartsByMessageCli = (dbPath: string, sessionId: string) => {
  const rows = sqliteJson<OpenCodePartRow>(
    dbPath,
    `select id, message_id, time_created, ${OPENCODE_PRUNED_PART_DATA_SQL} as data from part where session_id = ${sql(sessionId)} order by time_created, id`,
  );
  const partsByMessage = new Map<string, NativeValue[]>();
  for (const part of rows) {
    const list = partsByMessage.get(part.message_id) ?? [];
    list.push(parsePartData(part.data));
    partsByMessage.set(part.message_id, list);
  }
  return partsByMessage;
};

const sqliteJson = <A>(dbPath: string, query: string): A[] => {
  try {
    const output = execFileSync("sqlite3", ["-json", dbPath, query], { encoding: "utf8" });
    return output.trim().length === 0 ? [] : (JSON.parse(output) as A[]);
  } catch {
    return [];
  }
};

const sql = (value: string) => `'${value.replaceAll("'", "''")}'`;

const hasSqliteSessionColumn = (db: OpenCodeDatabase, column: "path") =>
  (db.query("pragma table_info(session)").all() as SQLiteColumnRow[]).some(
    (row) => row.name === column,
  );

const hasSqliteSessionColumnCli = (dbPath: string, column: "path") =>
  sqliteJson<SQLiteColumnRow>(dbPath, "pragma table_info(session)").some(
    (row) => row.name === column,
  );

const sessionPathProjection = (db: OpenCodeDatabase) =>
  hasSqliteSessionColumn(db, "path") ? "path" : "directory";

const sessionPathProjectionCli = (dbPath: string) =>
  hasSqliteSessionColumnCli(dbPath, "path") ? "path" : "directory";

const readSessionCountCli = (dbPath: string) => {
  const [row] = sqliteJson<SQLiteCountRow>(dbPath, "select count(*) as count from session");
  return typeof row?.count === "number" && Number.isFinite(row.count) ? row.count : undefined;
};

const parsePartData = (data: string): NativeValue => {
  try {
    return JSON.parse(data) as NativeValue;
  } catch {
    return data;
  }
};

const parseMessageData = (message: OpenCodeMessageRow) => {
  try {
    return JSON.parse(message.data) as Record<string, NativeValue | undefined>;
  } catch {
    return { content: message.data };
  }
};

const summaryMetadata = (value: unknown): NativeValue | undefined => {
  const summary = recordFrom(value);
  if (Object.keys(summary).length === 0) return undefined;
  const allowed = new Set(["text", "content", "message", "title"]);
  return Object.fromEntries(
    Object.entries(summary)
      .filter(([key]) => allowed.has(key))
      .filter(([, item]) =>
        typeof item === "string" ||
        typeof item === "number" ||
        typeof item === "boolean"
      )
      .filter(([, item]) => item !== undefined),
  ) as NativeValue;
};

/**
 * Part types that are agent machinery, not session turns: lifecycle markers,
 * compaction records, and file attachments. They never project into message
 * content (the search surface); diff/patch parts are likewise machinery and
 * already surface separately as artifacts.
 */
const MACHINERY_PART_TYPES = new Set(["step-start", "step-finish", "compaction", "file"]);

const partContentProjection = (part: NativeValue): NativeValue | undefined => {
  const record = recordFrom(part);
  if (Object.keys(record).length === 0) return typeof part === "string" ? part : undefined;
  const type = typeof record.type === "string" ? record.type : undefined;
  const lowerType = type?.toLowerCase() ?? "";
  if (lowerType.includes("diff") || lowerType.includes("patch")) return undefined;
  if (MACHINERY_PART_TYPES.has(lowerType)) return undefined;
  const rawText =
    typeof record.text === "string"
      ? record.text
      : typeof record.content === "string"
        ? record.content
        : typeof record.message === "string"
          ? record.message
          : undefined;
  // Blank text is absent text: the measured corpus holds thousands of
  // encrypted-reasoning stubs ({"type":"reasoning","text":""}) whose plaintext
  // is empty — the actual reasoning lives encrypted in metadata.
  const text = rawText !== undefined && rawText.trim().length > 0 ? rawText : undefined;
  const toolName = toolNameFromPart(record);
  // A part with neither session text nor a tool identity is machinery, not a
  // turn: it never projects, so a JSON dump of its bare envelope (e.g.
  // {"type":"reasoning"}) can never reach the search surface.
  if (text === undefined && toolName === undefined) return undefined;
  const path =
    typeof record.path === "string"
      ? record.path
      : typeof record.file === "string"
        ? record.file
        : typeof record.filePath === "string"
          ? record.filePath
          : undefined;
  // Reasoning parts are plaintext thinking: project under the `thinking` key
  // so the shared block builder emits `kind: "thinking"` blocks, which the
  // ingest layer promotes to `role: "reasoning"` rows.
  const textKey = lowerType === "reasoning" ? "thinking" : "text";
  return {
    ...(type !== undefined ? { type } : {}),
    ...(text !== undefined ? { [textKey]: text } : {}),
    ...(path !== undefined ? { path } : {}),
    ...(toolName !== undefined ? { toolName } : {}),
    ...(typeof record.callID === "string" ? { callID: record.callID } : {}),
    ...(typeof record.id === "string" ? { id: record.id } : {}),
  };
};

const messageContentProjection = (
  data: Record<string, NativeValue | undefined>,
  parts: NativeValue[],
): NativeValue => {
  const role = typeof data.role === "string" ? data.role : undefined;
  const content =
    typeof data.content === "string"
      ? data.content
      : typeof data.text === "string"
        ? data.text
        : typeof data.message === "string"
          ? data.message
          : undefined;
  const projectedParts = parts.flatMap((part) => {
    const projected = partContentProjection(part);
    return projected === undefined ? [] : [projected];
  });
  const summary = summaryMetadata(data.summary);
  return {
    ...(role !== undefined ? { role } : {}),
    ...(content !== undefined ? { content } : {}),
    ...(summary !== undefined ? { summary } : {}),
    ...(projectedParts.length > 0 ? { parts: projectedParts } : {}),
  };
};

const toolStatusFromPart = (part: Record<string, unknown>) => {
  const state = recordFrom(part.state);
  return typeof state.status === "string"
    ? state.status
    : typeof part.status === "string"
      ? part.status
      : undefined;
};

const collectToolCalls = (
  parts: NativeValue[],
  sessionId: SessionId,
  messageId: string,
  eventId: string,
) =>
  parts.flatMap((part, partIndex) => {
    const toolName = toolNameFromPart(part);
    if (toolName === undefined) return [];
    const record = recordFrom(part);
    const state = recordFrom(record.state);
    const partId =
      typeof record.callID === "string"
        ? record.callID
        : typeof record.id === "string"
          ? record.id
          : partIndex;
    const startedAt =
      typeof record.time_created === "string"
        ? record.time_created
        : dateFromNestedTime(state.time, "start");
    const completedAt = dateFromNestedTime(state.time, "end");
    const input = projectToolPayloadNativeValue(state.input ?? record.input);
    const output = projectToolPayloadNativeValue(state.output ?? record.output);
    return [
      {
        id: scopedId(sessionId, "tool", messageId, partId),
        eventId,
        toolName,
        status: toolStatusFromPart(record),
        ...(input !== undefined ? { input } : {}),
        ...(output !== undefined ? { output } : {}),
        ...(startedAt !== undefined ? { startedAt } : {}),
        ...(completedAt !== undefined ? { completedAt } : {}),
      },
    ];
  });

const dateFromNestedTime = (value: unknown, key: string) => {
  const time = recordFrom(value);
  const millis = numberValue(time[key]);
  return millis === undefined ? undefined : new Date(millis).toISOString();
};

const usageFromMessage = (
  sessionId: SessionId,
  eventId: string,
  index: number,
  data: Record<string, NativeValue | undefined>,
): OpenCodeUsageDraft | undefined => {
  const tokens = recordFrom(data.tokens);
  const hasTokens = Object.keys(tokens).length > 0;
  const cost = numberValue(data.cost);
  if (!hasTokens && cost === undefined) return undefined;
  const cache = recordFrom(tokens.cache);
  const inputTokens = numberValue(tokens.input);
  const outputTokens = numberValue(tokens.output);
  const reasoningTokens = numberValue(tokens.reasoning);
  const totalTokens =
    numberValue(tokens.total) ?? sumNumbers([inputTokens, outputTokens, reasoningTokens]);
  return {
    id: usageIdFor(sessionId, eventId, index),
    eventId,
    timestamp: dateFromNestedTime(data.time, "created"),
    model: typeof data.modelID === "string" ? data.modelID : undefined,
    modelProvider: typeof data.providerID === "string" ? data.providerID : undefined,
    inputTokens,
    outputTokens,
    reasoningTokens,
    cacheCreationInputTokens: numberValue(cache.write),
    cacheReadInputTokens: numberValue(cache.read),
    totalTokens,
    cost,
  };
};

const sumNumbers = (values: readonly (number | undefined)[]) => {
  const present = values.filter((value): value is number => value !== undefined);
  return present.length === 0
    ? undefined
    : present.reduce((sum, value) => sum + value, 0);
};

const collectArtifacts = (
  sessionId: SessionId,
  dbPath: string,
  eventId: string,
  parts: NativeValue[],
): OpenCodeArtifactDraft[] =>
  parts.flatMap((part, index) => {
    const record = recordFrom(part);
    const type = typeof record.type === "string" ? record.type.toLowerCase() : "";
    if (!type.includes("diff") && !type.includes("patch")) return [];
    const path = typeof record.path === "string" ? record.path : undefined;
    if (path === undefined) return [];
    return [
      {
        id: artifactIdFor(sessionId, [eventId, index, path, type]),
        eventId,
        kind: type || "diff",
        ...(path !== undefined ? { path } : {}),
        sourcePath: dbPath,
        sourceRef: { table: "part", eventId, index },
      },
    ];
  });

const eventFromMessage = (
  dbPath: string,
  message: OpenCodeMessageRow,
  index: number,
  parts: NativeValue[],
  sessionId: SessionId,
) => {
  const data = parseMessageData(message);
  const content = messageContentProjection(data, parts);
  // Machinery-only turns (step markers, compaction, patches) project to a
  // bare role envelope; without content or parts there is no session text,
  // so no content surfaces (a JSON dump of the envelope is not a turn).
  const contentRecord = recordFrom(content);
  const hasTurnContent =
    contentRecord.content !== undefined || contentRecord.parts !== undefined;
  const role: SessionRole =
    data.role === "assistant" || data.role === "user" ? data.role : "unknown";
  const eventId = eventIdFor(sessionId, index, message.id);
  return {
    eventId,
    parentId: typeof data.parentID === "string" ? data.parentID : undefined,
    toolCalls: collectToolCalls(parts, sessionId, message.id, eventId),
    usageRecord: usageFromMessage(sessionId, eventId, index, data),
    artifacts: collectArtifacts(sessionId, dbPath, eventId, parts),
    event: {
      id: eventId,
      nativeEventId: message.id,
      sequence: index,
      timestamp: new Date(message.time_created).toISOString(),
      role,
      kind: parts.some((part) => toolNameFromPart(part) !== undefined) ? ("tool_call" as const) : ("message" as const),
      ...(hasTurnContent
        ? { contentText: compactText(content as NativeValue), contentSource: content }
        : {}),
      rawReference: {
        sourcePath: dbPath,
        table: "message",
        rowId: message.id,
        nativeType: "message",
        ...(typeof message.raw_bytes === "number" && Number.isFinite(message.raw_bytes)
          ? { rawBytes: message.raw_bytes }
          : {}),
      },
    },
  };
};

const buildOpenCodeSession = (
  db: OpenCodeDatabase,
  dbPath: string,
  root: string,
  options: AdapterOptions,
  sessionRow: OpenCodeSessionRow,
) => {
  const partsByMessage = readPartsByMessage(db, sessionRow.id);
  return buildOpenCodeSessionFromRows(
    dbPath,
    root,
    options,
    sessionRow,
    readMessages(db, sessionRow.id),
    partsByMessage,
  );
};

const buildOpenCodeSessionFromRows = (
  dbPath: string,
  root: string,
  options: AdapterOptions,
  sessionRow: OpenCodeSessionRow,
  messages: OpenCodeMessageRow[],
  partsByMessage: Map<string, NativeValue[]>,
) => {
  const toolCalls: Omit<ToolCall, "sessionId" | "machineId" | "provider" | "agentName" | "projectIdentityKey">[] = [];
  const usageRecords: OpenCodeUsageDraft[] = [];
  const sessionEdges: OpenCodeEdgeDraft[] = [];
  const artifacts: OpenCodeArtifactDraft[] = [];
  const nativeSessionId = OpenCodeSessionId(sessionRow.id);
  const sessionId = sessionIdFor("opencode", nativeSessionId);
  const messageIdToEventId = new Map<string, string>();
  const events = messages.map((message, index) => {
    const result = eventFromMessage(
      dbPath,
      message,
      index,
      partsByMessage.get(message.id) ?? [],
      sessionId,
    );
    messageIdToEventId.set(message.id, result.eventId);
    if (result.parentId !== undefined) {
      const parentEventId = messageIdToEventId.get(result.parentId);
      sessionEdges.push({
        id: edgeIdFor(sessionId, "parent", result.parentId, message.id),
        kind: "parent",
        ...(parentEventId !== undefined ? { fromEventId: parentEventId } : { fromId: result.parentId }),
        toEventId: result.eventId,
        rawReference: { sourcePath: dbPath, table: "message", rowId: message.id, nativeType: "parentID" },
      });
    }
    toolCalls.push(...result.toolCalls);
    if (result.usageRecord !== undefined) usageRecords.push(result.usageRecord);
    artifacts.push(...result.artifacts);
    return result.event;
  });
  return buildSession({
    provider: "opencode",
    agentName: "opencode",
    machine: options.machine,
    sessionId,
    nativeSessionId,
    nativeProjectKey: sessionRow.directory,
    title: sessionRow.title,
    sourceRoot: root,
    sourcePath: dbPath,
    projectPath: sessionRow.path ?? sessionRow.directory,
    events,
    toolCalls,
    sessionEdges,
    usageRecords,
    artifacts,
  });
};

const buildOpenCodeSessionCli = (
  queryDbPath: string,
  sourceDbPath: string,
  root: string,
  options: AdapterOptions,
  sessionRow: OpenCodeSessionRow,
) =>
  buildOpenCodeSessionFromRows(
    sourceDbPath,
    root,
    options,
    sessionRow,
    readMessagesCli(queryDbPath, sessionRow.id),
    readPartsByMessageCli(queryDbPath, sessionRow.id),
  );

const copyDatabaseForRead = (dbPath: string) => {
  const tempDir = mkdtempSync(join(tmpdir(), "quasar-opencode-"));
  const tempDbPath = join(tempDir, "opencode.db");
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

const opencodeDbPath = (root: string | undefined) => {
  if (root === undefined) return undefined;
  try {
    if (statSync(root).isFile()) return root;
  } catch {
    // Fall through to conventional directory candidates.
  }
  const candidates = OPENCODE_DB_FILENAMES.flatMap((filename, index) => {
    const path = join(root, filename);
    if (!existsSync(path)) return [];
    return [{ path, index, sessionCount: readSessionCountCli(path) }];
  });
  if (candidates.length > 0) {
    return candidates.sort((left, right) => {
      const countDiff = (right.sessionCount ?? -1) - (left.sessionCount ?? -1);
      return countDiff === 0 ? left.index - right.index : countDiff;
    })[0]?.path;
  }
  return join(root, "opencode.db");
};

const logicalOpencodeDbPath = (
  root: string | undefined,
  logicalRoot: string | undefined,
  dbPath: string | undefined,
) => {
  if (logicalRoot === undefined || dbPath === undefined) return undefined;
  if (root !== undefined) {
    try {
      if (statSync(root).isFile()) return logicalRoot;
    } catch {
      // Treat missing roots as directories for diagnostics.
    }
  }
  return join(logicalRoot, basename(dbPath));
};

/**
 * Per-session change signal. All opencode sessions live in one shared db
 * file, so a file-level stat fingerprint would mismatch for every session
 * whenever any single one is touched — forcing a full-estate re-ingest. The
 * session row's own time_updated is the per-session signal.
 */
const opencodeSessionFingerprint = (row: OpenCodeSessionRow): UnitFingerprint | undefined =>
  typeof row.time_updated === "number" ? { mtimeMs: row.time_updated } : undefined;

/**
 * Cheap pre-parse gate for a shared-db session: the session row already
 * carries its own change signal (time_updated), so the message/parts read can
 * be skipped without touching them. The probe's sourceFingerprint equals what
 * the engine derives from `item.fingerprint` (JSON.stringify of the same unit
 * fingerprint); when no per-session fingerprint exists the engine falls back
 * to a file stat the probe cannot match, so the gate is not consulted.
 */
const skipOpenCodeSession = async (
  options: AdapterOptions,
  sessionEntry: OpenCodeSessionRow,
  sourcePath: string,
): Promise<boolean> => {
  if (options.shouldParseSession === undefined) return false;
  const fingerprint = opencodeSessionFingerprint(sessionEntry);
  if (fingerprint === undefined) return false;
  const probe = {
    sessionId: sessionIdFor("opencode", OpenCodeSessionId(sessionEntry.id)),
    sourceFingerprint: JSON.stringify(fingerprint),
  };
  return (await options.shouldParseSession(probe)) === false;
};

async function* streamOpenCode(options: AdapterOptions): AsyncGenerator<AdapterStreamItem> {
  const root = options.roots?.opencode ?? opencodeAdapter.defaultRoot();
  const dbPath = opencodeDbPath(root);
  const logicalRoot = root === undefined ? undefined : logicalRootFor("opencode", root, options);
  const logicalDbPath = logicalOpencodeDbPath(root, logicalRoot, dbPath);
  if (root === undefined || dbPath === undefined || !existsSync(dbPath)) {
    for (const diagnostic of missingDatabaseResult(logicalRoot ?? root).diagnostics) {
      yield { type: "diagnostic", diagnostic };
    }
    return;
  }
  const tempDb = copyDatabaseForRead(dbPath);
  const db = await maybeDatabase(tempDb.path);
  if (db === undefined) {
    try {
      const rows = readSessionRowsCli(tempDb.path, options.limit, options.skip);
      if (rows.length === 0) {
        for (const diagnostic of unsupportedRuntimeResult(dbPath).diagnostics) {
          yield { type: "diagnostic", diagnostic };
        }
        return;
      }
      yield {
        type: "sourceRoot",
        sourceRoot: sourceRoot("opencode", opencodeAdapter.id, logicalRoot ?? root, options.machine, options.now),
      };
      let sessionCount = 0;
      for (const sessionEntry of rows) {
        if (await skipOpenCodeSession(options, sessionEntry, logicalDbPath ?? dbPath)) continue;
        const session = buildOpenCodeSessionCli(
          tempDb.path,
          logicalDbPath ?? dbPath,
          logicalRoot ?? root,
          options,
          sessionEntry,
        );
        const fingerprint = opencodeSessionFingerprint(sessionEntry);
        yield {
          type: "session",
          session,
          sourceUnit: {
            provider: "opencode" as const,
            adapterId: opencodeAdapter.id,
            rootPath: logicalRoot ?? root,
            sourcePath: session.sourcePath,
            physicalPath: dbPath,
          },
          ...(fingerprint !== undefined ? { fingerprint } : {}),
        };
        sessionCount += 1;
      }
      yield {
        type: "diagnostic",
        diagnostic: {
          adapterId: opencodeAdapter.id,
          provider: "opencode" as const,
          status: "available" as const,
          parserConfidence: "observed" as const,
          rootPath: logicalDbPath ?? dbPath,
          message: `Discovered ${sessionCount} OpenCode session(s) via sqlite3 fallback.`,
        },
      };
    } finally {
      tempDb.cleanup();
    }
    return;
  }
  try {
    yield {
      type: "sourceRoot",
      sourceRoot: sourceRoot("opencode", opencodeAdapter.id, logicalRoot ?? root, options.machine, options.now),
    };
    let sessionCount = 0;
    for (const sessionEntry of readSessionRows(db, options.limit, options.skip)) {
      if (await skipOpenCodeSession(options, sessionEntry, logicalDbPath ?? dbPath)) continue;
      const session = buildOpenCodeSession(
        db,
        logicalDbPath ?? dbPath,
        logicalRoot ?? root,
        options,
        sessionEntry,
      );
      const fingerprint = opencodeSessionFingerprint(sessionEntry);
      yield {
        type: "session",
        session,
        sourceUnit: {
          provider: "opencode" as const,
          adapterId: opencodeAdapter.id,
          rootPath: logicalRoot ?? root,
          sourcePath: session.sourcePath,
          physicalPath: dbPath,
        },
        ...(fingerprint !== undefined ? { fingerprint } : {}),
      };
      sessionCount += 1;
    }
    yield {
      type: "diagnostic",
      diagnostic: {
        adapterId: opencodeAdapter.id,
        provider: "opencode" as const,
        status: sessionCount > 0 ? ("available" as const) : ("no_data_found" as const),
        parserConfidence: "observed" as const,
        rootPath: logicalDbPath ?? dbPath,
        message: `Discovered ${sessionCount} OpenCode session(s).`,
      },
    };
  } finally {
    db.close();
    tempDb.cleanup();
  }
}

const readOpenCode = async (options: AdapterOptions): Promise<AdapterReadResult> => {
  const result: AdapterReadResult = {
    sourceRoots: [],
    sessions: [],
    diagnostics: [],
  };
  for await (const item of streamOpenCode(options)) {
    switch (item.type) {
      case "sourceRoot":
        result.sourceRoots.push(item.sourceRoot);
        break;
      case "session":
        result.sessions.push(item.session);
        break;
      case "diagnostic":
        result.diagnostics.push(item.diagnostic);
        break;
    }
  }
  return result;
};

export const opencodeAdapter: SessionAdapter = {
  id: "opencode-sqlite",
  provider: "opencode",
  displayName: "OpenCode SQLite",
  stable: true,
  defaultRoot: () => homePath(".local/share/opencode"),
  read: readOpenCode,
  stream: streamOpenCode,
};
