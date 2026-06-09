import { copyFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

import type { SessionAdapter } from "./types";
import type { Artifact, SessionEdge, SessionRole, ToolCall, UsageRecord } from "../schemas";
import {
  artifactIdFor,
  buildSession,
  compactText,
  edgeIdFor,
  eventIdFor,
  homePath,
  numberValue,
  recordFrom,
  scopedId,
  sourceRoot,
  type NativeValue,
  usageIdFor,
} from "./common";

const maybeDatabase = async (path: string) => {
  try {
    const { Database } = await import("bun:sqlite");
    return new Database(path, { readonly: true });
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
type OpenCodeMessageRow = { id: string; time_created: number; data: string };
type OpenCodePartRow = {
  id: string;
  message_id: string;
  time_created: number;
  data: string;
};

const OPENCODE_PRUNED_MESSAGE_DATA_SQL = [
  "case when json_valid(data) then",
  "json_remove(",
  "data,",
  "'$.summary.diffs',",
  "'$.summary.diff',",
  "'$.summary.patches',",
  "'$.summary.snapshots',",
  "'$.workspace.diffs',",
  "'$.workspace.snapshot',",
  "'$.workspace.snapshots',",
  "'$.workspaceDiff',",
  "'$.workspaceSnapshot',",
  "'$.checkpoint',",
  "'$.checkpoints',",
  "'$.snapshot',",
  "'$.snapshots',",
  "'$.diffs',",
  "'$.patches'",
  ") else data end",
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

const readSessionRows = (db: OpenCodeDatabase, limit: number | undefined) =>
  db
    .query(
      "select id, title, directory, path, time_created, time_updated from session order by time_updated desc limit ?",
    )
    .all(limit ?? 500) as OpenCodeSessionRow[];

const readMessages = (db: OpenCodeDatabase, sessionId: string) =>
  db
    .query(
      `select id, time_created, ${OPENCODE_PRUNED_MESSAGE_DATA_SQL} as data from message where session_id = ? order by time_created, id`,
    )
    .all(sessionId) as OpenCodeMessageRow[];

const readPartsByMessage = (db: OpenCodeDatabase, sessionId: string) => {
  const rows = db
    .query(
      "select id, message_id, time_created, data from part where session_id = ? order by time_created, id",
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

const readSessionRowsCli = (dbPath: string, limit: number | undefined) =>
  sqliteJson<OpenCodeSessionRow>(
    dbPath,
    `select id, title, directory, path, time_created, time_updated from session order by time_updated desc limit ${Math.max(1, Math.floor(limit ?? 500))}`,
  );

const readMessagesCli = (dbPath: string, sessionId: string) =>
  sqliteJson<OpenCodeMessageRow>(
    dbPath,
    `select id, time_created, ${OPENCODE_PRUNED_MESSAGE_DATA_SQL} as data from message where session_id = ${sql(sessionId)} order by time_created, id`,
  );

const readPartsByMessageCli = (dbPath: string, sessionId: string) => {
  const rows = sqliteJson<OpenCodePartRow>(
    dbPath,
    `select id, message_id, time_created, data from part where session_id = ${sql(sessionId)} order by time_created, id`,
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
  return Object.fromEntries(
    Object.entries(summary)
      .filter(([key]) => !/diffs?|patches?|snapshots?|checkpoint/i.test(key))
      .filter(([, item]) => item !== undefined),
  ) as NativeValue;
};

const partContentProjection = (part: NativeValue): NativeValue | undefined => {
  const record = recordFrom(part);
  if (Object.keys(record).length === 0) return typeof part === "string" ? part : undefined;
  const type = typeof record.type === "string" ? record.type : undefined;
  const text =
    typeof record.text === "string"
      ? record.text
      : typeof record.content === "string"
        ? record.content
        : typeof record.message === "string"
          ? record.message
          : undefined;
  const path =
    typeof record.path === "string"
      ? record.path
      : typeof record.file === "string"
        ? record.file
        : typeof record.filePath === "string"
          ? record.filePath
          : undefined;
  const projected = {
    ...(type !== undefined ? { type } : {}),
    ...(text !== undefined ? { text } : {}),
    ...(path !== undefined ? { path } : {}),
    ...(toolNameFromPart(record) !== undefined ? { toolName: toolNameFromPart(record) } : {}),
    ...(typeof record.callID === "string" ? { callID: record.callID } : {}),
    ...(typeof record.id === "string" ? { id: record.id } : {}),
  };
  return Object.keys(projected).length === 0 ? undefined : projected;
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
  machineId: string,
  sourcePath: string,
  nativeSessionId: string,
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
    return [
      {
        id: scopedId("opencode", machineId, sourcePath, "tool", nativeSessionId, messageId, partId),
        eventId,
        toolName,
        status: toolStatusFromPart(record),
        input: state.input ?? record.input,
        output: state.output ?? record.output,
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
  machineId: string,
  dbPath: string,
  nativeSessionId: string,
  messageId: string,
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
    id: usageIdFor("opencode", machineId, dbPath, nativeSessionId, eventId, index),
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
    raw: { messageId, tokens, cost },
  };
};

const sumNumbers = (values: readonly (number | undefined)[]) => {
  const present = values.filter((value): value is number => value !== undefined);
  return present.length === 0
    ? undefined
    : present.reduce((sum, value) => sum + value, 0);
};

const collectArtifacts = (
  machineId: string,
  dbPath: string,
  nativeSessionId: string,
  eventId: string,
  parts: NativeValue[],
): OpenCodeArtifactDraft[] =>
  parts.flatMap((part, index) => {
    const record = recordFrom(part);
    const type = typeof record.type === "string" ? record.type.toLowerCase() : "";
    if (!type.includes("diff") && !type.includes("patch")) return [];
    const path = typeof record.path === "string" ? record.path : undefined;
    return [
      {
        id: artifactIdFor("opencode", machineId, dbPath, nativeSessionId, [eventId, index, path, type]),
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
  machineId: string,
  nativeSessionId: string,
) => {
  const data = parseMessageData(message);
  const content = messageContentProjection(data, parts);
  const role: SessionRole =
    data.role === "assistant" || data.role === "user" ? data.role : "unknown";
  const eventId = eventIdFor("opencode", machineId, dbPath, index, message.id);
  return {
    eventId,
    parentId: typeof data.parentID === "string" ? data.parentID : undefined,
    toolCalls: collectToolCalls(parts, machineId, dbPath, nativeSessionId, message.id, eventId),
    usageRecord: usageFromMessage(machineId, dbPath, nativeSessionId, message.id, eventId, index, data),
    artifacts: collectArtifacts(machineId, dbPath, nativeSessionId, eventId, parts),
    event: {
      id: eventId,
      nativeEventId: message.id,
      sequence: index,
      timestamp: new Date(message.time_created).toISOString(),
      role,
      kind: parts.some((part) => toolNameFromPart(part) !== undefined) ? ("tool_call" as const) : ("message" as const),
      contentText: compactText(content as NativeValue),
      content,
      rawReference: { sourcePath: dbPath, table: "message", rowId: message.id, nativeType: "message" },
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
  const messageIdToEventId = new Map<string, string>();
  const events = messages.map((message, index) => {
    const result = eventFromMessage(
      dbPath,
      message,
      index,
      partsByMessage.get(message.id) ?? [],
      options.machine.machineId,
      sessionRow.id,
    );
    messageIdToEventId.set(message.id, result.eventId);
    if (result.parentId !== undefined) {
      const parentEventId = messageIdToEventId.get(result.parentId);
      sessionEdges.push({
        id: edgeIdFor("opencode", options.machine.machineId, dbPath, "parent", result.parentId, message.id),
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
    nativeSessionId: sessionRow.id,
    nativeProjectKey: sessionRow.directory,
    title: sessionRow.title,
    sourceRoot: root,
    sourcePath: dbPath,
    projectPath: sessionRow.path ?? sessionRow.directory,
    rawMetadata: sessionRow as unknown as NativeValue,
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

const readOpenCode = async (options: AdapterOptions) => {
  const root = options.roots?.opencode ?? opencodeAdapter.defaultRoot();
  const dbPath = root === undefined ? undefined : join(root, "opencode.db");
  if (root === undefined || dbPath === undefined || !existsSync(dbPath)) {
    return missingDatabaseResult(root);
  }
  const tempDb = copyDatabaseForRead(dbPath);
  const db = await maybeDatabase(tempDb.path);
  if (db === undefined) {
    const sessions = readSessionRowsCli(tempDb.path, options.limit).map((row) =>
      buildOpenCodeSessionCli(tempDb.path, dbPath, root, options, row),
    );
    tempDb.cleanup();
    if (sessions.length === 0) return unsupportedRuntimeResult(dbPath);
    return {
      sourceRoots: [sourceRoot("opencode", opencodeAdapter.id, root, options.machine, options.now)],
      sessions,
      diagnostics: [
        {
          adapterId: opencodeAdapter.id,
          provider: "opencode" as const,
          status: "available" as const,
          parserConfidence: "observed" as const,
          rootPath: dbPath,
          message: `Discovered ${sessions.length} OpenCode session(s) via sqlite3 fallback.`,
        },
      ],
    };
  }
  let sessions;
  try {
    sessions = readSessionRows(db, options.limit).map((row) =>
      buildOpenCodeSession(db, dbPath, root, options, row),
    );
  } finally {
    db.close();
    tempDb.cleanup();
  }
  return {
    sourceRoots: [sourceRoot("opencode", opencodeAdapter.id, root, options.machine, options.now)],
    sessions,
    diagnostics: [
      {
        adapterId: opencodeAdapter.id,
        provider: "opencode" as const,
        status: sessions.length > 0 ? ("available" as const) : ("no_data_found" as const),
        parserConfidence: "observed" as const,
        rootPath: dbPath,
        message: `Discovered ${sessions.length} OpenCode session(s).`,
      },
    ],
  };
};

export const opencodeAdapter: SessionAdapter = {
  id: "opencode-sqlite",
  provider: "opencode",
  displayName: "OpenCode SQLite",
  stable: true,
  defaultRoot: () => homePath(".local/share/opencode"),
  read: readOpenCode,
};
