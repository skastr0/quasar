import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import { Schema } from "effect";

import { HermesSessionId, type SessionId } from "../core/identity";
import type { Artifact, SessionEdge, SessionRole, ToolCall, UsageRecord } from "../core/schemas";
import { type DecodeDiagnostic, decodeOrDrop, isSignal } from "./harness-schema";
import {
  HermesCodexMessageItemsArraySchema,
  HermesCodexReasoningItemsArraySchema,
  HermesMessageRowSchema,
  HermesReasoningDetailsArraySchema,
  HermesSessionRowSchema,
  HermesToolCallsArraySchema,
  type HermesMessageRow,
  type HermesSessionRow,
  type HermesToolCall,
  classifyMessage,
  classifyToolCall,
} from "./hermes-schema";
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
// On-disk record schemas + declarative classification live in hermes-schema.ts
// (QSR-220 FULL DATA FIDELITY). This adapter imports them read-only and routes
// EVERY provider record — session rows, message rows, and the JSON sub-records
// inside the tool_calls / codex_* / reasoning_details TEXT columns — through
// `decodeOrDrop`, then dispatches each via the declarative `classifyMessage` /
// `classifyToolCall` (signal mapped-kind / drop named-reason). There is no
// "unknown" pass-through and no shared kind/role heuristic in this file.
// ---------------------------------------------------------------------------

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
    const output = execFileSync("sqlite3", ["-json", dbPath, query], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
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
  "source",
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
  "handoff_state",
  "handoff_platform",
  "handoff_error",
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

/**
 * Decode a JSON-as-TEXT column through a modeled Schema fail-closed. The column
 * value is first JSON.parsed (the column stores a JSON string), then validated.
 * A malformed payload is NOT projected as raw NativeValue — it is dropped with
 * a named diagnostic so a garbage column never coerces silently. Returns the
 * decoded value (typed) or undefined when absent/empty/invalid.
 */
const decodeJsonColumn = <A, I>(
  schema: Schema.Schema<A, I>,
  value: unknown,
  diagnosticName: string,
  diagnostics: DecodeDiagnostic[],
): A | undefined => {
  const parsed = parseJsonString(value);
  if (parsed === undefined || parsed === null || parsed === "") return undefined;
  const decision = decodeOrDrop(schema, parsed, {
    kind: "json" as const,
    diagnosticName,
    diagnostics,
  });
  return isSignal(decision) ? decision.value : undefined;
};

/**
 * Decode all reasoning/codex JSON sub-record columns of a message through their
 * modeled schemas. Each is a NAMED record type; a malformed column is a named
 * drop, never silent passthrough.
 */
const projectedReasoningFields = (message: HermesMessageRow, diagnostics: DecodeDiagnostic[]) => ({
  reasoningDetails: decodeJsonColumn(
    HermesReasoningDetailsArraySchema,
    message.reasoning_details,
    "hermes.reasoning_details.decode_failed",
    diagnostics,
  ),
  codexReasoningItems: decodeJsonColumn(
    HermesCodexReasoningItemsArraySchema,
    message.codex_reasoning_items,
    "hermes.codex_reasoning_items.decode_failed",
    diagnostics,
  ),
  codexMessageItems: decodeJsonColumn(
    HermesCodexMessageItemsArraySchema,
    message.codex_message_items,
    "hermes.codex_message_items.decode_failed",
    diagnostics,
  ),
});

/**
 * Decode the tool_calls TEXT column into the modeled tool-call array. The column
 * stores either a JSON array or (legacy) a single object; both are normalized to
 * an array before validation. A malformed payload is a named drop.
 */
const decodedToolCalls = (value: unknown, diagnostics: DecodeDiagnostic[]): HermesToolCall[] => {
  const parsed = parseJsonString(value);
  if (parsed === undefined || parsed === null || parsed === "") return [];
  const asArray = Array.isArray(parsed) ? parsed : [parsed];
  const decision = decodeOrDrop(HermesToolCallsArraySchema, asArray, {
    kind: "tool_calls" as const,
    diagnosticName: "hermes.tool_calls.decode_failed",
    diagnostics,
  });
  return isSignal(decision) ? [...decision.value] : [];
};

const toolInputFromCall = (call: HermesToolCall) => {
  const fn = call.function ?? undefined;
  return projectToolPayloadNativeValue(
    parseJsonString(fn?.arguments) ??
    parseJsonString(call.arguments) ??
    fn?.input ??
    fn?.parameters ??
    call.args ??
    call.input ??
    call.params ??
    call.parameters,
  );
};

const nativeToolIdFromCall = (call: HermesToolCall, fallback: unknown) =>
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

type DecodedReasoning = ReturnType<typeof projectedReasoningFields>;

/**
 * Peel the hermes `messages.content` TEXT column down to the leaf prose value.
 *
 * The column stores one of two shapes on disk:
 *   - Plain prose ("hello!") — kept VERBATIM, never inspected further.
 *   - A JSON blob (starts with '{' or '[') — the harness structural wrapper is
 *     stripped; only the leaf message text is kept:
 *       • object:  .content (string) | .parts[*].text joined by " "
 *       • array:   every item's .text joined by " "
 *
 * When content is absent or yields nothing after peeling, fall back to the
 * codex_message_items column (codex-bridged messages): join all
 * items[*].content[*].text.
 *
 * EXTRACTION RULE: peel the known per-harness envelope → leaf value, VERBATIM.
 * NEVER classify prose-vs-json. NEVER reformat or pretty-print content.
 * Agent-generated JSON is legitimate content and kept as-is (it only gets
 * peeled if the OUTER wrapper is the harness envelope, not because its value
 * happens to look like JSON).
 */
const extractHermesContentText = (
  rawContent: string | null | undefined,
  codexMessageItems: DecodedReasoning["codexMessageItems"],
): string | undefined => {
  const raw = typeof rawContent === "string" && rawContent.length > 0 ? rawContent : undefined;

  if (raw !== undefined && raw[0] !== "{" && raw[0] !== "[") {
    // Plain prose — keep verbatim (no compaction; compactText runs downstream).
    return raw;
  }

  // JSON-blob path: parse and peel the harness envelope.
  if (raw !== undefined) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      // Not valid JSON despite starting with { or [. Treat as verbatim prose.
      return raw;
    }

    const extractText = (value: unknown): string | undefined => {
      if (typeof value === "string") return value.length > 0 ? value : undefined;
      if (Array.isArray(value)) {
        const parts = value.flatMap((item) => {
          const t = extractText(item);
          return t !== undefined ? [t] : [];
        });
        return parts.length > 0 ? parts.join(" ") : undefined;
      }
      if (value !== null && typeof value === "object") {
        const record = value as Record<string, unknown>;
        // .content (string) or .parts[*].text are the two hermes envelope shapes.
        const fromContent = typeof record.content === "string" ? record.content : undefined;
        if (fromContent !== undefined && fromContent.length > 0) return fromContent;
        if (record.parts !== undefined) {
          const parts = (Array.isArray(record.parts) ? record.parts : [record.parts]).flatMap(
            (part) => {
              if (part !== null && typeof part === "object") {
                const t = (part as Record<string, unknown>).text;
                return typeof t === "string" && t.length > 0 ? [t] : [];
              }
              return [];
            },
          );
          if (parts.length > 0) return parts.join(" ");
        }
        // Array-of-objects shape: try .text on each element.
        const fromText = typeof record.text === "string" ? record.text : undefined;
        if (fromText !== undefined && fromText.length > 0) return fromText;
      }
      return undefined;
    };

    const extracted = extractText(parsed);
    if (extracted !== undefined) return extracted;
  }

  // Codex-bridged fallback: join all items[*].content[*].text.
  if (codexMessageItems !== undefined && Array.isArray(codexMessageItems)) {
    const parts: string[] = [];
    for (const item of codexMessageItems as Array<Record<string, unknown>>) {
      const content = item.content;
      if (!Array.isArray(content)) continue;
      for (const block of content as Array<Record<string, unknown>>) {
        const t = typeof block.text === "string" ? block.text : undefined;
        if (t !== undefined && t.length > 0) parts.push(t);
      }
    }
    if (parts.length > 0) return parts.join(" ");
  }

  return undefined;
};

/**
 * Extract the reasoning prose from a message row. Reasoning is first-class and
 * searchable — not restricted to contentBlocks. Priority: reasoning_content
 * (the display-facing field Hermes populates for most providers), then
 * reasoning (the raw scratchpad).
 */
const extractReasoningText = (message: HermesMessageRow): string | undefined =>
  stringValue(message.reasoning_content) ?? stringValue(message.reasoning);

const messageContent = (message: HermesMessageRow, reasoning: DecodedReasoning): NativeValue => {
  const reasoningDetails = projectSessionNativeValue(reasoning.reasoningDetails as NativeValue);
  const codexReasoningItems = projectSessionNativeValue(reasoning.codexReasoningItems as NativeValue);
  const codexMessageItems = projectSessionNativeValue(reasoning.codexMessageItems as NativeValue);
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
  reasoning: DecodedReasoning,
) => {
  const blockInputs: NativeValue[] = [];
  const content = stringValue(message.content);
  if (content !== undefined) blockInputs.push({ type: "text", text: content });
  const thinking = stringValue(message.reasoning_content) ?? stringValue(message.reasoning);
  if (thinking !== undefined) blockInputs.push({ type: "thinking", thinking });
  const reasoningDetails = projectSessionNativeValue(reasoning.reasoningDetails as NativeValue);
  if (reasoningDetails !== undefined) {
    blockInputs.push({ type: "json", value: reasoningDetails, label: "reasoning_details" });
  }
  const codexReasoningItems = projectSessionNativeValue(reasoning.codexReasoningItems as NativeValue);
  if (codexReasoningItems !== undefined) {
    blockInputs.push({ type: "json", value: codexReasoningItems, label: "codex_reasoning_items" });
  }
  const codexMessageItems = projectSessionNativeValue(reasoning.codexMessageItems as NativeValue);
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
  diagnostics: DecodeDiagnostic[],
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

  // Each message row is classified DECLARATIVELY (signal kind+role / drop named
  // reason). A dropped message (e.g. the empty `session_meta` lifecycle marker)
  // produces NO event — there is no "unknown" fall-through. The native-event
  // sequence index advances only for kept (signal) events so the sequence stays
  // dense and deterministic.
  let sequence = 0;
  const events = messages.flatMap((message) => {
    const nativeEventId = String(message.id ?? sequence);
    const calls = decodedToolCalls(message.tool_calls, diagnostics);
    const decision = classifyMessage(message, calls);
    if (!isSignal(decision)) {
      // Named drop (session_meta marker, empty/unmapped) — recorded as a
      // diagnostic so the boundary stays attributable; emits no event.
      diagnostics.push({ name: "hermes.message.dropped", message: decision.reason });
      return [];
    }
    const index = sequence;
    sequence += 1;
    const eventId = eventIdFor(sessionId, index, nativeEventId);
    let eventToolCallId: string | undefined;

    // tool_call kind: assemble each modeled+classified tool call.
    for (const [callIndex, call] of calls.entries()) {
      const callDecision = classifyToolCall(call);
      if (!isSignal(callDecision)) {
        diagnostics.push({ name: "hermes.toolcall.dropped", message: callDecision.reason });
        continue;
      }
      const nativeToolId = nativeToolIdFromCall(call, `${nativeEventId}:${callIndex}`);
      const input = toolInputFromCall(call);
      const toolCall: HermesToolCallDraft = {
        id: scopedId(sessionId, "tool", nativeToolId),
        eventId,
        toolName: callDecision.value.name,
        status: statusFromFinishReason(message.finish_reason),
        ...(input !== undefined ? { input } : {}),
        startedAt: isoFromEpoch(message.timestamp),
      };
      toolCallsByNativeId.set(nativeToolId, toolCall);
      toolEventByNativeId.set(nativeToolId, eventId);
      eventToolCallId ??= toolCall.id;
    }

    // tool_result kind: a row carrying a tool_call_id back-reference completes
    // the matching call (or synthesizes one when the call row was unseen).
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
    const reasoning = projectedReasoningFields(message, diagnostics);
    const content = messageContent(message, reasoning);

    // Extract the leaf prose from the content TEXT column. When the column
    // stores a JSON blob (starts with '{' or '['), peel the harness envelope
    // and surface only the inner text. Plain prose is kept VERBATIM.
    const mainContentText = extractHermesContentText(
      stringValue(message.content) ?? null,
      reasoning.codexMessageItems,
    );

    // Reasoning is first-class and searchable. Extract the prose now so it can
    // surface as a separate reasoning event (kind="reasoning", role="thinking")
    // in addition to the contentBlocks it already occupies. This ensures
    // reasoning text is findable via contentText search.
    const reasoningProse = extractReasoningText(message);

    const mainEvent = {
      id: eventId,
      nativeEventId,
      sequence: index,
      timestamp: isoFromEpoch(message.timestamp),
      // Declarative role from the classifier — NOT the shared `roleFrom`
      // heuristic (which mislabels `session_meta` as "unknown").
      role: decision.value.role satisfies SessionRole,
      kind: decision.kind,
      // For reasoning-only events (kind="reasoning"), surfacing the reasoning
      // prose as contentText makes it searchable. For regular messages,
      // contentText is the extracted prose from the content column.
      contentText: decision.kind === "reasoning" && mainContentText === undefined
        ? (reasoningProse !== undefined ? compactText(reasoningProse) : compactText(content))
        : (mainContentText !== undefined ? compactText(mainContentText) : compactText(content)),
      contentSource: content,
      contentBlocks: messageBlocks(sessionId, eventId, message, reasoning),
      ...(eventToolCallId !== undefined ? { toolCallId: eventToolCallId } : {}),
      rawReference: { sourcePath: dbPath, table: "messages", rowId: nativeEventId, nativeType: "message" },
    };

    // When reasoning co-occurs with conversational content (the assistant row
    // carries BOTH content and reasoning_content/reasoning), emit a dedicated
    // reasoning event so the reasoning prose becomes independently searchable.
    // This does NOT apply to reasoning-only rows (already classified as
    // kind="reasoning") or tool_call / tool_result rows.
    const shouldEmitReasoningEvent =
      reasoningProse !== undefined &&
      decision.kind === "message" &&
      mainContentText !== undefined;

    if (!shouldEmitReasoningEvent) {
      return [mainEvent];
    }

    // Reasoning event: kind="reasoning", role="thinking" (the valid SessionRole
    // closest to "reasoning"). Sequence advances once more so IDs are dense.
    const reasoningIndex = sequence;
    sequence += 1;
    const reasoningEventId = eventIdFor(sessionId, reasoningIndex, `${nativeEventId}:reasoning`);
    const reasoningEvent = {
      id: reasoningEventId,
      nativeEventId: `${nativeEventId}:reasoning`,
      sequence: reasoningIndex,
      timestamp: isoFromEpoch(message.timestamp),
      role: "thinking" as SessionRole,
      kind: "reasoning" as const,
      contentText: compactText(reasoningProse),
      contentSource: { reasoning_content: stringValue(message.reasoning_content), reasoning: stringValue(message.reasoning) } as NativeValue,
      contentBlocks: contentBlocksFromNative(sessionId, reasoningEventId, [{ type: "thinking", thinking: reasoningProse }]),
      rawReference: { sourcePath: dbPath, table: "messages", rowId: nativeEventId, nativeType: "message_reasoning" },
    };

    return [mainEvent, reasoningEvent];
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
    // Stat-level gate: skip unchanged DB files BEFORE copying and opening them.
    // An unchanged state.db means no session in this profile has changed;
    // skip the entire profile without opening the file.
    if (options.shouldReadFile !== undefined) {
      const stat = statSync(dbPath);
      if (!options.shouldReadFile(dbPath, stat)) continue;
    }
    let tempDb: ReturnType<typeof copyDatabaseForRead>;
    try {
      tempDb = copyDatabaseForRead(dbPath);
    } catch (error) {
      yield {
        type: "diagnostic",
        diagnostic: {
          adapterId: hermesAdapter.id,
          provider: "hermes" as const,
          status: "unsupported" as const,
          parserConfidence: "documented" as const,
          rootPath: logicalDbPath,
          message: `Hermes state.db for profile '${profileName}' could not be copied for reading.`,
          details: {
            diagnostic: "hermes.sqlite.unreadable",
            error: error instanceof Error ? error.message : String(error),
          },
        },
      };
      continue;
    }
    const db = await maybeDatabase(tempDb.path);
    let profileSessionCount = 0;
    // Named decode diagnostics for malformed rows in THIS profile's db. Drops
    // are accumulated here and surfaced as a single attributable diagnostic so a
    // garbage row never aborts the file and never coerces silently.
    const decodeDiagnostics: DecodeDiagnostic[] = [];
    try {
      // Raw, unvalidated readers — identical window, just two transports.
      const rawSessionRows = db === undefined
        ? readSessionRowsCli(tempDb.path, options.limit, options.skip)
        : readSessionRows(db, options.limit, options.skip);
      const rawMessageRows = (sessionId: string): HermesRawRow[] =>
        db === undefined ? readMessageRowsCli(tempDb.path, sessionId) : readMessageRows(db, sessionId);
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
          decodeDiagnostics,
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
          details: {
            diagnostic: "hermes.sqlite.unreadable",
            error: error instanceof Error ? error.message : String(error),
          },
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
