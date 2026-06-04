import { existsSync } from "node:fs";
import { join } from "node:path";

import type { SessionAdapter } from "./types";
import type { SessionRole, ToolCall } from "../schemas";
import {
  buildSession,
  compactText,
  eventIdFor,
  homePath,
  readJsonFile,
  sourceRoot,
  type NativeValue,
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

const missingDatabaseResult = (root: string | undefined) => ({
  sourceRoots: [],
  sessions: [],
  diagnostics: [
    {
      adapterId: opencodeAdapter.id,
      provider: "opencode" as const,
      status: "no_data_found" as const,
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
      "select id, time_created, data from message where session_id = ? order by time_created, id",
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
    return { raw: message.data };
  }
};

const collectToolCalls = (
  parts: NativeValue[],
  messageId: string,
  eventId: string,
) =>
  parts.flatMap((part, partIndex) => {
    const toolName = toolNameFromPart(part);
    return toolName === undefined
      ? []
      : [{ id: `opencode:tool:${messageId}:${partIndex}`, eventId, toolName, input: part, raw: part }];
  });

const eventFromMessage = (
  dbPath: string,
  message: OpenCodeMessageRow,
  index: number,
  parts: NativeValue[],
) => {
  const data = parseMessageData(message);
  const content = { message: data, parts };
  const role: SessionRole =
    data.role === "assistant" || data.role === "user" ? data.role : "unknown";
  const eventId = eventIdFor("opencode", dbPath, index, message.id);
  return {
    eventId,
    toolCalls: collectToolCalls(parts, message.id, eventId),
    event: {
      id: eventId,
      nativeEventId: message.id,
      sequence: index,
      timestamp: new Date(message.time_created).toISOString(),
      role,
      kind: "message" as const,
      contentText: compactText(content as NativeValue),
      content,
      rawReference: { sourcePath: dbPath, table: "message", rowId: message.id, nativeType: "message" },
      raw: content,
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
  const toolCalls: Omit<ToolCall, "sessionId" | "machineId" | "provider" | "agentName" | "projectIdentityKey">[] = [];
  const events = readMessages(db, sessionRow.id).map((message, index) => {
    const result = eventFromMessage(dbPath, message, index, partsByMessage.get(message.id) ?? []);
    toolCalls.push(...result.toolCalls);
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
  });
};

const readOpenCode = async (options: AdapterOptions) => {
  const root = options.roots?.opencode ?? opencodeAdapter.defaultRoot();
  const dbPath = root === undefined ? undefined : join(root, "opencode.db");
  if (root === undefined || dbPath === undefined || !existsSync(dbPath)) {
    return missingDatabaseResult(root);
  }
  const db = await maybeDatabase(dbPath);
  if (db === undefined) return unsupportedRuntimeResult(dbPath);
  const sessions = readSessionRows(db, options.limit).map((row) =>
    buildOpenCodeSession(db, dbPath, root, options, row),
  );
  db.close();
  return {
    sourceRoots: [sourceRoot("opencode", opencodeAdapter.id, root, options.machine, options.now)],
    sessions,
    diagnostics: [
      {
        adapterId: opencodeAdapter.id,
        provider: "opencode" as const,
        status: sessions.length > 0 ? ("available" as const) : ("no_data_found" as const),
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
