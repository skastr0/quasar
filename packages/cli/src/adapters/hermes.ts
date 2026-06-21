import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import { Schema } from "effect";

import { HermesSessionId, type SessionId } from "../core/identity";
import type { Artifact, SessionEdge, SessionEventKind, ToolCall, UsageRecord } from "../core/schemas";
import { type DecodeDiagnostic, decodeOrDrop, isSignal } from "./harness-schema";
import {
  buildSession,
  compactText,
  contentBlocksFromNative,
  edgeIdFor,
  eventIdFor,
  homePath,
  logicalRootFor,
  numberValue,
  parseJsonString,
  projectSessionNativeValue,
  projectToolPayloadNativeValue,
  recordFrom,
  roleFrom,
  scopedId,
  sessionIdFor,
  sourceRoot,
  stringValue,
  type NativeValue,
  usageIdFor,
} from "./common";
import {
  collectAdapterStream,
  type AdapterStreamItem,
  type SessionAdapter,
  type UnitFingerprint,
} from "./types";

type AdapterOptions = Parameters<SessionAdapter["read"]>[0];
type HermesDatabase = NonNullable<Awaited<ReturnType<typeof maybeDatabase>>>;

// ---------------------------------------------------------------------------
// On-disk row schemas (QSR-220 fail-closed boundary)
//
// Grounded against the real ~/.hermes/state.db `.schema`:
//   sessions: id TEXT PK NOT NULL, started_at REAL NOT NULL; everything else
//             this adapter reads is nullable TEXT/REAL/INTEGER.
//   messages: id INTEGER PK, session_id TEXT NOT NULL, role TEXT NOT NULL,
//             timestamp REAL NOT NULL; everything else read is nullable.
//
// These schemas declare expectations for every field this adapter reads (the
// boundary doctrine: every schema field declares what it admits). Rows are
// decoded through `decodeOrDrop`, so a malformed/garbage row becomes a NAMED
// diagnostic + a dropped record — never a throw that aborts the whole file,
// never a silently coerced half-row. SQLite hands back numbers for INTEGER /
// REAL and strings for TEXT; nullable columns arrive as `null`. The decode is
// lenient about excess columns (Effect ignores excess properties by default)
// but strict about the load-bearing identity/ordering fields.
// ---------------------------------------------------------------------------

/** A SQLite TEXT column that may be absent or NULL. */
const NullableText = Schema.optional(Schema.NullOr(Schema.String));
/** A SQLite numeric (INTEGER/REAL) column that may be absent or NULL. */
const NullableNumeric = Schema.optional(Schema.NullOr(Schema.Number));
/** A nullable column whose stored type we do not constrain (free-form TEXT/JSON). */
const NullableLoose = Schema.optional(Schema.NullOr(Schema.Unknown));

const HermesSessionRowSchema = Schema.Struct({
  // sessions.id is TEXT PRIMARY KEY NOT NULL — the load-bearing native id.
  id: Schema.String,
  // started_at is REAL NOT NULL — the ordering key.
  started_at: Schema.Number,
  model: NullableText,
  parent_session_id: NullableText,
  ended_at: NullableNumeric,
  input_tokens: NullableNumeric,
  output_tokens: NullableNumeric,
  cache_read_tokens: NullableNumeric,
  cache_write_tokens: NullableNumeric,
  reasoning_tokens: NullableNumeric,
  billing_provider: NullableText,
  estimated_cost_usd: NullableNumeric,
  actual_cost_usd: NullableNumeric,
  title: NullableText,
  cwd: NullableText,
});

const HermesMessageRowSchema = Schema.Struct({
  // messages.id is INTEGER PRIMARY KEY AUTOINCREMENT — arrives as a number.
  id: Schema.Number,
  // session_id TEXT NOT NULL, role TEXT NOT NULL, timestamp REAL NOT NULL.
  session_id: Schema.String,
  role: Schema.String,
  timestamp: Schema.Number,
  content: NullableText,
  tool_call_id: NullableText,
  tool_calls: NullableLoose,
  tool_name: NullableText,
  token_count: NullableNumeric,
  finish_reason: NullableText,
  reasoning: NullableText,
  reasoning_content: NullableText,
  reasoning_details: NullableLoose,
  codex_reasoning_items: NullableLoose,
  codex_message_items: NullableLoose,
  platform_message_id: NullableText,
});

type HermesSessionRow = typeof HermesSessionRowSchema.Type;
type HermesMessageRow = typeof HermesMessageRowSchema.Type;
type HermesToolCallDraft = Omit<
  ToolCall,
  "sessionId" | "machineId" | "provider" | "agentName" | "projectIdentityKey"
>;
type HermesUsageDraft = Omit<
  UsageRecord,
  "sessionId" | "machineId" | "provider" | "agentName" | "projectIdentityKey"
>;
type HermesEdgeDraft = Omit<
  SessionEdge,
  "sessionId" | "machineId" | "provider" | "agentName" | "projectIdentityKey"
>;
type HermesArtifactDraft = Omit<
  Artifact,
  "sessionId" | "machineId" | "provider" | "agentName" | "projectIdentityKey"
>;

const maybeDatabase = async (path: string) => {
  try {
    const { Database } = await import("bun:sqlite");
    return new Database(path);
  } catch {
    return undefined;
  }
};

const sql = (value: string) => `'${value.replaceAll("'", "''")}'`;

const sqliteJson = <A>(dbPath: string, query: string): A[] => {
  try {
    const output = execFileSync("sqlite3", ["-json", dbPath, query], { encoding: "utf8" });
    return output.trim().length === 0 ? [] : (JSON.parse(output) as A[]);
  } catch {
    return [];
  }
};

const copyDatabaseForRead = (dbPath: string) => {
  const tempDir = mkdtempSync(join(tmpdir(), "quasar-hermes-"));
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

/** Enumerate all profile-scoped state.db files plus the top-level default. */
const discoverHermesDbPaths = (root: string): { dbPath: string; profileName: string }[] => {
  const results: { dbPath: string; profileName: string }[] = [];
  const profilesDir = join(root, "profiles");
  if (existsSync(profilesDir)) {
    let profileDirs: string[] = [];
    try {
      profileDirs = readdirSync(profilesDir)
        .filter((entry) => {
          try {
            return statSync(join(profilesDir, entry)).isDirectory();
          } catch {
            return false;
          }
        })
        .sort();
    } catch {
      // unreadable profiles dir — skip, fall through to top-level
    }
    for (const profileName of profileDirs) {
      const dbPath = join(profilesDir, profileName, "state.db");
      if (existsSync(dbPath)) {
        results.push({ dbPath, profileName });
      }
    }
  }
  const topLevelDb = join(root, "state.db");
  if (existsSync(topLevelDb)) {
    results.push({ dbPath: topLevelDb, profileName: "hermes" });
  }
  return results;
};

export const hermesSessionWindowLimit = (limit: number | undefined) =>
  limit === undefined ? -1 : Math.max(1, Math.floor(limit));
const sessionWindowSkip = (skip: number | undefined) => Math.max(0, Math.floor(skip ?? 0));
const HERMES_SESSION_COLUMNS = [
  "id",
  "model",
  "parent_session_id",
  "started_at",
  "ended_at",
  "input_tokens",
  "output_tokens",
  "cache_read_tokens",
  "cache_write_tokens",
  "reasoning_tokens",
  "billing_provider",
  "estimated_cost_usd",
  "actual_cost_usd",
  "title",
  "cwd",
].join(", ");
// Columns are read in full — never byte caps. Provider garbage surfaces as
// named diagnostics at the ingest layer.
const HERMES_MESSAGE_COLUMNS = [
  "id",
  "session_id",
  "role",
  "content",
  "tool_call_id",
  "tool_calls",
  "tool_name",
  "timestamp",
  "token_count",
  "finish_reason",
  "reasoning",
  "reasoning_content",
  "reasoning_details",
  "codex_reasoning_items",
  "codex_message_items",
  "platform_message_id",
].join(", ");

// Raw reads return UNVALIDATED rows. Decoding happens at the boundary via
// `decodeOrDrop` so a garbage row is named + dropped, never silently coerced.
type HermesRawRow = Record<string, unknown>;

const readSessionRows = (
  db: HermesDatabase,
  limit: number | undefined,
  skip: number | undefined,
) =>
  db
    .query(`select ${HERMES_SESSION_COLUMNS} from sessions order by started_at desc, id desc limit ? offset ?`)
    .all(hermesSessionWindowLimit(limit), sessionWindowSkip(skip)) as HermesRawRow[];

const readMessageRows = (db: HermesDatabase, sessionId: string) =>
  db
    .query(`select ${HERMES_MESSAGE_COLUMNS} from messages where session_id = ? order by timestamp, id`)
    .all(sessionId) as HermesRawRow[];

const readSessionRowsCli = (
  dbPath: string,
  limit: number | undefined,
  skip: number | undefined,
) =>
  sqliteJson<HermesRawRow>(
    dbPath,
    `select ${HERMES_SESSION_COLUMNS} from sessions order by started_at desc, id desc limit ${hermesSessionWindowLimit(limit)} offset ${sessionWindowSkip(skip)}`,
  );

export const readHermesSessionRowsForWindow = (
  dbPath: string,
  limit?: number,
  skip?: number,
) => readSessionRowsCli(dbPath, limit, skip);

const readMessageRowsCli = (dbPath: string, sessionId: string) =>
  sqliteJson<HermesRawRow>(
    dbPath,
    `select ${HERMES_MESSAGE_COLUMNS} from messages where session_id = ${sql(sessionId)} order by timestamp, id`,
  );

/**
 * Decode the raw session-window rows fail-closed: valid rows pass through
 * (behavior identical to before), malformed rows become a named diagnostic in
 * `diagnostics` and are dropped from the window.
 */
const decodeSessionRows = (
  rows: readonly HermesRawRow[],
  diagnostics: DecodeDiagnostic[],
): HermesSessionRow[] =>
  rows.flatMap((row) => {
    const decision = decodeOrDrop(HermesSessionRowSchema, row, {
      kind: "session" as const,
      diagnosticName: "hermes.session.decode_failed",
      diagnostics,
    });
    return isSignal(decision) ? [decision.value] : [];
  });

/** Decode the raw message rows for a session fail-closed; drops are named. */
const decodeMessageRows = (
  rows: readonly HermesRawRow[],
  diagnostics: DecodeDiagnostic[],
): HermesMessageRow[] =>
  rows.flatMap((row) => {
    const decision = decodeOrDrop(HermesMessageRowSchema, row, {
      kind: "message" as const,
      diagnosticName: "hermes.message.decode_failed",
      diagnostics,
    });
    return isSignal(decision) ? [decision.value] : [];
  });

const isoFromEpoch = (value: unknown) => {
  const numeric = numberValue(value);
  if (numeric === undefined) return stringValue(value);
  return new Date(numeric > 10_000_000_000 ? numeric : numeric * 1000).toISOString();
};

const parsedJsonField = (value: unknown): NativeValue | undefined => {
  const parsed = parseJsonString(value);
  if (parsed === undefined || parsed === null || parsed === "") return undefined;
  return parsed as NativeValue;
};

const projectedReasoningFields = (message: HermesMessageRow) => ({
  reasoningDetails: parsedJsonField(message.reasoning_details),
  codexReasoningItems: parsedJsonField(message.codex_reasoning_items),
  codexMessageItems: parsedJsonField(message.codex_message_items),
});

const toolCallRecords = (value: unknown) => {
  const parsed = parseJsonString(value);
  if (Array.isArray(parsed)) return parsed.map(recordFrom).filter((record) => Object.keys(record).length > 0);
  const record = recordFrom(parsed);
  return Object.keys(record).length === 0 ? [] : [record];
};

const toolNameFromCall = (call: Record<string, unknown>) => {
  const functionRecord = recordFrom(call.function);
  return (
    stringValue(functionRecord.name) ??
    stringValue(call.name) ??
    stringValue(call.tool_name) ??
    stringValue(call.toolName) ??
    "hermes_tool"
  );
};

const toolInputFromCall = (call: Record<string, unknown>) => {
  const functionRecord = recordFrom(call.function);
  return projectToolPayloadNativeValue(
    parseJsonString(functionRecord.arguments) ??
    parseJsonString(call.arguments) ??
    functionRecord.input ??
    functionRecord.parameters ??
    call.args ??
    call.input ??
    call.params ??
    call.parameters,
  );
};

const nativeToolIdFromCall = (call: Record<string, unknown>, fallback: unknown) =>
  stringValue(call.id) ??
  stringValue(call.call_id) ??
  stringValue(call.tool_call_id) ??
  stringValue(call.toolCallId) ??
  String(fallback);

const statusFromFinishReason = (finishReason: unknown) => {
  const value = stringValue(finishReason);
  if (value === undefined) return undefined;
  return value.includes("tool") ? "started" : value;
};

const messageKind = (
  message: HermesMessageRow,
  calls: readonly Record<string, unknown>[],
): SessionEventKind => {
  if (message.tool_call_id !== undefined || stringValue(message.role) === "tool") return "tool_result";
  if (calls.length > 0) return "tool_call";
  if (
    stringValue(message.reasoning) !== undefined ||
    stringValue(message.reasoning_content) !== undefined ||
    message.reasoning_details !== undefined
  ) {
    return stringValue(message.content) === undefined ? "reasoning" : "message";
  }
  return "message";
};

const messageContent = (message: HermesMessageRow): NativeValue => {
  const reasoning = projectedReasoningFields(message);
  const reasoningDetails = projectSessionNativeValue(reasoning.reasoningDetails);
  const codexReasoningItems = projectSessionNativeValue(reasoning.codexReasoningItems);
  const codexMessageItems = projectSessionNativeValue(reasoning.codexMessageItems);
  return {
    content: stringValue(message.content),
    reasoning: stringValue(message.reasoning),
    reasoning_content: stringValue(message.reasoning_content),
    ...(reasoningDetails !== undefined ? { reasoning_details: reasoningDetails } : {}),
    ...(codexReasoningItems !== undefined ? { codex_reasoning_items: codexReasoningItems } : {}),
    ...(codexMessageItems !== undefined ? { codex_message_items: codexMessageItems } : {}),
    finish_reason: stringValue(message.finish_reason),
    platform_message_id: stringValue(message.platform_message_id),
  };
};

const messageBlocks = (
  sessionId: SessionId,
  eventId: string,
  message: HermesMessageRow,
) => {
  const reasoning = projectedReasoningFields(message);
  const blockInputs: NativeValue[] = [];
  const content = stringValue(message.content);
  if (content !== undefined) blockInputs.push({ type: "text", text: content });
  const thinking = stringValue(message.reasoning_content) ?? stringValue(message.reasoning);
  if (thinking !== undefined) blockInputs.push({ type: "thinking", thinking });
  const reasoningDetails = projectSessionNativeValue(reasoning.reasoningDetails);
  if (reasoningDetails !== undefined) {
    blockInputs.push({ type: "json", value: reasoningDetails, label: "reasoning_details" });
  }
  const codexReasoningItems = projectSessionNativeValue(reasoning.codexReasoningItems);
  if (codexReasoningItems !== undefined) {
    blockInputs.push({ type: "json", value: codexReasoningItems, label: "codex_reasoning_items" });
  }
  const codexMessageItems = projectSessionNativeValue(reasoning.codexMessageItems);
  if (codexMessageItems !== undefined) {
    blockInputs.push({ type: "json", value: codexMessageItems, label: "codex_message_items" });
  }
  return contentBlocksFromNative(sessionId, eventId, blockInputs);
};

const messageUsage = (
  sessionId: SessionId,
  eventId: string,
  message: HermesMessageRow,
  index: number,
  session: HermesSessionRow,
): HermesUsageDraft | undefined => {
  const totalTokens = numberValue(message.token_count);
  if (totalTokens === undefined) return undefined;
  return {
    id: usageIdFor(sessionId, eventId, index),
    eventId,
    timestamp: isoFromEpoch(message.timestamp),
    model: stringValue(session.model),
    modelProvider: stringValue(session.billing_provider),
    totalTokens,
  };
};

const sessionUsage = (
  sessionId: SessionId,
  session: HermesSessionRow,
): HermesUsageDraft | undefined => {
  const inputTokens = numberValue(session.input_tokens);
  const outputTokens = numberValue(session.output_tokens);
  const cacheReadInputTokens = numberValue(session.cache_read_tokens);
  const cacheCreationInputTokens = numberValue(session.cache_write_tokens);
  const reasoningTokens = numberValue(session.reasoning_tokens);
  const totalTokens = sumNumbers([
    inputTokens,
    outputTokens,
    cacheReadInputTokens,
    cacheCreationInputTokens,
    reasoningTokens,
  ]);
  const cost = numberValue(session.actual_cost_usd) ?? numberValue(session.estimated_cost_usd);
  if (totalTokens === undefined && cost === undefined) return undefined;
  return {
    id: usageIdFor(sessionId, undefined, -1),
    timestamp: isoFromEpoch(session.ended_at) ?? isoFromEpoch(session.started_at),
    model: stringValue(session.model),
    modelProvider: stringValue(session.billing_provider),
    inputTokens,
    outputTokens,
    cacheCreationInputTokens,
    cacheReadInputTokens,
    reasoningTokens,
    totalTokens,
    cost,
    currency: cost === undefined ? undefined : "USD",
  };
};

const sumNumbers = (values: readonly (number | undefined)[]) => {
  const present = values.filter((value): value is number => value !== undefined);
  return present.length === 0
    ? undefined
    : present.reduce((sum, value) => sum + value, 0);
};

const buildHermesSessionFromRows = (
  dbPath: string,
  root: string,
  options: AdapterOptions,
  session: HermesSessionRow,
  messages: readonly HermesMessageRow[],
  profileName: string,
) => {
  const nativeSessionId = HermesSessionId(String(session.id ?? ""));
  const sessionId = sessionIdFor("hermes", nativeSessionId);
  const toolCallsByNativeId = new Map<string, HermesToolCallDraft>();
  const toolEventByNativeId = new Map<string, string>();
  const usageRecords: HermesUsageDraft[] = [];
  const sessionEdges: HermesEdgeDraft[] = [];
  const artifacts: HermesArtifactDraft[] = [];
  const sessionLevelUsage = sessionUsage(sessionId, session);
  if (sessionLevelUsage !== undefined) usageRecords.push(sessionLevelUsage);
  // Session-to-session subagent lineage: hermes stores the parent's NATIVE id.
  // This is SESSION lineage, NOT event-to-event message threading, so it uses
  // the purpose-built `subagent_of` edge kind — never `parent`, which other
  // adapters (claude, opencode) use for event threading and on whose `fromId`
  // they place a raw message uuid. The canonical edge carries the parent's
  // machine-independent Quasar SessionId on `fromId` (and the child's on
  // `toId`) so it joins to `sessions.session_id` once persisted; the native
  // value is preserved in `rawReference`. mapSession projects `subagent_of`
  // onto the canonical `SessionRow.parentSessionId` column.
  const parentNativeSessionId = stringValue(session.parent_session_id);
  if (parentNativeSessionId !== undefined) {
    const parentSessionId = sessionIdFor("hermes", HermesSessionId(parentNativeSessionId));
    sessionEdges.push({
      id: edgeIdFor(sessionId, "subagent_of", parentSessionId, sessionId),
      kind: "subagent_of",
      fromId: parentSessionId,
      toId: sessionId,
      rawReference: {
        sourcePath: dbPath,
        table: "sessions",
        rowId: nativeSessionId,
        nativeType: "parent_session_id",
        nativeValue: parentNativeSessionId,
      },
    });
  }

  const events = messages.map((message, index) => {
    const nativeEventId = String(message.id ?? index);
    const eventId = eventIdFor(sessionId, index, nativeEventId);
    const calls = toolCallRecords(message.tool_calls);
    let eventToolCallId: string | undefined;
    for (const [callIndex, call] of calls.entries()) {
      const nativeToolId = nativeToolIdFromCall(call, `${nativeEventId}:${callIndex}`);
      const input = toolInputFromCall(call);
      const toolCall: HermesToolCallDraft = {
        id: scopedId(sessionId, "tool", nativeToolId),
        eventId,
        toolName: toolNameFromCall(call),
        status: statusFromFinishReason(message.finish_reason),
        ...(input !== undefined ? { input } : {}),
        startedAt: isoFromEpoch(message.timestamp),
      };
      toolCallsByNativeId.set(nativeToolId, toolCall);
      toolEventByNativeId.set(nativeToolId, eventId);
      eventToolCallId ??= toolCall.id;
    }

    const resultNativeToolId = stringValue(message.tool_call_id);
    if (resultNativeToolId !== undefined) {
      const existing = toolCallsByNativeId.get(resultNativeToolId);
      const resultToolCall =
        existing ??
        ({
          id: scopedId(sessionId, "tool", resultNativeToolId),
          eventId,
          toolName: stringValue(message.tool_name) ?? "hermes_tool",
        } satisfies HermesToolCallDraft);
      const output = projectToolPayloadNativeValue(stringValue(message.content) ?? message.content);
      const completed = {
        ...resultToolCall,
        status: "completed",
        ...(output !== undefined ? { output } : {}),
        completedAt: isoFromEpoch(message.timestamp),
      };
      toolCallsByNativeId.set(resultNativeToolId, completed);
      eventToolCallId = completed.id;
      const callEventId = toolEventByNativeId.get(resultNativeToolId);
      if (callEventId !== undefined) {
        sessionEdges.push({
          id: edgeIdFor(sessionId, "tool_result_for", callEventId, eventId),
          kind: "tool_result_for",
          fromEventId: callEventId,
          toEventId: eventId,
        });
      }
    }

    const usage = messageUsage(sessionId, eventId, message, index, session);
    if (usage !== undefined) usageRecords.push(usage);
    const content = messageContent(message);
    return {
      id: eventId,
      nativeEventId,
      sequence: index,
      timestamp: isoFromEpoch(message.timestamp),
      role: roleFrom(stringValue(message.role)),
      kind: messageKind(message, calls),
      contentText: compactText(content),
      contentSource: content,
      contentBlocks: messageBlocks(sessionId, eventId, message),
      ...(eventToolCallId !== undefined ? { toolCallId: eventToolCallId } : {}),
      rawReference: { sourcePath: dbPath, table: "messages", rowId: nativeEventId, nativeType: "message" },
    };
  });

  return buildSession({
    provider: "hermes",
    agentName: "hermes",
    machine: options.machine,
    sessionId,
    nativeSessionId,
    nativeProjectKey: stringValue(session.cwd),
    title: stringValue(session.title),
    startedAt: isoFromEpoch(session.started_at),
    updatedAt: isoFromEpoch(session.ended_at),
    sourceRoot: root,
    sourcePath: dbPath,
    explicitProjectKey: `profile:${profileName}`,
    events,
    toolCalls: [...toolCallsByNativeId.values()],
    sessionEdges,
    usageRecords,
    artifacts,
  });
};

const missingDatabaseResult = (root: string | undefined) => ({
  sourceRoots: [],
  sessions: [],
  diagnostics: [
    {
      adapterId: hermesAdapter.id,
      provider: "hermes" as const,
      status: "no_data_found" as const,
      parserConfidence: "documented" as const,
      message: "Hermes state.db was not found.",
      ...(root !== undefined ? { rootPath: root } : {}),
    },
  ],
});

/**
 * Per-session change signal. Hermes shards sessions across profile-scoped
 * state.db files (one per ~/.hermes/profiles/<name>/state.db), so a
 * file-level stat fingerprint would mismatch for every session in a profile
 * whenever any single one is touched — forcing a full-estate re-ingest. The
 * session's own message-row count plus newest message timestamp (epoch
 * seconds, append-only log) is the per-session signal.
 */
const hermesSessionFingerprint = (rows: readonly HermesMessageRow[]): UnitFingerprint => {
  let latest = 0;
  for (const row of rows) {
    const ts = typeof row.timestamp === "number" ? row.timestamp : Number(row.timestamp);
    if (Number.isFinite(ts) && ts > latest) latest = ts;
  }
  return { size: rows.length, mtimeMs: latest };
};

/**
 * Cheap pre-parse gate for a hermes session. Hermes is honest about its
 * partial skip: the message rows must be read to fingerprint a session (the
 * shared state.db's file stat is useless per-session), but the gate runs
 * before buildHermesSessionFromRows so the expensive normalization (content
 * block projection, tool-call assembly, redaction) is skipped on a hit. The
 * probe's sourceFingerprint equals what the engine derives from
 * `item.fingerprint` (JSON.stringify of the same unit fingerprint).
 */
const skipHermesSession = async (
  options: AdapterOptions,
  sessionEntry: HermesSessionRow,
  messageRows: readonly HermesMessageRow[],
  sourcePath: string,
): Promise<boolean> => {
  if (options.shouldParseSession === undefined) return false;
  const probe = {
    sessionId: sessionIdFor("hermes", HermesSessionId(String(sessionEntry.id ?? ""))),
    sourceFingerprint: JSON.stringify(hermesSessionFingerprint(messageRows)),
  };
  return (await options.shouldParseSession(probe)) === false;
};

async function* streamHermes(options: AdapterOptions): AsyncGenerator<AdapterStreamItem> {
  const root = options.roots?.hermes ?? hermesAdapter.defaultRoot();
  const logicalRoot = root === undefined ? undefined : logicalRootFor("hermes", root, options);

  if (root === undefined) {
    for (const diagnostic of missingDatabaseResult(logicalRoot ?? root).diagnostics) {
      yield { type: "diagnostic", diagnostic };
    }
    return;
  }

  const dbEntries = discoverHermesDbPaths(root);

  if (dbEntries.length === 0) {
    yield {
      type: "diagnostic",
      diagnostic: {
        adapterId: hermesAdapter.id,
        provider: "hermes" as const,
        status: "no_data_found" as const,
        parserConfidence: "documented" as const,
        message: "No Hermes state.db files found (checked profiles/* and top-level).",
        rootPath: logicalRoot ?? root,
      },
    };
    return;
  }

  yield {
    type: "sourceRoot",
    sourceRoot: sourceRoot("hermes", hermesAdapter.id, logicalRoot ?? root, options.machine, options.now),
  };

  let totalSessionCount = 0;

  for (const { dbPath, profileName } of dbEntries) {
    const logicalDbPath =
      logicalRoot !== undefined
        ? dbPath.replace(root, logicalRoot)
        : dbPath;
    const tempDb = copyDatabaseForRead(dbPath);
    const db = await maybeDatabase(tempDb.path);
    let profileSessionCount = 0;
    // Named decode diagnostics for malformed rows in THIS profile's db. Drops
    // are accumulated here and surfaced as a single attributable diagnostic so a
    // garbage row never aborts the file and never coerces silently.
    const decodeDiagnostics: DecodeDiagnostic[] = [];
    // Raw, unvalidated readers — identical window, just two transports.
    const rawSessionRows = db === undefined
      ? readSessionRowsCli(tempDb.path, options.limit, options.skip)
      : readSessionRows(db, options.limit, options.skip);
    const rawMessageRows = (sessionId: string): HermesRawRow[] =>
      db === undefined ? readMessageRowsCli(tempDb.path, sessionId) : readMessageRows(db, sessionId);
    try {
      for (const sessionEntry of decodeSessionRows(rawSessionRows, decodeDiagnostics)) {
        const messageRows = decodeMessageRows(rawMessageRows(sessionEntry.id), decodeDiagnostics);
        if (await skipHermesSession(options, sessionEntry, messageRows, logicalDbPath)) continue;
        const session = buildHermesSessionFromRows(
          logicalDbPath,
          logicalRoot ?? root,
          options,
          sessionEntry,
          messageRows,
          profileName,
        );
        yield {
          type: "session",
          session,
          sourceUnit: {
            provider: "hermes" as const,
            adapterId: hermesAdapter.id,
            rootPath: logicalRoot ?? root,
            sourcePath: session.sourcePath,
            physicalPath: dbPath,
          },
          fingerprint: hermesSessionFingerprint(messageRows),
        };
        profileSessionCount += 1;
      }
      totalSessionCount += profileSessionCount;
      for (const diagnostic of decodeDiagnostics) {
        yield {
          type: "diagnostic",
          diagnostic: {
            adapterId: hermesAdapter.id,
            provider: "hermes" as const,
            status: "unsupported" as const,
            parserConfidence: "documented" as const,
            rootPath: logicalDbPath,
            message: `Hermes row dropped (${diagnostic.name}) in profile '${profileName}'.`,
            details: { error: diagnostic.message },
          },
        };
      }
    } catch (error) {
      yield {
        type: "diagnostic",
        diagnostic: {
          adapterId: hermesAdapter.id,
          provider: "hermes" as const,
          status: "unsupported" as const,
          parserConfidence: "documented" as const,
          rootPath: logicalDbPath,
          message: `Hermes state.db for profile '${profileName}' did not match the documented sessions/messages schema.`,
          details: { error: error instanceof Error ? error.message : String(error) },
        },
      };
    } finally {
      db?.close();
      tempDb.cleanup();
    }
  }

  yield {
    type: "diagnostic",
    diagnostic: {
      adapterId: hermesAdapter.id,
      provider: "hermes" as const,
      status: totalSessionCount > 0 ? ("available" as const) : ("no_data_found" as const),
      parserConfidence: "documented" as const,
      rootPath: logicalRoot ?? root,
      message: `Discovered ${totalSessionCount} Hermes session(s) across ${dbEntries.length} profile database(s).`,
    },
  };
}

export const hermesAdapter: SessionAdapter = {
  id: "hermes-state-sqlite",
  provider: "hermes",
  displayName: "Hermes state.db SQLite",
  stable: true,
  defaultRoot: () => process.env.HERMES_HOME ?? homePath(".hermes"),
  read: async (options) => collectAdapterStream(streamHermes(options)),
  stream: streamHermes,
};
