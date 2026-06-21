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
  stringValue,
  type NativeValue,
  usageIdFor,
} from "./common";
import { type DecodeDiagnostic, isSignal, type SignalDecision } from "./harness-schema";
import {
  classifyOpenCodeMessage,
  classifyOpenCodePart,
  decodeMessageRows,
  decodeSessionRows,
  type OpenCodeMessageRow,
  type OpenCodePart,
  type OpenCodePartKind,
  type OpenCodeRawRow,
  type OpenCodeSessionRow,
} from "./opencode-schema";

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
type OpenCodePartRow = {
  id: string;
  message_id: string;
  time_created: number;
  data: string;
};
type SQLiteColumnRow = { name: string };
type SQLiteCountRow = { count: number };

/**
 * A part row after declarative per-record-type dispatch (QSR-220). The raw
 * parsed payload is retained for field projection, but EVERY downstream
 * decision (does it project as turn content? is it a tool call? an artifact?)
 * reads `decision` — the schema-driven signal/drop verdict — never an ad-hoc
 * string/shape heuristic. `decision` is a drop (with a named reason) for
 * machinery parts and for malformed/unrecognised-type parts.
 */
type ClassifiedPart = {
  readonly raw: NativeValue;
  readonly decision: SignalDecision<OpenCodePart, OpenCodePartKind>;
};

/** The signal arm: a kept part with its mapped kind + decoded value. */
type SignalPart = ClassifiedPart & {
  readonly decision: { readonly _tag: "signal"; readonly kind: OpenCodePartKind; readonly value: OpenCodePart };
};

const isSignalPart = (part: ClassifiedPart): part is SignalPart => isSignal(part.decision);

const partKind = (part: ClassifiedPart): OpenCodePartKind | undefined =>
  isSignal(part.decision) ? part.decision.kind : undefined;

/**
 * Classify one parsed part payload through the schema-driven dispatch, routing
 * malformed/unrecognised parts to a NAMED diagnostic + drop (never a throw,
 * never a silent unknown pass-through).
 */
const classifyPart = (raw: NativeValue, diagnostics: DecodeDiagnostic[]): ClassifiedPart => ({
  raw,
  decision: classifyOpenCodePart(raw, diagnostics),
});

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

/**
 * The tool name of a part — derived from the schema-validated `tool` field of a
 * part the classifier already mapped to a tool kind. This is no longer a
 * shape/string heuristic: a part is "a tool" iff `classifyOpenCodePart` mapped
 * it to `tool_call`/`tool_result`, and the name is the decoded `tool` field.
 */
const toolNameFromSignalPart = (part: SignalPart): string | undefined => {
  const kind = part.decision.kind;
  if (kind !== "tool_call" && kind !== "tool_result") return undefined;
  const value = part.decision.value;
  return value.type === "tool" ? value.tool : undefined;
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

// Session lineage columns (QSR-220). `parent_id` carries the subagent's own
// parent ses_ id; `agent` carries the named subagent role. Both are absent on
// older DB files (opencode-local.db predates `agent`), so they are projected
// conditionally — a missing column becomes a NULL literal rather than a SQL
// error, and the schema admits the column as nullable.
const sessionLineageProjection = (
  hasParentId: boolean,
  hasAgent: boolean,
) =>
  `${hasParentId ? "parent_id" : "null"} as parent_id, ${hasAgent ? "agent" : "null"} as agent`;

const readSessionRows = (
  db: OpenCodeDatabase,
  limit: number | undefined,
  skip: number | undefined,
): OpenCodeRawRow[] =>
  db
    .query(
      `select id, title, directory, ${sessionPathProjection(db)} as path, ${sessionLineageProjection(hasSqliteSessionColumn(db, "parent_id"), hasSqliteSessionColumn(db, "agent"))}, time_created, time_updated from session order by time_updated desc, id desc limit ? offset ?`,
    )
    .all(opencodeSessionWindowLimit(limit), sessionWindowSkip(skip)) as OpenCodeRawRow[];

const readMessages = (db: OpenCodeDatabase, sessionId: string): OpenCodeRawRow[] =>
  db
    .query(
      `select id, time_created, ${OPENCODE_RAW_BYTES_SQL} as raw_bytes, ${OPENCODE_PRUNED_MESSAGE_DATA_SQL} as data from message where session_id = ? order by time_created, id`,
    )
    .all(sessionId) as OpenCodeRawRow[];

const readPartsByMessage = (
  db: OpenCodeDatabase,
  sessionId: string,
  diagnostics: DecodeDiagnostic[],
) => {
  const rows = db
    .query(
      `select id, message_id, time_created, ${OPENCODE_PRUNED_PART_DATA_SQL} as data from part where session_id = ? order by time_created, id`,
    )
    .all(sessionId) as OpenCodePartRow[];
  return groupClassifiedParts(rows, diagnostics);
};

const groupClassifiedParts = (
  rows: readonly OpenCodePartRow[],
  diagnostics: DecodeDiagnostic[],
) => {
  const partsByMessage = new Map<string, ClassifiedPart[]>();
  for (const part of rows) {
    const list = partsByMessage.get(part.message_id) ?? [];
    list.push(classifyPart(parsePartData(part.data), diagnostics));
    partsByMessage.set(part.message_id, list);
  }
  return partsByMessage;
};

const readSessionRowsCli = (
  dbPath: string,
  limit: number | undefined,
  skip: number | undefined,
): OpenCodeRawRow[] =>
  sqliteJson<OpenCodeRawRow>(
    dbPath,
    `select id, title, directory, ${sessionPathProjectionCli(dbPath)} as path, ${sessionLineageProjection(hasSqliteSessionColumnCli(dbPath, "parent_id"), hasSqliteSessionColumnCli(dbPath, "agent"))}, time_created, time_updated from session order by time_updated desc, id desc limit ${opencodeSessionWindowLimit(limit)} offset ${sessionWindowSkip(skip)}`,
  );

export const readOpenCodeSessionRowsForWindow = (
  dbPath: string,
  limit?: number,
  skip?: number,
) => readSessionRowsCli(dbPath, limit, skip);

const readMessagesCli = (dbPath: string, sessionId: string): OpenCodeRawRow[] =>
  sqliteJson<OpenCodeRawRow>(
    dbPath,
    `select id, time_created, ${OPENCODE_RAW_BYTES_SQL} as raw_bytes, ${OPENCODE_PRUNED_MESSAGE_DATA_SQL} as data from message where session_id = ${sql(sessionId)} order by time_created, id`,
  );

const readPartsByMessageCli = (
  dbPath: string,
  sessionId: string,
  diagnostics: DecodeDiagnostic[],
) => {
  const rows = sqliteJson<OpenCodePartRow>(
    dbPath,
    `select id, message_id, time_created, ${OPENCODE_PRUNED_PART_DATA_SQL} as data from part where session_id = ${sql(sessionId)} order by time_created, id`,
  );
  return groupClassifiedParts(rows, diagnostics);
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

type OpenCodeSessionColumn = "path" | "parent_id" | "agent";

const hasSqliteSessionColumn = (db: OpenCodeDatabase, column: OpenCodeSessionColumn) =>
  (db.query("pragma table_info(session)").all() as SQLiteColumnRow[]).some(
    (row) => row.name === column,
  );

const hasSqliteSessionColumnCli = (dbPath: string, column: OpenCodeSessionColumn) =>
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
 * Project a CLASSIFIED part into turn content. Driven entirely by the schema
 * dispatch verdict — no string/shape re-sniffing:
 *   - drop (machinery: step-start/-finish/compaction/file; patch artifacts; or
 *     a malformed/unrecognised part) -> never projects as turn content.
 *   - signal "reasoning" -> plaintext thinking, projected under `thinking`.
 *   - signal "message" (text part) -> visible text, projected under `text`.
 *   - signal "tool_call"/"tool_result" -> a tool envelope carrying the decoded
 *     `tool` name + callID; the shared block builder tags it tool machinery.
 * Blank text is absent text: the measured corpus holds thousands of
 * encrypted-reasoning stubs ({"type":"reasoning","text":""}) whose plaintext is
 * empty (the real reasoning lives encrypted in metadata) — those never project.
 */
const partContentProjection = (part: ClassifiedPart): NativeValue | undefined => {
  if (!isSignalPart(part)) return undefined;
  const kind = part.decision.kind;
  if (kind === "artifact") return undefined; // patch surfaces only as an artifact
  const value = part.decision.value;
  const rawText =
    (value.type === "text" || value.type === "reasoning") ? value.text : undefined;
  const text = rawText !== undefined && rawText.trim().length > 0 ? rawText : undefined;
  const toolName = toolNameFromSignalPart(part);
  // A part with neither session text nor a tool identity never projects, so a
  // JSON dump of a bare envelope (e.g. an empty-text reasoning stub) can never
  // reach the search surface.
  if (text === undefined && toolName === undefined) return undefined;
  const callID = value.type === "tool" ? value.callID ?? undefined : undefined;
  // Reasoning parts are plaintext thinking: project under the `thinking` key so
  // the shared block builder emits `kind: "thinking"` blocks, which the ingest
  // layer promotes to `role: "reasoning"` rows.
  const textKey = kind === "reasoning" ? "thinking" : "text";
  return {
    type: value.type,
    ...(text !== undefined ? { [textKey]: text } : {}),
    ...(toolName !== undefined ? { toolName } : {}),
    ...(callID !== undefined ? { callID } : {}),
  };
};

const messageContentProjection = (
  data: Record<string, NativeValue | undefined>,
  parts: ClassifiedPart[],
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

const collectToolCalls = (
  parts: ClassifiedPart[],
  sessionId: SessionId,
  messageId: string,
  eventId: string,
) =>
  parts.flatMap((part, partIndex) => {
    if (!isSignalPart(part)) return [];
    const toolName = toolNameFromSignalPart(part);
    if (toolName === undefined) return [];
    const value = part.decision.value;
    if (value.type !== "tool") return [];
    const state = value.state ?? undefined;
    const partId = value.callID ?? partIndex;
    const startedAt = dateFromNestedTime(state?.time, "start");
    const completedAt = dateFromNestedTime(state?.time, "end");
    const input = projectToolPayloadNativeValue(state?.input);
    const output = projectToolPayloadNativeValue(state?.output);
    return [
      {
        id: scopedId(sessionId, "tool", messageId, partId),
        eventId,
        toolName,
        status: state?.status ?? undefined,
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
  parts: ClassifiedPart[],
): OpenCodeArtifactDraft[] =>
  parts.flatMap((part, index) => {
    // A part is an artifact iff the schema dispatch mapped it to `artifact`
    // (i.e. a `patch` part). No string-sniffing for "diff"/"patch".
    if (!isSignalPart(part) || part.decision.kind !== "artifact") return [];
    const value = part.decision.value;
    if (value.type !== "patch") return [];
    const hash = value.hash ?? undefined;
    return [
      {
        id: artifactIdFor(sessionId, [eventId, index, hash ?? "patch", value.type]),
        eventId,
        kind: value.type,
        ...(hash !== undefined ? { contentHash: hash } : {}),
        sourcePath: dbPath,
        sourceRef: { table: "part", eventId, index },
      },
    ];
  });

const eventFromMessage = (
  dbPath: string,
  message: OpenCodeMessageRow,
  index: number,
  parts: ClassifiedPart[],
  sessionId: SessionId,
  diagnostics: DecodeDiagnostic[],
) => {
  const data = parseMessageData(message);
  // Declarative role dispatch: the message payload is classified through the
  // role-discriminated schema. A payload whose role is neither user nor
  // assistant becomes a NAMED drop diagnostic and resolves to role "unknown"
  // WITHOUT any content (its parts already drop too) — never a coerced turn.
  const messageDecision = classifyOpenCodeMessage(data, diagnostics);
  const role: SessionRole = isSignal(messageDecision)
    ? messageDecision.value.role
    : "unknown";
  const content = messageContentProjection(data, parts);
  // Machinery-only turns (step markers, compaction, patches) project to a
  // bare role envelope; without content or parts there is no session text,
  // so no content surfaces (a JSON dump of the envelope is not a turn).
  const contentRecord = recordFrom(content);
  const hasTurnContent =
    contentRecord.content !== undefined || contentRecord.parts !== undefined;
  // A turn is a tool_call iff a part was classified as a tool invocation.
  const isToolTurn = parts.some((part) => {
    const kind = partKind(part);
    return kind === "tool_call" || kind === "tool_result";
  });
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
      kind: isToolTurn ? ("tool_call" as const) : ("message" as const),
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
  diagnostics: DecodeDiagnostic[],
) => {
  const partsByMessage = readPartsByMessage(db, sessionRow.id, diagnostics);
  return buildOpenCodeSessionFromRows(
    dbPath,
    root,
    options,
    sessionRow,
    decodeMessageRows(readMessages(db, sessionRow.id), diagnostics),
    partsByMessage,
    diagnostics,
  );
};

const buildOpenCodeSessionFromRows = (
  dbPath: string,
  root: string,
  options: AdapterOptions,
  sessionRow: OpenCodeSessionRow,
  messages: OpenCodeMessageRow[],
  partsByMessage: Map<string, ClassifiedPart[]>,
  diagnostics: DecodeDiagnostic[],
) => {
  const toolCalls: Omit<ToolCall, "sessionId" | "machineId" | "provider" | "agentName" | "projectIdentityKey">[] = [];
  const usageRecords: OpenCodeUsageDraft[] = [];
  const sessionEdges: OpenCodeEdgeDraft[] = [];
  const artifacts: OpenCodeArtifactDraft[] = [];
  const nativeSessionId = OpenCodeSessionId(sessionRow.id);
  const sessionId = sessionIdFor("opencode", nativeSessionId);
  // Session-to-session subagent lineage (QSR-220): a non-null `session.parent_id`
  // is the subagent's own parent ses_ id. This is SESSION lineage, NOT the
  // event-to-event `message.parentID` threading below (which uses kind="parent"
  // and may carry a raw message uuid on fromId). The canonical edge is
  // `subagent_of`, carrying the PARENT's machine-independent Quasar SessionId on
  // `fromId` (and the child's on `toId`) so it joins to `sessions.session_id`
  // once persisted; mapSession projects `subagent_of` onto the served
  // SessionRow.parentSessionId column. The native parent id is preserved in
  // `rawReference`. `parent` (event threading) is deliberately never used here.
  const parentNativeSessionId = stringValue(sessionRow.parent_id);
  if (parentNativeSessionId !== undefined) {
    const parentSessionId = sessionIdFor("opencode", OpenCodeSessionId(parentNativeSessionId));
    sessionEdges.push({
      id: edgeIdFor(sessionId, "subagent_of", parentSessionId, sessionId),
      kind: "subagent_of",
      fromId: parentSessionId,
      toId: sessionId,
      rawReference: {
        sourcePath: dbPath,
        table: "session",
        rowId: nativeSessionId,
        nativeType: "parent_id",
        nativeValue: parentNativeSessionId,
      },
    });
  }
  // The named subagent role from the `agent` column. Root sessions (and older
  // DBs without the column) carry no agent: fall back to the provider name.
  const agentName = stringValue(sessionRow.agent) ?? "opencode";
  const messageIdToEventId = new Map<string, string>();
  const events = messages.map((message, index) => {
    const result = eventFromMessage(
      dbPath,
      message,
      index,
      partsByMessage.get(message.id) ?? [],
      sessionId,
      diagnostics,
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
    agentName,
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
  diagnostics: DecodeDiagnostic[],
) =>
  buildOpenCodeSessionFromRows(
    sourceDbPath,
    root,
    options,
    sessionRow,
    decodeMessageRows(readMessagesCli(queryDbPath, sessionRow.id), diagnostics),
    readPartsByMessageCli(queryDbPath, sessionRow.id, diagnostics),
    diagnostics,
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

/** Surface accumulated fail-closed decode drops as named diagnostics. */
const decodeDropDiagnostics = (
  diagnostics: readonly DecodeDiagnostic[],
  rootPath: string,
): AdapterStreamItem[] =>
  diagnostics.map((diagnostic) => ({
    type: "diagnostic" as const,
    diagnostic: {
      adapterId: opencodeAdapter.id,
      provider: "opencode" as const,
      status: "unsupported" as const,
      parserConfidence: "observed" as const,
      rootPath,
      message: `OpenCode row dropped (${diagnostic.name}).`,
      details: { error: diagnostic.message },
    },
  }));

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
      const rawRows = readSessionRowsCli(tempDb.path, options.limit, options.skip);
      if (rawRows.length === 0) {
        for (const diagnostic of unsupportedRuntimeResult(dbPath).diagnostics) {
          yield { type: "diagnostic", diagnostic };
        }
        return;
      }
      // Fail-closed decode: a malformed session row becomes a named diagnostic
      // and is dropped from the window — it never aborts the file.
      const decodeDiagnostics: DecodeDiagnostic[] = [];
      const rows = decodeSessionRows(rawRows, decodeDiagnostics);
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
          decodeDiagnostics,
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
      for (const item of decodeDropDiagnostics(decodeDiagnostics, logicalDbPath ?? dbPath)) {
        yield item;
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
    // Fail-closed decode: a malformed session row becomes a named diagnostic
    // and is dropped from the window — it never aborts the file.
    const decodeDiagnostics: DecodeDiagnostic[] = [];
    const sessionRows = decodeSessionRows(
      readSessionRows(db, options.limit, options.skip),
      decodeDiagnostics,
    );
    for (const sessionEntry of sessionRows) {
      if (await skipOpenCodeSession(options, sessionEntry, logicalDbPath ?? dbPath)) continue;
      const session = buildOpenCodeSession(
        db,
        logicalDbPath ?? dbPath,
        logicalRoot ?? root,
        options,
        sessionEntry,
        decodeDiagnostics,
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
    for (const item of decodeDropDiagnostics(decodeDiagnostics, logicalDbPath ?? dbPath)) {
      yield item;
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
