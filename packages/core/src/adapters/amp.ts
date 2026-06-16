import { execFileSync } from "node:child_process";

import { stableWideHash } from "../hash";
import { collectAdapterStream, type AdapterStreamItem, type SessionAdapter } from "./types";
import type { ToolCall } from "../schemas";
import {
  buildSession,
  compactText,
  homePath,
  numberValue,
  projectToolPayloadNativeValue,
  recordFrom,
  sourceRoot,
  stringValue,
  type NativeValue,
} from "./common";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/** Page size for the thread list — the CLI caps a single page at this many. */
const LIST_PAGE_SIZE = 200;

/** Hard cap on list pages so a misbehaving CLI can never loop forever. */
const MAX_LIST_PAGES = 100;

/**
 * Recent-thread scope line. Threads last updated before this instant are out of
 * scope for the current dogfood (the owner cleans older threads up first). This
 * is a SCOPE filter on which remote threads we enumerate — not a byte budget,
 * clamp, or truncation of any value. Threads at or after it are exported in
 * full and rejected only at the Convex boundary if a value is oversized.
 */
const RECENT_THREAD_CUTOFF = new Date("2026-03-16T00:00:00.000Z");

/** Canonical public thread URL — machine-independent, the stable identity. */
const canonicalThreadURL = (threadId: string) => `https://ampcode.com/threads/${threadId}`;

// ---------------------------------------------------------------------------
// Subprocess runner (injectable so tests never touch the network)
// ---------------------------------------------------------------------------

/** Tagged result of one amp invocation. A failure never throws to the caller. */
export type AmpRunResult =
  | { readonly ok: true; readonly stdout: string }
  | { readonly ok: false; readonly reason: "missing_binary" | "command_failed" };

/** Runs one amp subcommand and returns its stdout, fail-soft. */
export type AmpRunner = (args: readonly string[]) => AmpRunResult;

const ampBinaryPath = () => homePath(".amp/bin/amp");

/**
 * Default runner: execFiles the amp CLI. The CLI's own stored auth key is
 * consulted IMPLICITLY by the binary — this adapter never reads or prints any
 * credential. Any failure (missing binary, non-zero exit, auth failure)
 * collapses to a tagged failure the generator turns into a named diagnostic.
 */
const defaultAmpRunner: AmpRunner = (args) => {
  const binary = ampBinaryPath();
  if (binary === undefined) return { ok: false, reason: "missing_binary" };
  try {
    const stdout = execFileSync(binary, [...args], {
      encoding: "utf8",
      timeout: 60_000,
      maxBuffer: Number.POSITIVE_INFINITY,
    });
    return { ok: true, stdout };
  } catch {
    return { ok: false, reason: "command_failed" };
  }
};

type AdapterOptions = Parameters<SessionAdapter["read"]>[0] & {
  /** Injected in tests so no real amp process is ever spawned. */
  readonly ampRunner?: AmpRunner;
};

type AmpToolCallDraft = Omit<
  ToolCall,
  "sessionId" | "machineId" | "provider" | "agentName" | "projectIdentityKey"
>;

type AmpEventDraft = {
  readonly id: string;
  readonly sequence: number;
  readonly timestamp?: string;
  readonly role: "user" | "assistant" | "thinking" | "unknown";
  readonly kind: "message" | "reasoning" | "tool_call" | "tool_result" | "unknown";
  readonly contentText?: string;
  readonly contentSource?: NativeValue;
  readonly toolCallId?: string;
  readonly rawReference: {
    readonly sourcePath: string;
    readonly line: number;
    readonly nativeType: string;
  };
};

// ---------------------------------------------------------------------------
// List enumeration
// ---------------------------------------------------------------------------

interface AmpThreadSummary {
  readonly id: string;
  readonly title?: string;
  readonly updated: string;
  readonly messageCount: number;
}

const parseJson = (text: string): unknown => {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
};

/**
 * Normalize one list entry into a summary. Branches defensively on field
 * presence; an entry with no usable id or `updated` is dropped.
 */
const summaryFrom = (value: unknown): AmpThreadSummary | undefined => {
  const record = recordFrom(value);
  const id = stringValue(record.id);
  const updated = stringValue(record.updated);
  if (id === undefined || updated === undefined) return undefined;
  return {
    id,
    ...(stringValue(record.title) !== undefined ? { title: stringValue(record.title) } : {}),
    updated,
    messageCount: numberValue(record.messageCount) ?? 0,
  };
};

/** The thread list array can be the top-level value or under a `threads` key. */
const listArrayFrom = (value: unknown): readonly unknown[] => {
  if (Array.isArray(value)) return value;
  const record = recordFrom(value);
  if (Array.isArray(record.threads)) return record.threads;
  return [];
};

/** Whether a thread's `updated` parses to a date in the recent scope. */
const isRecent = (updated: string): boolean => {
  const time = Date.parse(updated);
  return Number.isFinite(time) && time >= RECENT_THREAD_CUTOFF.getTime();
};

/** Paginate `amp threads list` until a short page; fail-soft on any error. */
const enumerateThreads = (
  runner: AmpRunner,
): { readonly threads: readonly AmpThreadSummary[]; readonly failed: boolean } => {
  const threads: AmpThreadSummary[] = [];
  for (let page = 0; page < MAX_LIST_PAGES; page += 1) {
    const offset = page * LIST_PAGE_SIZE;
    const result = runner([
      "threads",
      "list",
      "--json",
      "--limit",
      String(LIST_PAGE_SIZE),
      "--offset",
      String(offset),
    ]);
    if (!result.ok) return { threads, failed: true };
    const parsed = parseJson(result.stdout);
    if (parsed === undefined) return { threads, failed: true };
    const entries = listArrayFrom(parsed);
    for (const entry of entries) {
      const summary = summaryFrom(entry);
      if (summary !== undefined) threads.push(summary);
    }
    if (entries.length < LIST_PAGE_SIZE) break;
  }
  return { threads, failed: false };
};

// ---------------------------------------------------------------------------
// Export mapping
// ---------------------------------------------------------------------------

/** epoch ms → ISO timestamp, defensively. */
const isoFromEpochMs = (value: unknown): string | undefined => {
  const ms = numberValue(value);
  if (ms === undefined) return undefined;
  const date = new Date(ms);
  return Number.isFinite(date.getTime()) ? date.toISOString() : undefined;
};

/** ISO/epoch passthrough for block-level start/final times. */
const isoFromBlockTime = (value: unknown): string | undefined => {
  const asString = stringValue(value);
  if (asString !== undefined) return asString;
  return isoFromEpochMs(value);
};

/** Project path from env.initial.trees[].uri (file:///… → filesystem path). */
const projectPathFromExport = (exportRecord: Record<string, unknown>): string | undefined => {
  const env = recordFrom(exportRecord.env);
  const initial = recordFrom(env.initial);
  const trees = Array.isArray(initial.trees) ? initial.trees : [];
  for (const tree of trees) {
    const uri = stringValue(recordFrom(tree).uri);
    if (uri === undefined) continue;
    if (uri.startsWith("file://")) {
      try {
        return decodeURIComponent(new URL(uri).pathname);
      } catch {
        return uri.replace(/^file:\/\//, "");
      }
    }
  }
  return undefined;
};

const threadLevelModel = (exportRecord: Record<string, unknown>): string | undefined => {
  const meta = recordFrom(exportRecord.meta);
  return stringValue(meta.agentMode) ?? stringValue(exportRecord.agentMode);
};

/**
 * Map one exported thread to a normalized session. Branches on the schema
 * field `v` defensively (presence-based, never asserting a particular version):
 * any field we cannot read is simply skipped.
 */
const buildAmpSession = (
  summary: AmpThreadSummary,
  exportValue: unknown,
  machine: AdapterOptions["machine"],
) => {
  const exportRecord = recordFrom(exportValue);
  const threadUrl = canonicalThreadURL(summary.id);
  const canonicalId = `amp:${stableWideHash(threadUrl)}`;
  const messages = Array.isArray(exportRecord.messages) ? exportRecord.messages : [];

  const events: AmpEventDraft[] = [];
  const toolCallsById = new Map<string, AmpToolCallDraft>();
  let seq = 0;

  const eventIdFor = (suffix: string) =>
    `amp:event:${canonicalId}:${stableWideHash(`${summary.id}:${suffix}`)}`;
  const toolIdFor = (toolUseId: string) =>
    `amp:tool:${canonicalId}:${stableWideHash(`${summary.id}:${toolUseId}`)}`;

  for (let messageIndex = 0; messageIndex < messages.length; messageIndex += 1) {
    const message = recordFrom(messages[messageIndex]);
    const role = stringValue(message.role);
    const blocks = Array.isArray(message.content) ? message.content : [];
    const messageMeta = recordFrom(message.meta);
    const userTimestamp = isoFromEpochMs(messageMeta.sentAt);

    for (let blockIndex = 0; blockIndex < blocks.length; blockIndex += 1) {
      const block = recordFrom(blocks[blockIndex]);
      const type = stringValue(block.type);
      const line = messageIndex;
      const blockTime =
        role === "user"
          ? userTimestamp
          : isoFromBlockTime(block.finalTime) ?? isoFromBlockTime(block.startTime);

      if (type === "text") {
        const text = stringValue(block.text);
        if (text === undefined) continue;
        const contentText = compactText(text);
        events.push({
          id: eventIdFor(`${messageIndex}:${blockIndex}:text`),
          sequence: seq,
          ...(blockTime !== undefined ? { timestamp: blockTime } : {}),
          role: role === "user" ? "user" : role === "assistant" ? "assistant" : "unknown",
          kind: "message",
          ...(contentText !== undefined ? { contentText } : {}),
          contentSource: text,
          rawReference: { sourcePath: threadUrl, line, nativeType: "text" },
        });
        seq += 1;
        continue;
      }

      if (type === "thinking") {
        // The opaque openAIReasoning.encryptedContent blob is dropped by the
        // shared redaction pass in common.ts — no special-case here.
        const thinking = stringValue(block.thinking);
        if (thinking === undefined) continue;
        const contentText = compactText(thinking);
        events.push({
          id: eventIdFor(`${messageIndex}:${blockIndex}:thinking`),
          sequence: seq,
          ...(blockTime !== undefined ? { timestamp: blockTime } : {}),
          role: "thinking",
          kind: "reasoning",
          ...(contentText !== undefined ? { contentText } : {}),
          contentSource: thinking,
          rawReference: { sourcePath: threadUrl, line, nativeType: "thinking" },
        });
        seq += 1;
        continue;
      }

      if (type === "tool_use") {
        const toolUseId = stringValue(block.id);
        const toolName = stringValue(block.name);
        if (toolUseId === undefined || toolName === undefined) continue;
        const eventId = eventIdFor(`${messageIndex}:${blockIndex}:tool_use`);
        const input = projectToolPayloadNativeValue(block.input);
        const draft: AmpToolCallDraft = {
          id: toolIdFor(toolUseId),
          eventId,
          toolName,
          status: "started",
          ...(input !== undefined ? { input } : {}),
          ...(blockTime !== undefined ? { startedAt: blockTime } : {}),
        };
        toolCallsById.set(toolUseId, draft);
        events.push({
          id: eventId,
          sequence: seq,
          ...(blockTime !== undefined ? { timestamp: blockTime } : {}),
          role: "assistant",
          kind: "tool_call",
          toolCallId: draft.id,
          rawReference: { sourcePath: threadUrl, line, nativeType: "tool_use" },
        });
        seq += 1;
        continue;
      }

      if (type === "tool_result") {
        const toolUseId = stringValue(block.toolUseID);
        if (toolUseId === undefined) continue;
        const run = recordFrom(block.run);
        const runResult = recordFrom(run.result);
        const resultContent = Array.isArray(runResult.content) ? runResult.content : [];
        const outputText = resultContent
          .map((part) => stringValue(recordFrom(part).text))
          .filter((part): part is string => part !== undefined)
          .join("\n");
        const output = projectToolPayloadNativeValue(
          outputText.length > 0 ? outputText : undefined,
        );
        const existing = toolCallsById.get(toolUseId);
        const eventId = eventIdFor(`${messageIndex}:${blockIndex}:tool_result`);
        const merged: AmpToolCallDraft = {
          id: existing?.id ?? toolIdFor(toolUseId),
          eventId: existing?.eventId ?? eventId,
          toolName: existing?.toolName ?? "amp_tool",
          status: "completed",
          ...(existing?.input !== undefined ? { input: existing.input } : {}),
          ...(output !== undefined ? { output } : {}),
          ...(existing?.startedAt !== undefined ? { startedAt: existing.startedAt } : {}),
          ...(blockTime !== undefined ? { completedAt: blockTime } : {}),
        };
        toolCallsById.set(toolUseId, merged);
        events.push({
          id: eventId,
          sequence: seq,
          ...(blockTime !== undefined ? { timestamp: blockTime } : {}),
          role: "unknown",
          kind: "tool_result",
          toolCallId: merged.id,
          rawReference: { sourcePath: threadUrl, line, nativeType: "tool_result" },
        });
        seq += 1;
        continue;
      }
    }
  }

  const projectPath = projectPathFromExport(exportRecord);
  const model = threadLevelModel(exportRecord);

  return buildSession({
    provider: "amp",
    agentName: model ?? "amp",
    machine,
    nativeSessionId: summary.id,
    canonicalId,
    ...(summary.title !== undefined ? { title: summary.title } : {}),
    updatedAt: summary.updated,
    sourceRoot: "https://ampcode.com/threads",
    sourcePath: threadUrl,
    ...(projectPath !== undefined ? { projectPath } : {}),
    events,
    toolCalls: [...toolCallsById.values()],
  });
};

// ---------------------------------------------------------------------------
// Stream
// ---------------------------------------------------------------------------

async function* streamAmp(options: AdapterOptions): AsyncGenerator<AdapterStreamItem> {
  const runner = options.ampRunner ?? defaultAmpRunner;
  const root = "https://ampcode.com/threads";

  yield { type: "sourceRoot", sourceRoot: sourceRoot("amp", ampAdapter.id, root, options.machine, options.now) };

  const { threads, failed } = enumerateThreads(runner);
  if (failed) {
    yield {
      type: "diagnostic",
      diagnostic: {
        adapterId: ampAdapter.id,
        provider: "amp",
        status: "error",
        parserConfidence: "observed",
        rootPath: root,
        message: "Amp thread enumeration failed (CLI unavailable, auth failure, or unparseable output).",
      },
    };
    return;
  }

  const inScope = threads.filter((thread) => isRecent(thread.updated));
  let sessionCount = 0;
  let skipped = 0;

  for (const thread of inScope) {
    if (skipped < (options.skip ?? 0)) {
      skipped += 1;
      continue;
    }
    if (sessionCount >= (options.limit ?? Number.POSITIVE_INFINITY)) break;

    // Cheap list-metadata fingerprint: a thread whose (updated, messageCount)
    // is unchanged never reaches the expensive export.
    const tag = stableWideHash(`${thread.updated}:${thread.messageCount}`);
    const fingerprint = { tag } as const;
    const sessionId = `amp:${stableWideHash(canonicalThreadURL(thread.id))}`;
    if (
      options.shouldParseSession !== undefined &&
      options.shouldParseSession({
        sessionId,
        sourceFingerprint: JSON.stringify(fingerprint),
      }) === false
    ) {
      continue;
    }

    const exportResult = runner(["threads", "export", thread.id]);
    if (!exportResult.ok) {
      yield {
        type: "diagnostic",
        diagnostic: {
          adapterId: ampAdapter.id,
          provider: "amp",
          status: "error",
          parserConfidence: "observed",
          rootPath: root,
          message: `Amp thread export failed for one thread; continuing.`,
        },
      };
      continue;
    }
    const exportValue = parseJson(exportResult.stdout);
    if (exportValue === undefined) {
      yield {
        type: "diagnostic",
        diagnostic: {
          adapterId: ampAdapter.id,
          provider: "amp",
          status: "error",
          parserConfidence: "observed",
          rootPath: root,
          message: `Amp thread export returned unparseable JSON for one thread; continuing.`,
        },
      };
      continue;
    }

    const session = buildAmpSession(thread, exportValue, options.machine);
    sessionCount += 1;
    yield {
      type: "session",
      session,
      sourceUnit: {
        provider: "amp",
        adapterId: ampAdapter.id,
        rootPath: root,
        sourcePath: session.sourcePath,
      },
      fingerprint,
    };
  }

  yield {
    type: "diagnostic",
    diagnostic: {
      adapterId: ampAdapter.id,
      provider: "amp",
      status: sessionCount > 0 ? "available" : "no_data_found",
      parserConfidence: "observed",
      rootPath: root,
      message: `Discovered ${sessionCount} recent Amp thread(s).`,
    },
  };
}

// ---------------------------------------------------------------------------
// Adapter export
// ---------------------------------------------------------------------------

export const ampAdapter: SessionAdapter = {
  id: "amp-thread-export",
  provider: "amp",
  displayName: "Amp thread export",
  stable: true,
  defaultRoot: () => ampBinaryPath(),
  read: async (options) => collectAdapterStream(streamAmp(options)),
  stream: streamAmp,
};
