import { createReadStream, existsSync, readdirSync, statSync, type Stats } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";

import {
  collectAdapterStream,
  type SessionAdapter,
} from "./types";
import { CodexSessionId, type SessionId } from "../core/identity";
import type { NormalizedSession, SessionEventKind, SessionRole, ToolCall, UsageRecord } from "../core/schemas";
import {
  CODEX_SESSION_META_DECODE_FAILED,
  CodexSessionMetaSchema,
  type CodexSessionMeta,
} from "./codex-schema";
import { type DecodeDiagnostic, decodeOrDrop, isSignal } from "./harness-schema";
import {
  buildSession,
  collectFiles,
  compactText,
  edgeIdFor,
  eventIdFor,
  homePath,
  kindFromNative,
  logicalPathFor,
  logicalRootFor,
  numberValue,
  projectSessionNativeValue,
  projectToolPayloadNativeValue,
  recordFrom,
  roleFrom,
  scopedId,
  sessionIdFor,
  sourceFingerprintFor,
  sourceRoot,
  usageIdFor,
} from "./common";

type CodexRecord = Record<string, unknown>;
type AdapterOptions = Parameters<SessionAdapter["read"]>[0];
type CodexToolCallDraft = Omit<
  ToolCall,
  "sessionId" | "machineId" | "provider" | "agentName" | "projectIdentityKey"
>;
type CodexUsageDraft = Omit<
  UsageRecord,
  "sessionId" | "machineId" | "provider" | "agentName" | "projectIdentityKey"
>;
type CodexEventDraft = Parameters<typeof buildSession>[0]["events"][number];
type CodexEdgeDraft = NonNullable<Parameters<typeof buildSession>[0]["sessionEdges"]>[number];

const payloadRecordFrom = (value: unknown): CodexRecord =>
  value !== null && typeof value === "object" ? (value as CodexRecord) : {};

const payloadTypeFrom = (payload: CodexRecord) =>
  typeof payload.type === "string" ? payload.type : undefined;

const codexNativeType = (recordType: string, payloadType: string | undefined) =>
  payloadType === undefined ? recordType : `${recordType}.${payloadType}`;

/**
 * Codex injects machine-authored context into the transcript as ordinary
 * `user`/`assistant` message records. No human authored these; they are
 * wrappers around session machinery, recognized by the opening tag of the
 * first content block and mapped to `kind: "preamble"` so the ingest layer's
 * injected-kind filter excludes them from the search surface.
 */
const INJECTED_WRAPPER_PREFIXES = [
  "<environment_context",
  "<user_instructions",
  "<turn_aborted",
  "<ide_context",
  "<skill>",
  "<subagent_notification",
  "<goal_context",
  "<codex_internal_context",
  "<proposed_plan",
  "<collaboration_mode",
  "<personality_spec",
  "<model_switch",
  "<app-context",
  "# AGENTS.md instructions",
] as const;

/**
 * Codex instruction bundles share one tag grammar — `<skills_instructions>`,
 * `<apps_instructions>`, `<plugins_instructions>`, `<permissions instructions>`,
 * `<user_instructions>`, … — all harness-injected, none human-authored.
 * Measured 2026-06-11 (full corpus): wrapper blocks only ever lead a message;
 * no genuine user text follows one, so the first-block test is exact.
 */
const INJECTED_INSTRUCTIONS_TAG = /^<[a-z][a-z0-9_-]*[_ ]instructions>/;

const firstContentText = (payload: CodexRecord): string | undefined => {
  const content = payload.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return undefined;
  for (const block of content) {
    const text = recordFrom(block).text;
    if (typeof text === "string") return text;
  }
  return undefined;
};

const codexImageOrFileItem = (item: CodexRecord): boolean => {
  const type = typeof item.type === "string" ? item.type.toLowerCase() : "";
  return (
    type.includes("image") ||
    type.includes("file") ||
    item.image_url !== undefined ||
    item.imageUrl !== undefined ||
    item.image !== undefined ||
    item.file !== undefined
  );
};

/**
 * A codex message payload is a session turn only when its content carries
 * non-blank text (string content, a non-blank string item, or an item with a
 * non-blank `text`) or attaches an image/file. The measured corpus holds
 * assistant messages whose entire content is `[{"type":"output_text","text":""}]`
 * — empty stubs, provider machinery: such an event carries no turn content,
 * so a JSON dump of its envelope can never reach the search surface.
 */
const codexMessageHasTurnContent = (payload: CodexRecord): boolean => {
  const content = payload.content;
  if (typeof content === "string") return content.trim().length > 0;
  if (!Array.isArray(content)) {
    // event_msg user_message/agent_message payloads carry text directly.
    const direct = payload.message ?? payload.text;
    return typeof direct === "string" && direct.trim().length > 0;
  }
  return content.some((item) => {
    if (typeof item === "string") return item.trim().length > 0;
    if (item === null || typeof item !== "object") return false;
    const record = item as CodexRecord;
    if (typeof record.text === "string" && record.text.trim().length > 0) return true;
    return codexImageOrFileItem(record);
  });
};

const isInjectedWrapperMessage = (payload: CodexRecord): boolean => {
  const text = firstContentText(payload)?.trimStart();
  return (
    text !== undefined &&
    (INJECTED_WRAPPER_PREFIXES.some((prefix) => text.startsWith(prefix)) ||
      INJECTED_INSTRUCTIONS_TAG.test(text))
  );
};

const codexKindFrom = (
  recordType: string,
  payloadType: string | undefined,
  payload: CodexRecord,
): SessionEventKind => {
  switch (payloadType) {
    case "message":
      return isInjectedWrapperMessage(payload) ? "preamble" : "message";
    case "user_message":
      return "message";
    case "agent_message":
      return payload.phase === "commentary" ? "preamble" : "message";
    case "function_call":
    case "local_shell_call":
    case "custom_tool_call":
      return "tool_call";
    case "function_call_output":
    case "local_shell_call_output":
    case "custom_tool_call_output":
      return "tool_result";
    case "reasoning":
      return "reasoning";
    case "token_count":
      return "usage";
    case "task_started":
    case "task_complete":
    case "turn_aborted":
      return "lifecycle";
    case "compacted":
      return "summary";
    default:
      return kindFromNative(payloadType ?? recordType);
  }
};

const codexRoleFrom = (
  recordType: string,
  payloadType: string | undefined,
  payload: CodexRecord,
): SessionRole => {
  const explicitRole = roleFrom(
    typeof payload.role === "string" ? payload.role : undefined,
  );
  if (explicitRole !== "unknown") return explicitRole;
  switch (payloadType) {
    case "function_call":
    case "local_shell_call":
    case "custom_tool_call":
    case "agent_message":
      return "assistant";
    case "function_call_output":
    case "local_shell_call_output":
    case "custom_tool_call_output":
      return "tool";
    case "reasoning":
      return "thinking";
    case "user_message":
      return "user";
    case "token_count":
    case "task_started":
    case "task_complete":
    case "turn_aborted":
      return "system";
    default:
      return roleFrom(recordType);
  }
};

const callIdFromPayload = (payload: CodexRecord) =>
  typeof payload.call_id === "string" && payload.call_id.length > 0
    ? payload.call_id
    : undefined;

const toolCallIdFor = (sessionId: SessionId, callId: string) =>
  scopedId(sessionId, "tool", callId);

const parseToolInput = (value: unknown): unknown => {
  if (typeof value !== "string") return projectToolPayloadNativeValue(value);
  try {
    return projectToolPayloadNativeValue(JSON.parse(value) as unknown);
  } catch {
    return projectToolPayloadNativeValue(value);
  }
};

const upsertCodexToolCall = (
  toolCallsById: Map<string, CodexToolCallDraft>,
  sessionId: SessionId,
  eventId: string,
  timestamp: string | undefined,
  payload: CodexRecord,
) => {
  const payloadType = payloadTypeFrom(payload);
  const callId = callIdFromPayload(payload);
  if (callId === undefined) return undefined;
  const id = toolCallIdFor(sessionId, callId);
  // custom_tool_call (apply_patch and friends) shares the function_call shape
  // but carries its payload in `input` (raw text) instead of `arguments` (JSON).
  // local_shell_call carries its payload in `action` (exec command record) and
  // has no `name`.
  if (
    payloadType === "function_call" ||
    payloadType === "local_shell_call" ||
    payloadType === "custom_tool_call"
  ) {
    const toolName =
      typeof payload.name === "string" && payload.name.length > 0
        ? payload.name
        : payloadType === "local_shell_call"
          ? "local_shell"
          : "codex_tool";
    const existing = toolCallsById.get(id);
    const input =
      payloadType === "custom_tool_call"
        ? projectToolPayloadNativeValue(payload.input)
        : payloadType === "local_shell_call"
          ? projectToolPayloadNativeValue(payload.action)
          : parseToolInput(payload.arguments);
    toolCallsById.set(id, {
      ...existing,
      id,
      eventId: existing?.eventId ?? eventId,
      toolName,
      status: existing?.status === "completed" ? "completed" : "started",
      ...(input !== undefined ? { input } : {}),
      ...(existing?.output !== undefined ? { output: existing.output } : {}),
      ...(timestamp !== undefined ? { startedAt: timestamp } : {}),
      ...(existing?.completedAt !== undefined ? { completedAt: existing.completedAt } : {}),
    });
    return id;
  }
  if (
    payloadType === "function_call_output" ||
    payloadType === "local_shell_call_output" ||
    payloadType === "custom_tool_call_output"
  ) {
    const existing = toolCallsById.get(id);
    const output = projectToolPayloadNativeValue(payload.output);
    toolCallsById.set(id, {
      id,
      eventId: existing?.eventId ?? eventId,
      toolName: existing?.toolName ?? "codex_tool",
      status: "completed",
      ...(existing?.input !== undefined ? { input: existing.input } : {}),
      ...(output !== undefined ? { output } : {}),
      ...(existing?.startedAt !== undefined ? { startedAt: existing.startedAt } : {}),
      ...(timestamp !== undefined ? { completedAt: timestamp } : {}),
    });
    return id;
  }
  return undefined;
};

const codexUsageRecord = (
  sessionId: SessionId,
  eventId: string,
  sequence: number,
  timestamp: string | undefined,
  payload: CodexRecord,
): CodexUsageDraft | undefined => {
  if (payloadTypeFrom(payload) !== "token_count") return undefined;
  const info = recordFrom(payload.info);
  const nestedTotalUsage = recordFrom(info.total_token_usage);
  const usage =
    Object.keys(nestedTotalUsage).length > 0
      ? nestedTotalUsage
      : Object.keys(info).length > 0
        ? info
        : payload;
  const inputTokens =
    numberValue(usage.input_tokens) ??
    numberValue(usage.inputTokens) ??
    numberValue(usage.prompt_tokens) ??
    numberValue(usage.promptTokens);
  const outputTokens =
    numberValue(usage.output_tokens) ??
    numberValue(usage.outputTokens) ??
    numberValue(usage.completion_tokens) ??
    numberValue(usage.completionTokens);
  const reasoningTokens =
    numberValue(usage.reasoning_tokens) ?? numberValue(usage.reasoningTokens);
  const cacheCreationInputTokens =
    numberValue(usage.cache_creation_input_tokens) ??
    numberValue(usage.cacheCreationInputTokens);
  const cacheReadInputTokens =
    numberValue(usage.cache_read_input_tokens) ?? numberValue(usage.cacheReadInputTokens);
  const totalTokens =
    numberValue(usage.total_tokens) ??
    numberValue(usage.totalTokens) ??
    sumNumbers([
      inputTokens,
      outputTokens,
      reasoningTokens,
      cacheCreationInputTokens,
      cacheReadInputTokens,
    ]);
  return {
    id: usageIdFor(sessionId, eventId, sequence),
    eventId,
    ...(timestamp !== undefined ? { timestamp } : {}),
    model:
      typeof usage.model === "string"
        ? usage.model
        : typeof payload.model === "string"
          ? payload.model
          : undefined,
    modelProvider: "openai",
    inputTokens,
    outputTokens,
    reasoningTokens,
    cacheCreationInputTokens,
    cacheReadInputTokens,
    totalTokens,
  };
};

const sumNumbers = (values: readonly (number | undefined)[]) => {
  const present = values.filter((value): value is number => value !== undefined);
  return present.length === 0
    ? undefined
    : present.reduce((sum, value) => sum + value, 0);
};

type CodexSessionSlice = {
  readonly events: CodexEventDraft[];
  readonly toolCallIds: Set<string>;
  readonly usageRecords: CodexUsageDraft[];
  readonly sessionEdges: CodexEdgeDraft[];
};

const emptyCodexSlice = (): CodexSessionSlice => ({
  events: [],
  toolCallIds: new Set<string>(),
  usageRecords: [],
  sessionEdges: [],
});

class CodexJsonLineParseError extends Error {
  readonly lineNumber: number;

  constructor(path: string, lineNumber: number, cause: unknown) {
    super(
      `Failed to parse Codex JSONL record at ${path}:${lineNumber}: ${
        cause instanceof Error ? cause.message : String(cause)
      }`,
    );
    this.name = "CodexJsonLineParseError";
    this.lineNumber = lineNumber;
  }
}

async function* readCodexJsonLines(
  path: string,
  options: { readonly strict?: boolean } = {},
) {
  const lines = createInterface({
    input: createReadStream(path, { encoding: "utf8" }),
    crlfDelay: Infinity,
  });
  let lineNumber = 0;
  let recordIndex = 0;
  for await (const line of lines) {
    lineNumber += 1;
    if (line.trim().length === 0) continue;
    try {
      yield { value: JSON.parse(line) as unknown, lineNumber, recordIndex };
      recordIndex += 1;
    } catch (cause) {
      if (options.strict === true) {
        throw new CodexJsonLineParseError(path, lineNumber, cause);
      }
      // Preserve best-effort behavior from readJsonLines.
    }
  }
}

const projectPathFromSessionMeta = (value: unknown) => {
  const record = recordFrom(value);
  if (record.type !== "session_meta") return undefined;
  const payload = recordFrom(record.payload);
  return typeof payload.cwd === "string"
    ? payload.cwd
    : typeof payload.working_dir === "string"
      ? payload.working_dir
      : undefined;
};

/**
 * The codex native session id is the bare UUIDv7 the harness assigns at
 * `session_meta.payload.id` (the first JSON record of every rollout file) — content-sourced,
 * not derived from the filename stem. The stem embeds a timestamp (provenance)
 * and is path-derived, so two re-keyings of the same conversation under
 * different filenames would otherwise diverge. Reading the canonical uuid
 * re-keys codex sessions to their clean id.
 */
const sessionIdFromSessionMeta = (value: unknown): string | undefined => {
  const record = recordFrom(value);
  if (record.type !== "session_meta") return undefined;
  const payload = recordFrom(record.payload);
  return typeof payload.id === "string" && payload.id.length > 0
    ? payload.id
    : undefined;
};

/**
 * A rollout file missing `session_meta.payload.id` is a contract breach at the
 * ingest boundary, not a fallback case: emitting a path-derived id would
 * silently re-introduce the provenance-bearing filename stem this change
 * removes. The named diagnostic identifies the offending file; the adapter
 * writes zero rows for it and continues.
 */
export const CODEX_MISSING_SESSION_META_ID =
  "codex.session_meta.payload.id.missing";

/**
 * Codex subagents are separate rollout-*.jsonl files, each with its own UUIDv7.
 * A subagent rollout records its spawning parent at
 * `session_meta.payload.source.subagent.thread_spawn.parent_thread_id` (the
 * parent's native id) and its agent identity at `agent_nickname` (preferred) /
 * `agent_role` (fallback). A main-session rollout carries no `source.subagent`,
 * so this returns `undefined` and the session maps with no parent.
 */
type CodexSubagentLineage = {
  /** The parent rollout's native id (its session_meta.payload.id). */
  readonly parentNativeId: string;
  /** Human label for the spawned agent, or undefined when none was recorded. */
  readonly agentName: string | undefined;
};

const trimmedNonEmpty = (value: string | null | undefined): string | undefined => {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length === 0 ? undefined : trimmed;
};

const codexSubagentLineage = (meta: CodexSessionMeta): CodexSubagentLineage | undefined => {
  const subagent = meta.payload.source?.subagent ?? undefined;
  if (subagent === undefined || subagent === null) return undefined;
  const parentNativeId = trimmedNonEmpty(subagent.thread_spawn?.parent_thread_id ?? undefined);
  if (parentNativeId === undefined) return undefined;
  return {
    parentNativeId,
    agentName: trimmedNonEmpty(subagent.agent_nickname) ?? trimmedNonEmpty(subagent.agent_role),
  };
};


const parseFileWalkInput = (root: string, limit: number | undefined, skip: number | undefined) => {
  const trimmedRoot = root.trim();
  if (trimmedRoot.length === 0 || (limit !== undefined && limit <= 0)) return undefined;
  return {
    root: trimmedRoot,
    limit: limit === undefined || !Number.isFinite(limit) ? Number.POSITIVE_INFINITY : Math.floor(limit),
    skip: skip === undefined || !Number.isFinite(skip) || skip <= 0 ? 0 : Math.floor(skip),
  };
};

function* walkFilesWithStats(
  root: string,
  predicate: (path: string) => boolean,
  limit?: number,
  skip?: number,
): Generator<{ readonly path: string; readonly stats: Stats }> {
  const input = parseFileWalkInput(root, limit, skip);
  if (input === undefined || !existsSync(input.root)) return;
  const walkInput = input;
  let matched = 0;
  let emitted = 0;

  function* visit(path: string): Generator<{ readonly path: string; readonly stats: Stats }> {
    if (emitted >= walkInput.limit) return;
    let stats: Stats;
    try {
      stats = statSync(path);
    } catch {
      return;
    }
    if (stats.isDirectory()) {
      for (const entry of readdirSync(path).sort()) {
        yield* visit(join(path, entry));
        if (emitted >= walkInput.limit) return;
      }
      return;
    }
    if (!predicate(path)) return;
    if (matched >= walkInput.skip) {
      emitted += 1;
      yield { path, stats };
    }
    matched += 1;
  }

  yield* visit(walkInput.root);
}

/** Read only the codex native id (session_meta.payload.id) from the first JSON record. */
const readCodexNativeId = async (
  path: string,
  parseOptions: { readonly strictJsonLines?: boolean },
): Promise<string | undefined> => {
  for await (const { value } of readCodexJsonLines(path, {
    strict: parseOptions.strictJsonLines,
  })) {
    const id = sessionIdFromSessionMeta(value);
    if (id !== undefined) return id;
    // session_meta is the first JSON record of every rollout file; if the first record is not
    // a session_meta carrying an id, the file is malformed at the boundary.
    return undefined;
  }
  return undefined;
};

async function* streamCodexSessionFromFile(
  path: string,
  sourcePath: string,
  logicalSessionsRoot: string,
  rawNativeId: string,
  options: AdapterOptions,
  decodeDiagnostics: DecodeDiagnostic[],
  parseOptions: { readonly strictJsonLines?: boolean } = {},
): AsyncGenerator<NormalizedSession> {
  const nativeSessionId = CodexSessionId(rawNativeId);
  const sessionId = sessionIdFor("codex", nativeSessionId);
  const toolCallsById = new Map<string, CodexToolCallDraft>();
  const toolCallEventByToolId = new Map<string, string>();
  let projectPath: string | undefined;
  // Subagent lineage + agent identity, sourced fail-closed from the decoded
  // session_meta. Defaults: no parent, agentName "codex" (a main session).
  let agentName = "codex";
  let slice = emptyCodexSlice();

  const buildCompleteSession = () => {
    if (slice.events.length === 0) return undefined;
    const session = buildSession({
      provider: "codex",
      agentName,
      machine: options.machine,
      sessionId,
      nativeSessionId,
      nativeProjectKey: projectPath,
      sourceRoot: logicalSessionsRoot,
      sourcePath,
      projectPath,
      events: slice.events,
      toolCalls: [...slice.toolCallIds].flatMap((id) => {
        const toolCall = toolCallsById.get(id);
        return toolCall === undefined ? [] : [toolCall];
      }),
      usageRecords: slice.usageRecords,
      sessionEdges: slice.sessionEdges,
    });
    slice = emptyCodexSlice();

    return {
      ...session,
      eventCount: session.events.length,
      toolCallCount: session.toolCalls.length,
      contentBlockCount: session.events.reduce(
        (count, event) => count + event.contentBlocks.length,
        0,
      ),
      sessionEdgeCount: session.sessionEdges.length,
      usageRecordCount: session.usageRecords.length,
      artifactCount: session.artifacts.length,
    };
  };

  for await (const { value, lineNumber, recordIndex } of readCodexJsonLines(path, {
    strict: parseOptions.strictJsonLines,
  })) {
    projectPath ??= projectPathFromSessionMeta(value);
    // Fail-closed decode of the session_meta record (the first JSON record).
    // A garbage session_meta becomes the NAMED diagnostic
    // `codex.session_meta.decode_failed` + a dropped decode — never a throw,
    // never silent coercion. Subagent lineage + agentName are projected ONLY
    // from a successfully decoded session_meta.
    if (recordFrom(value).type === "session_meta") {
      const decision = decodeOrDrop(CodexSessionMetaSchema, value, {
        kind: "session_meta" as const,
        diagnosticName: CODEX_SESSION_META_DECODE_FAILED,
        diagnostics: decodeDiagnostics,
      });
      if (isSignal(decision)) {
        const lineage = codexSubagentLineage(decision.value);
        if (lineage !== undefined) {
          if (lineage.agentName !== undefined) agentName = lineage.agentName;
          // Session-to-session subagent lineage. The canonical signal is a
          // `subagent_of` edge whose `fromId` is the parent's machine-independent
          // Quasar SessionId and `toId` is this child's; mapSession projects it
          // onto SessionRow.parentSessionId. The parent's native id is preserved
          // in `rawReference`. NEVER `kind: "parent"` (event threading).
          const parentSessionId = sessionIdFor("codex", CodexSessionId(lineage.parentNativeId));
          slice.sessionEdges.push({
            id: edgeIdFor(sessionId, "subagent_of", parentSessionId, sessionId),
            kind: "subagent_of",
            fromId: parentSessionId,
            toId: sessionId,
            rawReference: {
              sourcePath,
              line: lineNumber,
              nativeType: "session_meta.payload.source.subagent.thread_spawn.parent_thread_id",
              nativeValue: lineage.parentNativeId,
            },
          });
        }
      }
    }
    const record =
      typeof value === "object" && value !== null
        ? (value as Record<string, unknown>)
        : {};
    const nativeType = typeof record.type === "string" ? record.type : "unknown";
    const payloadValue = record.payload;
    const payloadRecord = payloadRecordFrom(payloadValue);
    const content = projectSessionNativeValue(payloadValue);
    const payloadType = payloadTypeFrom(payloadRecord);
    const role = codexRoleFrom(nativeType, payloadType, payloadRecord);
    const kind = codexKindFrom(nativeType, payloadType, payloadRecord);
    const payloadCallId = callIdFromPayload(payloadRecord);
    const nativeEventId =
      typeof payloadRecord.id === "string"
        ? payloadRecord.id
        : payloadCallId ?? (typeof record.id === "string" ? record.id : undefined);
    const eventId = eventIdFor(sessionId, recordIndex, nativeEventId ?? lineNumber);
    const timestamp = typeof record.timestamp === "string" ? record.timestamp : undefined;
    const toolCallId = upsertCodexToolCall(
      toolCallsById,
      sessionId,
      eventId,
      timestamp,
      payloadRecord,
    );
    if (toolCallId !== undefined) {
      slice.toolCallIds.add(toolCallId);
      if (kind === "tool_call") toolCallEventByToolId.set(toolCallId, eventId);
      if (kind === "tool_result") {
        const callEventId = toolCallEventByToolId.get(toolCallId);
        if (callEventId !== undefined) {
          slice.sessionEdges.push({
            id: edgeIdFor(sessionId, "tool_result_for", callEventId, eventId),
            kind: "tool_result_for",
            fromEventId: callEventId,
            toEventId: eventId,
          });
        }
      }
    }
    const usageRecord = codexUsageRecord(
      sessionId,
      eventId,
      recordIndex,
      timestamp,
      payloadRecord,
    );
    if (usageRecord !== undefined) slice.usageRecords.push(usageRecord);
    // Message events whose payload carries no turn content (empty text stubs)
    // surface as bare events: no contentText/contentSource means no blocks and
    // no fallback JSON dump on the search surface.
    const hasTurnContent = kind !== "message" || codexMessageHasTurnContent(payloadRecord);
    slice.events.push({
      id: eventId,
      nativeEventId,
      sequence: recordIndex,
      timestamp,
      role,
      kind,
      ...(hasTurnContent
        ? { contentText: compactText(content), contentSource: content }
        : {}),
      ...(toolCallId !== undefined ? { toolCallId } : {}),
      rawReference: {
        sourcePath,
        line: lineNumber,
        nativeType: codexNativeType(nativeType, payloadType),
      },
    });
  }

  const final = buildCompleteSession();
  if (final !== undefined) yield final;
}

async function* streamCodex(options: AdapterOptions) {
  const root = options.roots?.codex ?? codexAdapter.defaultRoot();
  if (root === undefined || !existsSync(root)) {
    yield {
      type: "diagnostic" as const,
      diagnostic: {
        adapterId: codexAdapter.id,
        provider: "codex" as const,
        status: "no_data_found" as const,
        parserConfidence: "documented" as const,
        message: "Codex root was not found.",
        ...(root !== undefined ? { rootPath: root } : {}),
      },
    };
    return;
  }

  const logicalRoot = logicalRootFor("codex", root, options);
  // Codex keeps live rollouts under sessions/<year>/… and archived rollouts
  // flat under archived_sessions/. Both hold the identical JSONL format, so
  // both are scanned; skip/limit apply to the combined file list.
  const scans = ["sessions", "archived_sessions"].map((directory) => ({
    physicalRoot: join(root, directory),
    logicalScanRoot: join(logicalRoot, directory),
  }));
  const logicalSessionsRoot = scans[0]!.logicalScanRoot;
  const allFiles = scans.flatMap((scan) =>
    collectFiles(scan.physicalRoot, (path) => /rollout-.*\.jsonl$/.test(path)).map(
      (path) => ({ path, scan }),
    ),
  );
  const skip =
    options.skip !== undefined && Number.isFinite(options.skip) && options.skip > 0
      ? Math.floor(options.skip)
      : 0;
  const limit =
    options.limit !== undefined && Number.isFinite(options.limit)
      ? Math.max(0, Math.floor(options.limit))
      : Number.POSITIVE_INFINITY;
  const files =
    limit === Number.POSITIVE_INFINITY
      ? allFiles.slice(skip)
      : allFiles.slice(skip, skip + limit);
  for (const scan of scans) {
    yield {
      type: "sourceRoot" as const,
      sourceRoot: sourceRoot("codex", codexAdapter.id, scan.logicalScanRoot, options.machine, options.now),
    };
  }
  let sessionCount = 0;
  let rejectedCount = 0;
  for (const { path, scan } of files) {
    const sourcePath = logicalPathFor(path, scan.physicalRoot, scan.logicalScanRoot);
    // The codex native id is the content-sourced session_meta.payload.id, so the
    // pre-parse probe must read it from the first JSON record to derive the same canonical
    // sessionId the full parse would; a file missing it is boundary-rejected.
    const nativeId = await readCodexNativeId(path, {});
    if (nativeId === undefined) {
      rejectedCount += 1;
      yield {
        type: "diagnostic" as const,
        diagnostic: {
          adapterId: codexAdapter.id,
          provider: "codex" as const,
          status: "error" as const,
          parserConfidence: "documented" as const,
          rootPath: scan.logicalScanRoot,
          message: `${CODEX_MISSING_SESSION_META_ID}: ${sourcePath} has no session_meta.payload.id; wrote zero rows for this session.`,
          details: { sourcePath, physicalPath: path },
        },
      };
      continue;
    }
    // Cheap pre-parse gate: a stat (size/mtime) is the per-session change
    // signal, so an unchanged rollout file never reaches the line parse.
    if (options.shouldParseSession !== undefined) {
      const stat = statSync(path);
      const probe = {
        sessionId: sessionIdFor("codex", CodexSessionId(nativeId)),
        sourceFingerprint: sourceFingerprintFor(stat),
      };
      if ((await options.shouldParseSession(probe)) === false) continue;
    }
    sessionCount += 1;
    // Named decode diagnostics for a malformed session_meta in THIS file. A
    // drop is accumulated here and surfaced as an attributable diagnostic; it
    // never aborts the file and never coerces silently.
    const decodeDiagnostics: DecodeDiagnostic[] = [];
    for await (const session of streamCodexSessionFromFile(
        path,
        sourcePath,
        scan.logicalScanRoot,
        nativeId,
        options,
        decodeDiagnostics,
    )) {
      yield {
        type: "session" as const,
        session,
        sourceUnit: {
          provider: "codex" as const,
          adapterId: codexAdapter.id,
          rootPath: scan.logicalScanRoot,
          sourcePath,
          physicalPath: path,
        },
      };
    }
    for (const diagnostic of decodeDiagnostics) {
      yield {
        type: "diagnostic" as const,
        diagnostic: {
          adapterId: codexAdapter.id,
          provider: "codex" as const,
          status: "unsupported" as const,
          parserConfidence: "documented" as const,
          rootPath: scan.logicalScanRoot,
          message: `Codex session_meta dropped (${diagnostic.name}) for ${sourcePath}.`,
          details: { error: diagnostic.message, sourcePath, physicalPath: path },
        },
      };
    }
  }
  yield {
    type: "diagnostic" as const,
    diagnostic: {
      adapterId: codexAdapter.id,
      provider: "codex" as const,
      status: sessionCount > 0 ? ("available" as const) : ("no_data_found" as const),
      parserConfidence: "documented" as const,
      rootPath: logicalSessionsRoot,
      message:
        rejectedCount > 0
          ? `Discovered ${sessionCount} Codex session(s); rejected ${rejectedCount} file(s) missing session_meta.payload.id.`
          : `Discovered ${sessionCount} Codex session(s).`,
    },
  };
}

export const codexAdapter: SessionAdapter = {
  id: "codex-local-jsonl",
  provider: "codex",
  displayName: "Codex local JSONL",
  stable: true,
  defaultRoot: () => process.env.CODEX_HOME ?? homePath(".codex"),
  read: async (options) => collectAdapterStream(streamCodex(options)),
  stream: streamCodex,
};
