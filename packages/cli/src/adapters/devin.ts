import { execFileSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { join } from "node:path";

import { Schema } from "effect";

import { stableCanonicalJsonHash } from "../core/hash";

import { DevinSessionId } from "../core/identity";
import type { AdapterDiagnostic, NormalizedSession } from "../core/schemas";
import {
  DevinChatMessageEnvelopeSchema,
  DevinChatMessageSchema,
  DevinGraphCoordinateSchema,
  DevinMessageNodeRowSchema,
  DevinNodeMetadataValueSchema,
  DevinSessionMetadataValueSchema,
  DevinSessionRowSchema,
  type DevinChatMessage,
  type DevinGraphCoordinate,
  type DevinMessageNodeRow,
  type DevinSessionRow,
  type DevinToolMessage,
  classifyDevinMessage,
  classifyDevinRole,
  classifyDevinSession,
  classifyDevinToolCall,
  classifyDevinToolResult,
} from "./devin-schema";
import { type DecodeDiagnostic, decodeOrDrop, isSignal } from "./harness-schema";
import {
  buildSession,
  compactText,
  contentBlocksFromNative,
  edgeIdFor,
  eventIdFor,
  homePath,
  logicalPathFor,
  logicalRootFor,
  projectToolPayloadNativeValue,
  scopedId,
  sessionIdFor,
  sourceRoot,
  sqliteSnapshotForRead,
} from "./common";
import type { SqliteSnapshot } from "./source";
import {
  collectAdapterStream,
  type AdapterDiscoverOptions,
  type AdapterStreamItem,
  type SessionAdapter,
} from "./types";

type NormalizedToolCall = NormalizedSession["toolCalls"][number];
type NormalizedEdge = NormalizedSession["sessionEdges"][number];
type NormalizedEvent = NormalizedSession["events"][number];
type NormalizedExecutionContext = NormalizedSession["executionContexts"][number];
type DevinToolCallDraft = Omit<
  NormalizedToolCall,
  "sessionId" | "machineId" | "provider" | "agentName" | "projectIdentityKey"
>;
type DevinEdgeDraft = Omit<
  NormalizedEdge,
  "sessionId" | "machineId" | "provider" | "agentName" | "projectIdentityKey"
>;
type DevinEventDraft = Omit<
  NormalizedEvent,
  "sessionId" | "machineId" | "provider" | "agentName" | "projectIdentityKey" | "contentBlocks"
> & { readonly contentBlocks?: NormalizedEvent["contentBlocks"] };
type DevinExecutionContextDraft = Omit<
  NormalizedExecutionContext,
  "sessionId" | "machineId" | "provider" | "agentName" | "projectIdentityKey"
>;

type RawSqliteRow = Record<string, unknown>;
type Query = { readonly all: (...parameters: readonly unknown[]) => RawSqliteRow[] };
type DevinDatabase = { readonly query: (sqlText: string) => Query; readonly close: () => void };

// `bun:sqlite` does not exist in Node builds; this literal dynamic import is the
// platform-specific exception that lets the compiled Bun CLI avoid a sqlite3 dependency.
const openBunDatabase = async (path: string): Promise<DevinDatabase | undefined> => {
  try {
    const { Database } = await import("bun:sqlite");
    return new Database(path) as unknown as DevinDatabase;
  } catch {
    return undefined;
  }
};

const sqlString = (value: string) => `'${value.replaceAll("'", "''")}'`;

const sqliteJson = (dbPath: string, query: string): RawSqliteRow[] => {
  const text = execFileSync("sqlite3", ["-json", dbPath, query], {
    encoding: "utf8",
    maxBuffer: 128 * 1024 * 1024,
  }).trim();
  return text.length === 0 ? [] : (JSON.parse(text) as RawSqliteRow[]);
};

const SESSION_COLUMNS = [
  "id",
  "working_directory",
  "backend_type",
  "model",
  "agent_mode",
  "created_at",
  "last_activity_at",
  "title",
  "main_chain_id",
  "shell_last_seen_index",
  "cogs_json",
  "workspace_dirs",
  "hidden",
  "metadata",
].join(", ");

const MESSAGE_COLUMNS = [
  "row_id",
  "session_id",
  "node_id",
  "parent_node_id",
  "chat_message",
  "created_at",
  "metadata",
].join(", ");

const windowLimit = (limit: number | undefined) =>
  limit === undefined ? -1 : Math.max(1, Math.floor(limit));
const windowSkip = (skip: number | undefined) => Math.max(0, Math.floor(skip ?? 0));

const readSessionRows = (
  database: DevinDatabase | undefined,
  dbPath: string,
  limit: number | undefined,
  skip: number | undefined,
): RawSqliteRow[] => {
  const statement = `select ${SESSION_COLUMNS} from sessions order by last_activity_at desc, id desc limit ? offset ?`;
  if (database !== undefined) {
    return database.query(statement).all(windowLimit(limit), windowSkip(skip));
  }
  return sqliteJson(
    dbPath,
    `select ${SESSION_COLUMNS} from sessions order by last_activity_at desc, id desc limit ${windowLimit(limit)} offset ${windowSkip(skip)}`,
  );
};

const ancestryQuery = (sessionExpression: string, headExpression: string) => `
with recursive chain(node_id, parent_node_id, depth, path, cycle) as (
  select node_id, parent_node_id, 0, printf(',%d,', node_id), 0
    from message_nodes
   where session_id = ${sessionExpression} and node_id = ${headExpression}
  union all
  select parent.node_id,
         parent.parent_node_id,
         chain.depth + 1,
         chain.path || parent.node_id || ',',
         instr(chain.path, printf(',%d,', parent.node_id)) > 0
    from chain
    join message_nodes as parent
      on parent.session_id = ${sessionExpression}
     and parent.node_id = chain.parent_node_id
   where chain.cycle = 0 and chain.parent_node_id is not null
)
select node_id, parent_node_id, depth, cycle from chain order by depth asc`;

const readAncestry = (
  database: DevinDatabase | undefined,
  dbPath: string,
  sessionId: string,
  headNodeId: number,
): RawSqliteRow[] => {
  if (database !== undefined) {
    return database
      .query(ancestryQuery("?", "?"))
      .all(sessionId, headNodeId, sessionId);
  }
  return sqliteJson(dbPath, ancestryQuery(sqlString(sessionId), String(headNodeId)));
};

const readMessageNode = (
  database: DevinDatabase | undefined,
  dbPath: string,
  sessionId: string,
  nodeId: number,
): RawSqliteRow | undefined => {
  if (database !== undefined) {
    return database
      .query(`select ${MESSAGE_COLUMNS} from message_nodes where session_id = ? and node_id = ?`)
      .all(sessionId, nodeId)[0];
  }
  return sqliteJson(
    dbPath,
    `select ${MESSAGE_COLUMNS} from message_nodes where session_id = ${sqlString(sessionId)} and node_id = ${nodeId}`,
  )[0];
};

const findOtherSessionForNode = (
  database: DevinDatabase | undefined,
  dbPath: string,
  sessionId: string,
  nodeId: number,
): string | undefined => {
  const rows = database !== undefined
    ? database
        .query("select session_id from message_nodes where session_id <> ? and node_id = ? limit 1")
        .all(sessionId, nodeId)
    : sqliteJson(
        dbPath,
        `select session_id from message_nodes where session_id <> ${sqlString(sessionId)} and node_id = ${nodeId} limit 1`,
      );
  return typeof rows[0]?.session_id === "string" ? rows[0].session_id : undefined;
};

const MAX_DATE_MILLISECONDS = 8_640_000_000_000_000;

const epochSecondsToIso = (value: number): string | undefined => {
  const milliseconds = value * 1_000;
  if (
    !Number.isFinite(milliseconds) ||
    Math.abs(milliseconds) > MAX_DATE_MILLISECONDS
  ) {
    return undefined;
  }
  return new Date(milliseconds).toISOString();
};

const rawRowBytes = (row: DevinMessageNodeRow): number =>
  Buffer.byteLength(JSON.stringify({
    row_id: row.row_id,
    session_id: row.session_id,
    node_id: row.node_id,
    parent_node_id: row.parent_node_id,
    chat_message: row.chat_message,
    created_at: row.created_at,
    metadata: row.metadata ?? null,
  }), "utf8");

const fingerprintForSession = (
  session: DevinSessionRow,
  rawNodes: readonly RawSqliteRow[],
): { readonly size: number; readonly mtimeMs: number; readonly tag: string } => ({
  size: Buffer.byteLength(JSON.stringify(rawNodes), "utf8"),
  mtimeMs: session.last_activity_at * 1_000,
  tag: stableCanonicalJsonHash({ session, nodes: rawNodes }),
});

const adapterDiagnostic = (
  rootPath: string,
  name: string,
  message: string,
  status: AdapterDiagnostic["status"] = "unsupported",
): AdapterDiagnostic => ({
  adapterId: devinAdapter.id,
  provider: "devin",
  status,
  parserConfidence: "observed",
  rootPath,
  message,
  details: { diagnostic: name },
});

const schemaDiagnostic = (
  rootPath: string,
  diagnostic: DecodeDiagnostic,
  sessionId?: string,
): AdapterDiagnostic => ({
  ...adapterDiagnostic(
    rootPath,
    diagnostic.name,
    `Devin record rejected (${diagnostic.name}).`,
  ),
  details: {
    diagnostic: diagnostic.name,
    error: diagnostic.message,
    ...(sessionId === undefined ? {} : { nativeSessionId: sessionId }),
  },
});

const decodeJsonText = <A, I>(
  schema: Schema.Schema<A, I>,
  text: string,
  diagnosticName: string,
  diagnostics: DecodeDiagnostic[],
): A | undefined => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch (error) {
    diagnostics.push({
      name: diagnosticName,
      message: error instanceof Error ? error.message : String(error),
    });
    return undefined;
  }
  const decoded = decodeOrDrop(schema, parsed, {
    kind: "record",
    diagnosticName,
    diagnostics,
  });
  return isSignal(decoded) ? decoded.value : undefined;
};

const decodeChatMessage = (
  row: DevinMessageNodeRow,
  diagnostics: DecodeDiagnostic[],
): DevinChatMessage | undefined => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(row.chat_message) as unknown;
  } catch (error) {
    diagnostics.push({
      name: "devin.message.decode_failed",
      message: error instanceof Error ? error.message : String(error),
    });
    return undefined;
  }

  const envelopeDecision = decodeOrDrop(DevinChatMessageEnvelopeSchema, parsed, {
    kind: "message",
    diagnosticName: "devin.message.decode_failed",
    diagnostics,
  });
  if (!isSignal(envelopeDecision)) return undefined;

  const roleDecision = classifyDevinRole(envelopeDecision.value);
  if (!isSignal(roleDecision)) {
    diagnostics.push({ name: roleDecision.reason, message: `Unsupported Devin role '${envelopeDecision.value.role}'.` });
    return undefined;
  }

  const messageDecision = decodeOrDrop(DevinChatMessageSchema, parsed, {
    kind: "message",
    diagnosticName: "devin.message.decode_failed",
    diagnostics,
  });
  return isSignal(messageDecision) ? messageDecision.value : undefined;
};

interface CanonicalNode {
  readonly row: DevinMessageNodeRow;
  readonly message: DevinChatMessage;
}

interface BuiltDevinSession {
  readonly session: NormalizedSession;
  readonly diagnostics: readonly DecodeDiagnostic[];
}

const buildDevinSession = (
  sourcePath: string,
  rootPath: string,
  options: AdapterDiscoverOptions,
  sessionRow: DevinSessionRow,
  nodes: readonly CanonicalNode[],
): BuiltDevinSession => {
  const nativeSessionId = DevinSessionId(sessionRow.id);
  const sessionId = sessionIdFor("devin", nativeSessionId);
  const events: DevinEventDraft[] = [];
  const edges: DevinEdgeDraft[] = [];
  const diagnostics: DecodeDiagnostic[] = [];
  const firstEventByNodeId = new Map<number, string>();
  const lastEventByNodeId = new Map<number, string>();
  const callDrafts = new Map<string, DevinToolCallDraft>();
  const callEventByNativeId = new Map<string, string>();
  const results = new Map<string, { readonly message: DevinToolMessage; readonly eventId: string }>();
  const duplicateResults = new Set<string>();
  const executionContexts: DevinExecutionContextDraft[] = [];
  let sequence = 0;

  for (const { row, message } of nodes) {
    const decision = classifyDevinMessage(message);
    if (!isSignal(decision)) {
      diagnostics.push({ name: decision.reason, message: decision.reason });
      continue;
    }
    const timestamp = Number.isNaN(Date.parse(message.metadata.created_at))
      ? undefined
      : message.metadata.created_at;
    if (timestamp === undefined) {
      diagnostics.push({
        name: "devin.timestamp.invalid",
        message: `Invalid created_at on node ${row.node_id}.`,
      });
    }
    const bytes = rawRowBytes(row);
    const reasoningText = message.role === "assistant" ? message.thinking?.thinking : undefined;

    let reasoningEventId: string | undefined;
    if (reasoningText !== undefined && reasoningText.trim().length > 0) {
      const reasoningNativeId = `node:${row.node_id}:reasoning`;
      reasoningEventId = eventIdFor(sessionId, sequence, reasoningNativeId);
      events.push({
        id: reasoningEventId,
        nativeEventId: reasoningNativeId,
        sequence,
        ...(timestamp === undefined ? {} : { timestamp }),
        role: "thinking",
        kind: "reasoning",
        contentText: compactText(reasoningText),
        contentBlocks: contentBlocksFromNative(sessionId, reasoningEventId, [
          { type: "thinking", thinking: reasoningText },
        ]),
        rawReference: {
          sourcePath,
          table: "message_nodes",
          rowId: String(row.row_id),
          nativeType: "assistant_reasoning",
          rawBytes: bytes,
        },
      });
      sequence += 1;
    }

    const mainNativeId = `node:${row.node_id}:main`;
    const mainEventId = eventIdFor(sessionId, sequence, mainNativeId);
    firstEventByNodeId.set(row.node_id, reasoningEventId ?? mainEventId);
    lastEventByNodeId.set(row.node_id, mainEventId);
    let eventToolCallId: string | undefined;

    if (message.role === "assistant") {
      const generationModel = message.metadata.generation_model.trim();
      if (generationModel.length > 0) {
        executionContexts.push({
          id: scopedId(sessionId, "execution-context", "message", message.message_id),
          sequence,
          scope: "turn",
          ...(timestamp === undefined ? {} : { timestamp }),
          turnId: message.message_id,
          model: generationModel,
        });
      }
      for (const call of [...message.tool_calls].sort((left, right) => left.index - right.index)) {
        const callDecision = classifyDevinToolCall(call);
        if (!isSignal(callDecision)) {
          diagnostics.push({ name: callDecision.reason, message: callDecision.reason });
          continue;
        }
        if (callDrafts.has(call.id)) {
          diagnostics.push({
            name: "devin.tool_call.duplicate",
            message: `Duplicate tool call id '${call.id}' on the canonical chain.`,
          });
          continue;
        }
        const toolCallId = scopedId(sessionId, "tool", call.id);
        callDrafts.set(call.id, {
          id: toolCallId,
          eventId: mainEventId,
          toolName: call.name,
          input: projectToolPayloadNativeValue(call.arguments),
        });
        callEventByNativeId.set(call.id, mainEventId);
        eventToolCallId ??= toolCallId;
      }
    }

    if (message.role === "tool") {
      const toolCallId = scopedId(sessionId, "tool", message.tool_call_id);
      eventToolCallId = toolCallId;
      if (results.has(message.tool_call_id)) duplicateResults.add(message.tool_call_id);
      else results.set(message.tool_call_id, { message, eventId: mainEventId });
    }

    events.push({
      id: mainEventId,
      nativeEventId: mainNativeId,
      sequence,
      ...(timestamp === undefined ? {} : { timestamp }),
      role: decision.value.role,
      kind: decision.kind,
      contentText: compactText(message.content),
      contentBlocks: contentBlocksFromNative(sessionId, mainEventId, message.content),
      ...(eventToolCallId === undefined ? {} : { toolCallId: eventToolCallId }),
      rawReference: {
        sourcePath,
        table: "message_nodes",
        rowId: String(row.row_id),
        nativeType: message.role,
        rawBytes: bytes,
      },
    });
    if (reasoningEventId !== undefined) {
      edges.push({
        id: edgeIdFor(sessionId, "next", reasoningEventId, mainEventId),
        kind: "next",
        fromEventId: reasoningEventId,
        toEventId: mainEventId,
        rawReference: {
          sourcePath,
          table: "message_nodes",
          rowId: String(row.row_id),
          nativeType: "reasoning_to_main",
        },
      });
    }
    sequence += 1;
  }

  for (const { row } of nodes) {
    if (row.parent_node_id === null) continue;
    const fromEventId = lastEventByNodeId.get(row.parent_node_id);
    const toEventId = firstEventByNodeId.get(row.node_id);
    if (fromEventId === undefined || toEventId === undefined) continue;
    edges.push({
      id: edgeIdFor(sessionId, "parent", fromEventId, toEventId),
      kind: "parent",
      fromEventId,
      toEventId,
      rawReference: {
        sourcePath,
        table: "message_nodes",
        rowId: String(row.row_id),
        nativeType: "parent_node_id",
      },
    });
  }

  for (const [nativeCallId, result] of results) {
    if (duplicateResults.has(nativeCallId)) {
      diagnostics.push({
        name: "devin.tool_result.duplicate",
        message: `Duplicate tool result for '${nativeCallId}' on the canonical chain.`,
      });
      callDrafts.delete(nativeCallId);
      continue;
    }
    const draft = callDrafts.get(nativeCallId);
    if (draft === undefined) {
      diagnostics.push({
        name: "devin.tool_result.orphaned",
        message: `Tool result '${nativeCallId}' has no canonical assistant call.`,
      });
      continue;
    }
    const resultDecision = classifyDevinToolResult(result.message);
    if (!isSignal(resultDecision)) {
      diagnostics.push({ name: resultDecision.reason, message: resultDecision.reason });
      continue;
    }
    const extensions = result.message.metadata.extensions;
    const resultMeta = extensions["chisel/tool_result_meta"];
    const timing = extensions["chisel/tool_call_timing"];
    const output = projectToolPayloadNativeValue({
      content: result.message.content,
      result: resultMeta,
      ...(extensions["chisel/terminal_output"] === undefined
        ? {}
        : { terminalOutput: extensions["chisel/terminal_output"] }),
      ...(extensions["chisel/tool_failure"] === undefined
        ? {}
        : { failure: extensions["chisel/tool_failure"] }),
    });
    callDrafts.set(nativeCallId, {
      ...draft,
      status: resultDecision.value.status,
      ...(output === undefined ? {} : { output }),
      ...(timing === undefined || Number.isNaN(Date.parse(timing.started_at))
        ? {}
        : { startedAt: timing.started_at }),
      ...(timing === undefined || Number.isNaN(Date.parse(timing.finished_at))
        ? {}
        : { completedAt: timing.finished_at }),
    });
    const fromEventId = callEventByNativeId.get(nativeCallId);
    if (fromEventId !== undefined) {
      edges.push({
        id: edgeIdFor(sessionId, "tool_result_for", fromEventId, result.eventId),
        kind: "tool_result_for",
        fromEventId,
        toEventId: result.eventId,
      });
    }
  }

  const startedAt = epochSecondsToIso(sessionRow.created_at);
  const updatedAt = epochSecondsToIso(sessionRow.last_activity_at);
  if (startedAt === undefined) {
    diagnostics.push({
      name: "devin.timestamp.invalid",
      message: `Invalid created_at on session '${sessionRow.id}'.`,
    });
  }
  if (updatedAt === undefined) {
    diagnostics.push({
      name: "devin.timestamp.invalid",
      message: `Invalid last_activity_at on session '${sessionRow.id}'.`,
    });
  }

  const sessionModel = sessionRow.model.trim();
  const permissionProfileType = sessionRow.agent_mode.trim();
  if (sessionModel.length > 0 || permissionProfileType.length > 0) {
    executionContexts.unshift({
      id: scopedId(sessionId, "execution-context", "session"),
      sequence: 0,
      scope: "session",
      ...(startedAt === undefined ? {} : { timestamp: startedAt }),
      ...(sessionModel.length === 0 ? {} : { model: sessionModel }),
      ...(permissionProfileType.length === 0 ? {} : { permissionProfileType }),
    });
  }

  return {
    session: buildSession({
      provider: "devin",
      agentName: "devin",
      machine: options.machine,
      sessionId,
      nativeSessionId,
      nativeProjectKey: sessionRow.working_directory,
      projectPath: sessionRow.working_directory,
      title: sessionRow.title ?? undefined,
      ...(startedAt === undefined ? {} : { startedAt }),
      ...(updatedAt === undefined ? {} : { updatedAt }),
      sourceRoot: rootPath,
      sourcePath,
      events,
      toolCalls: [...callDrafts.values()],
      sessionEdges: edges,
      executionContexts,
    }),
    diagnostics,
  };
};

interface ValidatedAncestry {
  readonly coordinates: readonly DevinGraphCoordinate[];
  readonly diagnostic?: DecodeDiagnostic;
}

const validateAncestry = (
  database: DevinDatabase | undefined,
  dbPath: string,
  session: DevinSessionRow,
  rawCoordinates: readonly RawSqliteRow[],
): ValidatedAncestry => {
  const diagnostics: DecodeDiagnostic[] = [];
  const coordinates: DevinGraphCoordinate[] = [];
  for (const raw of rawCoordinates) {
    const decision = decodeOrDrop(DevinGraphCoordinateSchema, raw, {
      kind: "coordinate",
      diagnosticName: "devin.graph.decode_failed",
      diagnostics,
    });
    if (!isSignal(decision)) {
      return { coordinates: [], diagnostic: diagnostics.at(-1) };
    }
    coordinates.push(decision.value);
  }
  if (coordinates.length === 0) {
    return {
      coordinates: [],
      diagnostic: {
        name: "devin.graph.head_missing",
        message: `Main-chain head '${session.main_chain_id}' does not exist.`,
      },
    };
  }
  if (coordinates.some((coordinate) => coordinate.cycle !== 0)) {
    return {
      coordinates: [],
      diagnostic: { name: "devin.graph.cycle", message: "The main-chain ancestry contains a cycle." },
    };
  }
  const deepest = coordinates.at(-1);
  if (deepest?.parent_node_id !== null && deepest?.parent_node_id !== undefined) {
    const otherSession = findOtherSessionForNode(
      database,
      dbPath,
      session.id,
      deepest.parent_node_id,
    );
    return {
      coordinates: [],
      diagnostic: {
        name: otherSession === undefined ? "devin.graph.parent_missing" : "devin.graph.cross_session_parent",
        message: `Parent node '${deepest.parent_node_id}' is unavailable in session '${session.id}'.`,
      },
    };
  }
  return { coordinates: [...coordinates].reverse() };
};

async function* streamDevin(options: AdapterDiscoverOptions): AsyncGenerator<AdapterStreamItem> {
  const physicalRoot = options.roots?.devin ?? devinAdapter.defaultRoot();
  if (physicalRoot === undefined) {
    yield {
      type: "diagnostic",
      diagnostic: adapterDiagnostic("", "devin.sqlite.not_found", "Devin sessions.db was not found.", "no_data_found"),
    };
    return;
  }
  const logicalRoot = logicalRootFor("devin", physicalRoot, options);
  const physicalDbPath = join(physicalRoot, "sessions.db");
  const logicalDbPath = logicalPathFor(physicalDbPath, physicalRoot, logicalRoot);
  if (!existsSync(physicalDbPath)) {
    yield {
      type: "diagnostic",
      diagnostic: adapterDiagnostic(
        logicalRoot,
        "devin.sqlite.not_found",
        "Devin sessions.db was not found.",
        "no_data_found",
      ),
    };
    return;
  }

  const sourceStats = [
    physicalDbPath,
    `${physicalDbPath}-wal`,
    `${physicalDbPath}-shm`,
  ].flatMap((path) => existsSync(path) ? [{ path, stat: statSync(path) }] : []);
  if (options.shouldReadFile !== undefined) {
    const shouldRead = sourceStats
      .map(({ path, stat }) => options.shouldReadFile?.(path, stat) !== false)
      .some(Boolean);
    if (!shouldRead) return;
  }

  yield {
    type: "sourceRoot",
    sourceRoot: sourceRoot("devin", devinAdapter.id, logicalRoot, options.machine, options.now),
  };

  let snapshot: SqliteSnapshot;
  try {
    snapshot = sqliteSnapshotForRead(physicalDbPath, { label: "devin", fileName: "sessions.db" });
  } catch (error) {
    yield {
      type: "diagnostic",
      diagnostic: {
        ...adapterDiagnostic(logicalRoot, "devin.sqlite.unreadable", "Devin sessions.db could not be snapshotted."),
        details: {
          diagnostic: "devin.sqlite.unreadable",
          error: error instanceof Error ? error.message : String(error),
        },
      },
    };
    return;
  }

  const database = await openBunDatabase(snapshot.path);
  let emitted = 0;
  try {
    const rawSessions = readSessionRows(database, snapshot.path, options.limit, options.skip);
    for (const rawSession of rawSessions) {
      const sessionDiagnostics: DecodeDiagnostic[] = [];
      const sessionDecision = decodeOrDrop(DevinSessionRowSchema, rawSession, {
        kind: "session",
        diagnosticName: "devin.session.decode_failed",
        diagnostics: sessionDiagnostics,
      });
      if (!isSignal(sessionDecision)) {
        for (const diagnostic of sessionDiagnostics) {
          yield { type: "diagnostic", diagnostic: schemaDiagnostic(logicalRoot, diagnostic) };
        }
        continue;
      }
      const sessionRow = sessionDecision.value;
      const classification = classifyDevinSession(sessionRow);
      if (!isSignal(classification)) {
        const invalidId = classification.reason === "devin.session.id_invalid";
        yield {
          type: "diagnostic",
          diagnostic: schemaDiagnostic(
            logicalRoot,
            {
              name: classification.reason,
              message: invalidId
                ? "Devin session row has an empty native session id."
                : `Session '${sessionRow.id}' has no main-chain head.`,
            },
            invalidId ? undefined : sessionRow.id,
          ),
        };
        continue;
      }

      if (sessionRow.metadata !== undefined && sessionRow.metadata !== null) {
        const parsedMetadata = decodeJsonText(
          DevinSessionMetadataValueSchema,
          sessionRow.metadata,
          "devin.session.metadata_decode_failed",
          sessionDiagnostics,
        );
        if (parsedMetadata === undefined) {
          for (const diagnostic of sessionDiagnostics) {
            yield { type: "diagnostic", diagnostic: schemaDiagnostic(logicalRoot, diagnostic, sessionRow.id) };
          }
          continue;
        }
      }

      const rawCoordinates = readAncestry(
        database,
        snapshot.path,
        sessionRow.id,
        sessionRow.main_chain_id as number,
      );
      const ancestry = validateAncestry(database, snapshot.path, sessionRow, rawCoordinates);
      if (ancestry.diagnostic !== undefined) {
        yield {
          type: "diagnostic",
          diagnostic: schemaDiagnostic(logicalRoot, ancestry.diagnostic, sessionRow.id),
        };
        continue;
      }

      const rawNodes: RawSqliteRow[] = [];
      let sessionFailed = false;
      for (const coordinate of ancestry.coordinates) {
        const rawNode = readMessageNode(
          database,
          snapshot.path,
          sessionRow.id,
          coordinate.node_id,
        );
        if (rawNode === undefined) {
          sessionDiagnostics.push({
            name: "devin.graph.parent_missing",
            message: `Canonical node '${coordinate.node_id}' disappeared from the snapshot.`,
          });
          sessionFailed = true;
          break;
        }
        rawNodes.push(rawNode);
      }
      if (sessionFailed) {
        for (const diagnostic of sessionDiagnostics) {
          yield { type: "diagnostic", diagnostic: schemaDiagnostic(logicalRoot, diagnostic, sessionRow.id) };
        }
        continue;
      }

      const fingerprint = fingerprintForSession(sessionRow, rawNodes);
      const canonicalSessionId = sessionIdFor("devin", DevinSessionId(sessionRow.id));
      if (
        options.shouldParseSession !== undefined &&
        !(await options.shouldParseSession({
          sessionId: canonicalSessionId,
          sourceFingerprint: JSON.stringify(fingerprint),
        }))
      ) {
        continue;
      }

      const canonicalNodes: CanonicalNode[] = [];
      for (const rawNode of rawNodes) {
        const nodeDecision = decodeOrDrop(DevinMessageNodeRowSchema, rawNode, {
          kind: "node",
          diagnosticName: "devin.message.decode_failed",
          diagnostics: sessionDiagnostics,
        });
        if (!isSignal(nodeDecision)) {
          sessionFailed = true;
          break;
        }
        const node = nodeDecision.value;
        if (node.metadata !== undefined && node.metadata !== null) {
          const parsedMetadata = decodeJsonText(
            DevinNodeMetadataValueSchema,
            node.metadata,
            "devin.message.metadata_decode_failed",
            sessionDiagnostics,
          );
          if (parsedMetadata === undefined) {
            sessionFailed = true;
            break;
          }
        }
        const message = decodeChatMessage(node, sessionDiagnostics);
        if (message === undefined) {
          sessionFailed = true;
          break;
        }
        canonicalNodes.push({ row: node, message });
      }
      if (sessionFailed) {
        for (const diagnostic of sessionDiagnostics) {
          yield { type: "diagnostic", diagnostic: schemaDiagnostic(logicalRoot, diagnostic, sessionRow.id) };
        }
        continue;
      }

      const built = buildDevinSession(
        logicalDbPath,
        logicalRoot,
        options,
        sessionRow,
        canonicalNodes,
      );
      yield {
        type: "session",
        session: built.session,
        sourceUnit: {
          provider: "devin",
          adapterId: devinAdapter.id,
          rootPath: logicalRoot,
          sourcePath: logicalDbPath,
          physicalPath: physicalDbPath,
        },
        fingerprint,
      };
      emitted += 1;
      for (const diagnostic of built.diagnostics) {
        yield { type: "diagnostic", diagnostic: schemaDiagnostic(logicalRoot, diagnostic, sessionRow.id) };
      }
    }
  } catch (error) {
    yield {
      type: "diagnostic",
      diagnostic: {
        ...adapterDiagnostic(
          logicalRoot,
          "devin.sqlite.schema_mismatch",
          "Devin sessions.db did not match the measured sessions/message_nodes schema.",
        ),
        details: {
          diagnostic: "devin.sqlite.schema_mismatch",
          error: error instanceof Error ? error.message : String(error),
        },
      },
    };
  } finally {
    database?.close();
    snapshot.cleanup();
  }

  yield {
    type: "diagnostic",
    diagnostic: adapterDiagnostic(
      logicalRoot,
      "devin.sqlite.available",
      `Discovered ${emitted} Devin session(s).`,
      emitted > 0 ? "available" : "no_data_found",
    ),
  };
}

export const devinAdapter: SessionAdapter = {
  id: "devin-session-sqlite",
  provider: "devin",
  displayName: "Devin CLI sessions.db",
  stable: true,
  defaultRoot: () => homePath(".local/share/devin/cli"),
  read: async (options) => collectAdapterStream(streamDevin(options)),
  stream: streamDevin,
};
