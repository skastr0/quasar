import { execFile, type ExecFileOptions } from "node:child_process";
import { existsSync } from "node:fs";
import { promisify } from "node:util";

import { gitRemoteForPath } from "../core/git-identity";
import { stableJsonHash } from "../core/hash";
import { AmpSessionId, type SessionId } from "../core/identity";
import type {
  AdapterDiagnostic,
  ContentBlock,
  ExecutionContextRecord,
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
  projectSessionNativeValue,
  scopedId,
  sessionIdFor,
  sourceRoot,
  type NativeValue,
} from "./common";
import {
  AmpExportSchema,
  AmpImageBlockSchema,
  AmpSummaryBlockSchema,
  AmpTextBlockSchema,
  AmpThinkingBlockSchema,
  AmpThreadListEntrySchema,
  AmpToolResultBlockSchema,
  AmpToolUseBlockSchema,
  type AmpExport,
  type AmpUsage,
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
export const AMP_LIST_PAGE_STRIDE = AMP_LIST_PAGE_SIZE - 1;
const LIST_PAGE_SIZE = AMP_LIST_PAGE_SIZE;
/**
 * Hard cap on list pagination. Hitting it is a truncated walk — not a complete
 * corpus — and must emit `amp.list.page_cap_reached` (no silent truncation).
 * Exported so tests can assert the production default without re-deriving it.
 */
const DEFAULT_EXPORT_SPACING_MS = 3_000;
const MAX_EXPORT_ATTEMPTS = 5;
const MAX_LIST_ATTEMPTS = 3;
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
export type AmpRunner = (args: readonly string[]) => AmpRunResult | Promise<AmpRunResult>;

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

const execFileAsync = promisify(execFile);

const defaultAmpRunner: AmpRunner = async (args) => {
  const binary = resolveAmpBinary();
  if (binary === undefined) return { ok: false, reason: "missing_binary" };
  if (binary !== "amp" && !existsSync(binary)) {
    return { ok: false, reason: "missing_binary" };
  }
  try {
    const options: ExecFileOptions = {
      encoding: "utf8",
      timeout: 120_000,
      maxBuffer: 1024 * 1024 * 1024,
    };
    const { stdout } = await execFileAsync(binary, [...args], options);
    return { ok: true, stdout: typeof stdout === "string" ? stdout : stdout.toString("utf8") };
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
    "error",
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
const listArrayFrom = (value: unknown): readonly unknown[] | undefined => {
  if (Array.isArray(value)) return value;
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    const threads = (value as { readonly threads?: unknown }).threads;
    if (Array.isArray(threads)) return threads;
  }
  return undefined;
};

const parseUpdatedMs = (updated: string): number | undefined => {
  const time = Date.parse(updated);
  return Number.isFinite(time) ? time : undefined;
};

type EnumerateThreadsResult = {
  readonly threads: readonly AmpThreadListEntry[];
  readonly listFailed: boolean;
  /**
   * True when enumeration stopped because `maxListPages` was exhausted without a
   * short terminal page — a truncated walk, not a complete one.
   */
  readonly pageCapReached: boolean;
  /** Pages successfully fetched before exit (for the page-cap diagnostic message). */
  readonly pagesFetched: number;
};

/**
 * Paginate `amp threads list --json --limit 500`.
 *
 * Every run walks to a short terminal page. This is required so unchanged
 * older sessions still reach `shouldParseSession` after normalization changes.
 *
 * Exhausting `maxListPages` without a short page sets
 * `pageCapReached` so callers can emit a named truncation diagnostic.
 */
const enumerateThreads = async (
  runner: AmpRunner,
  diagnostics: DecodeDiagnostic[],
  maxListPages: number | undefined,
): Promise<EnumerateThreadsResult> => {
  const collected: AmpThreadListEntry[] = [];
  let pagesFetched = 0;
  /** True when the loop exited because a short (terminal) page was returned. */
  let sawShortPage = false;
  let previousPageLastIdentity: string | undefined;

  const fullPageSignatures = new Set<string>();
  for (let page = 0; maxListPages === undefined || page < maxListPages; page += 1) {
    const offset = page * AMP_LIST_PAGE_STRIDE;
    let parsed: unknown;
    let listSucceeded = false;
    for (let attempt = 0; attempt < MAX_LIST_ATTEMPTS; attempt += 1) {
      const result = await runner([
        "threads",
        "list",
        "--json",
        "--include-archived",
        "--limit",
        String(LIST_PAGE_SIZE),
        "--offset",
        String(offset),
      ]);
      if (result.ok) {
        parsed = parseJson(result.stdout);
        if (parsed !== undefined) {
          listSucceeded = true;
          break;
        }
      }
    }
    if (!listSucceeded) {
      diagnostics.push({
        name: "amp.list.failed",
        message: `Amp thread list page at offset ${offset} failed after ${MAX_LIST_ATTEMPTS} attempts.`,
      });
      return {
        threads: collected,
        listFailed: true,
        pageCapReached: false,
        pagesFetched,
      };
    }
    const rawEntries = listArrayFrom(parsed);
    if (rawEntries === undefined) {
      diagnostics.push({
        name: "amp.list.invalid_envelope",
        message: "Amp thread list must be an array or an object containing a threads array.",
      });
      return {
        threads: collected,
        listFailed: true,
        pageCapReached: false,
        pagesFetched,
      };
    }
    if (rawEntries.length === LIST_PAGE_SIZE) {
      const signature = stableJsonHash(rawEntries);
      if (fullPageSignatures.has(signature)) {
        diagnostics.push({ name: "amp.list.repeated_page", message: "Amp returned a repeated full list page; pagination offset is not advancing." });
        return { threads: collected, listFailed: true, pageCapReached: false, pagesFetched };
      }
      fullPageSignatures.add(signature);
    }
    const pageEntries: AmpThreadListEntry[] = [];
    for (const raw of rawEntries) {
      const decision = decodeOrDrop(AmpThreadListEntrySchema, raw, {
        kind: "thread",
        diagnosticName: "amp.list.entry.decode_failed",
        diagnostics,
      });
      if (isSignal(decision)) pageEntries.push(decision.value);
    }
    if (previousPageLastIdentity !== undefined) {
      const first = pageEntries[0];
      const firstIdentity = first === undefined ? undefined : stableJsonHash({
        id: first.id,
        updated: first.updated,
        title: first.title ?? null,
        tree: first.tree ?? null,
        messageCount: first.messageCount ?? null,
      });
      if (firstIdentity !== previousPageLastIdentity) {
        diagnostics.push({
          name: "amp.list.boundary_mismatch",
          message: `Amp list page at offset ${offset} does not overlap the prior page boundary.`,
        });
        return { threads: collected, listFailed: true, pageCapReached: false, pagesFetched };
      }
    }
    const last = pageEntries[pageEntries.length - 1];
    previousPageLastIdentity = last === undefined ? undefined : stableJsonHash({
      id: last.id,
      updated: last.updated,
      title: last.title ?? null,
      tree: last.tree ?? null,
      messageCount: last.messageCount ?? null,
    });
    collected.push(...pageEntries);
    pagesFetched += 1;

    if (rawEntries.length < LIST_PAGE_SIZE) {
      sawShortPage = true;
      break;
    }
  }

  // Cap hit = walked maxListPages full pages without a short terminal page.
  // Distinguishable from a complete walk so callers can surface
  // truncation (no silent partial corpus).
  const pageCapReached = maxListPages !== undefined && !sawShortPage && pagesFetched >= maxListPages;

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
  readonly nativeEventId?: string;
  readonly sequence: number;
  readonly timestamp?: string;
  readonly role: SessionRole;
  readonly kind: SessionEventKind;
  readonly contentText?: string;
  readonly contentSource?: NativeValue;
  readonly contentBlocks?: readonly ContentBlock[];
  readonly toolCallId?: string;
  readonly rawReference: {
    readonly sourcePath: string;
    readonly line: number;
    readonly nativeType: string;
  };
};

type AmpUsageDraft = Omit<
  import("../core/schemas").UsageRecord,
  "sessionId" | "machineId" | "provider" | "agentName" | "projectIdentityKey"
>;

type AmpArtifactDraft = Omit<
  import("../core/schemas").Artifact,
  "sessionId" | "machineId" | "provider" | "agentName" | "projectIdentityKey"
>;

type AmpExecutionContextDraft = Omit<
  ExecutionContextRecord,
  "sessionId" | "machineId" | "provider" | "agentName" | "projectIdentityKey"
>;

const nonNegativeInteger = (value: number | undefined): number | undefined =>
  value !== undefined && Number.isInteger(value) && value >= 0 ? value : undefined;

const usageDraftFrom = (
  usage: AmpUsage,
  sessionId: SessionId,
  messageIndex: number,
  eventId: string | undefined,
): AmpUsageDraft | undefined => {
  const inputTokens = nonNegativeInteger(usage.inputTokens);
  const outputTokens = nonNegativeInteger(usage.outputTokens);
  const cacheReadInputTokens = nonNegativeInteger(usage.cacheReadInputTokens);
  const cacheCreationInputTokens = nonNegativeInteger(usage.cacheCreationInputTokens);
  const timestamp = isoFromBlockTime(usage.timestamp);
  if (
    usage.model === undefined
    && inputTokens === undefined
    && outputTokens === undefined
    && cacheReadInputTokens === undefined
    && cacheCreationInputTokens === undefined
    && timestamp === undefined
  ) return undefined;
  return {
    id: scopedId(sessionId, "usage", String(messageIndex)),
    ...(eventId !== undefined ? { eventId } : {}),
    ...(timestamp !== undefined ? { timestamp } : {}),
    ...(usage.model !== undefined ? { model: usage.model } : {}),
    ...(inputTokens !== undefined ? { inputTokens } : {}),
    ...(outputTokens !== undefined ? { outputTokens } : {}),
    ...(cacheReadInputTokens !== undefined ? { cacheReadInputTokens } : {}),
    ...(cacheCreationInputTokens !== undefined ? { cacheCreationInputTokens } : {}),
  };
};

const summaryText = (summary: string | { readonly summary: string }): string =>
  typeof summary === "string" ? summary : summary.summary;

const messageRole = (role: string): SessionRole => {
  if (role === "user") return "user";
  if (role === "assistant") return "assistant";
  return "system";
};

const nativeMessageIdentity = (message: AmpExport["messages"][number], messageIndex: number): string => {
  if (typeof message.protocolMessageID === "string" && message.protocolMessageID.length > 0) return message.protocolMessageID;
  if (typeof message.messageId === "number" && Number.isFinite(message.messageId)) return String(message.messageId);
  return `message:${messageIndex}`;
};

const nonEmptyString = (value: unknown): string | undefined =>
  typeof value === "string" && value.length > 0 ? value : undefined;

const sourceMetadataFor = (
  message: AmpExport["messages"][number],
  blockFacts: Readonly<Record<string, unknown>> = {},
): NativeValue | undefined => {
  const openAIResponsePhase = nonEmptyString(message.meta?.openAIResponsePhase);
  const stateType = nonEmptyString(message.state?.type);
  const stopReason = nonEmptyString(message.state?.stopReason);
  const hasBlockFacts = Object.values(blockFacts).some((value) => value !== undefined);
  if (!hasBlockFacts && openAIResponsePhase === undefined && stateType === undefined && stopReason === undefined) {
    return undefined;
  }
  return projectToolPayloadNativeValue({
    ...blockFacts,
    ...(openAIResponsePhase !== undefined ? { openAIResponsePhase } : {}),
    ...(stateType !== undefined || stopReason !== undefined
      ? {
          state: {
            ...(stateType !== undefined ? { type: stateType } : {}),
            ...(stopReason !== undefined ? { stopReason } : {}),
          },
        }
      : {}),
  });
};

const metadataContentBlock = (
  sessionId: SessionId,
  nativeEventId: string,
  metadata: NativeValue | undefined,
): readonly ContentBlock[] | undefined =>
  metadata === undefined
    ? undefined
    : [{
        id: scopedId(sessionId, "content", nativeEventId),
        sequence: 0,
        kind: "json",
        metadata,
      }];

const toolCallStatusFromRun = (run: Record<string, unknown> | undefined): string | undefined => {
  if (run === undefined) return undefined;
  const status = run.status;
  if (typeof status !== "string") return undefined;
  const trimmed = status.trim();
  return trimmed.length === 0 ? undefined : trimmed;
};

const buildAmpSession = (
  thread: AmpThreadListEntry,
  exported: AmpExport,
  machine: AdapterDiscoverOptions["machine"],
  sessionId: SessionId,
  diagnostics: DecodeDiagnostic[],
) => {
  const url = threadUrl(thread.id);
  const messages = exported.messages;
  const events: AmpEventDraft[] = [];
  const toolCallsById = new Map<string, AmpToolCallDraft>();
  const usageRecords: AmpUsageDraft[] = [];
  const artifacts: AmpArtifactDraft[] = [];
  const executionContexts: AmpExecutionContextDraft[] = [];
  let hasFatalBlockError = false;
  let seq = 0;

  for (let messageIndex = 0; messageIndex < messages.length; messageIndex += 1) {
    const message = messages[messageIndex]!;
    const role = messageRole(message.role);
    const blocks = message.content;
    const userTimestamp = isoFromEpochMs(message.meta?.sentAt);
    // RawReference.line is PositiveInteger (1-based).
    const line = messageIndex + 1;
    const firstEventAtMessage = events.length;
    const messageIdentity = nativeMessageIdentity(message, messageIndex);

    for (let blockIndex = 0; blockIndex < blocks.length; blockIndex += 1) {
      const rawBlock = blocks[blockIndex];
      const blockType =
        rawBlock !== null && typeof rawBlock === "object" && !Array.isArray(rawBlock)
          ? (rawBlock as { readonly type?: unknown }).type
          : undefined;
      if (
        blockType !== "text"
        && blockType !== "thinking"
        && blockType !== "tool_use"
        && blockType !== "tool_result"
        && blockType !== "summary"
        && blockType !== "image"
      ) {
        diagnostics.push({
          name: "amp.block.unknown",
          message: `Amp content block at message ${line} has an unsupported type.`,
        });
        hasFatalBlockError = true;
        continue;
      }
      const textDecision = blockType === "text"
        ? decodeOrDrop(AmpTextBlockSchema, rawBlock, {
            kind: "text",
            diagnosticName: "amp.block.text.decode_failed",
            diagnostics,
          })
        : undefined;
      if (textDecision !== undefined && isSignal(textDecision)) {
        const block = textDecision.value;
        const blockTime =
          role === "user"
            ? userTimestamp
            : isoFromBlockTime(block.finalTime) ?? isoFromBlockTime(block.startTime);
        const contentText = compactText(block.text);
        const nativeEventId = `${messageIdentity}:${blockIndex}`;
        const eventId = eventIdFor(sessionId, seq, nativeEventId);
        const metadata = sourceMetadataFor(message, {
          startTime: block.startTime,
          finalTime: block.finalTime,
          blockState: block.blockState,
        });
        events.push({
          id: eventId,
          nativeEventId,
          sequence: seq,
          ...(blockTime !== undefined ? { timestamp: blockTime } : {}),
          role,
          kind: "message",
          ...(contentText !== undefined ? { contentText } : {}),
          contentBlocks: [{
            id: scopedId(sessionId, "content", nativeEventId),
            sequence: 0,
            kind: "text",
            text: block.text,
            ...(metadata !== undefined ? { metadata } : {}),
          }],
          rawReference: { sourcePath: url, line, nativeType: "text" },
        });
        seq += 1;
        continue;
      }
      if (blockType === "text") {
        hasFatalBlockError = true;
        continue;
      }

      const thinkingDecision = blockType === "thinking"
        ? decodeOrDrop(AmpThinkingBlockSchema, rawBlock, {
            kind: "thinking",
            diagnosticName: "amp.block.thinking.decode_failed",
            diagnostics,
          })
        : undefined;
      if (thinkingDecision !== undefined && isSignal(thinkingDecision)) {
        const block = thinkingDecision.value;
        const blockTime =
          isoFromBlockTime(block.finalTime) ?? isoFromBlockTime(block.startTime);
        const contentText = compactText(block.thinking);
        const nativeEventId = `${messageIdentity}:${blockIndex}`;
        const eventId = eventIdFor(sessionId, seq, nativeEventId);
        const metadata = sourceMetadataFor(message, {
          startTime: block.startTime,
          finalTime: block.finalTime,
          provider: block.provider,
          blockState: block.blockState,
        });
        events.push({
          id: eventId,
          nativeEventId,
          sequence: seq,
          ...(blockTime !== undefined ? { timestamp: blockTime } : {}),
          role: "thinking",
          kind: "reasoning",
          ...(contentText !== undefined ? { contentText } : {}),
          contentBlocks: [{
            id: scopedId(sessionId, "content", nativeEventId),
            sequence: 0,
            kind: "thinking",
            thinking: block.thinking,
            ...(metadata !== undefined ? { metadata } : {}),
          }],
          rawReference: { sourcePath: url, line, nativeType: "thinking" },
        });
        seq += 1;
        continue;
      }
      if (blockType === "thinking") {
        hasFatalBlockError = true;
        continue;
      }

      const toolUseDecision = blockType === "tool_use"
        ? decodeOrDrop(AmpToolUseBlockSchema, rawBlock, {
            kind: "tool_use",
            diagnosticName: "amp.block.tool_use.decode_failed",
            diagnostics,
          })
        : undefined;
      if (toolUseDecision !== undefined && isSignal(toolUseDecision)) {
        const block = toolUseDecision.value;
        const blockTime =
          isoFromBlockTime(block.finalTime) ?? isoFromBlockTime(block.startTime);
        const nativeEventId = `${messageIdentity}:${blockIndex}`;
        const eventId = eventIdFor(sessionId, seq, nativeEventId);
        const toolCallId = scopedId(sessionId, "tool", block.id);
        const input = projectToolPayloadNativeValue(block.input);
        const startTime = isoFromBlockTime(block.startTime);
        const metadata = sourceMetadataFor(message, {
          startTime: block.startTime,
          finalTime: block.finalTime,
          complete: block.complete,
          blockState: block.blockState,
          providerToolUseId: block.providerToolUseId,
        });
        const contentBlocks = metadataContentBlock(sessionId, nativeEventId, metadata);
        const draft: AmpToolCallDraft = {
          id: toolCallId,
          eventId,
          toolName: block.name,
          status: "started",
          ...(input !== undefined ? { input } : {}),
          ...((startTime ?? blockTime) !== undefined ? { startedAt: startTime ?? blockTime } : {}),
        };
        toolCallsById.set(block.id, draft);
        events.push({
          id: eventId,
          nativeEventId,
          sequence: seq,
          ...(blockTime !== undefined ? { timestamp: blockTime } : {}),
          role: "assistant",
          kind: "tool_call",
          toolCallId,
          ...(contentBlocks !== undefined ? { contentBlocks } : {}),
          rawReference: { sourcePath: url, line, nativeType: "tool_use" },
        });
        seq += 1;
        continue;
      }
      if (blockType === "tool_use") {
        hasFatalBlockError = true;
        continue;
      }

      const toolResultDecision = blockType === "tool_result"
        ? decodeOrDrop(AmpToolResultBlockSchema, rawBlock, {
            kind: "tool_result",
            diagnosticName: "amp.block.tool_result.decode_failed",
            diagnostics,
          })
        : undefined;
      if (toolResultDecision !== undefined && isSignal(toolResultDecision)) {
        const block = toolResultDecision.value;
        const blockTime =
          isoFromBlockTime(block.finalTime) ?? isoFromBlockTime(block.startTime);
        const nativeEventId = `${messageIdentity}:${blockIndex}`;
        const eventId = eventIdFor(sessionId, seq, nativeEventId);
        const outputValue = toolResultOutput(block.run as Record<string, unknown> | undefined);
        const output = projectToolPayloadNativeValue(block.run);
        const runStatus = toolCallStatusFromRun(block.run as Record<string, unknown> | undefined);
        const finalTime = isoFromBlockTime(block.finalTime);
        const metadata = sourceMetadataFor(message, {
          startTime: block.startTime,
          finalTime: block.finalTime,
          blockState: block.blockState,
        });
        const contentBlocks = metadataContentBlock(sessionId, nativeEventId, metadata);
        const existing = toolCallsById.get(block.toolUseID);
        const toolCallId = existing?.id ?? scopedId(sessionId, "tool", block.toolUseID);
        const merged: AmpToolCallDraft = {
          id: toolCallId,
          eventId: existing?.eventId ?? eventId,
          toolName: existing?.toolName ?? "amp_tool",
          status: runStatus ?? "completed",
          ...(existing?.input !== undefined ? { input: existing.input } : {}),
          ...(output !== undefined ? { output } : {}),
          ...(existing?.startedAt !== undefined ? { startedAt: existing.startedAt } : {}),
          ...((finalTime ?? blockTime) !== undefined ? { completedAt: finalTime ?? blockTime } : {}),
        };
        toolCallsById.set(block.toolUseID, merged);
        events.push({
          id: eventId,
          nativeEventId,
          sequence: seq,
          ...(blockTime !== undefined ? { timestamp: blockTime } : {}),
          role: "tool",
          kind: "tool_result",
          toolCallId,
          ...(typeof outputValue === "string"
            ? { contentText: compactText(outputValue) }
            : {}),
          ...(contentBlocks !== undefined ? { contentBlocks } : {}),
          rawReference: { sourcePath: url, line, nativeType: "tool_result" },
        });
        seq += 1;
        continue;
      }
      if (blockType === "tool_result") {
        hasFatalBlockError = true;
        continue;
      }

      const summaryDecision = blockType === "summary"
        ? decodeOrDrop(AmpSummaryBlockSchema, rawBlock, {
            kind: "summary",
            diagnosticName: "amp.block.summary.decode_failed",
            diagnostics,
          })
        : undefined;
      if (summaryDecision !== undefined && isSignal(summaryDecision)) {
        const nativeEventId = `${messageIdentity}:${blockIndex}`;
        const eventId = eventIdFor(sessionId, seq, nativeEventId);
        const text = summaryText(summaryDecision.value.summary);
        const metadata = sourceMetadataFor(message);
        events.push({
          id: eventId,
          nativeEventId,
          sequence: seq,
          role: "assistant",
          kind: "summary",
          ...(compactText(text) !== undefined
            ? { contentText: compactText(text) }
            : {}),
          contentBlocks: [{
            id: scopedId(sessionId, "content", nativeEventId),
            sequence: 0,
            kind: "text",
            text,
            ...(metadata !== undefined ? { metadata } : {}),
          }],
          rawReference: { sourcePath: url, line, nativeType: "summary" },
        });
        seq += 1;
        continue;
      }
      if (blockType === "summary") {
        hasFatalBlockError = true;
        continue;
      }

      const imageDecision = blockType === "image"
        ? decodeOrDrop(AmpImageBlockSchema, rawBlock, {
            kind: "image",
            diagnosticName: "amp.block.image.decode_failed",
            diagnostics,
          })
        : undefined;
      if (imageDecision !== undefined && isSignal(imageDecision)) {
        const sourceRef = projectSessionNativeValue({
          source: imageDecision.value.source,
          sourcePath: imageDecision.value.sourcePath,
        });
        if (sourceRef !== undefined) {
          const nativeEventId = `${messageIdentity}:${blockIndex}`;
          const eventId = eventIdFor(sessionId, seq, nativeEventId);
          const imageTimestamp = role === "user" ? userTimestamp : undefined;
          const source = imageDecision.value.source;
          const uri =
            source !== null && typeof source === "object" && !Array.isArray(source)
            && typeof (source as { readonly url?: unknown }).url === "string"
              ? (source as { readonly url: string }).url
              : undefined;
          events.push({
            id: eventId,
            nativeEventId,
            sequence: seq,
            ...(imageTimestamp !== undefined ? { timestamp: imageTimestamp } : {}),
            role,
            kind: "message",
            contentBlocks: [{
              id: scopedId(sessionId, "content", `${messageIndex}:${blockIndex}`),
              sequence: blockIndex,
              kind: "image",
              ...(imageDecision.value.sourcePath !== undefined ? { path: imageDecision.value.sourcePath } : {}),
              ...(uri !== undefined ? { uri } : {}),
              metadata: sourceRef,
            }],
            rawReference: { sourcePath: url, line, nativeType: "image" },
          });
          artifacts.push({
            id: scopedId(sessionId, "artifact", `${messageIndex}:${blockIndex}`),
            kind: "image",
            eventId,
            sourcePath: url,
            sourceRef,
          });
          seq += 1;
        } else {
          hasFatalBlockError = true;
        }
        continue;
      }
      hasFatalBlockError = true;
    }
    const usage = message.usage;
    if (usage !== undefined) {
      const usageDraft = usageDraftFrom(usage, sessionId, messageIndex, events[firstEventAtMessage]?.id);
      if (usageDraft !== undefined) usageRecords.push(usageDraft);
      const maxInputTokens = nonNegativeInteger(usage.maxInputTokens);
      const totalInputTokens = nonNegativeInteger(usage.totalInputTokens);
      if (maxInputTokens !== undefined || totalInputTokens !== undefined) {
        artifacts.push({
          id: scopedId(sessionId, "usage-metadata", String(messageIndex)),
          kind: "usage_metadata",
          ...(events[firstEventAtMessage] !== undefined ? { eventId: events[firstEventAtMessage]!.id } : {}),
          sourceRef: {
            ...(maxInputTokens !== undefined ? { maxInputTokens } : {}),
            ...(totalInputTokens !== undefined ? { totalInputTokens } : {}),
          },
        });
      }
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
  const reasoningEffort = nonEmptyString(exported.reasoningEffort);
  if (reasoningEffort !== undefined) {
    executionContexts.push({
      id: scopedId(sessionId, "context", "session"),
      sequence: 0,
      scope: "session",
      ...(startedAt !== undefined ? { timestamp: startedAt } : {}),
      reasoningEffort,
    });
  }
  const metaAgentMode = nonEmptyString(exported.meta?.agentMode);
  const hasConfiguration =
    exported.agentMode !== undefined
    || metaAgentMode !== undefined
    || exported.activatedSkills !== undefined
    || exported.archived !== undefined;
  const configuration = hasConfiguration
    ? projectToolPayloadNativeValue({
        agentMode: exported.agentMode,
        metaAgentMode,
        activatedSkills: exported.activatedSkills,
        archived: exported.archived,
      })
    : undefined;
  if (configuration !== undefined) {
    artifacts.push({
      id: scopedId(sessionId, "artifact", "amp-session-configuration"),
      kind: "amp_session_configuration",
      sourcePath: url,
      sourceRef: configuration,
    });
  }

  const session = buildSession({
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
    usageRecords,
    artifacts,
    executionContexts,
  });
  return hasFatalBlockError ? undefined : session;
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
    const result = await runner(["threads", "export", threadId]);
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
  const probe = await runner(["--version"]);
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
  const maxListPages = options.maxListPages;
  const {
    threads,
    listFailed,
    pageCapReached,
    pagesFetched,
  } = await enumerateThreads(runner, listDiagnostics, maxListPages);
  for (const diagnostic of listDiagnostics) {
    yield { type: "diagnostic", diagnostic: schemaDiagnostic(SOURCE_ROOT, diagnostic) };
  }
  if (pageCapReached) {
    yield {
      type: "diagnostic",
      diagnostic: adapterDiagnostic(
        SOURCE_ROOT,
        "amp.list.page_cap_reached",
        `Amp thread list enumeration hit the page cap (${pagesFetched} full pages × ${LIST_PAGE_SIZE}); walk is truncated, not complete. Raise maxListPages or use --force with a higher cap once the corpus is dogfooded.`,
        "error",
      ),
    };
    return;
  }
  if (listFailed) {
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

    let exported: AmpExport | "failed" | undefined;
    if (exported === undefined) {
      if (exportCount > 0) await sleep(exportSpacingMs);
      exportCount += 1;
      const exportResult = await exportThread(runner, thread.id, sleep);
      if (!exportResult.ok) {
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
        for (const diagnostic of exportDiagnostics) {
          yield {
            type: "diagnostic",
            diagnostic: schemaDiagnostic(SOURCE_ROOT, diagnostic, thread.id),
          };
        }
        continue;
      }
      exported = decision.value;
      if (exported.id !== thread.id) {
        yield {
          type: "diagnostic",
          diagnostic: adapterDiagnostic(
            SOURCE_ROOT,
            "amp.export.id_mismatch",
            `Amp thread export id did not match requested thread ${thread.id}.`,
            "error",
          ),
        };
        continue;
      }
    }
    if (exported === "failed") continue;

    const mappingDiagnostics: DecodeDiagnostic[] = [];
    const session = buildAmpSession(thread, exported, options.machine, sessionId, mappingDiagnostics);
    for (const diagnostic of mappingDiagnostics) {
      yield { type: "diagnostic", diagnostic: schemaDiagnostic(SOURCE_ROOT, diagnostic, thread.id) };
    }
    if (session === undefined) continue;
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
