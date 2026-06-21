import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { collectAdapterStream, type AdapterStreamItem, type SessionAdapter } from "./types";
import type { NormalizedSession, ToolCall } from "../core/schemas";
import {
  buildSession,
  compactText,
  eventIdFor,
  homePath,
  projectToolPayloadNativeValue,
  recordFrom,
  readJsonLines,
  scopedId,
  sessionIdFor,
  sourceFingerprintFor,
  sourceRoot,
  type NativeValue,
} from "./common";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type AntigravityToolCallDraft = Omit<
  ToolCall,
  "sessionId" | "machineId" | "provider" | "agentName" | "projectIdentityKey"
>;

type AntigravityEventDraft = {
  readonly id: string;
  readonly nativeEventId?: string;
  readonly sequence: number;
  readonly timestamp?: string;
  readonly role: "user" | "assistant" | "system" | "thinking" | "unknown";
  readonly kind:
    | "message"
    | "tool_call"
    | "tool_result"
    | "reasoning"
    | "system"
    | "lifecycle"
    | "unknown";
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
// ---------------------------------------------------------------------------

// Non-PLANNER_RESPONSE tool execution records. Their content is a tool result
// (a directory listing, a file body, a command transcript) — structural, never
// an assistant message and never embedded.
const TOOL_EXECUTION_TYPES = new Set([
  "VIEW_FILE",
  "LIST_DIRECTORY",
  "GENERIC",
  "CODE_ACTION",
  "RUN_COMMAND",
]);

/**
 * Classification of a single transcript record AFTER turn segmentation. The
 * driving rule is structural, not content-length based (AGENTS.md: no invented
 * budgets):
 *
 *   USER_INPUT
 *     → role user / kind message (searchable). One per user turn.
 *
 *   PLANNER_RESPONSE that is the LAST one before the next USER_INPUT (or the
 *   end of the session) — the turn-TERMINAL response
 *     → role assistant / kind message (searchable). One per user turn. This is
 *       the model's real answer. Its tool_calls (if any) still emit as session
 *       toolCalls, but the record itself is the answer, so it stays a message.
 *
 *   PLANNER_RESPONSE (mid-loop) carrying tool_calls
 *     → kind tool_call / role assistant. The narration ("I will read X") is the
 *       call's context, NOT a standalone message; structural, not searchable.
 *
 *   PLANNER_RESPONSE (mid-loop) carrying thinking but no tool_calls
 *     → role thinking / kind reasoning. Off the embedding surface, like every
 *       other adapter's reasoning.
 *
 *   PLANNER_RESPONSE (mid-loop) bare — no tool_calls, no thinking
 *     → role unknown / kind lifecycle. A mid-loop tick: NOT a message, NOT
 *       embedded.
 *
 *   VIEW_FILE / LIST_DIRECTORY / GENERIC / CODE_ACTION / RUN_COMMAND
 *     → kind tool_call / role assistant (tool execution result; structural).
 *
 *   CHECKPOINT / SYSTEM_MESSAGE
 *     → role system / kind system.
 *
 *   CONVERSATION_HISTORY
 *     → SKIP (content is null — a replay marker, never content of its own).
 */
type AntigravityClassification = {
  readonly role: AntigravityEventDraft["role"];
  readonly kind: AntigravityEventDraft["kind"];
};

const classifyRecord = (input: {
  readonly type: string;
  readonly hasToolCalls: boolean;
  readonly hasThinking: boolean;
  readonly isTerminalPlannerResponse: boolean;
}): AntigravityClassification | "SKIP" => {
  const { type, hasToolCalls, hasThinking, isTerminalPlannerResponse } = input;

  if (type === "CONVERSATION_HISTORY") return "SKIP";
  if (type === "USER_INPUT") return { role: "user", kind: "message" };

  if (type === "PLANNER_RESPONSE") {
    // The turn-terminal response is the assistant's real answer — searchable,
    // exactly one per user turn. Terminal classification wins even if the
    // record also carries tool_calls (an aborted/incomplete final turn): the
    // tool_calls are still emitted, but the record is the answer.
    if (isTerminalPlannerResponse) return { role: "assistant", kind: "message" };
    // Mid-loop responses: tool narration, reasoning, or a bare tick. None are
    // messages; none reach the embedding surface.
    if (hasToolCalls) return { role: "assistant", kind: "tool_call" };
    if (hasThinking) return { role: "thinking", kind: "reasoning" };
    return { role: "unknown", kind: "lifecycle" };
  }

  if (TOOL_EXECUTION_TYPES.has(type)) return { role: "assistant", kind: "tool_call" };
  if (type === "CHECKPOINT" || type === "SYSTEM_MESSAGE") return { role: "system", kind: "system" };
  return { role: "unknown", kind: "unknown" };
};

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
// Session builder
// ---------------------------------------------------------------------------

const buildAntigravitySession = (
  uuid: string,
  transcriptPath: string,
  brainRoot: string,
  conversationsDir: string,
  options: AdapterOptions,
) => {
  const sourcePath = join(brainRoot, uuid);
  const lines = readJsonLines(transcriptPath);
  const toolCallsById = new Map<string, AntigravityToolCallDraft>();
  const eventDrafts: AntigravityEventDraft[] = [];

  // Tool-call results are stored in separate step records that follow the
  // PLANNER_RESPONSE that initiated them. We link by step_index when possible.
  const stepIndexToEventId = new Map<number, string>();

  // First pass: normalize every line into a record so turn segmentation can
  // identify the terminal PLANNER_RESPONSE of each turn before classification.
  const parsed = lines.map(({ value, lineNumber }) => {
    const record =
      typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
    return {
      record,
      lineNumber,
      type: typeof record.type === "string" ? record.type : "unknown",
    };
  });
  const terminalIndices = terminalPlannerResponseIndices(parsed);

  let seq = 0;
  for (let recordIndex = 0; recordIndex < parsed.length; recordIndex++) {
    const { record, lineNumber, type } = parsed[recordIndex]!;
    const createdAt = typeof record.created_at === "string" ? record.created_at : undefined;
    const stepIndex = typeof record.step_index === "number" ? record.step_index : undefined;

    // CONVERSATION_HISTORY records have null content — skip entirely.
    const rawToolCalls = Array.isArray(record.tool_calls) ? record.tool_calls : [];
    const hasThinking = typeof record.thinking === "string" && record.thinking.length > 0;
    const classification = classifyRecord({
      type,
      hasToolCalls: rawToolCalls.length > 0,
      hasThinking,
      isTerminalPlannerResponse: terminalIndices.has(recordIndex),
    });
    if (classification === "SKIP") continue;
    const { role, kind } = classification;

    const eventId = eventIdFor(
      "antigravity",
      options.machine.machineId,
      transcriptPath,
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

    // Tool calls on PLANNER_RESPONSE records
    let firstToolCallId: string | undefined;
    for (const tcValue of rawToolCalls) {
      const tc = recordFrom(tcValue);
      const toolName = typeof tc.name === "string" ? tc.name : undefined;
      if (toolName === undefined) continue;
      const input = projectToolPayloadNativeValue(tc.args);
      const nativeToolId = scopedId(
        "antigravity",
        options.machine.machineId,
        transcriptPath,
        "tool",
        uuid,
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

    // Tool result events (VIEW_FILE, LIST_DIRECTORY, etc. following a PLANNER_RESPONSE):
    // Link result content back to the matching tool call when we can find it
    // by matching the step that initiated the tool call.
    let linkedToolCallId: string | undefined = firstToolCallId;
    if (kind === "tool_call" && rawToolCalls.length === 0 && type !== "PLANNER_RESPONSE") {
      // This is an execution result (VIEW_FILE etc.), not an initiation.
      // Try to find the nearest preceding tool-call record that hasn't yet been completed.
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

  return buildSession({
    provider: "antigravity",
    agentName: "antigravity-cli",
    machine: options.machine,
    nativeSessionId: uuid,
    sourceRoot: brainRoot,
    sourcePath,
    ...(projectPath !== undefined ? { projectPath } : {}),
    events: eventDrafts,
    toolCalls: [...toolCallsById.values()],
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

  let sessionCount = 0;
  let skipped = 0;

  for (const uuid of entries) {
    // Real-session filter: only include sessions with a brain transcript.
    const transcriptPath = join(brainRoot, uuid, ".system_generated", "logs", "transcript_full.jsonl");
    if (!existsSync(transcriptPath)) continue;

    // Skip / limit support
    if (skipped < (options.skip ?? 0)) { skipped++; continue; }
    if (sessionCount >= (options.limit ?? Number.POSITIVE_INFINITY)) break;

    // Pre-parse gate: stat the transcript file as the per-session change signal.
    if (options.shouldParseSession !== undefined) {
      const stat = statSync(transcriptPath);
      const probe = {
        sessionId: sessionIdFor("antigravity", options.machine.machineId, uuid, join(brainRoot, uuid)),
        sourceFingerprint: sourceFingerprintFor(stat),
      };
      if ((await options.shouldParseSession(probe)) === false) continue;
    }

    const session = buildAntigravitySession(
      uuid,
      transcriptPath,
      brainRoot,
      conversationsDir,
      options,
    );
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
