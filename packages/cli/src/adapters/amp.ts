import { execFileSync, type ExecFileSyncOptions } from "node:child_process";
import { existsSync } from "node:fs";

import { gitRemoteForPath } from "../core/git-identity";
import { stableJsonHash } from "../core/hash";
import { AmpSessionId, type SessionId } from "../core/identity";
import type {
  AdapterDiagnostic,
  SessionEventKind,
  SessionRole,
  ToolCall,
} from "../core/schemas";
import {
  buildSession,
  compactText,
  eventIdFor,
  homePath,
  projectToolPayloadNativeValue,
  scopedId,
  sessionIdFor,
  sourceRoot,
  type NativeValue,
} from "./common";
import {
  AmpExportSchema,
  AmpTextBlockSchema,
  AmpThinkingBlockSchema,
  AmpThreadListEntrySchema,
  AmpToolResultBlockSchema,
  AmpToolUseBlockSchema,
  type AmpExport,
  type AmpThreadListEntry,
} from "./amp-schema";
import { type DecodeDiagnostic, decodeOrDrop, isSignal } from "./harness-schema";
import {
  collectAdapterStream,
  type AdapterDiscoverOptions,
  type AdapterStreamItem,
  type SessionAdapter,
  type UnitFingerprint,
} from "./types";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SOURCE_ROOT = "https://ampcode.com/threads";
/** Page size for `amp threads list --limit`. Exported for multi-page tests. */
export const AMP_LIST_PAGE_SIZE = 500;
const LIST_PAGE_SIZE = AMP_LIST_PAGE_SIZE;
/**
 * Hard cap on list pagination. Hitting it is a truncated walk — not a complete
 * corpus — and must emit `amp.list.page_cap_reached` (no silent truncation).
 * Exported so tests can assert the production default without re-deriving it.
 */
export const AMP_MAX_LIST_PAGES = 100;
const WATERMARK_GUARD_MS = 60 * 60 * 1_000;
const DEFAULT_EXPORT_SPACING_MS = 3_000;
const MAX_EXPORT_ATTEMPTS = 5;
const BASE_BACKOFF_MS = 1_000;

const threadUrl = (threadId: string) => `${SOURCE_ROOT}/${threadId}`;

// ---------------------------------------------------------------------------
// Subprocess runner (injectable so tests never touch the network)
// ---------------------------------------------------------------------------

/** Tagged result of one amp invocation. Failures never throw to the caller. */
export type AmpRunResult =
  | { readonly ok: true; readonly stdout: string }
  | {
      readonly ok: false;
      readonly reason: "missing_binary" | "command_failed" | "rate_limited";
      readonly detail?: string;
    };

/** Runs one amp subcommand and returns its stdout, fail-soft. */
export type AmpRunner = (args: readonly string[]) => AmpRunResult;

export type AmpStreamOptions = AdapterDiscoverOptions & {
  /** Injected in tests so no real amp process is ever spawned. */
  readonly ampRunner?: AmpRunner;
  /** Injected delay (tests pass a no-op). Defaults to real wall-clock sleep. */
  readonly ampSleep?: (ms: number) => Promise<void>;
  /** Spacing between sequential exports. Defaults to 3s. */
  readonly exportSpacingMs?: number;
  /**
   * Override for list pagination page cap (production default:
   * {@link AMP_MAX_LIST_PAGES}). Tests use a small value so a truncated walk is
   * cheap to assert; not a product knob.
   */
  readonly maxListPages?: number;
};

const resolveAmpBinary = (): string | undefined => {
  const fromEnv = process.env.AMP_BIN?.trim();
  if (fromEnv !== undefined && fromEnv.length > 0 && existsSync(fromEnv)) return fromEnv;
  const homeBinary = homePath(".amp/bin/amp");
  if (homeBinary !== undefined && existsSync(homeBinary)) return homeBinary;
  const localBinary = homePath(".local/bin/amp");
  if (localBinary !== undefined && existsSync(localBinary)) return localBinary;
  return "amp";
};

const isRateLimitedMessage = (text: string): boolean =>
  /\b429\b|rate.?limit|too many requests/i.test(text);

const defaultAmpRunner: AmpRunner = (args) => {
  const binary = resolveAmpBinary();
  if (binary === undefined) return { ok: false, reason: "missing_binary" };
  if (binary !== "amp" && !existsSync(binary)) {
    return { ok: false, reason: "missing_binary" };
  }
  try {
    const options: ExecFileSyncOptions = {
      encoding: "utf8",
      timeout: 120_000,
      maxBuffer: Number.MAX_SAFE_INTEGER,
    };
    const stdout = execFileSync(binary, [...args], options);
    return { ok: true, stdout: typeof stdout === "string" ? stdout : String(stdout) };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    if (isRateLimitedMessage(detail)) {
      return { ok: false, reason: "rate_limited", detail };
    }
    // Missing binary on PATH surfaces as ENOENT.
    if (
      typeof error === "object"
      && error !== null
      && "code" in error
      && (error as { code?: unknown }).code === "ENOENT"
    ) {
      return { ok: false, reason: "missing_binary", detail };
    }
    return { ok: false, reason: "command_failed", detail };
  }
};

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

// ---------------------------------------------------------------------------
// Diagnostics
// ---------------------------------------------------------------------------

const adapterDiagnostic = (
  rootPath: string,
  name: string,
  message: string,
  status: AdapterDiagnostic["status"] = "unsupported",
): AdapterDiagnostic => ({
  adapterId: ampAdapter.id,
  provider: "amp",
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
    `Amp record rejected (${diagnostic.name}).`,
  ),
  details: {
    diagnostic: diagnostic.name,
    error: diagnostic.message,
    ...(sessionId === undefined ? {} : { nativeSessionId: sessionId }),
  },
});

// ---------------------------------------------------------------------------
// List enumeration
// ---------------------------------------------------------------------------

const parseJson = (text: string): unknown => {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
};

/** The thread list array can be the top-level value or under a `threads` key. */
const listArrayFrom = (value: unknown): readonly unknown[] => {
  if (Array.isArray(value)) return value;
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    const threads = (value as { readonly threads?: unknown }).threads;
    if (Array.isArray(threads)) return threads;
  }
  return [];
};

const parseUpdatedMs = (updated: string): number | undefined => {
  const time = Date.parse(updated);
  return Number.isFinite(time) ? time : undefined;
};

const oldestUpdatedMs = (entries: readonly AmpThreadListEntry[]): number | undefined => {
  let oldest: number | undefined;
  for (const entry of entries) {
    const ms = parseUpdatedMs(entry.updated);
    if (ms === undefined) continue;
    oldest = oldest === undefined ? ms : Math.min(oldest, ms);
  }
  return oldest;
};

/**
 * Grounded contract (measured against live `amp threads list --json` 2026-07-24):
 * pages are returned `updated`-descending. Early-stop on watermark is only sound
 * under that order — if a page is not descending we disable early-stop for the
 * rest of the walk so recent threads on later pages are not silently dropped.
 */
const isUpdatedDescending = (entries: readonly AmpThreadListEntry[]): boolean => {
  let previousMs: number | undefined;
  for (const entry of entries) {
    const ms = parseUpdatedMs(entry.updated);
    if (ms === undefined) continue;
    if (previousMs !== undefined && ms > previousMs) return false;
    previousMs = ms;
  }
  return true;
};

type EnumerateThreadsResult = {
  readonly threads: readonly AmpThreadListEntry[];
  readonly listFailed: boolean;
  /** True when watermark early-stop truncated enumeration (after one guard page). */
  readonly earlyStop: boolean;
  /** True when a list page was not updated-descending; early-stop was disabled. */
  readonly orderAssumptionViolated: boolean;
  /**
   * True when enumeration stopped because `maxListPages` was exhausted without a
   * short terminal page or armed early-stop — a truncated walk, not a complete one.
   */
  readonly pageCapReached: boolean;
  /** Pages successfully fetched before exit (for the page-cap diagnostic message). */
  readonly pagesFetched: number;
};

/**
 * Paginate `amp threads list --json --limit 500`.
 *
 * With a high watermark, and only while pages remain updated-descending:
 * stop when a page's oldest `updated` is below watermark − 60 minutes, then
 * fetch one guard page and halt. Early-stop skips threads that never reach
 * shouldParseSession — omit highWatermark (ingest `--force`) for a full walk.
 *
 * Exhausting `maxListPages` without a short page or early-stop sets
 * `pageCapReached` so callers can emit a named truncation diagnostic.
 */
const enumerateThreads = (
  runner: AmpRunner,
  highWatermark: string | undefined,
  diagnostics: DecodeDiagnostic[],
  maxListPages: number,
): EnumerateThreadsResult => {
  const collected: AmpThreadListEntry[] = [];
  const watermarkMs =
    highWatermark !== undefined ? parseUpdatedMs(highWatermark) : undefined;
  const cutoffMs =
    watermarkMs !== undefined ? watermarkMs - WATERMARK_GUARD_MS : undefined;
  /** After a page trips the cutoff, fetch exactly one more page then halt. */
  let expectingGuardPage = false;
  let earlyStop = false;
  let orderAssumptionViolated = false;
  let listOrderTrusted = true;
  let pagesFetched = 0;
  /** True when the loop exited because a short (terminal) page was returned. */
  let sawShortPage = false;

  for (let page = 0; page < maxListPages; page += 1) {
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
    if (!result.ok) {
      return {
        threads: collected,
        listFailed: true,
        earlyStop,
        orderAssumptionViolated,
        pageCapReached: false,
        pagesFetched,
      };
    }
    const parsed = parseJson(result.stdout);
    if (parsed === undefined) {
      diagnostics.push({
        name: "amp.list.invalid_json",
        message: "amp threads list returned unparseable JSON.",
      });
      return {
        threads: collected,
        listFailed: true,
        earlyStop,
        orderAssumptionViolated,
        pageCapReached: false,
        pagesFetched,
      };
    }
    const rawEntries = listArrayFrom(parsed);
    const pageEntries: AmpThreadListEntry[] = [];
    for (const raw of rawEntries) {
      const decision = decodeOrDrop(AmpThreadListEntrySchema, raw, {
        kind: "thread",
        diagnosticName: "amp.list.entry.decode_failed",
        diagnostics,
      });
      if (isSignal(decision)) pageEntries.push(decision.value);
    }
    collected.push(...pageEntries);
    pagesFetched += 1;

    // Guard page (full or short) always ends enumeration after the cutoff trip.
    if (expectingGuardPage) {
      earlyStop = true;
      break;
    }

    if (rawEntries.length < LIST_PAGE_SIZE) {
      sawShortPage = true;
      break;
    }

    if (cutoffMs === undefined) continue;

    // Early-stop requires updated-descending pages; otherwise keep walking.
    if (!isUpdatedDescending(pageEntries)) {
      listOrderTrusted = false;
      orderAssumptionViolated = true;
      continue;
    }
    if (!listOrderTrusted) continue;

    const oldest = oldestUpdatedMs(pageEntries);
    if (oldest !== undefined && oldest < cutoffMs) {
      // One extra page after the stop condition, then halt.
      expectingGuardPage = true;
    }
  }

  // Cap hit = walked maxListPages full pages without a short terminal page or
  // early-stop. Distinguishable from a complete walk so callers can surface
  // truncation (no silent partial corpus).
  const pageCapReached = !earlyStop && !sawShortPage && pagesFetched >= maxListPages;

  const byId = new Map<string, AmpThreadListEntry>();
  for (const thread of collected) byId.set(thread.id, thread);
  const threads = [...byId.values()].sort((left, right) => {
    const leftMs = parseUpdatedMs(left.updated) ?? 0;
    const rightMs = parseUpdatedMs(right.updated) ?? 0;
    return rightMs - leftMs || left.id.localeCompare(right.id);
  });
  return {
    threads,
    listFailed: false,
    earlyStop,
    orderAssumptionViolated,
    pageCapReached,
    pagesFetched,
  };
};

// ---------------------------------------------------------------------------
// Fingerprint + path helpers
// ---------------------------------------------------------------------------

/**
 * Opaque change signal for the server fingerprint gate.
 *
 * Includes `messageCount` so content growth that fails to bump `updated`
 * still invalidates the tag and re-exports. `updated` alone is not assumed
 * to be a contractual last-activity guarantee.
 */
const fingerprintForThread = (thread: AmpThreadListEntry): UnitFingerprint => ({
  tag: stableJsonHash({
    updated: thread.updated,
    title: thread.title ?? null,
    tree: thread.tree ?? null,
    messageCount: thread.messageCount ?? null,
  }),
});

const pathFromFileUri = (uri: string | undefined | null): string | undefined => {
  if (uri === undefined || uri === null || uri.length === 0) return undefined;
  if (!uri.startsWith("file://")) return undefined;
  try {
    return decodeURIComponent(new URL(uri).pathname);
  } catch {
    return uri.replace(/^file:\/\//, "");
  }
};

const projectPathFrom = (
  thread: AmpThreadListEntry,
  exported: AmpExport,
): string | undefined => {
  const fromList = pathFromFileUri(thread.tree);
  if (fromList !== undefined) return fromList;
  const trees = exported.env?.initial?.trees ?? [];
  for (const tree of trees) {
    const path = pathFromFileUri(tree.uri);
    if (path !== undefined) return path;
  }
  return undefined;
};

const gitRemoteFrom = (exported: AmpExport, projectPath: string | undefined): string | undefined => {
  const trees = exported.env?.initial?.trees ?? [];
  const url = trees[0]?.repository?.url;
  if (typeof url === "string" && url.trim().length > 0) return url.trim();
  return gitRemoteForPath(projectPath);
};

const isoFromEpochMs = (value: unknown): string | undefined => {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : undefined;
};

const isoFromBlockTime = (value: unknown): string | undefined => {
  if (typeof value === "string" && value.length > 0) {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? new Date(parsed).toISOString() : value;
  }
  return isoFromEpochMs(value);
};

const toolResultOutput = (run: Record<string, unknown> | undefined): unknown => {
  if (run === undefined) return undefined;
  const result = run.result;
  if (result === undefined || result === null) return undefined;
  if (typeof result === "string") return result;
  if (typeof result !== "object") return result;
  if (Array.isArray(result)) return result;
  const record = result as Record<string, unknown>;
  if (typeof record.output === "string") return record.output;
  if (Array.isArray(record.content)) {
    const texts = record.content
      .map((part) => {
        if (part === null || typeof part !== "object") return undefined;
        const text = (part as { readonly text?: unknown }).text;
        return typeof text === "string" ? text : undefined;
      })
      .filter((part): part is string => part !== undefined);
    if (texts.length > 0) return texts.join("\n");
  }
  return result;
};

// ---------------------------------------------------------------------------
// Export mapping
// ---------------------------------------------------------------------------

type AmpToolCallDraft = Omit<
  ToolCall,
  "sessionId" | "machineId" | "provider" | "agentName" | "projectIdentityKey"
>;

type AmpEventDraft = {
  readonly id: string;
  readonly sequence: number;
  readonly timestamp?: string;
  readonly role: SessionRole;
  readonly kind: SessionEventKind;
  readonly contentText?: string;
  readonly contentSource?: NativeValue;
  readonly toolCallId?: string;
  readonly rawReference: {
    readonly sourcePath: string;
    readonly line: number;
    readonly nativeType: string;
  };
};

const messageRole = (role: string | undefined): SessionRole => {
  if (role === "user") return "user";
  if (role === "assistant") return "assistant";
  if (role === "system") return "system";
  if (role === "tool") return "tool";
  return "unknown";
};

const buildAmpSession = (
  thread: AmpThreadListEntry,
  exported: AmpExport,
  machine: AdapterDiscoverOptions["machine"],
  sessionId: SessionId,
) => {
  const url = threadUrl(thread.id);
  const messages = exported.messages ?? [];
  const events: AmpEventDraft[] = [];
  const toolCallsById = new Map<string, AmpToolCallDraft>();
  let seq = 0;

  for (let messageIndex = 0; messageIndex < messages.length; messageIndex += 1) {
    const message = messages[messageIndex]!;
    const role = messageRole(message.role);
    const blocks = message.content ?? [];
    const userTimestamp = isoFromEpochMs(message.meta?.sentAt);
    // RawReference.line is PositiveInteger (1-based).
    const line = messageIndex + 1;

    for (let blockIndex = 0; blockIndex < blocks.length; blockIndex += 1) {
      const rawBlock = blocks[blockIndex];
      const textDecision = decodeOrDrop(AmpTextBlockSchema, rawBlock, {
        kind: "text",
        diagnosticName: "amp.block.text.decode_failed",
      });
      if (isSignal(textDecision)) {
        const block = textDecision.value;
        const blockTime =
          role === "user"
            ? userTimestamp
            : isoFromBlockTime(block.finalTime) ?? isoFromBlockTime(block.startTime);
        const contentText = compactText(block.text);
        const eventId = eventIdFor(sessionId, seq, `${messageIndex}:${blockIndex}:text`);
        events.push({
          id: eventId,
          sequence: seq,
          ...(blockTime !== undefined ? { timestamp: blockTime } : {}),
          role,
          kind: "message",
          ...(contentText !== undefined ? { contentText } : {}),
          contentSource: block.text,
          rawReference: { sourcePath: url, line, nativeType: "text" },
        });
        seq += 1;
        continue;
      }

      const thinkingDecision = decodeOrDrop(AmpThinkingBlockSchema, rawBlock, {
        kind: "thinking",
        diagnosticName: "amp.block.thinking.decode_failed",
      });
      if (isSignal(thinkingDecision)) {
        const block = thinkingDecision.value;
        const blockTime =
          isoFromBlockTime(block.finalTime) ?? isoFromBlockTime(block.startTime);
        const contentText = compactText(block.thinking);
        const eventId = eventIdFor(sessionId, seq, `${messageIndex}:${blockIndex}:thinking`);
        events.push({
          id: eventId,
          sequence: seq,
          ...(blockTime !== undefined ? { timestamp: blockTime } : {}),
          role: "thinking",
          kind: "reasoning",
          ...(contentText !== undefined ? { contentText } : {}),
          contentSource: block.thinking,
          rawReference: { sourcePath: url, line, nativeType: "thinking" },
        });
        seq += 1;
        continue;
      }

      const toolUseDecision = decodeOrDrop(AmpToolUseBlockSchema, rawBlock, {
        kind: "tool_use",
        diagnosticName: "amp.block.tool_use.decode_failed",
      });
      if (isSignal(toolUseDecision)) {
        const block = toolUseDecision.value;
        const blockTime =
          isoFromBlockTime(block.finalTime) ?? isoFromBlockTime(block.startTime);
        const eventId = eventIdFor(sessionId, seq, `${messageIndex}:${blockIndex}:tool_use`);
        const toolCallId = scopedId(sessionId, "tool", block.id);
        const input = projectToolPayloadNativeValue(block.input);
        const draft: AmpToolCallDraft = {
          id: toolCallId,
          eventId,
          toolName: block.name,
          status: "started",
          ...(input !== undefined ? { input } : {}),
          ...(blockTime !== undefined ? { startedAt: blockTime } : {}),
        };
        toolCallsById.set(block.id, draft);
        events.push({
          id: eventId,
          sequence: seq,
          ...(blockTime !== undefined ? { timestamp: blockTime } : {}),
          role: "assistant",
          kind: "tool_call",
          toolCallId,
          rawReference: { sourcePath: url, line, nativeType: "tool_use" },
        });
        seq += 1;
        continue;
      }

      const toolResultDecision = decodeOrDrop(AmpToolResultBlockSchema, rawBlock, {
        kind: "tool_result",
        diagnosticName: "amp.block.tool_result.decode_failed",
      });
      if (isSignal(toolResultDecision)) {
        const block = toolResultDecision.value;
        const blockTime =
          isoFromBlockTime(block.finalTime) ?? isoFromBlockTime(block.startTime);
        const eventId = eventIdFor(sessionId, seq, `${messageIndex}:${blockIndex}:tool_result`);
        const outputValue = toolResultOutput(block.run as Record<string, unknown> | undefined);
        const output = projectToolPayloadNativeValue(outputValue);
        const existing = toolCallsById.get(block.toolUseID);
        const toolCallId = existing?.id ?? scopedId(sessionId, "tool", block.toolUseID);
        const merged: AmpToolCallDraft = {
          id: toolCallId,
          eventId: existing?.eventId ?? eventId,
          toolName: existing?.toolName ?? "amp_tool",
          status: "completed",
          ...(existing?.input !== undefined ? { input: existing.input } : {}),
          ...(output !== undefined ? { output } : {}),
          ...(existing?.startedAt !== undefined ? { startedAt: existing.startedAt } : {}),
          ...(blockTime !== undefined ? { completedAt: blockTime } : {}),
        };
        toolCallsById.set(block.toolUseID, merged);
        events.push({
          id: eventId,
          sequence: seq,
          ...(blockTime !== undefined ? { timestamp: blockTime } : {}),
          role: "tool",
          kind: "tool_result",
          toolCallId,
          ...(typeof outputValue === "string"
            ? { contentText: compactText(outputValue) }
            : {}),
          rawReference: { sourcePath: url, line, nativeType: "tool_result" },
        });
        seq += 1;
        continue;
      }

      // Unknown / summary / image blocks: skip without aborting the thread.
    }
  }

  const projectPath = projectPathFrom(thread, exported);
  const gitRemote = gitRemoteFrom(exported, projectPath);
  const startedAt = isoFromEpochMs(exported.created) ?? events.find((event) => event.timestamp)?.timestamp;
  const title =
    (typeof thread.title === "string" && thread.title.length > 0
      ? thread.title
      : undefined)
    ?? (typeof exported.title === "string" && exported.title.length > 0
      ? exported.title
      : undefined);

  return buildSession({
    provider: "amp",
    agentName: "amp",
    machine,
    sessionId,
    nativeSessionId: thread.id,
    ...(projectPath !== undefined ? { nativeProjectKey: projectPath, projectPath } : {}),
    ...(gitRemote !== undefined ? { gitRemote } : {}),
    ...(title !== undefined ? { title } : {}),
    ...(startedAt !== undefined ? { startedAt } : {}),
    updatedAt: thread.updated,
    sourceRoot: SOURCE_ROOT,
    sourcePath: url,
    events,
    toolCalls: [...toolCallsById.values()],
  });
};

// ---------------------------------------------------------------------------
// Export with sequential rate-limit / backoff
// ---------------------------------------------------------------------------

const exportThread = async (
  runner: AmpRunner,
  threadId: string,
  sleep: (ms: number) => Promise<void>,
): Promise<AmpRunResult> => {
  for (let attempt = 0; attempt < MAX_EXPORT_ATTEMPTS; attempt += 1) {
    const result = runner(["threads", "export", threadId]);
    if (result.ok) return result;
    if (result.reason === "missing_binary") return result;
    if (attempt === MAX_EXPORT_ATTEMPTS - 1) return result;
    const delay = BASE_BACKOFF_MS * 2 ** attempt;
    await sleep(delay);
  }
  return { ok: false, reason: "command_failed", detail: "export retry exhausted" };
};

// ---------------------------------------------------------------------------
// Stream
// ---------------------------------------------------------------------------

async function* streamAmp(options: AmpStreamOptions): AsyncGenerator<AdapterStreamItem> {
  const runner = options.ampRunner ?? defaultAmpRunner;
  const sleep = options.ampSleep ?? defaultSleep;
  const exportSpacingMs = options.exportSpacingMs ?? DEFAULT_EXPORT_SPACING_MS;

  // Cheap reachability probe — missing CLI yields one diagnostic and returns.
  const probe = runner(["--version"]);
  if (!probe.ok && probe.reason === "missing_binary") {
    yield {
      type: "diagnostic",
      diagnostic: adapterDiagnostic(
        SOURCE_ROOT,
        "amp.cli.not_found",
        "Amp CLI was not found on PATH or at ~/.amp/bin/amp.",
        "no_data_found",
      ),
    };
    return;
  }

  yield {
    type: "sourceRoot",
    sourceRoot: sourceRoot("amp", ampAdapter.id, SOURCE_ROOT, options.machine, options.now),
  };

  const listDiagnostics: DecodeDiagnostic[] = [];
  const maxListPages = options.maxListPages ?? AMP_MAX_LIST_PAGES;
  const {
    threads,
    listFailed,
    earlyStop,
    orderAssumptionViolated,
    pageCapReached,
    pagesFetched,
  } = enumerateThreads(runner, options.highWatermark, listDiagnostics, maxListPages);
  for (const diagnostic of listDiagnostics) {
    yield { type: "diagnostic", diagnostic: schemaDiagnostic(SOURCE_ROOT, diagnostic) };
  }
  if (orderAssumptionViolated) {
    yield {
      type: "diagnostic",
      diagnostic: adapterDiagnostic(
        SOURCE_ROOT,
        "amp.list.order_not_descending",
        "Amp thread list page was not updated-descending; watermark early-stop disabled for this walk so later pages are still enumerated.",
        "unsupported",
      ),
    };
  }
  if (earlyStop) {
    yield {
      type: "diagnostic",
      diagnostic: adapterDiagnostic(
        SOURCE_ROOT,
        "amp.list.early_stop",
        "Amp thread list enumeration stopped after watermark cutoff (+1 guard page). Threads older than the window were not enumerated and never reach shouldParseSession. Use --force for a full walk.",
        "unsupported",
      ),
    };
  }
  if (pageCapReached) {
    yield {
      type: "diagnostic",
      diagnostic: adapterDiagnostic(
        SOURCE_ROOT,
        "amp.list.page_cap_reached",
        `Amp thread list enumeration hit the page cap (${pagesFetched} full pages × ${LIST_PAGE_SIZE}); walk is truncated, not complete. Raise maxListPages or use --force with a higher cap once the corpus is dogfooded.`,
        "unsupported",
      ),
    };
  }
  if (listFailed && threads.length === 0) {
    yield {
      type: "diagnostic",
      diagnostic: adapterDiagnostic(
        SOURCE_ROOT,
        "amp.list.failed",
        "Amp thread enumeration failed (CLI unavailable, auth failure, or unparseable output).",
        "error",
      ),
    };
    return;
  }

  const exportMemo = new Map<string, AmpExport | "failed">();
  let emitted = 0;
  let exportCount = 0;
  const limit = options.limit ?? Number.POSITIVE_INFINITY;

  for (const thread of threads) {
    if (emitted >= limit) break;

    const fingerprint = fingerprintForThread(thread);
    const fingerprintKey = JSON.stringify(fingerprint);
    const sessionId = sessionIdFor("amp", AmpSessionId(thread.id));

    if (
      options.shouldParseSession !== undefined
      && !(await options.shouldParseSession({
        sessionId,
        sourceFingerprint: fingerprintKey,
      }))
    ) {
      continue;
    }

    let exported: AmpExport | "failed" | undefined = exportMemo.get(fingerprintKey);
    if (exported === undefined) {
      if (exportCount > 0) await sleep(exportSpacingMs);
      exportCount += 1;
      const exportResult = await exportThread(runner, thread.id, sleep);
      if (!exportResult.ok) {
        exportMemo.set(fingerprintKey, "failed");
        yield {
          type: "diagnostic",
          diagnostic: adapterDiagnostic(
            SOURCE_ROOT,
            exportResult.reason === "rate_limited"
              ? "amp.export.rate_limited"
              : "amp.export.failed",
            `Amp thread export failed for thread ${thread.id}; continuing.`,
            "error",
          ),
        };
        continue;
      }
      const parsed = parseJson(exportResult.stdout);
      if (parsed === undefined) {
        exportMemo.set(fingerprintKey, "failed");
        yield {
          type: "diagnostic",
          diagnostic: adapterDiagnostic(
            SOURCE_ROOT,
            "amp.export.invalid_json",
            `Amp thread export returned unparseable JSON for thread ${thread.id}; continuing.`,
            "error",
          ),
        };
        continue;
      }
      const exportDiagnostics: DecodeDiagnostic[] = [];
      const decision = decodeOrDrop(AmpExportSchema, parsed, {
        kind: "export",
        diagnosticName: "amp.export.decode_failed",
        diagnostics: exportDiagnostics,
      });
      if (!isSignal(decision)) {
        exportMemo.set(fingerprintKey, "failed");
        for (const diagnostic of exportDiagnostics) {
          yield {
            type: "diagnostic",
            diagnostic: schemaDiagnostic(SOURCE_ROOT, diagnostic, thread.id),
          };
        }
        continue;
      }
      exported = decision.value;
      exportMemo.set(fingerprintKey, exported);
    }
    if (exported === "failed") continue;

    const session = buildAmpSession(thread, exported, options.machine, sessionId);
    yield {
      type: "session",
      session,
      sourceUnit: {
        provider: "amp",
        adapterId: ampAdapter.id,
        rootPath: SOURCE_ROOT,
        sourcePath: session.sourcePath,
        // physicalPath intentionally unset — sourcePath is a URL.
      },
      fingerprint,
    };
    emitted += 1;
  }

  yield {
    type: "diagnostic",
    diagnostic: adapterDiagnostic(
      SOURCE_ROOT,
      "amp.threads.available",
      `Discovered ${emitted} Amp thread(s).`,
      emitted > 0 ? "available" : "no_data_found",
    ),
  };
}

// ---------------------------------------------------------------------------
// Adapter export
// ---------------------------------------------------------------------------

export const ampAdapter: SessionAdapter = {
  id: "amp-threads-cli",
  provider: "amp",
  displayName: "Amp threads",
  stable: false,
  defaultRoot: () => SOURCE_ROOT,
  read: async (options) => collectAdapterStream(streamAmp(options as AmpStreamOptions)),
  stream: (options) => streamAmp(options as AmpStreamOptions),
};

/** Test/entry helper that accepts injectable runner options without casts. */
export const readAmp = (options: AmpStreamOptions) =>
  collectAdapterStream(streamAmp(options));
