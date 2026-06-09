import { Effect, Schema } from "effect";

import { stableWideHash } from "./hash";
import type {
  Artifact,
  ContentBlock,
  IngestBatch,
  NormalizedSession,
  SessionEdge,
  SessionEvent,
  ToolCall,
  UsageRecord,
} from "./schemas";

const textEncoder = new TextEncoder();

export const SESSION_INTELLIGENCE_CONTRACT_VERSION = "session-intelligence/v2";

export const SessionIntelligenceBudgets = Schema.Struct({
  contentTextBytes: Schema.Number,
  contentBlockTextBytes: Schema.Number,
  toolInputBytes: Schema.Number,
  toolOutputBytes: Schema.Number,
  metadataBytes: Schema.Number,
  eventRecordBytes: Schema.Number,
  contentBlockRecordBytes: Schema.Number,
  toolCallRecordBytes: Schema.Number,
  usageRecordBytes: Schema.Number,
  artifactRecordBytes: Schema.Number,
  edgeRecordBytes: Schema.Number,
});
export type SessionIntelligenceBudgets = typeof SessionIntelligenceBudgets.Type;

export const CONVEX_SAFE_INGEST_BUDGETS = {
  contentTextBytes: 32 * 1024,
  contentBlockTextBytes: 32 * 1024,
  toolInputBytes: 48 * 1024,
  toolOutputBytes: 96 * 1024,
  metadataBytes: 16 * 1024,
  eventRecordBytes: 192 * 1024,
  contentBlockRecordBytes: 96 * 1024,
  toolCallRecordBytes: 192 * 1024,
  usageRecordBytes: 32 * 1024,
  artifactRecordBytes: 64 * 1024,
  edgeRecordBytes: 32 * 1024,
} satisfies SessionIntelligenceBudgets;

export class ConvexShapeViolationError extends Error {
  constructor(
    readonly path: string,
    readonly bytes: number,
    readonly maxBytes: number,
  ) {
    super(`${path} is ${bytes} bytes; maximum is ${maxBytes} bytes.`);
    this.name = "ConvexShapeViolationError";
  }
}

type NativePath = readonly string[];

const SESSION_TRASH_PATHS = [
  ["summary", "diffs"],
  ["summary", "diff"],
  ["summary", "patches"],
  ["summary", "snapshots"],
  ["workspace", "diffs"],
  ["workspace", "snapshot"],
  ["workspace", "snapshots"],
  ["workspaceDiff"],
  ["workspaceSnapshot"],
  ["checkpoint"],
  ["checkpoints"],
  ["snapshot"],
  ["snapshots"],
  ["diffs"],
  ["patches"],
] as const;

const GENERATED_PATH_SEGMENTS = /(^|\/)(node_modules|\.git|\.next|\.turbo|dist|build|out|coverage|target|vendor)(\/|$)/i;
const GENERATED_FILE = /(^|\/)(bun\.lockb?|package-lock\.json|pnpm-lock\.yaml|yarn\.lock)$/i;
const BINARY_KEY = /(^|_)(base64|data|bytes|blob|binary|image|source)(_|$)/i;
const NON_INTELLIGENCE_KEY =
  /(encrypted[_-]?content|cipher[_-]?text|diffs?|patches?|snapshots?|checkpoint|workspaceSnapshot|workspaceDiff)/i;
const BASE64ISH = /^[A-Za-z0-9+/=\s]+$/;
const CONTROL_CHARS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;
const ESCAPED_CONTROL_CHARS = /\\u00(?:0[0-9a-f]|1[0-9a-f]|7f)/gi;
const REPLACEMENT_CHAR = /\ufffd/g;

export const byteLength = (value: string) => textEncoder.encode(value).length;

export const jsonByteLength = (value: unknown): number => {
  try {
    return byteLength(JSON.stringify(value));
  } catch {
    return Number.POSITIVE_INFINITY;
  }
};

const truncateUtf8 = (value: string, maxBytes: number) => {
  if (byteLength(value) <= maxBytes) return value;
  const suffix = "\n[truncated for Convex ingest]";
  const suffixBytes = byteLength(suffix);
  const budget = Math.max(0, maxBytes - suffixBytes);
  let output = "";
  let used = 0;
  for (const char of value) {
    const charBytes = byteLength(char);
    if (used + charBytes > budget) break;
    output += char;
    used += charBytes;
  }
  return `${output}${suffix}`;
};

const isBinaryishString = (value: string) => {
  const controlCount =
    (value.match(CONTROL_CHARS)?.length ?? 0) +
    (value.match(ESCAPED_CONTROL_CHARS)?.length ?? 0) +
    (value.match(REPLACEMENT_CHAR)?.length ?? 0);
  if (value.length > 200 && controlCount > 20 && controlCount / value.length > 0.02) return true;
  const compact = value.replace(/\s+/g, "");
  if (compact.length <= 4_096 || compact.length % 4 !== 0 || !BASE64ISH.test(compact)) {
    return false;
  }
  const alphaNumeric = (compact.match(/[A-Za-z0-9]/g)?.length ?? 0) / compact.length;
  const symbolRatio = (compact.match(/[+/=]/g)?.length ?? 0) / compact.length;
  const longWordRatio = (compact.match(/[A-Za-z]{80,}/g)?.join("").length ?? 0) / compact.length;
  return alphaNumeric > 0.9 && symbolRatio > 0.01 && longWordRatio > 0.5;
};

const nativePathMatches = (path: NativePath, candidate: readonly string[]) => {
  if (candidate.length > path.length) return false;
  const start = path.length - candidate.length;
  return candidate.every((part, index) => path[start + index] === part);
};

const matchesNativeTrashPath = (path: NativePath) =>
  SESSION_TRASH_PATHS.some((candidate) => nativePathMatches(path, candidate));

const stringValue = (value: unknown) =>
  typeof value === "string" && value.trim().length > 0 ? value : undefined;

const nativePathFromRecord = (record: Record<string, unknown>) =>
  stringValue(record.path) ??
  stringValue(record.file) ??
  stringValue(record.file_path) ??
  stringValue(record.filePath) ??
  stringValue(record.filename) ??
  stringValue(record.sourcePath);

const isGeneratedPath = (value: string | undefined) =>
  value !== undefined && (GENERATED_PATH_SEGMENTS.test(value) || GENERATED_FILE.test(value));

const declaresBinaryPayload = (record: Record<string, unknown>) =>
  String(record.type ?? record.sourceType ?? record.encoding ?? record.mediaType ?? "")
    .toLowerCase()
    .includes("base64") ||
  String(record.mimeType ?? record.media_type ?? "")
    .toLowerCase()
    .startsWith("image/");

const sortedObject = (record: Record<string, unknown>) =>
  Object.fromEntries(Object.entries(record).sort(([left], [right]) => left.localeCompare(right)));

const boundedValue = (
  value: unknown,
  maxBytes: number,
  path: NativePath = [],
  depth = 0,
): unknown => {
  if (value === undefined || value === null) return value;
  if (typeof value === "string") {
    if (isBinaryishString(value)) {
      return {
        omitted: true,
        reason: "binary_or_base64",
        byteLength: byteLength(value),
        hash: stableWideHash(value),
      };
    }
    return truncateUtf8(value, maxBytes);
  }
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (depth > 8) return { omitted: true, reason: "max_depth" };
  if (Array.isArray(value)) {
    if (matchesNativeTrashPath(path)) {
      return {
        omitted: true,
        reason: "native_non_session_intelligence",
        itemCount: value.length,
        byteLength: jsonByteLength(value),
      };
    }
    const result: unknown[] = [];
    for (let index = 0; index < value.length; index += 1) {
      const item = boundedValue(value[index], maxBytes, [...path, String(index)], depth + 1);
      if (item !== undefined) result.push(item);
      if (jsonByteLength(result) > maxBytes) {
        result.push({
          omitted: true,
          reason: "array_byte_budget",
          remainingItems: value.length - index - 1,
        });
        break;
      }
    }
    return result;
  }
  if (typeof value !== "object") return String(value);
  const record = value as Record<string, unknown>;
  const nativePath = nativePathFromRecord(record);
  const binaryPayloadRecord = declaresBinaryPayload(record);
  if (isGeneratedPath(nativePath)) {
    return {
      omitted: true,
      reason: "generated_or_vendor_artifact",
      path: nativePath,
      byteLength: jsonByteLength(value),
      hash: stableWideHash(JSON.stringify(value)),
    };
  }
  const output: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(record)) {
    const childPath = [...path, key];
    if (matchesNativeTrashPath(childPath) || NON_INTELLIGENCE_KEY.test(key)) {
      output[key] = {
        omitted: true,
        reason: "native_non_session_intelligence",
        byteLength: jsonByteLength(item),
      };
      continue;
    }
    if (
      BINARY_KEY.test(key) &&
      typeof item === "string" &&
      (binaryPayloadRecord || isBinaryishString(item))
    ) {
      output[key] = {
        omitted: true,
        reason: "binary_or_base64",
        byteLength: byteLength(item),
        hash: stableWideHash(item),
      };
      continue;
    }
    const next = boundedValue(item, maxBytes, childPath, depth + 1);
    if (next !== undefined) output[key] = next;
    if (jsonByteLength(output) > maxBytes) {
      output.__quasarOmitted = {
        reason: "object_byte_budget",
        byteLength: jsonByteLength(value),
      };
      break;
    }
  }
  return sortedObject(output);
};

const boundedText = (value: string | undefined, maxBytes: number) =>
  value === undefined ? undefined : truncateUtf8(value, maxBytes);

const omittedRecordValue = (value: unknown, reason: string) => ({
  omitted: true,
  reason,
  byteLength: jsonByteLength(value),
  hash: stableWideHash(JSON.stringify(value)),
});

const sanitizeContentBlock = (block: ContentBlock): ContentBlock | undefined => {
  const next: ContentBlock = {
    ...block,
    text: boundedText(block.text, CONVEX_SAFE_INGEST_BUDGETS.contentBlockTextBytes),
    markdown: boundedText(block.markdown, CONVEX_SAFE_INGEST_BUDGETS.contentBlockTextBytes),
    thinking: boundedText(block.thinking, CONVEX_SAFE_INGEST_BUDGETS.contentBlockTextBytes),
    value: boundedValue(block.value, CONVEX_SAFE_INGEST_BUDGETS.metadataBytes),
    metadata: boundedValue(block.metadata, CONVEX_SAFE_INGEST_BUDGETS.metadataBytes),
  };
  if (next.kind === "json" && next.value === undefined && next.metadata === undefined) {
    return undefined;
  }
  return fitContentBlockRecord(compactUndefined(next));
};

const fitContentBlockRecord = (block: ContentBlock): ContentBlock => {
  if (jsonByteLength(block) <= CONVEX_SAFE_INGEST_BUDGETS.contentBlockRecordBytes) return block;
  const compact = compactUndefined({
    ...block,
    text: boundedText(block.text, 16 * 1024),
    markdown: boundedText(block.markdown, 16 * 1024),
    thinking: boundedText(block.thinking, 16 * 1024),
    value: block.value === undefined ? undefined : omittedRecordValue(block.value, "content_block_value_budget"),
    metadata:
      block.metadata === undefined
        ? undefined
        : omittedRecordValue(block.metadata, "content_block_metadata_budget"),
  });
  if (jsonByteLength(compact) <= CONVEX_SAFE_INGEST_BUDGETS.contentBlockRecordBytes) return compact;
  return compactUndefined({
    ...compact,
    text: boundedText(compact.text, 8 * 1024),
    markdown: boundedText(compact.markdown, 8 * 1024),
    thinking: boundedText(compact.thinking, 8 * 1024),
  });
};

const sanitizeEvent = (event: SessionEvent): SessionEvent =>
  compactUndefined({
    ...event,
    contentText: boundedText(event.contentText, CONVEX_SAFE_INGEST_BUDGETS.contentTextBytes),
    content: boundedValue(event.content, CONVEX_SAFE_INGEST_BUDGETS.metadataBytes),
    contentBlocks: event.contentBlocks.flatMap((block) => {
      const next = sanitizeContentBlock(block);
      return next === undefined ? [] : [next];
    }),
    raw: undefined,
  });

const sanitizeToolCall = (toolCall: ToolCall): ToolCall =>
  compactUndefined({
    ...toolCall,
    input: boundedValue(toolCall.input, CONVEX_SAFE_INGEST_BUDGETS.toolInputBytes),
    output: boundedValue(toolCall.output, CONVEX_SAFE_INGEST_BUDGETS.toolOutputBytes),
    raw: undefined,
  });

const sanitizeUsageRecord = (usageRecord: UsageRecord): UsageRecord =>
  compactUndefined({
    ...usageRecord,
    raw: undefined,
  });

const sanitizeArtifact = (artifact: Artifact): Artifact =>
  compactUndefined({
    ...artifact,
    sourceRef: boundedValue(artifact.sourceRef, CONVEX_SAFE_INGEST_BUDGETS.metadataBytes),
    metadata: boundedValue(artifact.metadata, CONVEX_SAFE_INGEST_BUDGETS.metadataBytes),
    raw: undefined,
  });

const sanitizeEdge = (edge: SessionEdge): SessionEdge =>
  compactUndefined({
    ...edge,
    rawReference: boundedValue(edge.rawReference, CONVEX_SAFE_INGEST_BUDGETS.metadataBytes),
    metadata: boundedValue(edge.metadata, CONVEX_SAFE_INGEST_BUDGETS.metadataBytes),
  });

const compactUndefined = <A extends Record<string, unknown>>(record: A): A =>
  Object.fromEntries(Object.entries(record).filter(([, value]) => value !== undefined)) as A;

export const sanitizeSessionIntelligenceSession = (
  session: NormalizedSession,
): NormalizedSession =>
  compactUndefined({
    ...session,
    rawMetadata: boundedValue(session.rawMetadata, CONVEX_SAFE_INGEST_BUDGETS.metadataBytes),
    events: session.events.map(sanitizeEvent),
    toolCalls: session.toolCalls.map(sanitizeToolCall),
    sessionEdges: session.sessionEdges.map(sanitizeEdge),
    usageRecords: session.usageRecords.map(sanitizeUsageRecord),
    artifacts: session.artifacts.map(sanitizeArtifact),
  });

export const sanitizeSessionIntelligenceBatch = (batch: IngestBatch): IngestBatch => ({
  ...batch,
  sessions: batch.sessions.map(sanitizeSessionIntelligenceSession),
});

const assertRecordBudget = (path: string, value: unknown, maxBytes: number) => {
  const bytes = jsonByteLength(value);
  if (bytes > maxBytes) throw new ConvexShapeViolationError(path, bytes, maxBytes);
};

export const assertConvexSafeSessionIntelligenceBatch = (
  batch: IngestBatch,
): IngestBatch => {
  for (const session of batch.sessions) {
    const sessionDoc = {
      ...session,
      events: undefined,
      toolCalls: undefined,
      sessionEdges: undefined,
      usageRecords: undefined,
      artifacts: undefined,
    };
    assertRecordBudget(`sessions.${session.id}`, sessionDoc, CONVEX_SAFE_INGEST_BUDGETS.eventRecordBytes);
    for (const event of session.events) {
      const eventDoc = {
        ...event,
        contentBlocks: undefined,
      };
      assertRecordBudget(
        `sessionEvents.${event.id}`,
        eventDoc,
        CONVEX_SAFE_INGEST_BUDGETS.eventRecordBytes,
      );
      for (const block of event.contentBlocks) {
        assertRecordBudget(
          `contentBlocks.${block.id}`,
          block,
          CONVEX_SAFE_INGEST_BUDGETS.contentBlockRecordBytes,
        );
      }
    }
    for (const toolCall of session.toolCalls) {
      assertRecordBudget(
        `toolCalls.${toolCall.id}`,
        toolCall,
        CONVEX_SAFE_INGEST_BUDGETS.toolCallRecordBytes,
      );
    }
    for (const usageRecord of session.usageRecords) {
      assertRecordBudget(
        `usageRecords.${usageRecord.id}`,
        usageRecord,
        CONVEX_SAFE_INGEST_BUDGETS.usageRecordBytes,
      );
    }
    for (const artifact of session.artifacts) {
      assertRecordBudget(
        `artifacts.${artifact.id}`,
        artifact,
        CONVEX_SAFE_INGEST_BUDGETS.artifactRecordBytes,
      );
    }
    for (const edge of session.sessionEdges) {
      assertRecordBudget(
        `sessionEdges.${edge.id}`,
        edge,
        CONVEX_SAFE_INGEST_BUDGETS.edgeRecordBytes,
      );
    }
  }
  return batch;
};

export const assertConvexSafeSessionIntelligenceBatchEffect = (batch: IngestBatch) =>
  Effect.sync(() => assertConvexSafeSessionIntelligenceBatch(batch));

export const toConvexSafeSessionIntelligenceBatch = (batch: IngestBatch): IngestBatch =>
  assertConvexSafeSessionIntelligenceBatch(sanitizeSessionIntelligenceBatch(batch));
