import { createHash } from "node:crypto";
import {
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
  type Dirent,
  type Stats,
} from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";

import { Database } from "bun:sqlite";
import { Schema } from "effect";

import { CursorSessionId, type SessionId } from "../core/identity";
import type {
  AdapterDiagnostic,
  ContentBlock,
  NormalizedSession,
  SessionEvent,
  SessionRole,
  ToolCall,
  UsageRecord,
} from "../core/schemas";
import {
  CursorAcpMetaSchema,
  CursorBlobRowSchema,
  CursorChatMetaSchema,
  CursorContentBlockSchema,
  CursorDatabaseMetadataSchema,
  CursorMessageSchema,
  CursorMetaRowSchema,
  CursorTableNameRowSchema,
  CursorUserVersionRowSchema,
  classifyCursorBlock,
  classifyCursorMessage,
  cursorBlockSchemaForType,
  type CursorAcpMeta,
  type CursorChatMeta,
  type CursorContentBlock,
  type CursorDatabaseMetadata,
  type CursorMessage,
} from "./cursor-schema";
import { type DecodeDiagnostic, decodeOrDrop, isSignal } from "./harness-schema";
import {
  buildSession,
  compactText,
  contentBlockIdFor,
  eventIdFor,
  homePath,
  logicalPathFor,
  logicalRootFor,
  projectSessionNativeValue,
  projectToolPayloadNativeValue,
  scopedId,
  sessionIdFor,
  sourceRoot,
  sqliteSnapshotForRead,
  usageIdFor,
  walkFiles,
} from "./common";
import {
  collectAdapterStream,
  type AdapterDiscoverOptions,
  type AdapterStreamItem,
  type SessionAdapter,
  type SourceUnit,
  type UnitFingerprint,
} from "./types";

const ADAPTER_ID = "cursor-agent-kv-sqlite";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HASH = /^[0-9a-f]{64}$/i;
const WORKSPACE_HASH = /^[0-9a-f]{32}$/i;
const fatalUtf8 = new TextDecoder("utf-8", { fatal: true });

type CursorSourceKind = "chat" | "acp";

type CursorCandidate = {
  readonly kind: CursorSourceKind;
  readonly dbPath: string;
  readonly metaPath: string;
  readonly nativeSessionId: string;
  readonly workspaceKey?: string;
  readonly physicalRoot: string;
  readonly logicalRoot: string;
};

type WireField = {
  readonly fieldNumber: number;
  readonly wireType: number;
  readonly bytes?: Uint8Array;
  readonly varint?: number;
};

export type CursorRootReferences = {
  readonly activeMessageRefs: readonly string[];
  readonly legacyArchiveRef?: string;
  readonly archiveRefs: readonly string[];
};

export type CursorSummaryArchive = {
  readonly messageRefs: readonly string[];
  readonly summary: string;
  readonly windowTail: number;
  readonly summaryMessageRef?: string;
};

type HydratedMessage = {
  readonly message: CursorMessage;
  readonly blobId: string;
  readonly rawBytes: number;
  readonly origin: "archive" | "active";
};

type ToolCallDraft = Omit<
  ToolCall,
  "sessionId" | "machineId" | "provider" | "agentName" | "projectIdentityKey"
>;

type UsageDraft = Omit<
  UsageRecord,
  "sessionId" | "machineId" | "provider" | "agentName" | "projectIdentityKey"
>;

type EventDraft = Omit<
  SessionEvent,
  "sessionId" | "machineId" | "provider" | "agentName" | "projectIdentityKey" | "contentBlocks"
> & { readonly contentBlocks?: readonly ContentBlock[] };

type ParsedCandidate = {
  readonly nativeSessionId: string;
  readonly rootBlobId: string;
  readonly updatedAtMs: number;
  readonly session: NormalizedSession;
  readonly sourceUnit: SourceUnit;
  readonly fingerprint: UnitFingerprint;
};

type CandidateResult = {
  readonly diagnostics: readonly AdapterDiagnostic[];
  readonly parsed?: ParsedCandidate;
};

class CursorFormatError extends Error {
  readonly diagnostic: string;

  constructor(diagnostic: string, message: string) {
    super(message);
    this.name = "CursorFormatError";
    this.diagnostic = diagnostic;
  }
}

const cursorDiagnostic = (
  rootPath: string,
  diagnostic: string,
  message: string,
  status: AdapterDiagnostic["status"] = "unsupported",
  details: Readonly<Record<string, unknown>> = {},
): AdapterDiagnostic => ({
  adapterId: ADAPTER_ID,
  provider: "cursor",
  status,
  parserConfidence: "observed",
  rootPath,
  message,
  details: { diagnostic, ...details },
});

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

const safeDirectories = (path: string): Dirent[] => {
  try {
    return readdirSync(path, { withFileTypes: true }).filter((entry) => entry.isDirectory());
  } catch {
    return [];
  }
};

const discoverCandidates = (root: string, logicalRoot: string): CursorCandidate[] => {
  const candidates: CursorCandidate[] = [];
  const chatsRoot = join(root, "chats");
  for (const workspace of safeDirectories(chatsRoot)) {
    if (!WORKSPACE_HASH.test(workspace.name)) continue;
    const workspacePath = join(chatsRoot, workspace.name);
    for (const session of safeDirectories(workspacePath)) {
      const dbPath = join(workspacePath, session.name, "store.db");
      if (!UUID.test(session.name) || !existsSync(dbPath)) continue;
      candidates.push({
        kind: "chat",
        dbPath,
        metaPath: join(workspacePath, session.name, "meta.json"),
        nativeSessionId: session.name,
        workspaceKey: workspace.name.toLowerCase(),
        physicalRoot: chatsRoot,
        logicalRoot: join(logicalRoot, "chats"),
      });
    }
  }

  const acpRoot = join(root, "acp-sessions");
  for (const session of safeDirectories(acpRoot)) {
    const dbPath = join(acpRoot, session.name, "store.db");
    if (!UUID.test(session.name) || !existsSync(dbPath)) continue;
    candidates.push({
      kind: "acp",
      dbPath,
      metaPath: join(acpRoot, session.name, "meta.json"),
      nativeSessionId: session.name,
      physicalRoot: acpRoot,
      logicalRoot: join(logicalRoot, "acp-sessions"),
    });
  }

  return candidates.sort((left, right) => left.dbPath.localeCompare(right.dbPath));
};

const fingerprintFiles = (candidate: CursorCandidate) =>
  [candidate.dbPath, `${candidate.dbPath}-wal`, `${candidate.dbPath}-shm`, candidate.metaPath]
    .filter(existsSync)
    .map((path) => ({ path, stats: statSync(path) }));

const cursorFingerprint = (
  candidate: CursorCandidate,
  files: readonly { readonly path: string; readonly stats: Stats }[],
): UnitFingerprint => ({
  tag: JSON.stringify(
    files.map(({ path, stats }) => ({
      path: relative(candidate.physicalRoot, path),
      size: stats.size,
      mtimeMs: stats.mtimeMs,
    })),
  ),
});

const decodeSchema = <A, I>(
  schema: Schema.Schema<A, I>,
  value: unknown,
  diagnosticName: string,
  diagnostics: DecodeDiagnostic[],
): A | undefined => {
  const decision = decodeOrDrop(schema, value, {
    kind: "decoded",
    diagnosticName,
    diagnostics,
  });
  return isSignal(decision) ? decision.value : undefined;
};

const decodeHexMetadata = (
  value: string,
  diagnostics: DecodeDiagnostic[],
): CursorDatabaseMetadata | undefined => {
  if (value.length === 0 || value.length % 2 !== 0 || !/^[0-9a-f]+$/i.test(value)) {
    diagnostics.push({
      name: "cursor.metadata.invalid_hex",
      message: "Cursor meta row 0 is not an even-length hexadecimal string.",
    });
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(fatalUtf8.decode(Buffer.from(value, "hex"))) as unknown;
  } catch (error) {
    diagnostics.push({ name: "cursor.metadata.invalid_json", message: errorText(error) });
    return undefined;
  }
  return decodeSchema(
    CursorDatabaseMetadataSchema,
    parsed,
    "cursor.metadata.invalid_json",
    diagnostics,
  );
};

const readSidecar = (
  candidate: CursorCandidate,
  diagnostics: DecodeDiagnostic[],
): CursorChatMeta | CursorAcpMeta | undefined => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(candidate.metaPath, "utf8")) as unknown;
  } catch (error) {
    diagnostics.push({
      name: existsSync(candidate.metaPath) ? "cursor.meta.invalid_json" : "cursor.meta.missing",
      message: errorText(error),
    });
    return undefined;
  }
  return candidate.kind === "chat"
    ? decodeSchema(CursorChatMetaSchema, parsed, "cursor.meta.invalid_json", diagnostics)
    : decodeSchema(CursorAcpMetaSchema, parsed, "cursor.meta.invalid_json", diagnostics);
};

const isChatMeta = (sidecar: CursorChatMeta | CursorAcpMeta): sidecar is CursorChatMeta =>
  "createdAtMs" in sidecar && "updatedAtMs" in sidecar && "hasConversation" in sidecar;

const readVarint = (bytes: Uint8Array, start: number) => {
  let value = 0n;
  let shift = 0n;
  let offset = start;
  while (offset < bytes.length && shift <= 63n) {
    const byte = bytes[offset];
    if (byte === undefined) break;
    offset += 1;
    value |= BigInt(byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) {
      if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
        throw new CursorFormatError("cursor.root_blob.decode_failed", "Protobuf varint exceeds the safe integer range.");
      }
      return { value: Number(value), offset };
    }
    shift += 7n;
  }
  throw new CursorFormatError("cursor.root_blob.decode_failed", "Truncated or overflowing protobuf varint.");
};

const decodeWireFields = (bytes: Uint8Array, diagnostic: string): WireField[] => {
  const fields: WireField[] = [];
  let offset = 0;
  while (offset < bytes.length) {
    let key;
    try {
      key = readVarint(bytes, offset);
    } catch (error) {
      throw new CursorFormatError(diagnostic, errorText(error));
    }
    offset = key.offset;
    const fieldNumber = Math.floor(key.value / 8);
    const wireType = key.value & 7;
    if (fieldNumber <= 0) {
      throw new CursorFormatError(diagnostic, "Protobuf field number must be positive.");
    }
    if (wireType === 0) {
      let scalar;
      try {
        scalar = readVarint(bytes, offset);
      } catch (error) {
        throw new CursorFormatError(diagnostic, errorText(error));
      }
      fields.push({ fieldNumber, wireType, varint: scalar.value });
      offset = scalar.offset;
      continue;
    }
    if (wireType === 1) {
      if (offset + 8 > bytes.length) {
        throw new CursorFormatError(diagnostic, "Truncated fixed64 field.");
      }
      fields.push({ fieldNumber, wireType, bytes: bytes.subarray(offset, offset + 8) });
      offset += 8;
      continue;
    }
    if (wireType === 2) {
      let length;
      try {
        length = readVarint(bytes, offset);
      } catch (error) {
        throw new CursorFormatError(diagnostic, errorText(error));
      }
      offset = length.offset;
      if (length.value < 0 || offset + length.value > bytes.length) {
        throw new CursorFormatError(diagnostic, "Length-delimited field exceeds the protobuf payload.");
      }
      fields.push({
        fieldNumber,
        wireType,
        bytes: bytes.subarray(offset, offset + length.value),
      });
      offset += length.value;
      continue;
    }
    if (wireType === 5) {
      if (offset + 4 > bytes.length) {
        throw new CursorFormatError(diagnostic, "Truncated fixed32 field.");
      }
      fields.push({ fieldNumber, wireType, bytes: bytes.subarray(offset, offset + 4) });
      offset += 4;
      continue;
    }
    throw new CursorFormatError(diagnostic, `Unsupported protobuf wire type ${wireType}.`);
  }
  return fields;
};

const referenceHex = (field: WireField, diagnostic: string) => {
  if (field.wireType !== 2 || field.bytes === undefined || field.bytes.length !== 32) {
    throw new CursorFormatError(diagnostic, `Field ${field.fieldNumber} is not a 32-byte blob reference.`);
  }
  return Buffer.from(field.bytes).toString("hex");
};

export const decodeCursorRoot = (bytes: Uint8Array): CursorRootReferences => {
  const activeMessageRefs: string[] = [];
  const archiveRefs: string[] = [];
  let legacyArchiveRef: string | undefined;
  for (const field of decodeWireFields(bytes, "cursor.root_blob.decode_failed")) {
    if (field.fieldNumber === 1) {
      activeMessageRefs.push(referenceHex(field, "cursor.root_blob.decode_failed"));
    } else if (field.fieldNumber === 11) {
      if (legacyArchiveRef !== undefined) {
        throw new CursorFormatError("cursor.root_blob.decode_failed", "Duplicate legacy summary_archive field.");
      }
      legacyArchiveRef = referenceHex(field, "cursor.root_blob.decode_failed");
    } else if (field.fieldNumber === 13) {
      archiveRefs.push(referenceHex(field, "cursor.root_blob.decode_failed"));
    }
  }
  return { activeMessageRefs, ...(legacyArchiveRef === undefined ? {} : { legacyArchiveRef }), archiveRefs };
};

export const decodeCursorSummaryArchive = (bytes: Uint8Array): CursorSummaryArchive => {
  const messageRefs: string[] = [];
  let summary = "";
  let windowTail = 0;
  let summaryMessageRef: string | undefined;
  for (const field of decodeWireFields(bytes, "cursor.summary_archive.decode_failed")) {
    if (field.fieldNumber === 1) {
      messageRefs.push(referenceHex(field, "cursor.summary_archive.decode_failed"));
    } else if (field.fieldNumber === 2) {
      if (field.wireType !== 2 || field.bytes === undefined) {
        throw new CursorFormatError("cursor.summary_archive.decode_failed", "Archive summary has the wrong wire type.");
      }
      try {
        summary = fatalUtf8.decode(field.bytes);
      } catch (error) {
        throw new CursorFormatError("cursor.summary_archive.decode_failed", errorText(error));
      }
    } else if (field.fieldNumber === 3) {
      if (field.wireType !== 0 || field.varint === undefined) {
        throw new CursorFormatError("cursor.summary_archive.decode_failed", "Archive window_tail has the wrong wire type.");
      }
      windowTail = field.varint;
    } else if (field.fieldNumber === 4) {
      summaryMessageRef = referenceHex(field, "cursor.summary_archive.decode_failed");
    }
  }
  return { messageRefs, summary, windowTail, ...(summaryMessageRef === undefined ? {} : { summaryMessageRef }) };
};

class CursorBlobReader {
  readonly db: Database;
  readonly diagnostics: DecodeDiagnostic[];

  constructor(db: Database, diagnostics: DecodeDiagnostic[]) {
    this.db = db;
    this.diagnostics = diagnostics;
  }

  get(blobId: string, missingDiagnostic: string): Uint8Array | undefined {
    const row = decodeSchema(
      CursorBlobRowSchema,
      this.db.query("select data from blobs where id = ?").get(blobId.toLowerCase()),
      missingDiagnostic,
      this.diagnostics,
    );
    if (row === undefined) return undefined;
    if (!(row.data instanceof Uint8Array)) {
      this.diagnostics.push({
        name: "cursor.store.unsupported_encoding",
        message: `Blob ${blobId} is not stored as SQLite BLOB data.`,
      });
      return undefined;
    }
    const data = new Uint8Array(row.data);
    const actual = createHash("sha256").update(data).digest("hex");
    if (actual !== blobId.toLowerCase()) {
      this.diagnostics.push({
        name: "cursor.merkle.hash_mismatch",
        message: `Blob ${blobId} hashes to ${actual}.`,
      });
      return undefined;
    }
    return data;
  }
}

const replaceBinaryMarkers = (
  value: unknown,
  diagnostics: DecodeDiagnostic[],
): unknown => {
  if (Array.isArray(value)) {
    return value.map((entry) => replaceBinaryMarkers(entry, diagnostics));
  }
  if (typeof value !== "object" || value === null) return value;
  if (
    "__type" in value &&
    "hex" in value &&
    value.__type === "Uint8Array" &&
    typeof value.hex === "string"
  ) {
    const validHex = value.hex.length % 2 === 0 && /^[0-9a-f]*$/i.test(value.hex);
    diagnostics.push({
      name: validHex ? "cursor.blob.binary_opaque" : "cursor.blob.unsupported_encoding",
      message: validHex
        ? `Opaque Cursor Uint8Array marker retained as byte length ${value.hex.length / 2}; hexadecimal payload dropped.`
        : "Malformed Cursor Uint8Array marker was dropped.",
    });
    return {
      __type: "OpaqueBinary",
      byteLength: validHex ? value.hex.length / 2 : 0,
    };
  }
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [
      key,
      replaceBinaryMarkers(entry, diagnostics),
    ]),
  );
};

const decodeMessageBlob = (
  blobId: string,
  bytes: Uint8Array,
  origin: HydratedMessage["origin"],
  diagnostics: DecodeDiagnostic[],
): HydratedMessage | undefined => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(fatalUtf8.decode(bytes)) as unknown;
  } catch (error) {
    diagnostics.push({ name: "cursor.message.invalid_json", message: errorText(error) });
    return undefined;
  }
  const message = decodeSchema(
    CursorMessageSchema,
    replaceBinaryMarkers(parsed, diagnostics),
    "cursor.message.invalid_content",
    diagnostics,
  );
  if (message === undefined) return undefined;
  const classification = classifyCursorMessage(message);
  if (!isSignal(classification)) {
    diagnostics.push({ name: classification.reason.split(":", 1)[0] ?? "cursor.message.invalid_role", message: classification.reason });
    return undefined;
  }
  return { message, blobId, rawBytes: bytes.length, origin };
};

const hydrateMessages = (
  root: CursorRootReferences,
  blobs: CursorBlobReader,
  diagnostics: DecodeDiagnostic[],
) => {
  const messages: HydratedMessage[] = [];
  let recoveredArchive = false;
  let complete = true;
  const archiveRefs = root.legacyArchiveRef === undefined
    ? [...root.archiveRefs]
    : [root.legacyArchiveRef, ...root.archiveRefs];
  if (root.legacyArchiveRef !== undefined) {
    diagnostics.push({
      name: "cursor.summary_archive.legacy_unsupported",
      message: "Hydrating legacy summary_archive before summaryArchives; installed exporter only iterates the plural field.",
    });
  }

  for (const archiveRef of archiveRefs) {
    const archiveBytes = blobs.get(archiveRef, "cursor.merkle.missing_child");
    if (archiveBytes === undefined) {
      complete = false;
      diagnostics.push({ name: "cursor.summary_archive.decode_failed", message: `Archive blob ${archiveRef} is unavailable.` });
      continue;
    }
    let archive: CursorSummaryArchive;
    try {
      archive = decodeCursorSummaryArchive(archiveBytes);
    } catch (error) {
      complete = false;
      diagnostics.push({ name: "cursor.summary_archive.decode_failed", message: errorText(error) });
      continue;
    }
    let archiveComplete = archive.messageRefs.length > 0;
    for (const messageRef of archive.messageRefs) {
      const messageBytes = blobs.get(messageRef, "cursor.merkle.missing_child");
      if (messageBytes === undefined) {
        archiveComplete = false;
        continue;
      }
      const message = decodeMessageBlob(messageRef, messageBytes, "archive", diagnostics);
      if (message === undefined) archiveComplete = false;
      else messages.push(message);
    }
    if (archive.summaryMessageRef !== undefined) {
      const summaryBytes = blobs.get(archive.summaryMessageRef, "cursor.merkle.missing_child");
      if (summaryBytes === undefined) archiveComplete = false;
    }
    if (archiveComplete) recoveredArchive = true;
    else {
      complete = false;
      diagnostics.push({ name: "cursor.summary_archive.decode_failed", message: `Archive ${archiveRef} was only partially recoverable.` });
    }
  }

  for (const messageRef of root.activeMessageRefs) {
    const messageBytes = blobs.get(messageRef, "cursor.merkle.missing_child");
    if (messageBytes === undefined) {
      complete = false;
      continue;
    }
    const message = decodeMessageBlob(messageRef, messageBytes, "active", diagnostics);
    if (message === undefined) complete = false;
    else messages.push(message);
  }
  return { messages, recoveredArchive, complete };
};

const blockType = (value: unknown): string | undefined => {
  if (typeof value !== "object" || value === null || Array.isArray(value) || !("type" in value)) return undefined;
  return typeof value.type === "string" ? value.type : undefined;
};

const decodeBlock = (
  value: unknown,
  diagnostics: DecodeDiagnostic[],
): CursorContentBlock | undefined => {
  const type = blockType(value);
  const schema = cursorBlockSchemaForType(type);
  if (schema === undefined) {
    diagnostics.push({
      name: "cursor.block.unknown_type",
      message: `Unknown Cursor content block type '${type ?? "<missing>"}'.`,
    });
    return undefined;
  }
  return decodeSchema(CursorContentBlockSchema, value, "cursor.block.missing_required_field", diagnostics);
};

const projectedText = (value: string) => compactText(projectSessionNativeValue(value));

const toolOutput = (
  blockResult: string,
  message: CursorMessage,
  diagnostics: DecodeDiagnostic[],
) => {
  let decodedResult: unknown = blockResult;
  try {
    decodedResult = replaceBinaryMarkers(JSON.parse(blockResult) as unknown, diagnostics);
  } catch {
    // Cursor tool results are dual-format: non-JSON text is authoritative output.
  }
  const projectedResult = projectToolPayloadNativeValue(decodedResult);
  const highLevel = message.providerOptions?.cursor?.highLevelToolCallResult;
  const projectedHighLevel = projectToolPayloadNativeValue(highLevel?.output);
  if (projectedHighLevel === undefined) return projectedResult;
  if (projectedResult === undefined) return projectedHighLevel;
  if (JSON.stringify(projectedResult) === JSON.stringify(projectedHighLevel)) return projectedResult;
  return { result: projectedResult, highLevel: projectedHighLevel };
};

const mapMessages = (
  hydrated: readonly HydratedMessage[],
  recoveredArchive: boolean,
  sessionId: SessionId,
  sourcePath: string,
  diagnostics: DecodeDiagnostic[],
) => {
  const events: EventDraft[] = [];
  const usageRecords: UsageDraft[] = [];
  const calls = new Map<string, ToolCallDraft>();

  const pushEvent = (
    source: HydratedMessage,
    blockIndex: number,
    role: SessionRole,
    kind: EventDraft["kind"],
    contentText: string | undefined,
    contentBlocks: readonly ContentBlock[],
    nativeType: string,
    nativeToolCallId?: string,
  ) => {
    const sequence = events.length;
    const stableKey = source.message.id ?? `${source.blobId}:${blockIndex}`;
    const id = eventIdFor(sessionId, sequence, stableKey);
    const canonicalToolId = nativeToolCallId === undefined
      ? undefined
      : scopedId(sessionId, "tool", nativeToolCallId);
    events.push({
      id,
      nativeEventId: source.message.id === undefined ? undefined : `${source.message.id}:${blockIndex}`,
      sequence,
      role,
      kind,
      ...(contentText === undefined ? {} : { contentText }),
      contentBlocks,
      ...(canonicalToolId === undefined ? {} : { toolCallId: canonicalToolId }),
      rawReference: {
        sourcePath,
        table: "blobs",
        rowId: source.blobId,
        nativeType,
        rawBytes: source.rawBytes,
      },
    });
    return { id, canonicalToolId };
  };

  for (const source of hydrated) {
    const message = source.message;
    const classification = classifyCursorMessage(message);
    if (!isSignal(classification)) continue;
    const syntheticSummary = source.origin === "active" && message.providerOptions?.cursor?.isSummary === true;
    if (syntheticSummary && recoveredArchive) continue;
    const content = message.content;
    if (typeof content === "string") {
      const text = projectedText(content);
      if (text === undefined) continue;
      const kind = syntheticSummary
        ? "summary"
        : classification.kind === "system"
          ? "system"
          : classification.kind;
      const sequence = events.length;
      const stableKey = message.id ?? `${source.blobId}:0`;
      const id = eventIdFor(sessionId, sequence, stableKey);
      pushEvent(source, 0, classification.value.role, kind, text, [{
        id: contentBlockIdFor(sessionId, id, 0),
        sequence: 0,
        kind: "text",
        text,
      }], `${message.role}:string`);
      continue;
    }
    if (content.length === 0) {
      diagnostics.push({ name: "cursor.message.invalid_content", message: `Message ${source.blobId} has an empty content array.` });
      continue;
    }

    for (let blockIndex = 0; blockIndex < content.length; blockIndex += 1) {
      const block = decodeBlock(content[blockIndex], diagnostics);
      if (block === undefined) continue;
      const blockDecision = classifyCursorBlock(block);
      if (!isSignal(blockDecision)) continue;
      if (block.type === "text") {
        const text = projectedText(block.text);
        if (text === undefined) continue;
        const kind = syntheticSummary
          ? "summary"
          : classification.kind === "system"
            ? "system"
            : "message";
        const sequence = events.length;
        const stableKey = message.id ?? `${source.blobId}:${blockIndex}`;
        const id = eventIdFor(sessionId, sequence, stableKey);
        pushEvent(source, blockIndex, classification.value.role, kind, text, [{
          id: contentBlockIdFor(sessionId, id, 0),
          sequence: 0,
          kind: "text",
          text,
        }], `${message.role}:text`);
        continue;
      }
      if (block.type === "reasoning") {
        const text = projectedText(block.text);
        const sequence = events.length;
        const stableKey = message.id ?? `${source.blobId}:${blockIndex}`;
        const id = eventIdFor(sessionId, sequence, stableKey);
        const contentBlocks: ContentBlock[] = text === undefined
          ? []
          : [{
              id: contentBlockIdFor(sessionId, id, 0),
              sequence: 0,
              kind: "thinking",
              thinking: text,
            }];
        const emitted = pushEvent(
          source,
          blockIndex,
          "thinking",
          "reasoning",
          text,
          contentBlocks,
          `${message.role}:reasoning`,
        );
        const model = block.providerOptions?.cursor?.modelName;
        if (model !== undefined) {
          usageRecords.push({
            id: usageIdFor(sessionId, emitted.id, usageRecords.length),
            eventId: emitted.id,
            model,
            modelProvider: "cursor",
          });
        }
        continue;
      }
      if (block.type === "redacted-reasoning") {
        const text = projectedText(block.text ?? "[Redacted reasoning]");
        if (text === undefined) continue;
        const sequence = events.length;
        const stableKey = message.id ?? `${source.blobId}:${blockIndex}`;
        const id = eventIdFor(sessionId, sequence, stableKey);
        pushEvent(source, blockIndex, "thinking", "reasoning", text, [{
          id: contentBlockIdFor(sessionId, id, 0),
          sequence: 0,
          kind: "thinking",
          thinking: text,
        }], `${message.role}:redacted-reasoning`);
        continue;
      }
      if (block.type === "tool-call") {
        const sequence = events.length;
        const stableKey = message.id ?? `${source.blobId}:${blockIndex}`;
        const eventId = eventIdFor(sessionId, sequence, stableKey);
        const emitted = pushEvent(
          source,
          blockIndex,
          "assistant",
          "tool_call",
          undefined,
          [],
          `${message.role}:tool-call`,
          block.toolCallId,
        );
        if (calls.has(block.toolCallId)) {
          diagnostics.push({ name: "cursor.tool_call.duplicate_id", message: `Duplicate tool call id ${block.toolCallId}.` });
          continue;
        }
        const input = projectToolPayloadNativeValue(block.args);
        calls.set(block.toolCallId, {
          id: emitted.canonicalToolId ?? scopedId(sessionId, "tool", block.toolCallId),
          eventId,
          toolName: block.toolName,
          status: "pending",
          ...(input === undefined ? {} : { input }),
        });
        continue;
      }
      if (block.type === "tool-result") {
        const emitted = pushEvent(
          source,
          blockIndex,
          "tool",
          "tool_result",
          projectedText(block.result),
          [],
          `${message.role}:tool-result`,
          block.toolCallId,
        );
        const call = calls.get(block.toolCallId);
        if (call === undefined) {
          diagnostics.push({ name: "cursor.tool_call.orphan_result", message: `No tool call precedes result ${block.toolCallId}.` });
          continue;
        }
        const highLevel = message.providerOptions?.cursor?.highLevelToolCallResult;
        const output = toolOutput(block.result, message, diagnostics);
        calls.set(block.toolCallId, {
          ...call,
          id: emitted.canonicalToolId ?? call.id,
          status: highLevel?.isError === true ? "failed" : "completed",
          ...(output === undefined ? {} : { output }),
        });
        continue;
      }
      if (block.type === "image") {
        const sequence = events.length;
        const stableKey = message.id ?? `${source.blobId}:${blockIndex}`;
        const id = eventIdFor(sessionId, sequence, stableKey);
        pushEvent(source, blockIndex, classification.value.role, "message", undefined, [{
          id: contentBlockIdFor(sessionId, id, 0),
          sequence: 0,
          kind: "image",
          ...(block.uri === undefined ? {} : { uri: block.uri }),
          ...(block.mediaType === undefined ? {} : { mediaType: block.mediaType }),
          ...(block.image === undefined ? {} : { value: projectSessionNativeValue(block.image) }),
        }], `${message.role}:image`);
        continue;
      }
      if (block.type === "file") {
        const sequence = events.length;
        const stableKey = message.id ?? `${source.blobId}:${blockIndex}`;
        const id = eventIdFor(sessionId, sequence, stableKey);
        pushEvent(source, blockIndex, classification.value.role, "message", block.filename, [{
          id: contentBlockIdFor(sessionId, id, 0),
          sequence: 0,
          kind: "file",
          ...(block.filename === undefined ? {} : { path: block.filename }),
          ...(block.uri === undefined ? {} : { uri: block.uri }),
          ...(block.mediaType === undefined ? {} : { mediaType: block.mediaType }),
          ...(block.data === undefined ? {} : { value: projectSessionNativeValue(block.data) }),
        }], `${message.role}:file`);
      }
    }
  }

  return { events, toolCalls: [...calls.values()], usageRecords };
};

const toIso = (milliseconds: number | undefined) =>
  milliseconds === undefined || !Number.isFinite(milliseconds)
    ? undefined
    : new Date(milliseconds).toISOString();

const parseCandidate = async (
  candidate: CursorCandidate,
  options: AdapterDiscoverOptions,
): Promise<CandidateResult> => {
  const decodeDiagnostics: DecodeDiagnostic[] = [];
  const adapterDiagnostics: AdapterDiagnostic[] = [];
  const logicalDbPath = logicalPathFor(
    candidate.dbPath,
    candidate.physicalRoot,
    candidate.logicalRoot,
  );
  const files = fingerprintFiles(candidate);
  if (options.shouldReadFile !== undefined) {
    const changed = files
      .map(({ path, stats }) => options.shouldReadFile?.(path, stats) !== false)
      .includes(true);
    if (!changed) return { diagnostics: [] };
  }
  const fingerprint = cursorFingerprint(candidate, files);
  const sidecar = readSidecar(candidate, decodeDiagnostics);
  if (sidecar === undefined) {
    return {
      diagnostics: decodeDiagnostics.map((diagnostic) =>
        cursorDiagnostic(logicalDbPath, diagnostic.name, diagnostic.message)),
    };
  }
  if (!isAbsolute(sidecar.cwd)) {
    decodeDiagnostics.push({ name: "cursor.meta.cwd_not_absolute", message: `Cursor cwd '${sidecar.cwd}' is not absolute.` });
  }
  if (candidate.kind === "chat" && candidate.workspaceKey !== undefined) {
    const expectedWorkspace = createHash("md5").update(resolve(sidecar.cwd)).digest("hex");
    if (expectedWorkspace !== candidate.workspaceKey) {
      decodeDiagnostics.push({
        name: "cursor.meta.cwd_mismatch",
        message: `Cursor cwd hashes to ${expectedWorkspace}, not ${candidate.workspaceKey}.`,
      });
    }
  }
  if (decodeDiagnostics.length > 0) {
    return {
      diagnostics: decodeDiagnostics.map((diagnostic) =>
        cursorDiagnostic(logicalDbPath, diagnostic.name, diagnostic.message)),
    };
  }

  let snapshot;
  try {
    snapshot = sqliteSnapshotForRead(candidate.dbPath, { label: "cursor" });
  } catch (error) {
    return {
      diagnostics: [cursorDiagnostic(logicalDbPath, "cursor.store.snapshot_failed", errorText(error))],
    };
  }

  let db: Database | undefined;
  try {
    db = new Database(snapshot.path, { readonly: true });
    const version = decodeSchema(
      CursorUserVersionRowSchema,
      db.query("pragma user_version").get(),
      "cursor.store.schema_unsupported",
      decodeDiagnostics,
    );
    const tables = db
      .query("select name from sqlite_master where type = 'table' and name in ('blobs', 'meta') order by name")
      .all()
      .flatMap((row) => {
        const decoded = decodeSchema(
          CursorTableNameRowSchema,
          row,
          "cursor.store.schema_unsupported",
          decodeDiagnostics,
        );
        return decoded === undefined ? [] : [decoded.name];
      });
    if (version?.user_version !== 1 || tables.join(",") !== "blobs,meta") {
      throw new CursorFormatError(
        "cursor.store.schema_unsupported",
        `Expected schema version 1 with blobs/meta tables; got version ${version?.user_version ?? "invalid"} and ${tables.join(",") || "no tables"}.`,
      );
    }

    const metaRow = decodeSchema(
      CursorMetaRowSchema,
      db.query("select value from meta where key = ?").get("0"),
      "cursor.metadata.missing",
      decodeDiagnostics,
    );
    if (metaRow === undefined) {
      throw new CursorFormatError("cursor.metadata.missing", "Cursor metadata row key 0 is missing.");
    }
    const metadata = decodeHexMetadata(metaRow.value, decodeDiagnostics);
    if (metadata === undefined) {
      throw new CursorFormatError("cursor.metadata.invalid_json", "Cursor metadata row could not be decoded.");
    }
    if (!UUID.test(metadata.agentId) || !UUID.test(candidate.nativeSessionId)) {
      throw new CursorFormatError("cursor.session.invalid_uuid", "Cursor session identity is not a UUID.");
    }
    if (metadata.agentId.toLowerCase() !== candidate.nativeSessionId.toLowerCase()) {
      throw new CursorFormatError(
        "cursor.session.id_mismatch",
        `Directory id ${candidate.nativeSessionId} does not match metadata agentId ${metadata.agentId}.`,
      );
    }
    const nativeSessionId = metadata.agentId.toLowerCase();
    if (!HASH.test(metadata.latestRootBlobId)) {
      throw new CursorFormatError("cursor.metadata.invalid_hex", "latestRootBlobId is not a 32-byte hexadecimal hash.");
    }
    if (metadata.subagentInfo !== undefined) {
      decodeDiagnostics.push({ name: "cursor.subagent_info.unsupported", message: "Cursor subagentInfo lineage is not decoded by this adapter." });
    }
    const chatMeta = isChatMeta(sidecar) ? sidecar : undefined;
    if (candidate.kind === "chat" && chatMeta === undefined) {
      throw new CursorFormatError(
        "cursor.meta.invalid_json",
        "Normal Cursor chat sidecar did not contain the chat timestamp fields.",
      );
    }
    if (chatMeta !== undefined && chatMeta.createdAtMs !== metadata.createdAt) {
      decodeDiagnostics.push({
        name: "cursor.meta.timestamp_mismatch",
        message: `Sidecar createdAtMs ${chatMeta.createdAtMs} differs from Agent-KV createdAt ${metadata.createdAt}.`,
      });
    }

    const sessionId = sessionIdFor("cursor", CursorSessionId(nativeSessionId));
    if (options.shouldParseSession !== undefined) {
      const shouldParse = await options.shouldParseSession({
        sessionId,
        sourceFingerprint: JSON.stringify(fingerprint),
      });
      if (!shouldParse) return { diagnostics: [] };
    }

    const blobs = new CursorBlobReader(db, decodeDiagnostics);
    const rootBytes = blobs.get(metadata.latestRootBlobId, "cursor.root_blob.missing");
    if (rootBytes === undefined) {
      throw new CursorFormatError("cursor.root_blob.missing", `Current root ${metadata.latestRootBlobId} is unavailable or corrupt.`);
    }
    let rootReferences: CursorRootReferences;
    try {
      rootReferences = decodeCursorRoot(rootBytes);
    } catch (error) {
      throw new CursorFormatError("cursor.root_blob.decode_failed", errorText(error));
    }
    const hydration = hydrateMessages(rootReferences, blobs, decodeDiagnostics);
    if (!hydration.complete) {
      throw new CursorFormatError(
        "cursor.merkle.incomplete",
        "Cursor root references unavailable or invalid child blobs.",
      );
    }
    const mapped = mapMessages(
      hydration.messages,
      hydration.recoveredArchive,
      sessionId,
      logicalDbPath,
      decodeDiagnostics,
    );
    const updatedAtMs = chatMeta?.updatedAtMs ?? statSync(candidate.dbPath).mtimeMs;
    const title = metadata.name.trim().length > 0 ? metadata.name : sidecar.title;
    const session = buildSession({
      provider: "cursor",
      agentName: candidate.kind === "chat" ? "cursor-agent" : "cursor-agent-acp",
      machine: options.machine,
      sessionId,
      nativeSessionId,
      nativeProjectKey: candidate.workspaceKey,
      title,
      startedAt: toIso(metadata.createdAt),
      updatedAt: toIso(updatedAtMs),
      sourceRoot: candidate.logicalRoot,
      sourcePath: logicalDbPath,
      projectPath: sidecar.cwd,
      events: mapped.events,
      toolCalls: mapped.toolCalls,
      usageRecords: mapped.usageRecords,
    });

    for (const diagnostic of decodeDiagnostics) {
      adapterDiagnostics.push(cursorDiagnostic(logicalDbPath, diagnostic.name, diagnostic.message));
    }
    return {
      diagnostics: adapterDiagnostics,
      parsed: {
        nativeSessionId,
        rootBlobId: metadata.latestRootBlobId.toLowerCase(),
        updatedAtMs,
        session,
        sourceUnit: {
          provider: "cursor",
          adapterId: ADAPTER_ID,
          rootPath: candidate.logicalRoot,
          sourcePath: logicalDbPath,
          physicalPath: candidate.dbPath,
        },
        fingerprint,
      },
    };
  } catch (error) {
    const diagnostic = error instanceof CursorFormatError
      ? error.diagnostic
      : "cursor.store.schema_unsupported";
    return {
      diagnostics: [
        ...decodeDiagnostics.map((entry) => cursorDiagnostic(logicalDbPath, entry.name, entry.message)),
        cursorDiagnostic(logicalDbPath, diagnostic, errorText(error)),
      ],
    };
  } finally {
    db?.close();
    snapshot.cleanup();
  }
};

const transcriptDiagnostics = (root: string, logicalRoot: string, hasStores: boolean) => {
  const projectsRoot = join(root, "projects");
  if (!existsSync(projectsRoot)) return [];
  const transcripts = walkFiles(
    projectsRoot,
    (path) => path.includes(`${join("agent-transcripts", "")}`) && path.endsWith(".jsonl"),
  );
  if (transcripts.length === 0) return [];
  const diagnostic = hasStores
    ? "cursor.transcript.duplicate_incomplete"
    : "cursor.transcript.orphan_incomplete";
  return [cursorDiagnostic(
    logicalRoot,
    diagnostic,
    `${transcripts.length} derived agent-transcript export(s) were rejected; Agent-KV store.db is the only authoritative source.`,
  )];
};

async function* streamCursor(options: AdapterDiscoverOptions): AsyncGenerator<AdapterStreamItem> {
  const root = options.roots?.cursor ?? cursorAdapter.defaultRoot();
  if (root === undefined) {
    yield {
      type: "diagnostic",
      diagnostic: cursorDiagnostic("", "cursor.root.not_found", "Cursor configuration root is unavailable.", "no_data_found"),
    };
    return;
  }
  const logicalRoot = logicalRootFor("cursor", root, options);
  const candidates = discoverCandidates(root, logicalRoot);
  const physicalRoots = [join(root, "chats"), join(root, "acp-sessions")].filter(existsSync);
  for (const physicalRoot of physicalRoots) {
    const logicalSourceRoot = logicalPathFor(physicalRoot, root, logicalRoot);
    yield {
      type: "sourceRoot",
      sourceRoot: sourceRoot("cursor", ADAPTER_ID, logicalSourceRoot, options.machine, options.now),
    };
  }
  for (const diagnostic of transcriptDiagnostics(root, logicalRoot, candidates.length > 0)) {
    yield { type: "diagnostic", diagnostic };
  }
  if (candidates.length === 0) {
    yield {
      type: "diagnostic",
      diagnostic: cursorDiagnostic(
        logicalRoot,
        "cursor.root.not_found",
        "No Cursor chats/*/*/store.db or acp-sessions/*/store.db files were found.",
        "no_data_found",
      ),
    };
    return;
  }

  const parsed: ParsedCandidate[] = [];
  for (const candidate of candidates) {
    const result = await parseCandidate(candidate, options);
    for (const diagnostic of result.diagnostics) yield { type: "diagnostic", diagnostic };
    if (result.parsed !== undefined) parsed.push(result.parsed);
  }

  const byNativeId = new Map<string, ParsedCandidate>();
  for (const candidate of parsed) {
    const key = candidate.nativeSessionId;
    const existing = byNativeId.get(key);
    if (existing === undefined) {
      byNativeId.set(key, candidate);
      continue;
    }
    if (existing.rootBlobId === candidate.rootBlobId) {
      yield {
        type: "diagnostic",
        diagnostic: cursorDiagnostic(
          logicalRoot,
          "cursor.session.duplicate_root",
          `Duplicate Cursor session ${candidate.nativeSessionId} has the same current root; emitting one canonical session.`,
        ),
      };
      if (candidate.updatedAtMs > existing.updatedAtMs) byNativeId.set(key, candidate);
      continue;
    }
    yield {
      type: "diagnostic",
      diagnostic: cursorDiagnostic(
        logicalRoot,
        "cursor.session.conflicting_roots",
        `Cursor session ${candidate.nativeSessionId} has conflicting current roots; emitting the newer explicit source.`,
      ),
    };
    if (candidate.updatedAtMs > existing.updatedAtMs) byNativeId.set(key, candidate);
  }

  const selected = [...byNativeId.values()]
    .sort((left, right) => right.updatedAtMs - left.updatedAtMs || left.nativeSessionId.localeCompare(right.nativeSessionId))
    .slice(Math.max(0, Math.floor(options.skip ?? 0)), options.limit === undefined
      ? undefined
      : Math.max(0, Math.floor(options.skip ?? 0)) + Math.max(0, Math.floor(options.limit)));
  for (const candidate of selected) {
    yield {
      type: "session",
      session: candidate.session,
      sourceUnit: candidate.sourceUnit,
      fingerprint: candidate.fingerprint,
    };
  }

  yield {
    type: "diagnostic",
    diagnostic: cursorDiagnostic(
      logicalRoot,
      selected.length > 0 ? "cursor.sessions.available" : "cursor.sessions.no_data",
      `Discovered ${selected.length} authoritative Cursor Agent session(s).`,
      selected.length > 0 ? "available" : "no_data_found",
    ),
  };
}

export const cursorAdapter: SessionAdapter = {
  id: ADAPTER_ID,
  provider: "cursor",
  displayName: "Cursor Agent-KV SQLite",
  stable: true,
  defaultRoot: () => process.env.QUASAR_CURSOR_ROOT ?? process.env.CURSOR_HOME ?? homePath(".cursor"),
  read: async (options) => collectAdapterStream(streamCursor(options)),
  stream: streamCursor,
};
