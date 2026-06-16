import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { collectAdapterStream, type AdapterStreamItem, type SessionAdapter } from "./types";
import type { ToolCall } from "../schemas";
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

/**
 * source → role
 * USER_EXPLICIT → user
 * MODEL         → assistant
 * SYSTEM        → system
 * (anything else) → unknown
 */
const roleFromSource = (source: string | undefined): AntigravityEventDraft["role"] => {
  if (source === "USER_EXPLICIT") return "user";
  if (source === "MODEL") return "assistant";
  if (source === "SYSTEM") return "system";
  return "unknown";
};

/**
 * type → kind
 * USER_INPUT           → message
 * PLANNER_RESPONSE     → message (tool_call when tool_calls non-empty)
 * VIEW_FILE / LIST_DIRECTORY / GENERIC / CODE_ACTION / RUN_COMMAND → tool_call
 * CHECKPOINT / SYSTEM_MESSAGE → system
 * CONVERSATION_HISTORY → SKIP (content null)
 */
const kindFromAntigravityType = (
  type: string,
  hasToolCalls: boolean,
): AntigravityEventDraft["kind"] | "SKIP" => {
  if (type === "CONVERSATION_HISTORY") return "SKIP";
  if (type === "USER_INPUT") return "message";
  if (type === "PLANNER_RESPONSE") return hasToolCalls ? "tool_call" : "message";
  if (
    type === "VIEW_FILE" ||
    type === "LIST_DIRECTORY" ||
    type === "GENERIC" ||
    type === "CODE_ACTION" ||
    type === "RUN_COMMAND"
  )
    return "tool_call";
  if (type === "CHECKPOINT" || type === "SYSTEM_MESSAGE") return "system";
  return "unknown";
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

  let seq = 0;
  for (const { value, lineNumber } of lines) {
    const record = typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
    const type = typeof record.type === "string" ? record.type : "unknown";
    const source = typeof record.source === "string" ? record.source : undefined;
    const createdAt = typeof record.created_at === "string" ? record.created_at : undefined;
    const stepIndex = typeof record.step_index === "number" ? record.step_index : undefined;

    // CONVERSATION_HISTORY records have null content — skip entirely.
    const rawToolCalls = Array.isArray(record.tool_calls) ? record.tool_calls : [];
    const kind = kindFromAntigravityType(type, rawToolCalls.length > 0);
    if (kind === "SKIP") continue;

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
    const contentSource: NativeValue | undefined = contentRaw;
    const contentText = compactText(contentRaw);

    // Reasoning (thinking field — rare, appears on some PLANNER_RESPONSE records)
    const reasoningRaw =
      typeof record.thinking === "string" ? record.thinking : undefined;

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

    const role = roleFromSource(source);

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
      if (options.shouldParseSession(probe) === false) continue;
    }

    const session = buildAntigravitySession(
      uuid,
      transcriptPath,
      brainRoot,
      conversationsDir,
      options,
    );

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
