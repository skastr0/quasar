import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { collectAdapterStream, type AdapterStreamItem, type SessionAdapter } from "./types";
import { AntigravitySessionId } from "../core/identity";
import type { NormalizedSession, SessionEdge, ToolCall } from "../core/schemas";
import {
  buildSession,
  compactText,
  edgeIdFor,
  eventIdFor,
  homePath,
  projectToolPayloadNativeValue,
  readJsonLines,
  scopedId,
  sessionIdFor,
  sourceFingerprintFor,
  sourceRoot,
  type NativeValue,
} from "./common";
import { type DecodeDiagnostic, decodeOrDrop, isSignal } from "./harness-schema";
import {
  AntigravityRecordSchema,
  agentNameFromRole,
  childUuidsFromInvokeContent,
  classifyRecord,
  classifyToolCall,
  isToolExecutionType,
  isToolResultType,
  rolesFromInvokeToolCall,
  type AntigravityKind,
  type AntigravityRole,
  type SubagentRole,
} from "./antigravity-schema";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type AntigravityToolCallDraft = Omit<
  ToolCall,
  "sessionId" | "machineId" | "provider" | "agentName" | "projectIdentityKey"
>;

type AntigravityEdgeDraft = Omit<
  SessionEdge,
  "sessionId" | "machineId" | "provider" | "agentName" | "projectIdentityKey"
>;

/**
 * Resolved cross-session lineage for one child brain dir: the canonical PARENT
 * uuid that spawned it, plus the subagent Role/TypeName so the child session's
 * agentName can reflect what kind of subagent it was.
 */
interface AntigravityChildLineage {
  readonly parentUuid: string;
  readonly role?: SubagentRole;
}

/** The whole brain root's child-uuid → parent lineage map (built once per read). */
type AntigravityLineageMap = ReadonlyMap<string, AntigravityChildLineage>;

type AntigravityEventDraft = {
  readonly id: string;
  readonly nativeEventId?: string;
  readonly sequence: number;
  readonly timestamp?: string;
  readonly role: AntigravityRole;
  readonly kind: AntigravityKind;
  readonly contentText?: string;
  readonly contentSource?: NativeValue;
  readonly toolCallId?: string;
  readonly reasoning?: string;
  readonly rawReference: {
    readonly sourcePath: string;
    readonly line: number;
    readonly nativeType: string;
  };
};

type AdapterOptions = Parameters<SessionAdapter["read"]>[0];

// ---------------------------------------------------------------------------
// Role + kind mapping
//
// The record-level signal/drop dispatch is DECLARATIVE and lives ENTIRELY in
// antigravity-schema.ts (`classifyRecord`): every one of the 15 on-disk record
// types is explicitly signal(role/kind) or drop(named reason), with a
// compile-time exhaustiveness guard. This adapter no longer carries any local
// kind/role heuristic — it decodes fail-closed, then routes each record through
// that single declarative dispatch. Only the turn-segmentation pass
// (`terminalPlannerResponseIndices`) stays here, because it depends on the
// ordering of records, not on any one record's shape.
// ---------------------------------------------------------------------------

/**
 * Marks each PLANNER_RESPONSE record (by line index in the parsed-record array)
 * that is the LAST PLANNER_RESPONSE inside its turn. A turn starts at a
 * USER_INPUT and runs up to the next USER_INPUT (exclusive); the trailing span
 * after the final USER_INPUT is its own turn. Records before the first
 * USER_INPUT are provider preamble/noise, not assistant answers.
 * Antigravity transcripts are cumulative replay snapshots — every USER_INPUT
 * restarts step_index at 0 — so each replay's terminal response is counted,
 * which is exactly why the emitted assistant-message count tracks the
 * USER_INPUT count.
 */
const terminalPlannerResponseIndices = (
  records: readonly { readonly type: string }[],
): ReadonlySet<number> => {
  const terminal = new Set<number>();
  let lastPlannerInTurn: number | undefined;
  let seenUserInput = false;
  const flush = () => {
    if (lastPlannerInTurn !== undefined) terminal.add(lastPlannerInTurn);
    lastPlannerInTurn = undefined;
  };
  for (let i = 0; i < records.length; i++) {
    const type = records[i]!.type;
    if (type === "USER_INPUT") {
      // The previous turn ended at the PLANNER_RESPONSE we last saw.
      if (seenUserInput) flush();
      seenUserInput = true;
      lastPlannerInTurn = undefined;
      continue;
    }
    if (seenUserInput && type === "PLANNER_RESPONSE") lastPlannerInTurn = i;
  }
  flush();
  return terminal;
};

// ---------------------------------------------------------------------------
// Project workdir extraction from conversation DB
// ---------------------------------------------------------------------------

/**
 * Copy a sqlite DB (with -wal / -shm) to a temp dir, query it, then clean up.
 * Returns undefined on any error (missing db, sqlite3 not available, etc.).
 */
const copyDatabaseForRead = (dbPath: string) => {
  const tempDir = mkdtempSync(join(tmpdir(), "quasar-antigravity-"));
  const tempDbPath = join(tempDir, "session.db");
  copyFileSync(dbPath, tempDbPath);
  for (const suffix of ["-wal", "-shm"]) {
    const src = `${dbPath}${suffix}`;
    if (existsSync(src)) copyFileSync(src, `${tempDbPath}${suffix}`);
  }
  return {
    path: tempDbPath,
    cleanup: () => rmSync(tempDir, { recursive: true, force: true }),
  };
};

/**
 * Byte-scan raw bytes from trajectory_metadata_blob for file:/// and git:
 * patterns (stored as plain UTF-8 substrings inside the protobuf blob).
 * Returns the workdir string when found; undefined otherwise.
 */
const extractWorkdirFromBlob = (raw: Buffer): string | undefined => {
  // Prefer file:/// path — it is the local workdir
  const fileIdx = raw.indexOf("file:///");
  if (fileIdx >= 0) {
    // Read until a non-printable / control byte (protobuf delimiter)
    let end = fileIdx + 8;
    while (end < raw.length && raw[end]! >= 0x20 && raw[end]! < 0x7f) end++;
    const candidate = raw.subarray(fileIdx + 7, end).toString("utf8"); // keep leading /
    if (candidate.length > 1) return candidate;
  }
  // Fall back to https:// repo URL
  const httpsIdx = raw.indexOf("https://");
  if (httpsIdx >= 0) {
    let end = httpsIdx + 8;
    while (end < raw.length && raw[end]! >= 0x20 && raw[end]! < 0x7f) end++;
    const candidate = raw.subarray(httpsIdx, end).toString("utf8");
    if (candidate.length > 8) return candidate;
  }
  return undefined;
};

const readWorkdirFromConversationDb = (uuid: string, conversationsDir: string): string | undefined => {
  const dbPath = join(conversationsDir, `${uuid}.db`);
  if (!existsSync(dbPath)) return undefined;
  let tempDb: { path: string; cleanup: () => void } | undefined;
  try {
    tempDb = copyDatabaseForRead(dbPath);
    const hexOutput = execFileSync(
      "sqlite3",
      [tempDb.path, "SELECT hex(data) FROM trajectory_metadata_blob WHERE id='main' LIMIT 1;"],
      { encoding: "utf8", timeout: 5000 },
    ).trim();
    if (hexOutput.length === 0) return undefined;
    const raw = Buffer.from(hexOutput, "hex");
    return extractWorkdirFromBlob(raw);
  } catch {
    return undefined;
  } finally {
    tempDb?.cleanup();
  }
};

// ---------------------------------------------------------------------------
// Cross-session lineage map
//
// Antigravity subagents are spawned via invoke_subagent and get their OWN brain
// dir + uuid + transcript_full.jsonl (ingested flat). The parent link lives ONLY
// in the PARENT's content: an INVOKE_SUBAGENT record whose content blurb carries
// the child brain uuid(s), preceded by the invoke_subagent tool call whose
// Subagents[] carry the Role/TypeName in matching order. So lineage is built by
// scanning EVERY brain dir's transcript for INVOKE_SUBAGENT records, collecting
// childUuid → { parentUuid, role } across the whole root, then consulting that
// map when ingesting each child.
// ---------------------------------------------------------------------------

/**
 * Scan a single parent transcript for INVOKE_SUBAGENT records and record each
 * child it spawned. The most-recently-seen `invoke_subagent` tool call supplies
 * the ordered Role/TypeName list that pairs (by index) to the child uuids in the
 * following INVOKE_SUBAGENT content blurb. Records are decoded fail-closed; a
 * malformed line is dropped (lineage is best-effort and never throws).
 */
const collectLineageFromTranscript = (
  parentUuid: string,
  transcriptPath: string,
  into: Map<string, AntigravityChildLineage>,
) => {
  let pendingRoles: SubagentRole[] = [];
  for (const { value } of readJsonLines(transcriptPath)) {
    const decision = decodeOrDrop(AntigravityRecordSchema, value, {
      kind: "record" as const,
      diagnosticName: "antigravity.record.decode_failed",
    });
    if (!isSignal(decision)) continue;
    const record = decision.value;

    for (const rawToolCall of record.tool_calls ?? []) {
      const toolDecision = classifyToolCall(rawToolCall);
      if (isSignal(toolDecision) && toolDecision.kind === "invoke_subagent") {
        pendingRoles = rolesFromInvokeToolCall(toolDecision.value.args);
      }
    }

    if (record.type === "INVOKE_SUBAGENT") {
      const childUuids = childUuidsFromInvokeContent(record.content);
      childUuids.forEach((childUuid, index) => {
        if (childUuid === parentUuid) return; // never self-link
        // First writer wins: a child is spawned once; ignore later duplicates.
        if (into.has(childUuid)) return;
        const role = pendingRoles[index];
        into.set(childUuid, { parentUuid, ...(role !== undefined ? { role } : {}) });
      });
      pendingRoles = [];
    }
  }
};

/**
 * Build the child→parent lineage map across the entire brain root. Only dirs
 * with a transcript are scanned (the same filter the ingest scan applies).
 */
const buildLineageMap = (
  brainRoot: string,
  uuids: readonly string[],
  transcriptPathFor: (uuid: string) => string,
): AntigravityLineageMap => {
  const map = new Map<string, AntigravityChildLineage>();
  for (const uuid of uuids) {
    const transcriptPath = transcriptPathFor(uuid);
    if (!existsSync(transcriptPath)) continue;
    try {
      collectLineageFromTranscript(uuid, transcriptPath, map);
    } catch {
      // Lineage is best-effort: a single unreadable transcript never aborts the
      // whole map. The session still ingests; it just lacks a parent link.
    }
  }
  return map;
};

// ---------------------------------------------------------------------------
// Session builder
// ---------------------------------------------------------------------------

const buildAntigravitySession = (
  uuid: string,
  transcriptPath: string,
  brainRoot: string,
  conversationsDir: string,
  options: AdapterOptions,
  lineage: AntigravityLineageMap,
  diagnostics: DecodeDiagnostic[],
) => {
  const sourcePath = join(brainRoot, uuid);
  const nativeSessionId = AntigravitySessionId(uuid);
  const sessionId = sessionIdFor("antigravity", nativeSessionId);
  const lines = readJsonLines(transcriptPath);
  const toolCallsById = new Map<string, AntigravityToolCallDraft>();
  const eventDrafts: AntigravityEventDraft[] = [];

  // Tool-call results are stored in separate step records that follow the
  // PLANNER_RESPONSE that initiated them. We link by step_index when possible.
  const stepIndexToEventId = new Map<number, string>();

  // First pass: decode every line FAIL-CLOSED through the record schema so a
  // malformed line becomes a NAMED diagnostic (antigravity.record.decode_failed)
  // + a dropped record, never a thrown exception that aborts the transcript and
  // never a silently coerced half-record. Decoded records carry a typed `type`
  // discriminator that the turn segmentation + classification below key on.
  const parsed = lines.flatMap(({ value, lineNumber }) => {
    const decision = decodeOrDrop(AntigravityRecordSchema, value, {
      kind: "record" as const,
      diagnosticName: "antigravity.record.decode_failed",
      diagnostics,
    });
    if (!isSignal(decision)) return [];
    return [{ record: decision.value, lineNumber, type: decision.value.type }];
  });
  const terminalIndices = terminalPlannerResponseIndices(parsed);

  let seq = 0;
  for (let recordIndex = 0; recordIndex < parsed.length; recordIndex++) {
    const { record, lineNumber, type } = parsed[recordIndex]!;
    const createdAt = typeof record.created_at === "string" ? record.created_at : undefined;
    const stepIndex = typeof record.step_index === "number" ? record.step_index : undefined;

    const rawToolCalls = record.tool_calls ?? [];
    const hasThinking = typeof record.thinking === "string" && record.thinking.length > 0;

    // Single declarative dispatch: every record type is EXPLICITLY signal or
    // drop (no "unknown" pass-through). A drop (e.g. CONVERSATION_HISTORY replay
    // marker) emits no row; the named reason is structural, not provider garbage,
    // so it does not raise a decode diagnostic (only schema decode failures do).
    const decision = classifyRecord(type, {
      hasToolCalls: rawToolCalls.length > 0,
      hasThinking,
      isTerminalPlannerResponse: terminalIndices.has(recordIndex),
    });
    if (!isSignal(decision)) continue;
    const { role, kind } = decision.value;

    const eventId = eventIdFor(
      sessionId,
      seq,
      stepIndex !== undefined ? String(stepIndex) : lineNumber,
    );

    if (stepIndex !== undefined) stepIndexToEventId.set(stepIndex, eventId);

    // Extract content
    const contentRaw =
      typeof record.content === "string" ? record.content : undefined;
    const thinkingRaw = hasThinking ? (record.thinking as string) : undefined;

    // Content placement is keyed on the structural classification:
    //  - message (user / turn-terminal assistant): the answer text is the
    //    searchable + embeddable content.
    //  - reasoning (mid-loop thinking): the thinking text becomes contentText
    //    so the ingest mapper promotes it to a role:"reasoning" row (off the
    //    embedding surface) — it must NOT carry the bare planner narration.
    //  - tool_call (mid-loop narration) / lifecycle (bare tick): structural
    //    only. No contentText, so no message and no embedding; the tool_calls
    //    array below still carries the call payload.
    const isMessage = kind === "message";
    const isReasoning = role === "thinking" && kind === "reasoning";
    const contentSource: NativeValue | undefined = isMessage ? contentRaw : undefined;
    const contentText = isReasoning
      ? compactText(thinkingRaw)
      : isMessage
        ? compactText(contentRaw)
        : undefined;

    // Reasoning carried as a structural field for downstream rendering even
    // when it rides a turn-terminal assistant message (rare).
    const reasoningRaw = thinkingRaw;

    // Tool calls on PLANNER_RESPONSE records. Each is classified EXPLICITLY via
    // classifyToolCall (a SignalDecision): define_subagent / invoke_subagent /
    // subagent_admin are kept under named kinds; manage_task and manage_subagents
    // Action="list" polling NOISE is DROPPED (named reason) — it floods real
    // transcripts and is never useful tool-call provenance. The drop is silent at
    // the row level (the noise is expected, not provider garbage), so it does not
    // raise a decode diagnostic — only schema-level decode failures do.
    let firstToolCallId: string | undefined;
    for (const rawToolCall of rawToolCalls) {
      const toolDecision = classifyToolCall(rawToolCall);
      if (!isSignal(toolDecision)) continue; // dropped polling noise / unnamed
      const { name: toolName, args } = toolDecision.value;
      const input = projectToolPayloadNativeValue(args);
      const nativeToolId = scopedId(
        sessionId,
        "tool",
        String(stepIndex ?? seq),
        toolName,
      );
      const draft: AntigravityToolCallDraft = {
        id: nativeToolId,
        eventId,
        toolName,
        status: "started",
        ...(input !== undefined ? { input } : {}),
        ...(createdAt !== undefined ? { startedAt: createdAt } : {}),
      };
      toolCallsById.set(nativeToolId, draft);
      firstToolCallId ??= nativeToolId;
    }

    // Tool result events (VIEW_FILE, LIST_DIRECTORY, GREP_SEARCH, FIND,
    // SEARCH_WEB, etc. following a PLANNER_RESPONSE): link result content back to
    // the matching tool call when we can find it by matching the step that
    // initiated the tool call. A record is an execution RESULT (never an
    // initiation) when its type is one of the declared tool-execution or
    // tool-result types — derived from the same schema dispatch, not a local
    // heuristic.
    let linkedToolCallId: string | undefined = firstToolCallId;
    if (
      rawToolCalls.length === 0 &&
      (isToolExecutionType(type) || isToolResultType(type))
    ) {
      // This is an execution result (VIEW_FILE, GREP_SEARCH, …), not an
      // initiation. Find the nearest preceding tool call not yet completed.
      for (const [existingId, existing] of toolCallsById) {
        if (existing.status === "started") {
          const output = projectToolPayloadNativeValue(contentRaw);
          const merged: AntigravityToolCallDraft = {
            ...existing,
            status: "completed",
            ...(output !== undefined ? { output } : {}),
            ...(createdAt !== undefined ? { completedAt: createdAt } : {}),
          };
          toolCallsById.set(existingId, merged);
          linkedToolCallId = existingId;
          break;
        }
      }
    }

    eventDrafts.push({
      id: eventId,
      sequence: seq,
      timestamp: createdAt,
      role,
      kind,
      ...(contentText !== undefined ? { contentText } : {}),
      ...(contentSource !== undefined ? { contentSource } : {}),
      ...(linkedToolCallId !== undefined ? { toolCallId: linkedToolCallId } : {}),
      ...(reasoningRaw !== undefined ? { reasoning: reasoningRaw } : {}),
      rawReference: { sourcePath: transcriptPath, line: lineNumber, nativeType: type },
    });

    seq += 1;
  }

  // Lazy workdir fetch: only done once per session, only if DB exists.
  const projectPath = readWorkdirFromConversationDb(uuid, conversationsDir);

  // Cross-session subagent lineage. If THIS session is a known child (it appears
  // in some parent's INVOKE_SUBAGENT content), emit the canonical `subagent_of`
  // edge: fromId = the PARENT's machine-independent Quasar SessionId, toId =
  // this child's SessionId, with the native parent uuid preserved in
  // rawReference. mapSession projects `subagent_of` (and ONLY subagent_of) onto
  // SessionRow.parentSessionId — never `parent`, which is event threading. The
  // child's agentName reflects the subagent Role/TypeName from the invoke call,
  // so subagent sessions are labelled by what they are, not the generic CLI name.
  const childLineage = lineage.get(uuid.toLowerCase());
  const sessionEdges: AntigravityEdgeDraft[] = [];
  let agentName = "antigravity-cli";
  if (childLineage !== undefined) {
    const parentNativeSessionId = AntigravitySessionId(childLineage.parentUuid);
    const parentSessionId = sessionIdFor("antigravity", parentNativeSessionId);
    sessionEdges.push({
      id: edgeIdFor(sessionId, "subagent_of", parentSessionId, sessionId),
      kind: "subagent_of",
      fromId: parentSessionId,
      toId: sessionId,
      rawReference: {
        sourcePath: join(brainRoot, childLineage.parentUuid),
        nativeType: "INVOKE_SUBAGENT",
        rowId: childLineage.parentUuid,
      },
    });
    agentName = agentNameFromRole(childLineage.role) ?? agentName;
  }

  return buildSession({
    provider: "antigravity",
    agentName,
    machine: options.machine,
    sessionId,
    nativeSessionId,
    sourceRoot: brainRoot,
    sourcePath,
    ...(projectPath !== undefined ? { projectPath } : {}),
    events: eventDrafts,
    toolCalls: [...toolCallsById.values()],
    sessionEdges,
  });
};

const countMessages = (session: NormalizedSession) => ({
  userMessages: session.events.filter((event) => event.role === "user" && event.kind === "message").length,
  assistantMessages: session.events.filter((event) => event.role === "assistant" && event.kind === "message").length,
});

// ---------------------------------------------------------------------------
// Stream
// ---------------------------------------------------------------------------

async function* streamAntigravity(options: AdapterOptions): AsyncGenerator<AdapterStreamItem> {
  const root = options.roots?.antigravity ?? antigravityAdapter.defaultRoot();
  if (root === undefined || !existsSync(root)) {
    yield {
      type: "diagnostic",
      diagnostic: {
        adapterId: antigravityAdapter.id,
        provider: "antigravity",
        status: "no_data_found",
        parserConfidence: "observed",
        message: "Antigravity CLI root was not found.",
        ...(root !== undefined ? { rootPath: root } : {}),
      },
    };
    return;
  }

  const brainRoot = join(root, "brain");
  const conversationsDir = join(root, "conversations");

  if (!existsSync(brainRoot)) {
    yield {
      type: "diagnostic",
      diagnostic: {
        adapterId: antigravityAdapter.id,
        provider: "antigravity",
        status: "no_data_found",
        parserConfidence: "observed",
        message: "Antigravity brain directory not found.",
        rootPath: root,
      },
    };
    return;
  }

  yield {
    type: "sourceRoot",
    sourceRoot: sourceRoot("antigravity", antigravityAdapter.id, brainRoot, options.machine, options.now),
  };

  let entries: string[];
  try {
    entries = readdirSync(brainRoot).sort();
  } catch {
    entries = [];
  }

  const transcriptPathFor = (uuid: string) =>
    join(brainRoot, uuid, ".system_generated", "logs", "transcript_full.jsonl");

  // Build the cross-session child→parent lineage map BEFORE the (windowed)
  // ingest loop: a child can be ingested while its parent falls outside the
  // skip/limit window or fails the shouldParseSession gate, so the map must be
  // computed over the WHOLE brain root, not just the sessions being emitted.
  const lineage = buildLineageMap(brainRoot, entries, transcriptPathFor);

  let sessionCount = 0;
  let skipped = 0;

  for (const uuid of entries) {
    // Real-session filter: only include sessions with a brain transcript.
    const transcriptPath = transcriptPathFor(uuid);
    if (!existsSync(transcriptPath)) continue;

    // Skip / limit support
    if (skipped < (options.skip ?? 0)) { skipped++; continue; }
    if (sessionCount >= (options.limit ?? Number.POSITIVE_INFINITY)) break;

    // Pre-parse gate: stat the transcript file as the per-session change signal.
    if (options.shouldParseSession !== undefined) {
      const stat = statSync(transcriptPath);
      const probe = {
        sessionId: sessionIdFor("antigravity", AntigravitySessionId(uuid)),
        sourceFingerprint: sourceFingerprintFor(stat),
      };
      if ((await options.shouldParseSession(probe)) === false) continue;
    }

    // Named decode diagnostics for malformed transcript lines in THIS session.
    // Drops are accumulated here and surfaced as attributable diagnostics so a
    // garbage line never aborts the transcript and never coerces silently.
    const decodeDiagnostics: DecodeDiagnostic[] = [];
    const session = buildAntigravitySession(
      uuid,
      transcriptPath,
      brainRoot,
      conversationsDir,
      options,
      lineage,
      decodeDiagnostics,
    );
    for (const diagnostic of decodeDiagnostics) {
      yield {
        type: "diagnostic",
        diagnostic: {
          adapterId: antigravityAdapter.id,
          provider: "antigravity",
          status: "unsupported",
          parserConfidence: "observed",
          rootPath: brainRoot,
          message: `Antigravity transcript line dropped (${diagnostic.name}).`,
          details: { nativeSessionId: uuid, error: diagnostic.message },
        },
      };
    }
    const messageCounts = countMessages(session);
    if (messageCounts.userMessages === 0) {
      yield {
        type: "diagnostic",
        diagnostic: {
          adapterId: antigravityAdapter.id,
          provider: "antigravity",
          status: "unsupported",
          parserConfidence: "observed",
          rootPath: brainRoot,
          message: "Skipped Antigravity transcript with no user message events.",
          details: {
            nativeSessionId: uuid,
            transcriptPath,
            ...messageCounts,
          },
        },
      };
      continue;
    }

    sessionCount += 1;
    yield {
      type: "session",
      session,
      sourceUnit: {
        provider: "antigravity",
        adapterId: antigravityAdapter.id,
        rootPath: brainRoot,
        sourcePath: session.sourcePath,
        physicalPath: transcriptPath,
      },
    };
  }

  yield {
    type: "diagnostic",
    diagnostic: {
      adapterId: antigravityAdapter.id,
      provider: "antigravity",
      status: sessionCount > 0 ? "available" : "no_data_found",
      parserConfidence: "observed",
      rootPath: brainRoot,
      message: `Discovered ${sessionCount} Antigravity CLI session(s).`,
    },
  };
}

// ---------------------------------------------------------------------------
// Adapter export
// ---------------------------------------------------------------------------

export const antigravityAdapter: SessionAdapter = {
  id: "antigravity-cli-brain-jsonl",
  provider: "antigravity",
  displayName: "Antigravity CLI brain JSONL",
  stable: true,
  defaultRoot: () => homePath(".gemini/antigravity-cli"),
  read: async (options) => collectAdapterStream(streamAntigravity(options)),
  stream: streamAntigravity,
};
