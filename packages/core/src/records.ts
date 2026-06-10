import { Effect, Schema } from "effect";

import { stableCanonicalJsonHash } from "./hash";
import {
  Artifact,
  ContentBlockKind,
  MachineIdentity,
  ProjectResolution,
  Provider,
  RawReference,
  SessionEdge,
  SessionEventKind,
  SessionRole,
  SourceRoot,
  ToolCall,
  UsageRecord,
  type NormalizedSession,
} from "./schemas";

const NonNegativeInteger = Schema.Number.pipe(
  Schema.filter((value) => Number.isInteger(value) && value >= 0, {
    message: () => "Expected a non-negative integer",
  }),
);

const PositiveInteger = Schema.Number.pipe(
  Schema.filter((value) => Number.isInteger(value) && value > 0, {
    message: () => "Expected a positive integer",
  }),
);

export const RECORD_PROTOCOL = "quasar-records/v1" as const;

export const RecordLimits = Schema.Struct({
  maxRecordBytes: PositiveInteger,
  maxEnvelopeBytes: PositiveInteger,
  maxRecordsPerEnvelope: PositiveInteger,
});
export type RecordLimits = typeof RecordLimits.Type;

export const RECORD_LIMITS: RecordLimits = {
  maxRecordBytes: 32 * 1024,
  maxEnvelopeBytes: 480 * 1024,
  maxRecordsPerEnvelope: 200,
};

export const SessionRecord = Schema.Struct({
  id: Schema.String,
  nativeSessionId: Schema.String,
  provider: Provider,
  agentName: Schema.String,
  machineId: Schema.String,
  projectIdentity: ProjectResolution,
  nativeProjectKey: Schema.optional(Schema.String),
  title: Schema.optional(Schema.String),
  startedAt: Schema.optional(Schema.String),
  updatedAt: Schema.optional(Schema.String),
  sourceRoot: Schema.String,
  sourcePath: Schema.String,
  eventCount: NonNegativeInteger,
  toolCallCount: NonNegativeInteger,
  contentBlockCount: NonNegativeInteger,
  sessionEdgeCount: NonNegativeInteger,
  usageRecordCount: NonNegativeInteger,
  artifactCount: NonNegativeInteger,
});
export type SessionRecord = typeof SessionRecord.Type;

export const EventRecord = Schema.Struct({
  id: Schema.String,
  sessionId: Schema.String,
  nativeEventId: Schema.optional(Schema.String),
  sequence: NonNegativeInteger,
  timestamp: Schema.optional(Schema.String),
  machineId: Schema.String,
  provider: Provider,
  agentName: Schema.String,
  projectIdentityKey: Schema.String,
  role: SessionRole,
  kind: SessionEventKind,
  contentText: Schema.optional(Schema.String),
  toolCallId: Schema.optional(Schema.String),
  parentEventId: Schema.optional(Schema.String),
  rawReference: RawReference,
});
export type EventRecord = typeof EventRecord.Type;

export const ContentBlockRecord = Schema.Struct({
  id: Schema.String,
  eventId: Schema.String,
  sessionId: Schema.String,
  machineId: Schema.String,
  provider: Provider,
  agentName: Schema.String,
  projectIdentityKey: Schema.String,
  sequence: NonNegativeInteger,
  kind: ContentBlockKind,
  text: Schema.optional(Schema.String),
  markdown: Schema.optional(Schema.String),
  thinking: Schema.optional(Schema.String),
  path: Schema.optional(Schema.String),
  uri: Schema.optional(Schema.String),
  mediaType: Schema.optional(Schema.String),
  value: Schema.optional(Schema.Unknown),
  metadata: Schema.optional(Schema.Unknown),
});
export type ContentBlockRecord = typeof ContentBlockRecord.Type;

export const IngestRecordType = Schema.Literal(
  "session",
  "event",
  "content_block",
  "tool_call",
  "usage",
  "artifact",
  "edge",
  "source_root",
  "tombstone",
);
export type IngestRecordType = typeof IngestRecordType.Type;

export const TombstoneRecordType = Schema.Literal(
  "session",
  "event",
  "content_block",
  "tool_call",
  "usage",
  "artifact",
  "edge",
  "source_root",
);
export type TombstoneRecordType = typeof TombstoneRecordType.Type;

export const TombstoneRecord = Schema.Struct({
  recordType: TombstoneRecordType,
  recordId: Schema.String,
});
export type TombstoneRecord = typeof TombstoneRecord.Type;

export const IngestRecord = Schema.Union(
  Schema.Struct({ type: Schema.Literal("session"), record: SessionRecord }),
  Schema.Struct({ type: Schema.Literal("event"), record: EventRecord }),
  Schema.Struct({ type: Schema.Literal("content_block"), record: ContentBlockRecord }),
  Schema.Struct({ type: Schema.Literal("tool_call"), record: ToolCall }),
  Schema.Struct({ type: Schema.Literal("usage"), record: UsageRecord }),
  Schema.Struct({ type: Schema.Literal("artifact"), record: Artifact }),
  Schema.Struct({ type: Schema.Literal("edge"), record: SessionEdge }),
  Schema.Struct({ type: Schema.Literal("source_root"), record: SourceRoot }),
  Schema.Struct({ type: Schema.Literal("tombstone"), record: TombstoneRecord }),
);
export type IngestRecord = typeof IngestRecord.Type;

export const RecordEnvelope = Schema.Struct({
  protocol: Schema.Literal(RECORD_PROTOCOL),
  machine: MachineIdentity,
  records: Schema.Array(IngestRecord),
});
export type RecordEnvelope = typeof RecordEnvelope.Type;

export const IngestRecordsResponse = Schema.Struct({
  protocol: Schema.Literal(RECORD_PROTOCOL),
  applied: NonNegativeInteger,
  unchanged: NonNegativeInteger,
  tombstoned: NonNegativeInteger,
  backpressure: Schema.Struct({
    outboxDepth: NonNegativeInteger,
    retryAfterMs: Schema.Union(NonNegativeInteger, Schema.Null),
  }),
  limits: RecordLimits,
});
export type IngestRecordsResponse = typeof IngestRecordsResponse.Type;

export class RecordContractError extends Schema.TaggedError<RecordContractError>()(
  "RecordContractError",
  {
    reason: Schema.Literal(
      "invalid_envelope",
      "invalid_limits",
      "record_too_large",
      "envelope_too_large",
    ),
    message: Schema.String,
    recordId: Schema.optional(Schema.String),
  },
) {}

export type PackRecordEnvelopesInput = {
  readonly machine: MachineIdentity;
  readonly records: Iterable<IngestRecord>;
  readonly limits?: Partial<RecordLimits>;
};

const textEncoder = new TextEncoder();

const wireBytesOf = (value: unknown) => {
  try {
    const serialized = JSON.stringify(value);
    return serialized === undefined ? undefined : textEncoder.encode(serialized).byteLength;
  } catch (_error) {
    return undefined;
  }
};

const sourceRootRecordId = (record: SourceRoot) =>
  `source_root:${record.provider}:${record.machineId}:${stableCanonicalJsonHash([
    record.adapterId,
    record.rootPath,
  ])}`;

export const recordId = (record: IngestRecord): string => {
  switch (record.type) {
    case "source_root":
      return sourceRootRecordId(record.record);
    case "tombstone":
      return record.record.recordId;
    default:
      return record.record.id;
  }
};

const recordWireFailure = (record: IngestRecord) =>
  new RecordContractError({
    reason: "invalid_envelope",
    message: `Record ${recordId(record)} is not JSON serializable.`,
    recordId: recordId(record),
  });

const envelopeWireFailure = () =>
  new RecordContractError({
    reason: "invalid_envelope",
    message: "Record envelope is not JSON serializable.",
  });

export const recordWireBytes = (record: IngestRecord) => {
  const bytes = wireBytesOf(record);
  return bytes ?? Number.POSITIVE_INFINITY;
};

type TruncationMarker = {
  readonly truncated: true;
  readonly bytes: number;
};

type EventIngestRecord = Extract<IngestRecord, { readonly type: "event" }>;
type ContentBlockIngestRecord = Extract<IngestRecord, { readonly type: "content_block" }>;

const isObject = (value: unknown): value is { readonly [key: string]: unknown } =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isTruncationMarker = (value: unknown): value is TruncationMarker =>
  isObject(value) && value.truncated === true && typeof value.bytes === "number";

const truncationMarkerFor = (value: unknown): TruncationMarker => ({
  truncated: true,
  bytes: wireBytesOf(value) ?? 0,
});

const clampPayload = (value: unknown) =>
  isTruncationMarker(value) ? value : truncationMarkerFor(value);

const stringBytes = (value: string) => textEncoder.encode(value).byteLength;

const truncatedString = (value: string, retainedLength: number) =>
  `${value.slice(0, retainedLength)}\n[truncated bytes=${stringBytes(value)}]`;

const clampStringRecordField = <A extends IngestRecord>(
  record: A,
  value: string | undefined,
  setValue: (value: string) => A,
  limits: RecordLimits,
): A => {
  if (value === undefined) return record;
  const bytes = wireBytesOf(record);
  if (bytes === undefined || bytes <= limits.maxRecordBytes) return record;

  let best = setValue(truncatedString(value, 0));
  let low = 0;
  let high = value.length;

  while (low <= high) {
    const retainedLength = Math.floor((low + high) / 2);
    const candidate = setValue(truncatedString(value, retainedLength));
    const candidateBytes = wireBytesOf(candidate);
    if (candidateBytes !== undefined && candidateBytes <= limits.maxRecordBytes) {
      best = candidate;
      low = retainedLength + 1;
    } else {
      high = retainedLength - 1;
    }
  }

  return best;
};

const clampEventText = (
  record: EventIngestRecord,
  limits: RecordLimits,
): EventIngestRecord =>
  clampStringRecordField(
    record,
    record.record.contentText,
    (contentText) => ({
      ...record,
      record: {
        ...record.record,
        contentText,
      },
    }),
    limits,
  );

const clampContentBlockText = (
  record: ContentBlockIngestRecord,
  field: "text" | "markdown" | "thinking",
  limits: RecordLimits,
): ContentBlockIngestRecord =>
  clampStringRecordField(
    record,
    record.record[field],
    (value) => ({
      ...record,
      record: {
        ...record.record,
        [field]: value,
      },
    }),
    limits,
  );

export const clampOversizedRecord = <A extends IngestRecord>(
  record: A,
  limits: RecordLimits = RECORD_LIMITS,
): A => {
  const bytes = wireBytesOf(record);
  if (bytes === undefined || bytes <= limits.maxRecordBytes) return record;
  switch (record.type) {
    case "event":
      return clampEventText(record, limits) as A;
    case "content_block":
      return [
        "text" as const,
        "markdown" as const,
        "thinking" as const,
      ].reduce((next, field) => clampContentBlockText(next, field, limits), {
        ...record,
        record: {
          ...record.record,
          ...(record.record.value !== undefined
            ? { value: clampPayload(record.record.value) }
            : {}),
          ...(record.record.metadata !== undefined
            ? { metadata: clampPayload(record.record.metadata) }
            : {}),
        },
      } as ContentBlockIngestRecord) as A;
    case "tool_call":
      return {
        ...record,
        record: {
          ...record.record,
          ...(record.record.input !== undefined
            ? { input: clampPayload(record.record.input) }
            : {}),
          ...(record.record.output !== undefined
            ? { output: clampPayload(record.record.output) }
            : {}),
        },
      } as A;
    case "artifact":
      return {
        ...record,
        record: {
          ...record.record,
          ...(record.record.sourceRef !== undefined
            ? { sourceRef: clampPayload(record.record.sourceRef) }
            : {}),
          ...(record.record.metadata !== undefined
            ? { metadata: clampPayload(record.record.metadata) }
            : {}),
        },
      } as A;
    case "edge":
      return {
        ...record,
        record: {
          ...record.record,
          ...(record.record.rawReference !== undefined
            ? { rawReference: clampPayload(record.record.rawReference) }
            : {}),
          ...(record.record.metadata !== undefined
            ? { metadata: clampPayload(record.record.metadata) }
            : {}),
        },
      } as A;
    default:
      return record;
  }
};

export const normalizeRecordForWire = <A extends IngestRecord>(
  record: A,
  limits: RecordLimits = RECORD_LIMITS,
): A => clampOversizedRecord(record, limits);

export const recordContentHash = (
  record: IngestRecord,
  limits: RecordLimits = RECORD_LIMITS,
) => stableCanonicalJsonHash(normalizeRecordForWire(record, limits));

const contentBlockText = (record: ContentBlockRecord) => {
  if (record.kind === "text") return record.text;
  if (record.kind === "markdown") return record.markdown;
  if (record.kind === "thinking") return record.thinking;
  return undefined;
};

const onlyDuplicatesEventText = (
  event: NormalizedSession["events"][number],
  record: ContentBlockRecord,
) =>
  event.contentText !== undefined &&
  contentBlockText(record) === event.contentText &&
  record.path === undefined &&
  record.uri === undefined &&
  record.mediaType === undefined &&
  record.value === undefined;

export const sessionToRecords = (session: NormalizedSession): IngestRecord[] => {
  const {
    events,
    toolCalls,
    sessionEdges,
    usageRecords,
    artifacts,
    eventCount,
    toolCallCount,
    contentBlockCount,
    sessionEdgeCount,
    usageRecordCount,
    artifactCount,
    ...sessionRecord
  } = session;
  const contentBlockRecords = events.flatMap((event) =>
    event.contentBlocks
      .map((contentBlock) => ({
        event,
        contentBlock: {
          ...contentBlock,
          eventId: event.id,
          sessionId: event.sessionId,
          machineId: event.machineId,
          provider: event.provider,
          agentName: event.agentName,
          projectIdentityKey: event.projectIdentityKey,
        },
      }))
      .filter(({ event, contentBlock }) => !onlyDuplicatesEventText(event, contentBlock)),
  );

  return [
    {
      type: "session",
      record: {
        ...sessionRecord,
        eventCount: eventCount ?? events.length,
        toolCallCount: toolCallCount ?? toolCalls.length,
        contentBlockCount: contentBlockCount ?? contentBlockRecords.length,
        sessionEdgeCount: sessionEdgeCount ?? sessionEdges.length,
        usageRecordCount: usageRecordCount ?? usageRecords.length,
        artifactCount: artifactCount ?? artifacts.length,
      },
    },
    ...events.map(({ contentBlocks: _contentBlocks, ...event }) => ({
      type: "event" as const,
      record: event,
    })),
    ...contentBlockRecords.map(({ contentBlock }) => ({
      type: "content_block" as const,
      record: contentBlock,
    })),
    ...toolCalls.map((record) => ({ type: "tool_call" as const, record })),
    ...usageRecords.map((record) => ({ type: "usage" as const, record })),
    ...sessionEdges.map((record) => ({ type: "edge" as const, record })),
    ...artifacts.map((record) => ({ type: "artifact" as const, record })),
  ];
};

const resolveLimits = (limits: Partial<RecordLimits> | undefined): RecordLimits => ({
  ...RECORD_LIMITS,
  ...limits,
});

const limitsAreValid = (limits: RecordLimits) =>
  limits.maxRecordBytes > 0 &&
  limits.maxEnvelopeBytes > 0 &&
  limits.maxRecordsPerEnvelope > 0;

const requireRecordWireBytes = (
  record: IngestRecord,
): Effect.Effect<number, RecordContractError> => {
  const bytes = wireBytesOf(record);
  return bytes === undefined ? Effect.fail(recordWireFailure(record)) : Effect.succeed(bytes);
};

const requireEnvelopeWireBytes = (
  envelope: RecordEnvelope,
): Effect.Effect<number, RecordContractError> => {
  const bytes = wireBytesOf(envelope);
  return bytes === undefined ? Effect.fail(envelopeWireFailure()) : Effect.succeed(bytes);
};

const parseErrorMessage = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

export const enforceRecordEnvelopeLimits = (
  envelope: RecordEnvelope,
  inputLimits?: Partial<RecordLimits>,
): Effect.Effect<RecordEnvelope, RecordContractError> =>
  Effect.gen(function* () {
    const limits = resolveLimits(inputLimits);
    if (!limitsAreValid(limits)) {
      return yield* Effect.fail(
        new RecordContractError({
          reason: "invalid_limits",
          message: "Record envelope limits must be positive.",
        }),
      );
    }

    const records: IngestRecord[] = [];
    for (const record of envelope.records) {
      yield* requireRecordWireBytes(record);
      records.push(normalizeRecordForWire(record, limits));
    }
    if (records.length > limits.maxRecordsPerEnvelope) {
      return yield* Effect.fail(
        new RecordContractError({
          reason: "envelope_too_large",
          message: "Record envelope exceeds maxRecordsPerEnvelope.",
        }),
      );
    }

    const normalizedEnvelope: RecordEnvelope = { ...envelope, records };
    const normalizedEnvelopeBytes = yield* requireEnvelopeWireBytes(normalizedEnvelope);
    if (normalizedEnvelopeBytes > limits.maxEnvelopeBytes) {
      return yield* Effect.fail(
        new RecordContractError({
          reason: "envelope_too_large",
          message: "Record envelope exceeds maxEnvelopeBytes.",
        }),
      );
    }

    for (const record of records) {
      const recordBytes = yield* requireRecordWireBytes(record);
      if (recordBytes > limits.maxRecordBytes) {
        return yield* Effect.fail(
          new RecordContractError({
            reason: "record_too_large",
            message: `Record ${recordId(record)} exceeds maxRecordBytes after clamping.`,
            recordId: recordId(record),
          }),
        );
      }
    }

    return normalizedEnvelope;
  });

export const decodeRecordEnvelope = (
  value: unknown,
  limits?: Partial<RecordLimits>,
): Effect.Effect<RecordEnvelope, RecordContractError> =>
  Schema.decodeUnknown(RecordEnvelope)(value).pipe(
    Effect.mapError(
      (error) =>
        new RecordContractError({
          reason: "invalid_envelope",
          message: parseErrorMessage(error),
        }),
    ),
    Effect.flatMap((envelope) => enforceRecordEnvelopeLimits(envelope, limits)),
  );

export const packRecordEnvelopes = ({
  machine,
  records,
  limits: inputLimits,
}: PackRecordEnvelopesInput): Effect.Effect<RecordEnvelope[], RecordContractError> =>
  Effect.gen(function* () {
    const limits = resolveLimits(inputLimits);
    if (!limitsAreValid(limits)) {
      return yield* Effect.fail(
        new RecordContractError({
          reason: "invalid_limits",
          message: "Record envelope limits must be positive.",
        }),
      );
    }

    const envelopes: RecordEnvelope[] = [];
    let pendingRecords: IngestRecord[] = [];
    const flushPending = () => {
      if (pendingRecords.length === 0) return;
      envelopes.push({
        protocol: RECORD_PROTOCOL,
        machine,
        records: pendingRecords,
      });
      pendingRecords = [];
    };

    for (const inputRecord of records) {
      yield* requireRecordWireBytes(inputRecord);
      const record = normalizeRecordForWire(inputRecord, limits);
      const itemBytes = yield* requireRecordWireBytes(record);
      if (itemBytes > limits.maxRecordBytes) {
        return yield* Effect.fail(
          new RecordContractError({
            reason: "record_too_large",
            message: `Record ${recordId(record)} exceeds maxRecordBytes after clamping.`,
            recordId: recordId(record),
          }),
        );
      }

      const candidateRecords = [...pendingRecords, record];
      const candidate: RecordEnvelope = {
        protocol: RECORD_PROTOCOL,
        machine,
        records: candidateRecords,
      };
      const candidateTooLarge =
        candidateRecords.length > limits.maxRecordsPerEnvelope ||
        (yield* requireEnvelopeWireBytes(candidate)) > limits.maxEnvelopeBytes;

      if (pendingRecords.length > 0 && candidateTooLarge) {
        flushPending();
      }

      const nextCandidate: RecordEnvelope = {
        protocol: RECORD_PROTOCOL,
        machine,
        records: [...pendingRecords, record],
      };
      if ((yield* requireEnvelopeWireBytes(nextCandidate)) > limits.maxEnvelopeBytes) {
        return yield* Effect.fail(
          new RecordContractError({
            reason: "envelope_too_large",
            message: `Record ${recordId(record)} cannot fit within maxEnvelopeBytes.`,
            recordId: recordId(record),
          }),
        );
      }
      pendingRecords = [...pendingRecords, record];
    }

    flushPending();
    return envelopes;
  });
