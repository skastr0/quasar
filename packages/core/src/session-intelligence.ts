import { Effect, Schema } from "effect";

import { stableWideHash } from "./hash";
import { IngestBatch as IngestBatchSchema } from "./schemas";
import type {
  Artifact,
  ContentBlock,
  IngestBatch,
  MachineIdentity,
  NormalizedSession,
  ProjectResolution,
  ProjectSignal,
  SessionEdge,
  SessionEvent,
  SourceRoot,
  ToolCall,
  UsageRecord,
} from "./schemas";

const textEncoder = new TextEncoder();

export const SESSION_INTELLIGENCE_CONTRACT_VERSION = "session-intelligence/v5";

export const SessionIntelligenceBudgets = Schema.Struct({
  contentTextBytes: Schema.Number,
  contentBlockTextBytes: Schema.Number,
  toolInputBytes: Schema.Number,
  toolOutputBytes: Schema.Number,
  metadataBytes: Schema.Number,
  machineRecordBytes: Schema.Number,
  projectIdentityRecordBytes: Schema.Number,
  sourceRootRecordBytes: Schema.Number,
  eventRecordBytes: Schema.Number,
  contentBlockRecordBytes: Schema.Number,
  toolCallRecordBytes: Schema.Number,
  usageRecordBytes: Schema.Number,
  artifactRecordBytes: Schema.Number,
  edgeRecordBytes: Schema.Number,
  diagnosticRecordBytes: Schema.Number,
});
export type SessionIntelligenceBudgets = typeof SessionIntelligenceBudgets.Type;

export const CONVEX_SAFE_INGEST_BUDGETS = {
  contentTextBytes: 32 * 1024,
  contentBlockTextBytes: 32 * 1024,
  toolInputBytes: 48 * 1024,
  toolOutputBytes: 96 * 1024,
  metadataBytes: 16 * 1024,
  machineRecordBytes: 16 * 1024,
  projectIdentityRecordBytes: 16 * 1024,
  sourceRootRecordBytes: 16 * 1024,
  eventRecordBytes: 192 * 1024,
  contentBlockRecordBytes: 96 * 1024,
  toolCallRecordBytes: 192 * 1024,
  usageRecordBytes: 32 * 1024,
  artifactRecordBytes: 64 * 1024,
  edgeRecordBytes: 32 * 1024,
  diagnosticRecordBytes: 32 * 1024,
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
  ["summary", "cache"],
  ["summary", "state"],
  ["summary", "providerCache"],
  ["summary", "providerState"],
  ["summary", "viewState"],
  ["summary", "uiState"],
  ["summary", "providerUi"],
  ["workspace", "diff"],
  ["workspace", "diffs"],
  ["workspace", "patch"],
  ["workspace", "patches"],
  ["workspace", "cache"],
  ["workspace", "state"],
  ["workspace", "providerCache"],
  ["workspace", "providerState"],
  ["workspace", "viewState"],
  ["workspace", "uiState"],
  ["workspace", "providerUi"],
  ["workspace", "snapshot"],
  ["workspace", "snapshots"],
  ["workspaceDiff"],
  ["workspaceSnapshot"],
  ["checkpoint"],
  ["checkpoints"],
  ["snapshot"],
  ["snapshots"],
] as const;

const GENERATED_PATH_SEGMENTS = /(^|\/)(node_modules|\.git|\.next|\.turbo|dist|build|out|coverage|target|vendor)(\/|$)/i;
const GENERATED_FILE = /(^|\/)(bun\.lockb?|package-lock\.json|pnpm-lock\.yaml|yarn\.lock)$/i;
const BINARY_KEY = /(^|_)(base64|data|bytes|blob|binary|image|source)(_|$)/i;
const BASE64ISH = /^[A-Za-z0-9+/=\s]+$/;
const DATA_URI = /^data:[^,]{0,512},/i;
const DATA_URI_INLINE = /data:[^,\s"'<>]{0,512},[A-Za-z0-9+/=_-]{64,}/gi;
const CONTROL_CHARS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;
const ESCAPED_CONTROL_CHARS = /\\u00(?:0[0-9a-f]|1[0-9a-f]|7f)/gi;
const REPLACEMENT_CHAR = /\ufffd/g;
const CONTENT_BLOCK_LOCATOR_BYTES = 2 * 1024;
const CONTENT_BLOCK_MEDIA_TYPE_BYTES = 256;
const DIAGNOSTIC_MESSAGE_BYTES = 4 * 1024;
const INDEXED_ID_BYTES = 256;
const INDEXED_LOCATOR_BYTES = 512;
const RAW_REFERENCE_SOURCE_PATH_BYTES = 2 * 1024;
const RAW_REFERENCE_FIELD_BYTES = 512;
const PROJECT_IDENTITY_FIELD_BYTES = 1024;
const PROJECT_SIGNAL_LIMIT = 16;
const PROJECT_SIGNAL_VALUE_BYTES = 512;
const SESSION_TITLE_BYTES = 4 * 1024;
const TOOL_RESULT_PATCH_KEY = /^(diff|diffs|patch|patches)$/i;
const SESSION_PATCH_RECORD_TYPE = /(^|[_:-])(diff|patch|edit|hunk|artifact)([_:-]|$)/i;
const PROVIDER_CONTROL_KEYS = new Set([
  "cache",
  "cachestate",
  "checkpoint",
  "checkpoints",
  "ciphertext",
  "diff",
  "diffs",
  "display",
  "displayonly",
  "displaystate",
  "encryptedcontent",
  "patch",
  "patches",
  "providercache",
  "providerstate",
  "providerui",
  "snapshot",
  "snapshots",
  "state",
  "ui",
  "uistate",
  "viewstate",
  "workspacediff",
  "workspacepatch",
  "workspacesnapshot",
]);
const PROVIDER_SCOPED_KEY_PREFIXES = ["summary", "workspace"] as const;
const PROVIDER_SCOPED_KEY_SUFFIXES = [
  "cache",
  "diff",
  "diffs",
  "patch",
  "patches",
  "providercache",
  "providerstate",
  "providerui",
  "snapshot",
  "snapshots",
  "state",
  "uistate",
  "viewstate",
] as const;

type BoundedValueOptions = {
  readonly preserveToolPatchFields?: boolean;
  readonly preserveSessionPatchFields?: boolean;
};

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
  if (DATA_URI.test(value)) return true;
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

const replaceInlineBinary = (value: string) =>
  value.replace(DATA_URI_INLINE, (match) => {
    const bytes = byteLength(match);
    return `[omitted:data_uri bytes=${bytes} hash=${stableWideHash(match)}]`;
  });

const compactTextWhitespace = (value: string) =>
  value.replace(CONTROL_CHARS, " ").replace(/\s+/g, " ").trim();

const cleanTextBody = (value: string) => value.replace(CONTROL_CHARS, " ").trim();

const parseJsonText = (value: string): unknown | undefined => {
  const trimmed = value.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return undefined;
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return undefined;
  }
};

export const compactSessionIntelligenceText = (
  value: string | undefined,
  maxBytes = Number.POSITIVE_INFINITY,
) => {
  if (value === undefined) return undefined;
  if (isBinaryishString(value)) {
    return truncateUtf8(
      `[omitted:binary_or_base64 bytes=${byteLength(value)} hash=${stableWideHash(value)}]`,
      maxBytes,
    );
  }
  const parsed = parseJsonText(value);
  if (parsed !== undefined) {
    const projected = boundedValue(parsed, Math.min(maxBytes, CONVEX_SAFE_INGEST_BUDGETS.metadataBytes));
    return truncateUtf8(compactTextWhitespace(JSON.stringify(projected)), maxBytes);
  }
  const compact = cleanTextBody(replaceInlineBinary(value));
  return compact.length === 0 ? undefined : truncateUtf8(compact, maxBytes);
};

export const projectSessionIntelligenceNativeValue = (value: unknown): unknown =>
  boundedValue(value, CONVEX_SAFE_INGEST_BUDGETS.metadataBytes);

export const projectSessionIntelligencePatchPayloadValue = (value: unknown): unknown =>
  boundedValue(value, CONVEX_SAFE_INGEST_BUDGETS.metadataBytes, [], 0, {
    preserveSessionPatchFields: true,
  });

export const projectSessionIntelligenceToolPayloadValue = (value: unknown): unknown =>
  boundedValue(value, CONVEX_SAFE_INGEST_BUDGETS.toolOutputBytes, [], 0, {
    preserveToolPatchFields: true,
  });

const nativePathMatches = (path: NativePath, candidate: readonly string[]) => {
  if (candidate.length > path.length) return false;
  const start = path.length - candidate.length;
  return candidate.every((part, index) => path[start + index] === part);
};

const matchesNativeTrashPath = (path: NativePath) =>
  SESSION_TRASH_PATHS.some((candidate) => nativePathMatches(path, candidate));

const normalizedNativeKey = (key: string) => key.replace(/[^a-z0-9]/gi, "").toLowerCase();

const isProviderScopedKey = (key: string) =>
  PROVIDER_SCOPED_KEY_PREFIXES.some((prefix) =>
    PROVIDER_SCOPED_KEY_SUFFIXES.some((suffix) => key === `${prefix}${suffix}`),
  );

const isProviderControlKey = (key: string) => {
  const normalized = normalizedNativeKey(key);
  return PROVIDER_CONTROL_KEYS.has(normalized) || isProviderScopedKey(normalized);
};

const isProviderMetadataPath = (path: NativePath) =>
  path.some((part) =>
    /^(summary|workspace|workspacediff|workspacepatch|workspacesnapshot|checkpoint|checkpoints|delta|snapshots?)$/i.test(
      normalizedNativeKey(part),
    ),
  );

const recordDeclaresSessionPatch = (record: Record<string, unknown>) => {
  const type = String(
    record.type ??
      record.nativeType ??
      record.kind ??
      record.event ??
      record.action ??
      record.artifactKind ??
      "",
  ).toLowerCase();
  return SESSION_PATCH_RECORD_TYPE.test(type);
};

const shouldOmitNativeField = (
  key: string,
  path: NativePath,
  options: BoundedValueOptions,
) => {
  if (options.preserveToolPatchFields === true && TOOL_RESULT_PATCH_KEY.test(key) && !isProviderMetadataPath(path)) {
    return false;
  }
  if (options.preserveSessionPatchFields === true && TOOL_RESULT_PATCH_KEY.test(key) && !isProviderMetadataPath(path)) {
    return false;
  }
  if (TOOL_RESULT_PATCH_KEY.test(key)) return true;
  return matchesNativeTrashPath(path) || isProviderControlKey(key);
};

const hasProviderControlEnvelope = (
  value: unknown,
  path: NativePath = [],
  depth = 0,
): boolean => {
  if (depth > 8 || value === undefined || value === null) return false;
  if (Array.isArray(value)) {
    return value.some((item, index) =>
      hasProviderControlEnvelope(item, [...path, String(index)], depth + 1),
    );
  }
  if (typeof value !== "object") return false;
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    const childPath = [...path, key];
    if (matchesNativeTrashPath(childPath) || isProviderControlKey(key)) return true;
    if (hasProviderControlEnvelope(item, childPath, depth + 1)) return true;
  }
  return false;
};

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

const omittedFieldValue = (_key: string, value: unknown, reason: string) => ({
  reason,
  byteLength: jsonByteLength(value),
  hash: stableWideHash(JSON.stringify(value)),
});

const isOmissionRecord = (record: Record<string, unknown>) =>
  record.omitted === true && typeof record.reason === "string";

const addOmittedField = (
  output: Record<string, unknown>,
  field: ReturnType<typeof omittedFieldValue>,
) => {
  const current = output.__quasarOmitted;
  const currentRecord =
    current !== null && typeof current === "object" && !Array.isArray(current)
      ? (current as { fields?: unknown[]; omittedFieldCount?: number })
      : {};
  const fields = Array.isArray(currentRecord.fields) ? [...currentRecord.fields] : [];
  if (fields.length < 12) fields.push(field);
  output.__quasarOmitted = {
    reason: "non_session_intelligence_fields",
    omittedFieldCount: (currentRecord.omittedFieldCount ?? 0) + 1,
    fields,
  };
};

const boundedArrayValue = (
  value: readonly unknown[],
  maxBytes: number,
  path: NativePath,
  depth: number,
  options: BoundedValueOptions,
) => {
  const key = path.at(-1) ?? "";
  if (shouldOmitNativeField(key, path, options)) {
    return {
      omitted: true,
      reason: "native_non_session_intelligence",
      itemCount: value.length,
      byteLength: jsonByteLength(value),
    };
  }
  const result: unknown[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const item = boundedValue(value[index], maxBytes, [...path, String(index)], depth + 1, options);
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
};

const boundedValue = (
  value: unknown,
  maxBytes: number,
  path: NativePath = [],
  depth = 0,
  options: BoundedValueOptions = {},
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
    const parsed = parseJsonText(value);
    if (parsed !== undefined && hasProviderControlEnvelope(parsed, path)) {
      return boundedValue(parsed, maxBytes, path, depth, options);
    }
    return truncateUtf8(value, maxBytes);
  }
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (depth > 8) return { omitted: true, reason: "max_depth" };
  if (Array.isArray(value)) {
    return boundedArrayValue(value, maxBytes, path, depth, options);
  }
  if (typeof value !== "object") return String(value);
  const record = value as Record<string, unknown>;
  if (isOmissionRecord(record)) return sortedObject(record);
  const nextOptions = recordDeclaresSessionPatch(record)
    ? { ...options, preserveSessionPatchFields: true }
    : options;
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
    if (shouldOmitNativeField(key, childPath, nextOptions)) {
      addOmittedField(output, omittedFieldValue(key, item, "native_non_session_intelligence"));
      continue;
    }
    if (
      BINARY_KEY.test(key) &&
      typeof item === "string" &&
      (binaryPayloadRecord || isBinaryishString(item))
    ) {
      addOmittedField(output, {
        reason: "binary_or_base64",
        byteLength: byteLength(item),
        hash: stableWideHash(item),
      });
      continue;
    }
    const next = boundedValue(item, maxBytes, childPath, depth + 1, nextOptions);
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
  compactSessionIntelligenceText(value, maxBytes);

const omittedRecordValue = (value: unknown, reason: string) => ({
  omitted: true,
  reason,
  byteLength: jsonByteLength(value),
  hash: stableWideHash(JSON.stringify(value)),
});

const omittedStringValue = (value: string, key: string, reason: string) => ({
  key,
  reason,
  byteLength: byteLength(value),
  hash: stableWideHash(value),
});

const boundedLocator = (value: string | undefined, key: string) => {
  if (value === undefined) return {};
  if (isBinaryishString(value) || byteLength(value) > CONTENT_BLOCK_LOCATOR_BYTES) {
    return {
      omitted: omittedStringValue(value, key, `${key}_omitted`),
    };
  }
  return { value };
};

const boundedMediaType = (value: string | undefined) => {
  if (value === undefined) return {};
  if (byteLength(value) > CONTENT_BLOCK_MEDIA_TYPE_BYTES || isBinaryishString(value)) {
    return {
      omitted: omittedStringValue(value, "mediaType", "media_type_omitted"),
    };
  }
  return { value };
};

const boundedLocatorText = (value: string | undefined, maxBytes: number) =>
  boundedText(value, maxBytes);

const cleanIdentityText = (value: string) =>
  cleanTextBody(replaceInlineBinary(value));

const boundedRequiredIdentityText = (
  value: string,
  prefix: string,
  maxBytes: number,
) => {
  const cleaned = cleanIdentityText(value);
  if (cleaned.length > 0 && !isBinaryishString(value) && byteLength(cleaned) <= maxBytes) {
    return cleaned;
  }
  return `${prefix}:${stableWideHash(value)}`;
};

const boundedRequiredLocatorText = (value: string, key: string, maxBytes: number) =>
  boundedLocatorText(value, maxBytes) ?? `[omitted:${key}]`;

const boundedMachineId = (value: string) =>
  boundedRequiredIdentityText(value, "machine", INDEXED_ID_BYTES);

const boundedProjectIdentityKey = (value: string) =>
  boundedRequiredIdentityText(value, "project", INDEXED_ID_BYTES);

export type SessionIntelligenceGraphIdKind =
  | "session"
  | "native_session"
  | "event"
  | "content_block"
  | "tool_call"
  | "usage_record"
  | "artifact"
  | "session_edge"
  | "reference"
  | "agent"
  | "tool_name";

const graphIdPrefix = (kind: SessionIntelligenceGraphIdKind) => {
  switch (kind) {
    case "session":
      return "session";
    case "native_session":
      return "native_session";
    case "event":
      return "event";
    case "content_block":
      return "block";
    case "tool_call":
      return "tool";
    case "usage_record":
      return "usage";
    case "session_edge":
      return "edge";
    case "reference":
      return "ref";
    case "artifact":
      return "artifact";
    case "agent":
      return "agent";
    case "tool_name":
      return "tool_name";
  }
};

export const projectSessionIntelligenceGraphId = (
  kind: SessionIntelligenceGraphIdKind,
  value: string,
) => boundedRequiredIdentityText(value, graphIdPrefix(kind), INDEXED_ID_BYTES);

const boundedIndexedId = (value: string, kind: SessionIntelligenceGraphIdKind) =>
  projectSessionIntelligenceGraphId(kind, value);

const boundedAgentName = (value: string) =>
  projectSessionIntelligenceGraphId("agent", value);

const boundedToolName = (value: string) =>
  projectSessionIntelligenceGraphId("tool_name", value);

const sanitizeRawReference = (rawReference: SessionEvent["rawReference"]): SessionEvent["rawReference"] =>
  compactUndefined({
    sourcePath:
      boundedLocatorText(rawReference.sourcePath, RAW_REFERENCE_SOURCE_PATH_BYTES) ??
      "[omitted:sourcePath]",
    line: rawReference.line,
    table: boundedLocatorText(rawReference.table, RAW_REFERENCE_FIELD_BYTES),
    rowId: boundedLocatorText(rawReference.rowId, RAW_REFERENCE_FIELD_BYTES),
    nativeType: boundedLocatorText(rawReference.nativeType, RAW_REFERENCE_FIELD_BYTES),
  });

const sanitizeDiagnostic = (diagnostic: IngestBatch["diagnostics"][number]) =>
  fitDiagnosticRecord(
    compactUndefined({
      adapterId: boundedLocatorText(diagnostic.adapterId, RAW_REFERENCE_FIELD_BYTES) ?? diagnostic.adapterId,
      provider: diagnostic.provider,
      status: diagnostic.status,
      parserConfidence: diagnostic.parserConfidence,
      rootPath: boundedLocatorText(diagnostic.rootPath, RAW_REFERENCE_SOURCE_PATH_BYTES),
      message: boundedText(diagnostic.message, DIAGNOSTIC_MESSAGE_BYTES) ?? "",
      details: boundedValue(diagnostic.details, CONVEX_SAFE_INGEST_BUDGETS.metadataBytes),
    }),
  );

const fitDiagnosticRecord = (
  diagnostic: IngestBatch["diagnostics"][number],
): IngestBatch["diagnostics"][number] => {
  if (jsonByteLength(diagnostic) <= CONVEX_SAFE_INGEST_BUDGETS.diagnosticRecordBytes) {
    return diagnostic;
  }
  return compactUndefined({
    ...diagnostic,
    details:
      diagnostic.details === undefined
        ? undefined
        : omittedRecordValue(diagnostic.details, "diagnostic_details_budget"),
  });
};

export const sanitizeSessionIntelligenceDiagnostics = (
  diagnostics: readonly IngestBatch["diagnostics"][number][],
) => diagnostics.map(sanitizeDiagnostic);

const mergeContentBlockMetadata = (
  metadata: unknown,
  omissions: readonly ReturnType<typeof omittedStringValue>[],
) => {
  if (omissions.length === 0) return metadata;
  const metadataRecord =
    metadata !== null && typeof metadata === "object" && !Array.isArray(metadata)
      ? (metadata as Record<string, unknown>)
      : metadata === undefined
        ? {}
        : { value: metadata };
  return boundedValue(
    {
      ...metadataRecord,
      __quasarOmitted: {
        reason: "content_block_locator_fields",
        fields: omissions,
      },
    },
    CONVEX_SAFE_INGEST_BUDGETS.metadataBytes,
  );
};

type SessionIdentityMap = {
  readonly sessionId: string;
  readonly nativeSessionId: string;
  readonly machineId: string;
  readonly agentName: string;
  readonly projectIdentityKey: string;
  readonly sessionIds: ReadonlyMap<string, string>;
  readonly eventIds: ReadonlyMap<string, string>;
  readonly blockIds: ReadonlyMap<string, string>;
  readonly toolCallIds: ReadonlyMap<string, string>;
  readonly usageRecordIds: ReadonlyMap<string, string>;
  readonly artifactIds: ReadonlyMap<string, string>;
  readonly edgeIds: ReadonlyMap<string, string>;
};

const collectIdMap = <A>(
  values: readonly A[],
  valueId: (value: A) => string,
  kind: SessionIntelligenceGraphIdKind,
) => new Map(values.map((value) => [valueId(value), boundedIndexedId(valueId(value), kind)]));

const collectContentBlockIdMap = (events: readonly SessionEvent[]) =>
  new Map(
    events.flatMap((event) =>
      event.contentBlocks.map((block) => [block.id, boundedIndexedId(block.id, "content_block")] as const),
    ),
  );

const collectToolCallIdMap = (session: NormalizedSession) => {
  const ids = new Set<string>(session.toolCalls.map((toolCall) => toolCall.id));
  for (const event of session.events) {
    if (event.toolCallId !== undefined) ids.add(event.toolCallId);
  }
  return new Map([...ids].map((id) => [id, boundedIndexedId(id, "tool_call")]));
};

const collectSessionIdentityMap = (session: NormalizedSession): SessionIdentityMap => ({
  sessionId: boundedIndexedId(session.id, "session"),
  nativeSessionId: boundedIndexedId(session.nativeSessionId, "native_session"),
  machineId: boundedMachineId(session.machineId),
  agentName: boundedAgentName(session.agentName),
  projectIdentityKey: boundedProjectIdentityKey(session.projectIdentity.projectIdentityKey),
  sessionIds: new Map([[session.id, boundedIndexedId(session.id, "session")]]),
  eventIds: collectIdMap(session.events, (event) => event.id, "event"),
  blockIds: collectContentBlockIdMap(session.events),
  toolCallIds: collectToolCallIdMap(session),
  usageRecordIds: collectIdMap(session.usageRecords, (usageRecord) => usageRecord.id, "usage_record"),
  artifactIds: collectIdMap(session.artifacts, (artifact) => artifact.id, "artifact"),
  edgeIds: collectIdMap(session.sessionEdges, (edge) => edge.id, "session_edge"),
});

const mappedId = (
  map: ReadonlyMap<string, string>,
  value: string | undefined,
  kind: SessionIntelligenceGraphIdKind,
) => {
  if (value === undefined) return undefined;
  return map.get(value) ?? boundedIndexedId(value, kind);
};

const mappedKnownReferenceId = (
  maps: SessionIdentityMap,
  value: string | undefined,
) => {
  if (value === undefined) return undefined;
  return (
    maps.sessionIds.get(value) ??
    maps.eventIds.get(value) ??
    maps.toolCallIds.get(value) ??
    maps.blockIds.get(value) ??
    maps.artifactIds.get(value) ??
    maps.usageRecordIds.get(value) ??
    maps.edgeIds.get(value) ??
    boundedIndexedId(value, "reference")
  );
};

const sanitizeContentBlock = (block: ContentBlock, maps: SessionIdentityMap): ContentBlock | undefined => {
  const path = boundedLocator(block.path, "path");
  const uri = boundedLocator(block.uri, "uri");
  const mediaType = boundedMediaType(block.mediaType);
  const locatorOmissions = [path.omitted, uri.omitted, mediaType.omitted].filter(
    (item): item is ReturnType<typeof omittedStringValue> => item !== undefined,
  );
  const metadata = boundedValue(block.metadata, CONVEX_SAFE_INGEST_BUDGETS.metadataBytes);
  const next: ContentBlock = {
    id: mappedId(maps.blockIds, block.id, "content_block") ?? boundedIndexedId(block.id, "content_block"),
    sequence: block.sequence,
    kind: block.kind,
    path: path.value,
    uri: uri.value,
    mediaType: mediaType.value,
    text: boundedText(block.text, CONVEX_SAFE_INGEST_BUDGETS.contentBlockTextBytes),
    markdown: boundedText(block.markdown, CONVEX_SAFE_INGEST_BUDGETS.contentBlockTextBytes),
    thinking: boundedText(block.thinking, CONVEX_SAFE_INGEST_BUDGETS.contentBlockTextBytes),
    value: boundedValue(block.value, CONVEX_SAFE_INGEST_BUDGETS.metadataBytes),
    metadata: mergeContentBlockMetadata(metadata, locatorOmissions),
  };
  if (next.kind === "json" && next.value === undefined && next.metadata === undefined) {
    return undefined;
  }
  return fitContentBlockRecord(compactUndefined(next));
};

const eventCarriesSessionContent = (event: SessionEvent) =>
  event.kind !== "snapshot";

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

const sanitizeEvent = (event: SessionEvent, maps: SessionIdentityMap): SessionEvent =>
  compactUndefined({
    id: mappedId(maps.eventIds, event.id, "event") ?? boundedIndexedId(event.id, "event"),
    sessionId: maps.sessionId,
    nativeEventId: boundedLocatorText(event.nativeEventId, RAW_REFERENCE_FIELD_BYTES),
    sequence: event.sequence,
    timestamp: event.timestamp,
    machineId: maps.machineId,
    provider: event.provider,
    agentName: maps.agentName,
    projectIdentityKey: maps.projectIdentityKey,
    role: event.role,
    kind: event.kind,
    contentText: eventCarriesSessionContent(event)
      ? boundedText(event.contentText, CONVEX_SAFE_INGEST_BUDGETS.contentTextBytes)
      : undefined,
    contentBlocks: eventCarriesSessionContent(event)
      ? event.contentBlocks.flatMap((block) => {
          const next = sanitizeContentBlock(block, maps);
          return next === undefined ? [] : [next];
        })
      : [],
    toolCallId: mappedId(maps.toolCallIds, event.toolCallId, "tool_call"),
    parentEventId: mappedId(maps.eventIds, event.parentEventId, "event"),
    rawReference: sanitizeRawReference(event.rawReference),
  });

const sanitizeToolCall = (toolCall: ToolCall, maps: SessionIdentityMap): ToolCall =>
  compactUndefined({
    id: mappedId(maps.toolCallIds, toolCall.id, "tool_call") ?? boundedIndexedId(toolCall.id, "tool_call"),
    sessionId: maps.sessionId,
    eventId: mappedId(maps.eventIds, toolCall.eventId, "event") ?? boundedIndexedId(toolCall.eventId, "event"),
    machineId: maps.machineId,
    provider: toolCall.provider,
    agentName: maps.agentName,
    projectIdentityKey: maps.projectIdentityKey,
    toolName: boundedToolName(toolCall.toolName),
    status: toolCall.status,
    input: boundedValue(toolCall.input, CONVEX_SAFE_INGEST_BUDGETS.toolInputBytes, [], 0, {
      preserveToolPatchFields: true,
    }),
    output: boundedValue(toolCall.output, CONVEX_SAFE_INGEST_BUDGETS.toolOutputBytes, [], 0, {
      preserveToolPatchFields: true,
    }),
    startedAt: toolCall.startedAt,
    completedAt: toolCall.completedAt,
  });

const sanitizeUsageRecord = (usageRecord: UsageRecord, maps: SessionIdentityMap): UsageRecord =>
  compactUndefined({
    id: mappedId(maps.usageRecordIds, usageRecord.id, "usage_record") ?? boundedIndexedId(usageRecord.id, "usage_record"),
    sessionId: maps.sessionId,
    eventId: mappedId(maps.eventIds, usageRecord.eventId, "event"),
    machineId: maps.machineId,
    provider: usageRecord.provider,
    agentName: maps.agentName,
    projectIdentityKey: maps.projectIdentityKey,
    timestamp: usageRecord.timestamp,
    model: usageRecord.model,
    modelProvider: usageRecord.modelProvider,
    inputTokens: usageRecord.inputTokens,
    outputTokens: usageRecord.outputTokens,
    reasoningTokens: usageRecord.reasoningTokens,
    cacheCreationInputTokens: usageRecord.cacheCreationInputTokens,
    cacheReadInputTokens: usageRecord.cacheReadInputTokens,
    totalTokens: usageRecord.totalTokens,
    cost: usageRecord.cost,
    currency: usageRecord.currency,
  });

const sanitizeArtifact = (artifact: Artifact, maps: SessionIdentityMap): Artifact => {
  const path = boundedLocator(artifact.path, "path");
  const uri = boundedLocator(artifact.uri, "uri");
  const sourcePath = boundedLocator(artifact.sourcePath, "sourcePath");
  const locatorOmissions = [path.omitted, uri.omitted, sourcePath.omitted].filter(
    (item): item is ReturnType<typeof omittedStringValue> => item !== undefined,
  );
  const metadataOptions = SESSION_PATCH_RECORD_TYPE.test(artifact.kind)
    ? { preserveSessionPatchFields: true }
    : {};
  const metadata = mergeArtifactMetadata(
    boundedValue(artifact.metadata, CONVEX_SAFE_INGEST_BUDGETS.metadataBytes, [], 0, metadataOptions),
    locatorOmissions,
  );
  return compactUndefined({
    id: mappedId(maps.artifactIds, artifact.id, "artifact") ?? boundedIndexedId(artifact.id, "artifact"),
    sessionId: maps.sessionId,
    eventId: mappedId(maps.eventIds, artifact.eventId, "event"),
    machineId: maps.machineId,
    provider: artifact.provider,
    agentName: maps.agentName,
    projectIdentityKey: maps.projectIdentityKey,
    kind: artifact.kind,
    path: path.value,
    uri: uri.value,
    contentHash: artifact.contentHash,
    sourcePath: sourcePath.value,
    sourceRef: boundedValue(artifact.sourceRef, CONVEX_SAFE_INGEST_BUDGETS.metadataBytes),
    metadata,
  });
};

const mergeArtifactMetadata = (
  metadata: unknown,
  omissions: readonly ReturnType<typeof omittedStringValue>[],
) => {
  if (omissions.length === 0) return metadata;
  const metadataRecord =
    metadata !== null && typeof metadata === "object" && !Array.isArray(metadata)
      ? (metadata as Record<string, unknown>)
      : metadata === undefined
        ? {}
        : { value: metadata };
  return boundedValue(
    {
      ...metadataRecord,
      __quasarOmitted: {
        reason: "artifact_locator_fields",
        fields: omissions,
      },
    },
    CONVEX_SAFE_INGEST_BUDGETS.metadataBytes,
  );
};

const sanitizeEdge = (edge: SessionEdge, maps: SessionIdentityMap): SessionEdge =>
  compactUndefined({
    id: mappedId(maps.edgeIds, edge.id, "session_edge") ?? boundedIndexedId(edge.id, "session_edge"),
    sessionId: maps.sessionId,
    machineId: maps.machineId,
    provider: edge.provider,
    agentName: maps.agentName,
    projectIdentityKey: maps.projectIdentityKey,
    kind: edge.kind,
    fromEventId: mappedId(maps.eventIds, edge.fromEventId, "event"),
    toEventId: mappedId(maps.eventIds, edge.toEventId, "event"),
    fromId: mappedKnownReferenceId(maps, edge.fromId),
    toId: mappedKnownReferenceId(maps, edge.toId),
    rawReference: boundedValue(edge.rawReference, CONVEX_SAFE_INGEST_BUDGETS.metadataBytes),
    metadata: boundedValue(edge.metadata, CONVEX_SAFE_INGEST_BUDGETS.metadataBytes),
  });

const compactUndefined = <A extends Record<string, unknown>>(record: A): A =>
  Object.fromEntries(Object.entries(record).filter(([, value]) => value !== undefined)) as A;

const sanitizeMachineIdentity = (machine: MachineIdentity): MachineIdentity =>
  compactUndefined({
    machineId: boundedMachineId(machine.machineId),
    hostname: boundedLocatorText(machine.hostname, RAW_REFERENCE_FIELD_BYTES),
    tailscaleName: boundedLocatorText(machine.tailscaleName, RAW_REFERENCE_FIELD_BYTES),
    platform: boundedLocatorText(machine.platform, RAW_REFERENCE_FIELD_BYTES),
  });

const sanitizeProjectSignal = (signal: ProjectSignal): ProjectSignal => ({
  kind: signal.kind,
  value: boundedLocatorText(signal.value, PROJECT_SIGNAL_VALUE_BYTES) ?? "[omitted:signalValue]",
  confidence: signal.confidence,
});

const sanitizeProjectIdentity = (
  project: ProjectResolution,
  projectIdentityKey = boundedProjectIdentityKey(project.projectIdentityKey),
): ProjectResolution =>
  compactUndefined({
    projectIdentityKey,
    displayName:
      boundedLocatorText(project.displayName, RAW_REFERENCE_FIELD_BYTES) ??
      projectIdentityKey,
    confidence: project.confidence,
    rawPath: boundedLocatorText(project.rawPath, PROJECT_IDENTITY_FIELD_BYTES),
    normalizedPath: boundedLocatorText(project.normalizedPath, PROJECT_IDENTITY_FIELD_BYTES),
    gitRemote: boundedLocatorText(project.gitRemote, PROJECT_IDENTITY_FIELD_BYTES),
    gitRemoteNormalized: boundedLocatorText(project.gitRemoteNormalized, PROJECT_IDENTITY_FIELD_BYTES),
    packageName: boundedLocatorText(project.packageName, RAW_REFERENCE_FIELD_BYTES),
    signals: project.signals.slice(0, PROJECT_SIGNAL_LIMIT).map(sanitizeProjectSignal),
  });

const sanitizeSourceRoot = (root: SourceRoot): SourceRoot =>
  compactUndefined({
    provider: root.provider,
    adapterId: boundedLocatorText(root.adapterId, RAW_REFERENCE_FIELD_BYTES) ?? root.adapterId,
    rootPath: boundedLocatorText(root.rootPath, INDEXED_LOCATOR_BYTES) ?? "[omitted:rootPath]",
    machineId: boundedMachineId(root.machineId),
    discoveredAt: boundedLocatorText(root.discoveredAt, RAW_REFERENCE_FIELD_BYTES) ?? root.discoveredAt,
  });

export const sanitizeSessionIntelligenceSession = (
  session: NormalizedSession,
): NormalizedSession => {
  const maps = collectSessionIdentityMap(session);
  return compactUndefined({
    id: maps.sessionId,
    nativeSessionId: maps.nativeSessionId,
    provider: session.provider,
    agentName: maps.agentName,
    machineId: maps.machineId,
    projectIdentity: sanitizeProjectIdentity(session.projectIdentity, maps.projectIdentityKey),
    nativeProjectKey: boundedLocatorText(session.nativeProjectKey, RAW_REFERENCE_SOURCE_PATH_BYTES),
    title: boundedText(session.title, SESSION_TITLE_BYTES),
    startedAt: session.startedAt,
    updatedAt: session.updatedAt,
    sourceRoot: boundedLocatorText(session.sourceRoot, RAW_REFERENCE_SOURCE_PATH_BYTES) ?? "[omitted:sourceRoot]",
    sourcePath: boundedLocatorText(session.sourcePath, RAW_REFERENCE_SOURCE_PATH_BYTES) ?? "[omitted:sourcePath]",
    events: session.events.map((event) => sanitizeEvent(event, maps)),
    toolCalls: session.toolCalls.map((toolCall) => sanitizeToolCall(toolCall, maps)),
    sessionEdges: session.sessionEdges.map((edge) => sanitizeEdge(edge, maps)),
    usageRecords: session.usageRecords.map((usageRecord) => sanitizeUsageRecord(usageRecord, maps)),
    artifacts: session.artifacts.map((artifact) => sanitizeArtifact(artifact, maps)),
    eventCount: session.eventCount,
    toolCallCount: session.toolCallCount,
    contentBlockCount: session.contentBlockCount,
    sessionEdgeCount: session.sessionEdgeCount,
    usageRecordCount: session.usageRecordCount,
    artifactCount: session.artifactCount,
  });
};

export const sanitizeSessionIntelligenceBatch = (batch: IngestBatch): IngestBatch => ({
  ...batch,
  machine: sanitizeMachineIdentity(batch.machine),
  sourceRoots: batch.sourceRoots.map(sanitizeSourceRoot),
  sessions: batch.sessions.map(sanitizeSessionIntelligenceSession),
  diagnostics: sanitizeSessionIntelligenceDiagnostics(batch.diagnostics),
});

const assertRecordBudget = (path: string, value: unknown, maxBytes: number) => {
  const bytes = jsonByteLength(value);
  if (bytes > maxBytes) throw new ConvexShapeViolationError(path, bytes, maxBytes);
};

const assertIndexedStringBudget = (path: string, value: string | undefined) => {
  if (value === undefined) return;
  const bytes = byteLength(value);
  if (bytes > INDEXED_ID_BYTES) throw new ConvexShapeViolationError(path, bytes, INDEXED_ID_BYTES);
};

const assertIndexedLocatorBudget = (path: string, value: string | undefined) => {
  if (value === undefined) return;
  const bytes = byteLength(value);
  if (bytes > INDEXED_LOCATOR_BYTES) throw new ConvexShapeViolationError(path, bytes, INDEXED_LOCATOR_BYTES);
};

export const assertConvexSafeSessionIntelligenceBatch = (
  batch: IngestBatch,
): IngestBatch => {
  assertIndexedStringBudget("machine.machineId", batch.machine.machineId);
  assertRecordBudget("machine", batch.machine, CONVEX_SAFE_INGEST_BUDGETS.machineRecordBytes);
  batch.sourceRoots.forEach((sourceRoot, index) => {
    assertIndexedStringBudget(`sourceRoots.${index}.machineId`, sourceRoot.machineId);
    assertIndexedLocatorBudget(`sourceRoots.${index}.rootPath`, sourceRoot.rootPath);
    assertRecordBudget(
      `sourceRoots.${index}`,
      sourceRoot,
      CONVEX_SAFE_INGEST_BUDGETS.sourceRootRecordBytes,
    );
  });
  for (const session of batch.sessions) {
    assertIndexedStringBudget(`sessions.${session.id}.id`, session.id);
    assertIndexedStringBudget(`sessions.${session.id}.nativeSessionId`, session.nativeSessionId);
    assertIndexedStringBudget(`sessions.${session.id}.machineId`, session.machineId);
    assertIndexedStringBudget(`sessions.${session.id}.agentName`, session.agentName);
    assertIndexedStringBudget(
      `sessions.${session.id}.projectIdentityKey`,
      session.projectIdentity.projectIdentityKey,
    );
    assertRecordBudget(
      `projectIdentities.${session.id}`,
      session.projectIdentity,
      CONVEX_SAFE_INGEST_BUDGETS.projectIdentityRecordBytes,
    );
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
      assertIndexedStringBudget(`sessionEvents.${event.id}.id`, event.id);
      assertIndexedStringBudget(`sessionEvents.${event.id}.sessionId`, event.sessionId);
      assertIndexedStringBudget(`sessionEvents.${event.id}.nativeEventId`, event.nativeEventId);
      assertIndexedStringBudget(`sessionEvents.${event.id}.machineId`, event.machineId);
      assertIndexedStringBudget(`sessionEvents.${event.id}.agentName`, event.agentName);
      assertIndexedStringBudget(`sessionEvents.${event.id}.projectIdentityKey`, event.projectIdentityKey);
      assertIndexedStringBudget(`sessionEvents.${event.id}.toolCallId`, event.toolCallId);
      assertIndexedStringBudget(`sessionEvents.${event.id}.parentEventId`, event.parentEventId);
      assertRecordBudget(
        `sessionEvents.${event.id}`,
        eventDoc,
        CONVEX_SAFE_INGEST_BUDGETS.eventRecordBytes,
      );
      for (const block of event.contentBlocks) {
        assertIndexedStringBudget(`contentBlocks.${block.id}.id`, block.id);
        assertRecordBudget(
          `contentBlocks.${block.id}`,
          block,
          CONVEX_SAFE_INGEST_BUDGETS.contentBlockRecordBytes,
        );
      }
    }
    for (const toolCall of session.toolCalls) {
      assertIndexedStringBudget(`toolCalls.${toolCall.id}.id`, toolCall.id);
      assertIndexedStringBudget(`toolCalls.${toolCall.id}.sessionId`, toolCall.sessionId);
      assertIndexedStringBudget(`toolCalls.${toolCall.id}.eventId`, toolCall.eventId);
      assertIndexedStringBudget(`toolCalls.${toolCall.id}.machineId`, toolCall.machineId);
      assertIndexedStringBudget(`toolCalls.${toolCall.id}.agentName`, toolCall.agentName);
      assertIndexedStringBudget(`toolCalls.${toolCall.id}.projectIdentityKey`, toolCall.projectIdentityKey);
      assertIndexedStringBudget(`toolCalls.${toolCall.id}.toolName`, toolCall.toolName);
      assertRecordBudget(
        `toolCalls.${toolCall.id}`,
        toolCall,
        CONVEX_SAFE_INGEST_BUDGETS.toolCallRecordBytes,
      );
    }
    for (const usageRecord of session.usageRecords) {
      assertIndexedStringBudget(`usageRecords.${usageRecord.id}.id`, usageRecord.id);
      assertIndexedStringBudget(`usageRecords.${usageRecord.id}.sessionId`, usageRecord.sessionId);
      assertIndexedStringBudget(`usageRecords.${usageRecord.id}.eventId`, usageRecord.eventId);
      assertIndexedStringBudget(`usageRecords.${usageRecord.id}.machineId`, usageRecord.machineId);
      assertIndexedStringBudget(`usageRecords.${usageRecord.id}.agentName`, usageRecord.agentName);
      assertIndexedStringBudget(`usageRecords.${usageRecord.id}.projectIdentityKey`, usageRecord.projectIdentityKey);
      assertRecordBudget(
        `usageRecords.${usageRecord.id}`,
        usageRecord,
        CONVEX_SAFE_INGEST_BUDGETS.usageRecordBytes,
      );
    }
    for (const artifact of session.artifacts) {
      assertIndexedStringBudget(`artifacts.${artifact.id}.id`, artifact.id);
      assertIndexedStringBudget(`artifacts.${artifact.id}.sessionId`, artifact.sessionId);
      assertIndexedStringBudget(`artifacts.${artifact.id}.eventId`, artifact.eventId);
      assertIndexedStringBudget(`artifacts.${artifact.id}.machineId`, artifact.machineId);
      assertIndexedStringBudget(`artifacts.${artifact.id}.agentName`, artifact.agentName);
      assertIndexedStringBudget(`artifacts.${artifact.id}.projectIdentityKey`, artifact.projectIdentityKey);
      assertRecordBudget(
        `artifacts.${artifact.id}`,
        artifact,
        CONVEX_SAFE_INGEST_BUDGETS.artifactRecordBytes,
      );
    }
    for (const edge of session.sessionEdges) {
      assertIndexedStringBudget(`sessionEdges.${edge.id}.id`, edge.id);
      assertIndexedStringBudget(`sessionEdges.${edge.id}.sessionId`, edge.sessionId);
      assertIndexedStringBudget(`sessionEdges.${edge.id}.machineId`, edge.machineId);
      assertIndexedStringBudget(`sessionEdges.${edge.id}.agentName`, edge.agentName);
      assertIndexedStringBudget(`sessionEdges.${edge.id}.projectIdentityKey`, edge.projectIdentityKey);
      assertIndexedStringBudget(`sessionEdges.${edge.id}.fromEventId`, edge.fromEventId);
      assertIndexedStringBudget(`sessionEdges.${edge.id}.toEventId`, edge.toEventId);
      assertIndexedStringBudget(`sessionEdges.${edge.id}.fromId`, edge.fromId);
      assertIndexedStringBudget(`sessionEdges.${edge.id}.toId`, edge.toId);
      assertRecordBudget(
        `sessionEdges.${edge.id}`,
        edge,
        CONVEX_SAFE_INGEST_BUDGETS.edgeRecordBytes,
      );
    }
  }
  batch.diagnostics.forEach((diagnostic, index) => {
    assertRecordBudget(
      `diagnostics.${index}`,
      diagnostic,
      CONVEX_SAFE_INGEST_BUDGETS.diagnosticRecordBytes,
    );
  });
  return batch;
};

export const assertConvexSafeSessionIntelligenceBatchEffect = (batch: IngestBatch) =>
  Effect.sync(() => assertConvexSafeSessionIntelligenceBatch(batch));

const decodeIngestBatch = (value: unknown): IngestBatch =>
  Schema.decodeUnknownSync(IngestBatchSchema)(value);

export const toConvexSafeSessionIntelligenceBatch = (batch: IngestBatch): IngestBatch => {
  const decoded = decodeIngestBatch(batch);
  const sanitized = sanitizeSessionIntelligenceBatch(decoded);
  return assertConvexSafeSessionIntelligenceBatch(decodeIngestBatch(sanitized));
};
