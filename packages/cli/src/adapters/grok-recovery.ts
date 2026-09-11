import { existsSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";

import { readJsonFile } from "./common";
import {
  decodeGrokArchiveCompactionCheckpoint,
  decodeGrokArchiveCompactionRequest,
  decodeGrokArchiveRecapRequest,
} from "./grok-schema";
import {
  grokEntryStructuralKey,
  grokInjectedKind,
  grokSyntheticInstructionKind,
} from "./grok-text";
import type { DecodeDiagnostic } from "./harness-schema";

/**
 * Targeted Grok history recovery from compaction/recap archive inputs.
 *
 * Grok rewrites `chat_history.jsonl` when it compacts: older authored turns are
 * replaced by a continuation summary, so a plain replay of the live file loses
 * the pre-compaction product text. The harness retains those turns in three
 * archive surfaces:
 *
 *   compaction_requests/<id>.json    pre-compaction `chat_history` (plus a
 *                                    trailing synthetic summarization instruction)
 *   recap_requests/<id>.json         pre-recap `chat_history` (plus a trailing
 *                                    synthetic recap instruction)
 *   compaction_checkpoints/<id>.json post-compaction `compacted_history`
 *
 * Recovery stays deliberately bounded and conservative:
 *
 *   1. A request is only usable when its final instruction validates against a
 *      documented synthetic marker. A non-matching final line is authored text.
 *   2. Archives are aligned to the live chat by COMPLETE STRUCTURAL PREFIX
 *      equality over extracted turn text (never global text dedup), so
 *      cumulative snapshots keep the maximal history once and identical turns
 *      at different positions remain distinct.
 *   3. Recovery is applied ONLY when an archive history longer than the live
 *      chat anchors into the live chat's leading bootstrap region (the
 *      compaction junction). Otherwise the live chat is retained unchanged and
 *      a named diagnostic records that the archive branch was not resolved.
 *   4. Checkpoint continuation summaries are preserved once as provider
 *      context with provenance; they are never projected as authored turns.
 *
 * No normalization bump and no corpus replay are implied: the fingerprint only
 * changes for sessions whose archive inputs actually changed.
 */

/** One chat entry plus the on-disk location it was read from. */
export type GrokChatSource = {
  readonly value: unknown;
  readonly sourcePath: string;
  /** 1-based position in its source array (JSONL line number or history index). */
  readonly line: number;
  /** `chat_history` | `compaction_request` | `recap_request` | `compaction_checkpoint`. */
  readonly nativeType: string;
  /** History creation timestamp; empty for the live chat stream. */
  readonly createdAt: string;
  /** True when this entry was recovered from an archive input, not the live chat. */
  readonly archive: boolean;
};

export type GrokArchiveHistoryKind =
  | "compaction_request"
  | "recap_request"
  | "compaction_checkpoint";

export type GrokArchiveHistory = {
  readonly kind: GrokArchiveHistoryKind;
  readonly sourcePath: string;
  readonly createdAt: string;
  readonly entries: readonly GrokChatSource[];
  /** True when a validated synthetic instruction was excluded from the tail. */
  readonly syntheticTailExcluded: boolean;
  readonly checkpointId?: string;
  readonly promptIndexAtCompaction?: number;
};

export type GrokRecoveryPlan = {
  /** Chat entries the projection must consume, in order. */
  readonly sources: readonly GrokChatSource[];
  /** Provider context to preserve with provenance (never projected as turns). */
  readonly contextSources: readonly GrokChatSource[];
  readonly recovered: boolean;
  readonly selectedSourcePath?: string;
  readonly anchorIndex?: number;
  /**
   * Set when current source metadata PROVES the live chat cannot faithfully
   * replace the stored session (compaction archives missing or unresolvable).
   * The caller must fail the session closed with this code instead of emitting
   * a shorter replacement. `undefined` means the plan is safe to project.
   */
  readonly block?: { readonly code: string; readonly message: string };
  readonly diagnostics: readonly DecodeDiagnostic[];
};

/** Named diagnostic: live metadata proves missing/unrecoverable compaction history. */
export const GROK_RECOVERY_ARCHIVE_INCOMPLETE = "grok.recovery.archive_incomplete";
/** Named diagnostic: compaction evidence exists but no pre-compaction branch anchored. */
export const GROK_RECOVERY_COMPACTION_UNRESOLVED = "grok.recovery.compaction_unresolved";

export type GrokRecoveryVerification = {
  readonly total: number;
  readonly resolved: number;
  readonly unresolved: readonly string[];
};

const ARCHIVE_DIRS = [
  ["compaction_requests", "compaction_request"],
  ["recap_requests", "recap_request"],
  ["compaction_checkpoints", "compaction_checkpoint"],
] as const;

/**
 * Deterministic absolute paths of every archive input the adapter reads for a
 * session. The fingerprint and the stat read gate MUST cover these files, or an
 * archive change without a `chat_history.jsonl` change would be skipped.
 */
export const grokArchiveInputPaths = (sessionDir: string): string[] => {
  const paths: string[] = [];
  for (const [dir] of ARCHIVE_DIRS) {
    const full = join(sessionDir, dir);
    if (!existsSync(full)) continue;
    let names: string[];
    try {
      names = readdirSync(full).filter((name) => name.endsWith(".json")).sort();
    } catch {
      continue;
    }
    for (const name of names) paths.push(join(full, name));
  }
  return paths;
};

const entriesFromHistory = (
  values: readonly unknown[],
  sourcePath: string,
  nativeType: string,
  createdAt: string,
): { entries: GrokChatSource[]; syntheticTailExcluded: boolean } => {
  const sources = values.map((value, index) => ({
    value,
    sourcePath,
    line: index + 1,
    nativeType,
    createdAt,
    archive: true,
  }));
  const last = sources[sources.length - 1];
  if (last !== undefined && grokSyntheticInstructionKind(last.value) !== undefined) {
    return { entries: sources.slice(0, -1), syntheticTailExcluded: true };
  }
  return { entries: sources, syntheticTailExcluded: false };
};

/**
 * Read every archive history for one session. Malformed envelopes are dropped
 * fail-closed with a named diagnostic; readable siblings still yield. Ordering
 * is chronological (`created_at`), source path as a stable tiebreak.
 */
export const readGrokArchiveHistories = (
  sessionDir: string,
  diagnostics?: DecodeDiagnostic[],
): GrokArchiveHistory[] => {
  const histories: GrokArchiveHistory[] = [];
  for (const [dir, nativeType] of ARCHIVE_DIRS) {
    const full = join(sessionDir, dir);
    if (!existsSync(full)) continue;
    let names: string[];
    try {
      names = readdirSync(full).filter((name) => name.endsWith(".json")).sort();
    } catch {
      continue;
    }
    for (const name of names) {
      const sourcePath = join(full, name);
      const raw = readJsonFile(sourcePath, {
        diagnosticName: "grok.archive",
        ...(diagnostics !== undefined ? { diagnostics } : {}),
        sourcePath,
      });
      if (raw === undefined) continue;
      if (nativeType === "compaction_request") {
        const request = decodeGrokArchiveCompactionRequest(raw, diagnostics);
        if (request === undefined) continue;
        const { entries, syntheticTailExcluded } = entriesFromHistory(
          request.chat_history,
          sourcePath,
          nativeType,
          request.created_at,
        );
        histories.push({
          kind: nativeType,
          sourcePath,
          createdAt: request.created_at,
          entries,
          syntheticTailExcluded,
        });
      } else if (nativeType === "recap_request") {
        const request = decodeGrokArchiveRecapRequest(raw, diagnostics);
        if (request === undefined) continue;
        const { entries, syntheticTailExcluded } = entriesFromHistory(
          request.chat_history,
          sourcePath,
          nativeType,
          request.created_at,
        );
        histories.push({
          kind: nativeType,
          sourcePath,
          createdAt: request.created_at,
          entries,
          syntheticTailExcluded,
        });
      } else {
        const checkpoint = decodeGrokArchiveCompactionCheckpoint(raw, diagnostics);
        if (checkpoint === undefined) continue;
        const { entries, syntheticTailExcluded } = entriesFromHistory(
          checkpoint.compacted_history,
          sourcePath,
          nativeType,
          checkpoint.created_at,
        );
        histories.push({
          kind: nativeType,
          sourcePath,
          createdAt: checkpoint.created_at,
          entries,
          syntheticTailExcluded,
          checkpointId: checkpoint.checkpoint_id,
          ...(checkpoint.prompt_index_at_compaction !== undefined
            ? { promptIndexAtCompaction: checkpoint.prompt_index_at_compaction }
            : {}),
        });
      }
    }
  }
  histories.sort(
    (left, right) =>
      left.createdAt.localeCompare(right.createdAt) || left.sourcePath.localeCompare(right.sourcePath),
  );
  return histories;
};

/** Complete structural prefix equality over extracted turn keys. */
const isCompletePrefix = (
  prefix: readonly string[],
  full: readonly string[],
): boolean => {
  if (prefix.length > full.length) return false;
  for (let index = 0; index < prefix.length; index += 1) {
    if (prefix[index] !== full[index]) return false;
  }
  return true;
};

/**
 * A live-chat compaction junction: the archive history's TAIL equals a block in
 * the live chat's LEADING bootstrap region. The live chat then restarts from a
 * compacted context and everything after the anchor is new epoch content.
 */
const findBootstrapAnchor = (
  historyKeys: readonly string[],
  currentKeys: readonly string[],
  maxBootstrapAnchor: number,
): { anchor: number; overlap: number } | undefined => {
  let best: { anchor: number; overlap: number } | undefined;
  for (let anchor = 0; anchor <= maxBootstrapAnchor && anchor < currentKeys.length; anchor += 1) {
    let overlap = 0;
    while (
      overlap < historyKeys.length
      && anchor + overlap < currentKeys.length
      && historyKeys[historyKeys.length - 1 - overlap] === currentKeys[anchor + overlap]
    ) {
      overlap += 1;
    }
    if (overlap === 0 || anchor + overlap > maxBootstrapAnchor) continue;
    if (best === undefined || overlap > best.overlap) best = { anchor, overlap };
  }
  return best;
};

const stripLeadingInjected = (
  entries: readonly GrokChatSource[],
): readonly GrokChatSource[] => {
  let start = 0;
  while (start < entries.length && grokInjectedKind(entries[start]!.value) !== undefined) {
    start += 1;
  }
  return entries.slice(start);
};

/**
 * Continuation summaries are the one injected artifact whose prose is unique
 * per compaction epoch. Preserve each distinct one once, with provenance,
 * instead of collapsing it into a duplicate authored turn.
 */
const collectContextSources = (
  histories: readonly GrokArchiveHistory[],
  current: readonly GrokChatSource[],
  retainedKeys: ReadonlySet<string>,
): GrokChatSource[] => {
  const seen = new Set<string>();
  const collected: GrokChatSource[] = [];
  const push = (source: GrokChatSource) => {
    if (grokInjectedKind(source.value) !== "continuation_summary") return;
    const key = grokEntryStructuralKey(source.value);
    if (seen.has(key) || retainedKeys.has(key)) return;
    seen.add(key);
    collected.push(source);
  };
  for (const history of histories) for (const source of history.entries) push(source);
  for (const source of current) push(source);
  return collected;
};

/**
 * Project the live chat as the post-compaction epoch only. Archives are
 * ignored and no replacement block is raised. Used by the store-prefix merge
 * path so a held session can still expose source-only newer turns without
 * overwriting the canonical pre-compaction rows.
 */
export const planGrokLiveEpoch = (
  current: readonly GrokChatSource[],
): GrokRecoveryPlan => ({
  sources: current,
  contextSources: [],
  recovered: false,
  diagnostics: [],
});

/**
 * Plan the chat entries the projection must consume. Returns the live chat
 * unchanged unless a longer archive history anchors at the compaction junction.
 *
 * `compactionCheckpointUpdates` is the decoded count of `compaction_checkpoint`
 * updates in the live `updates.jsonl` (metadata, not a message-count ratio).
 * When it exceeds the retained checkpoint archives, compaction history is
 * provably missing and the session is blocked from replacement.
 */
export const planGrokHistoryRecovery = (
  current: readonly GrokChatSource[],
  histories: readonly GrokArchiveHistory[],
  options?: { readonly compactionCheckpointUpdates?: number },
): GrokRecoveryPlan => {
  const currentKeys = current.map((source) => grokEntryStructuralKey(source.value));
  const retainedKeys = new Set(currentKeys);
  if (histories.length === 0) {
    return { sources: current, contextSources: [], recovered: false, diagnostics: [] };
  }
  const retainedCheckpoints = histories.filter(
    (history) => history.kind === "compaction_checkpoint",
  ).length;
  const observedCheckpoints = options?.compactionCheckpointUpdates ?? 0;
  const compactionEvidence =
    observedCheckpoints > 0
    || histories.some(
      (history) =>
        history.kind === "compaction_checkpoint" || history.kind === "compaction_request",
    );
  if (observedCheckpoints > retainedCheckpoints) {
    const message =
      `Grok session compaction history is incomplete: ${observedCheckpoints} compaction_checkpoint `
      + `update(s) observed but only ${retainedCheckpoints} checkpoint archive(s) retained. `
      + `The stored session was left unchanged.`;
    return {
      sources: current,
      contextSources: collectContextSources(histories, current, retainedKeys),
      recovered: false,
      block: { code: GROK_RECOVERY_ARCHIVE_INCOMPLETE, message },
      diagnostics: [{ name: GROK_RECOVERY_ARCHIVE_INCOMPLETE, message }],
    };
  }
  const keyed = histories.map((history) => ({
    history,
    keys: history.entries.map((source) => grokEntryStructuralKey(source.value)),
  }));
  // Maximal cumulative snapshots only: a history that is a complete structural
  // prefix of a longer one is that longer history, kept once.
  const maximal = keyed.filter(
    (candidate) =>
      !keyed.some(
        (other) =>
          other !== candidate
          && other.keys.length > candidate.keys.length
          && isCompletePrefix(candidate.keys, other.keys),
      ),
  );
  const maxBootstrapAnchor = 6;
  let selected:
    | { readonly history: GrokArchiveHistory; readonly anchor: number; readonly overlap: number }
    | undefined;
  for (const candidate of maximal) {
    if (candidate.history.entries.length <= current.length) continue;
    const anchor = findBootstrapAnchor(candidate.keys, currentKeys, maxBootstrapAnchor);
    if (anchor === undefined) continue;
    if (
      selected === undefined
      || candidate.history.entries.length > selected.history.entries.length
    ) {
      selected = {
        history: candidate.history,
        anchor: anchor.anchor,
        overlap: anchor.overlap,
      };
    }
  }
  const diagnostics: DecodeDiagnostic[] = [];
  if (selected === undefined) {
    const message =
      `Grok archive history present but no pre-compaction branch anchored to the live chat `
      + `(${histories.length} archive histories); the live chat was retained unchanged.`;
    diagnostics.push({
      name: compactionEvidence ? GROK_RECOVERY_COMPACTION_UNRESOLVED : "grok.recovery.unresolved",
      message,
    });
    return {
      sources: current,
      contextSources: collectContextSources(histories, current, retainedKeys),
      recovered: false,
      ...(compactionEvidence
        ? { block: { code: GROK_RECOVERY_COMPACTION_UNRESOLVED, message } }
        : {}),
      diagnostics,
    };
  }
  const tail = stripLeadingInjected(current.slice(selected.anchor + selected.overlap));
  const sources = [...selected.history.entries, ...tail];
  const recoveredKeys = new Set(sources.map((source) => grokEntryStructuralKey(source.value)));
  return {
    sources,
    contextSources: collectContextSources(histories, current, recoveredKeys),
    recovered: true,
    selectedSourcePath: selected.history.sourcePath,
    anchorIndex: selected.anchor,
    diagnostics,
  };
};

/** Whitespace-normalized text used for evidence comparison. */
const normalizeForVerification = (text: string): string => text.replace(/\s+/g, " ").trim();

/**
 * Ordered injective verification of preserved canonical texts against a newly
 * projected session. Each canonical occurrence must match a distinct later
 * occurrence; unresolved occurrences are returned verbatim.
 */
export const verifyRecoveredTexts = (
  oldTexts: readonly string[],
  newTexts: readonly string[],
): GrokRecoveryVerification => {
  const normalizedNew = newTexts.map(normalizeForVerification);
  const unresolved: string[] = [];
  let cursor = 0;
  let resolved = 0;
  for (const oldText of oldTexts) {
    const needle = normalizeForVerification(oldText);
    if (needle.length === 0) {
      resolved += 1;
      continue;
    }
    let found = -1;
    for (let index = cursor; index < normalizedNew.length; index += 1) {
      if (normalizedNew[index] === needle) {
        found = index;
        break;
      }
    }
    if (found === -1) unresolved.push(oldText);
    else {
      cursor = found + 1;
      resolved += 1;
    }
  }
  return { total: oldTexts.length, resolved, unresolved };
};

/**
 * Count canonical message occurrences that appear MORE times in the new
 * projection than in the preserved canonical. Identical turns at different
 * positions are legitimate, so this is an excess check, not a dedup: any excess
 * is a merge-introduced duplicate.
 */
export const countExcessMessageOccurrences = (
  oldTexts: readonly string[],
  newTexts: readonly string[],
): number => {
  const tally = (texts: readonly string[]) => {
    const counts = new Map<string, number>();
    for (const text of texts) {
      const normalized = normalizeForVerification(text);
      if (normalized.length === 0) continue;
      counts.set(normalized, (counts.get(normalized) ?? 0) + 1);
    }
    return counts;
  };
  const oldCounts = tally(oldTexts);
  const newCounts = tally(newTexts);
  let excess = 0;
  for (const [text, count] of oldCounts) {
    excess += Math.max(0, (newCounts.get(text) ?? 0) - count);
  }
  return excess;
};

/** One stored canonical tool-call row, as served by the read-only query surface. */
export type GrokStoredToolCall = {
  readonly toolCallId: string;
  readonly sequence: number;
  readonly toolName: string;
  readonly status?: string | null;
  readonly inputBytes: number;
  readonly outputBytes: number;
  /** Optional stored payload hashes (sha256 hex, same as the store writes). */
  readonly inputHash?: string;
  readonly outputHash?: string;
};

export type GrokRecoveredToolCall = {
  readonly id: string;
  readonly toolName: string;
  readonly status?: string | null;
  readonly inputText: string;
  readonly outputText: string;
};

export type GrokToolCallRetention = {
  readonly total: number;
  readonly retained: number;
  readonly missing: readonly string[];
  readonly duplicateRecoveredIds: readonly string[];
  readonly toolNameMismatches: readonly string[];
  readonly statusMismatches: readonly string[];
  readonly byteMismatches: ReadonlyArray<{
    readonly toolCallId: string;
    readonly field: "input" | "output";
    readonly storedBytes: number;
    readonly recoveredBytes: number;
  }>;
  /** Stored payload hash mismatches (only when stored hashes were supplied). */
  readonly hashMismatches: ReadonlyArray<{
    readonly toolCallId: string;
    readonly field: "input" | "output";
    readonly storedHash: string;
    readonly recoveredHash: string;
  }>;
  /** Stored sequence groups whose cross-event order is not preserved. */
  readonly chronologyViolations: number;
};

/**
 * Retention of stored canonical tool calls in a recovered projection:
 * identity by canonical toolCallId, name/status equality, payload byte-length
 * equality, no duplicated recovered ids, and cross-event chronology (all calls
 * of an earlier stored `sequence` precede all calls of a later one). Order
 * WITHIN one stored sequence is not a chronology signal (the query serves it
 * sorted by id, not by source array position).
 */
export const verifyToolCallRetention = (
  stored: readonly GrokStoredToolCall[],
  recovered: readonly GrokRecoveredToolCall[],
): GrokToolCallRetention => {
  const recoveredById = new Map<string, GrokRecoveredToolCall>();
  const duplicateIds = new Set<string>();
  for (const toolCall of recovered) {
    if (recoveredById.has(toolCall.id)) duplicateIds.add(toolCall.id);
    recoveredById.set(toolCall.id, toolCall);
  }
  const missing: string[] = [];
  const toolNameMismatches: string[] = [];
  const statusMismatches: string[] = [];
  const byteMismatches: Array<GrokToolCallRetention["byteMismatches"][number]> = [];
  const hashMismatches: Array<GrokToolCallRetention["hashMismatches"][number]> = [];
  const recoveredIndex = new Map(recovered.map((toolCall, index) => [toolCall.id, index]));
  const groups: Array<{ sequence: number; min: number; max: number }> = [];
  let retained = 0;
  for (const row of stored) {
    const next = recoveredById.get(row.toolCallId);
    if (next === undefined) {
      missing.push(row.toolCallId);
      continue;
    }
    retained += 1;
    if (next.toolName !== row.toolName) toolNameMismatches.push(row.toolCallId);
    if ((next.status ?? null) !== (row.status ?? null)) statusMismatches.push(row.toolCallId);
    const inputBytes = Buffer.byteLength(next.inputText, "utf8");
    const outputBytes = Buffer.byteLength(next.outputText, "utf8");
    if (inputBytes !== row.inputBytes) {
      byteMismatches.push({ toolCallId: row.toolCallId, field: "input", storedBytes: row.inputBytes, recoveredBytes: inputBytes });
    }
    if (outputBytes !== row.outputBytes) {
      byteMismatches.push({ toolCallId: row.toolCallId, field: "output", storedBytes: row.outputBytes, recoveredBytes: outputBytes });
    }
    if (row.inputHash !== undefined) {
      const recoveredHash = createHash("sha256").update(next.inputText).digest("hex");
      if (recoveredHash !== row.inputHash) {
        hashMismatches.push({ toolCallId: row.toolCallId, field: "input", storedHash: row.inputHash, recoveredHash });
      }
    }
    if (row.outputHash !== undefined) {
      const recoveredHash = createHash("sha256").update(next.outputText).digest("hex");
      if (recoveredHash !== row.outputHash) {
        hashMismatches.push({ toolCallId: row.toolCallId, field: "output", storedHash: row.outputHash, recoveredHash });
      }
    }
    const index = recoveredIndex.get(row.toolCallId);
    if (index !== undefined) {
      const last = groups[groups.length - 1];
      if (last === undefined || last.sequence !== row.sequence) {
        groups.push({ sequence: row.sequence, min: index, max: index });
      } else {
        last.min = Math.min(last.min, index);
        last.max = Math.max(last.max, index);
      }
    }
  }
  groups.sort((left, right) => left.sequence - right.sequence);
  let chronologyViolations = 0;
  for (let index = 1; index < groups.length; index += 1) {
    if (groups[index]!.min < groups[index - 1]!.max) chronologyViolations += 1;
  }
  return {
    total: stored.length,
    retained,
    missing,
    duplicateRecoveredIds: [...duplicateIds],
    toolNameMismatches,
    statusMismatches,
    byteMismatches,
    hashMismatches,
    chronologyViolations,
  };
};

export type GrokEpochMessageRef = {
  readonly eventId: string;
  readonly seq: number;
  readonly text: string;
};

export type GrokEpochToolRef = {
  readonly id: string;
  readonly eventId: string;
  readonly seq: number;
  readonly toolName: string;
  readonly status?: string | null;
  readonly inputText: string;
  readonly outputText: string;
};

export type GrokEpochClassification = {
  readonly storedClass: ReadonlyArray<"old_only" | "shared">;
  readonly currentClass: ReadonlyArray<"shared" | "new_only">;
  readonly oldOnlyIndexes: readonly number[];
  readonly sharedStoredIndexes: readonly number[];
  readonly sharedCurrentIndexes: readonly number[];
  readonly newOnlyIndexes: readonly number[];
  readonly sharedIsStoredSuffix: boolean;
  readonly sharedIsCurrentPrefix: boolean;
  readonly newOnlyContiguousAfterShared: boolean;
};

/**
 * Injective stored→current alignment over whitespace-normalized message text.
 * Each stored occurrence consumes the first still-unused current occurrence
 * with identical text. Matching is COUNT-based, not positional: a stored
 * history that is itself the union of earlier epochs (canonical rows followed
 * by previously appended rows) must not drag a cursor past live occurrences,
 * and identical turns at different positions must stay distinct. Leftover
 * current rows are the post-compaction suffix.
 */
export const classifyGrokEpochMessages = (
  storedTexts: readonly string[],
  currentTexts: readonly string[],
): GrokEpochClassification => {
  const storedNorm = storedTexts.map(normalizeForVerification);
  const currentNorm = currentTexts.map(normalizeForVerification);
  const usedCurrent = new Set<number>();
  const storedClass: Array<"old_only" | "shared"> = [];
  for (const text of storedNorm) {
    let found = -1;
    if (text.length > 0) {
      for (let index = 0; index < currentNorm.length; index += 1) {
        if (usedCurrent.has(index)) continue;
        if (currentNorm[index] === text) {
          found = index;
          break;
        }
      }
    }
    if (found === -1) storedClass.push("old_only");
    else {
      storedClass.push("shared");
      usedCurrent.add(found);
    }
  }
  const currentClass = currentNorm.map((_, index) => (usedCurrent.has(index) ? "shared" as const : "new_only" as const));
  const oldOnlyIndexes = storedClass.flatMap((kind, index) => kind === "old_only" ? [index] : []);
  const sharedStoredIndexes = storedClass.flatMap((kind, index) => kind === "shared" ? [index] : []);
  const sharedCurrentIndexes = currentClass.flatMap((kind, index) => kind === "shared" ? [index] : []);
  const newOnlyIndexes = currentClass.flatMap((kind, index) => kind === "new_only" ? [index] : []);
  const sharedIsStoredSuffix = sharedStoredIndexes.length > 0
    && sharedStoredIndexes[0] === storedTexts.length - sharedStoredIndexes.length
    && sharedStoredIndexes.every((index, offset) => index === sharedStoredIndexes[0]! + offset);
  const sharedIsCurrentPrefix = sharedCurrentIndexes.length > 0
    && sharedCurrentIndexes[0] === 0
    && sharedCurrentIndexes.every((index, offset) => index === offset);
  const newOnlyContiguousAfterShared = newOnlyIndexes.length === 0
    || (
      (sharedCurrentIndexes.length === 0 && newOnlyIndexes[0] === 0
        && newOnlyIndexes.every((index, offset) => index === offset))
      || (sharedCurrentIndexes.length > 0
        && newOnlyIndexes[0] === sharedCurrentIndexes[sharedCurrentIndexes.length - 1]! + 1
        && newOnlyIndexes.every((index, offset) => index === newOnlyIndexes[0]! + offset))
    );
  return {
    storedClass,
    currentClass,
    oldOnlyIndexes,
    sharedStoredIndexes,
    sharedCurrentIndexes,
    newOnlyIndexes,
    sharedIsStoredSuffix,
    sharedIsCurrentPrefix,
    newOnlyContiguousAfterShared,
  };
};

export type GrokEpochMergePlan = {
  readonly safe: boolean;
  readonly blockers: readonly string[];
  readonly classification: GrokEpochClassification;
  readonly oldOnly: number;
  readonly shared: number;
  readonly newOnly: number;
  readonly unionMessages: number;
  readonly rebaseFromSeq: number;
  readonly appendCurrentMessageIndexes: readonly number[];
  readonly appendCurrentToolIds: readonly string[];
  readonly currentToolIdsAlreadyStored: number;
  readonly collidingNewEventIds: number;
};

/**
 * Store-prefix + live-suffix merge plan. Canonical stored rows stay verbatim.
 * Source-only current messages are appended in current order after max stored
 * seq. New tools may attach only to those appended turns. Same tool id with a
 * different payload is a blocker; seq overlap is expected and not a blocker.
 */
export const planGrokEpochMerge = (input: {
  readonly storedMessages: readonly GrokEpochMessageRef[];
  readonly storedTools: readonly GrokEpochToolRef[];
  readonly currentMessages: readonly GrokEpochMessageRef[];
  readonly currentTools: readonly GrokEpochToolRef[];
  readonly storedEventIds?: readonly string[];
  readonly storedMaxSeq?: number;
}): GrokEpochMergePlan => {
  const classification = classifyGrokEpochMessages(
    input.storedMessages.map((row) => row.text),
    input.currentMessages.map((row) => row.text),
  );
  const storedEventIds = new Set(
    input.storedEventIds ?? [
      ...input.storedMessages.map((row) => row.eventId),
      ...input.storedTools.map((row) => row.eventId),
    ],
  );
  const storedToolById = new Map(input.storedTools.map((tool) => [tool.id, tool]));
  const sharedCurrentEventIds = new Set(
    classification.sharedCurrentIndexes.map((index) => input.currentMessages[index]!.eventId),
  );
  const appendCurrentToolIds: string[] = [];
  const blockers: string[] = [];
  let currentToolIdsAlreadyStored = 0;
  for (const tool of input.currentTools) {
    const stored = storedToolById.get(tool.id);
    if (stored !== undefined) {
      currentToolIdsAlreadyStored += 1;
      if (stored.inputText !== tool.inputText || stored.outputText !== tool.outputText) {
        blockers.push(`tool_payload_conflict:${tool.id}`);
      }
      continue;
    }
    if (sharedCurrentEventIds.has(tool.eventId)) {
      blockers.push(`new_tool_on_shared_message:${tool.id}`);
      continue;
    }
    appendCurrentToolIds.push(tool.id);
  }
  const newMessages = classification.newOnlyIndexes.map((index) => input.currentMessages[index]!);
  const collidingNewEventIds = newMessages.filter((row) => storedEventIds.has(row.eventId)).length;
  const storedSeqs = input.storedMessages.map((row) => row.seq);
  const storedSeqMonotone = storedSeqs.every((seq, index) => index === 0 || seq > storedSeqs[index - 1]!);
  const textCounts = (texts: readonly string[]) => {
    const counts = new Map<string, number>();
    for (const text of texts) {
      const normalized = normalizeForVerification(text);
      if (normalized.length === 0) continue;
      counts.set(normalized, (counts.get(normalized) ?? 0) + 1);
    }
    return counts;
  };
  const unionTexts = [
    ...input.storedMessages.map((row) => row.text),
    ...newMessages.map((row) => row.text),
  ];
  const storedRetained = verifyRecoveredTexts(
    input.storedMessages.map((row) => row.text),
    unionTexts,
  );
  const currentTexts = input.currentMessages.map((row) => row.text);
  const storedCounts = textCounts(input.storedMessages.map((row) => row.text));
  const currentCounts = textCounts(currentTexts);
  const unionCounts = textCounts(unionTexts);
  // The count-based alignment keeps exactly max(stored, current) occurrences of
  // every text: no stored occurrence lost, no live occurrence lost, and no
  // occurrence invented. Any drift means alignment was not lossless.
  let multiplicityMismatch = false;
  for (const [text, count] of unionCounts) {
    if (count !== Math.max(storedCounts.get(text) ?? 0, currentCounts.get(text) ?? 0)) {
      multiplicityMismatch = true;
      break;
    }
  }
  if (input.currentMessages.length === 0) blockers.push("current_projection_empty");
  if (!storedSeqMonotone) blockers.push("stored_message_seq_not_monotone");
  if (storedRetained.unresolved.length > 0) blockers.push("union_drops_stored_texts");
  if (multiplicityMismatch) blockers.push("union_multiplicity_mismatch");
  const rebaseFromSeq = input.storedMaxSeq
    ?? Math.max(0, ...input.storedMessages.map((row) => row.seq), ...input.storedTools.map((row) => row.seq));
  return {
    safe: blockers.length === 0,
    blockers,
    classification,
    oldOnly: classification.oldOnlyIndexes.length,
    shared: classification.sharedStoredIndexes.length,
    newOnly: classification.newOnlyIndexes.length,
    unionMessages: input.storedMessages.length + newMessages.length,
    rebaseFromSeq,
    appendCurrentMessageIndexes: classification.newOnlyIndexes,
    appendCurrentToolIds,
    currentToolIdsAlreadyStored,
    collidingNewEventIds,
  };
};
