import { createHash } from "node:crypto";

import { Schema } from "effect";

import {
  AgentAssignment,
  NORMALIZED_SESSION_PROTOCOL_VERSION,
  Provider,
  SessionEventKind,
  SessionRole,
  decodeMappedSessionSync,
  eventMessageText,
  mappedSessionExamples,
  type ContentBlock,
  type MappedSession as MappedSessionType,
  type SessionEvent,
  type ToolCallRow,
} from "./normalized-session";

export const QUASAR_TRAJECTORY_VERSION = "quasar.trajectory/v1" as const;
export const LETTA_TRAJECTORY_SCHEMA_ID =
  "https://letta.ai/schemas/trajectory/v1.json" as const;

const strictParseOptions = {
  errors: "all",
  onExcessProperty: "error",
} as const;

const NonNegativeInteger = Schema.Number.pipe(
  Schema.int(),
  Schema.nonNegative(),
);

const PositiveInteger = Schema.Number.pipe(
  Schema.int(),
  Schema.positive(),
);

export const TrajectoryProjectionOptions = Schema.Struct({
  includeReasoning: Schema.Boolean,
  includeToolResults: Schema.Boolean,
  toolResultMaxBytes: Schema.optional(NonNegativeInteger),
});
export type TrajectoryProjectionOptions =
  typeof TrajectoryProjectionOptions.Type;

export interface TrajectoryProjectionInput {
  readonly includeReasoning?: boolean;
  readonly includeToolResults?: boolean;
  readonly toolResultMaxBytes?: number;
}

export const TrajectoryFullReadPointer = Schema.Union(
  Schema.Struct({
    resource: Schema.Literal("session-detail"),
    sessionId: Schema.String,
    eventId: Schema.optional(Schema.String),
  }),
  Schema.Struct({
    resource: Schema.Literal("tool-call"),
    sessionId: Schema.String,
    eventId: Schema.optional(Schema.String),
    toolCallId: Schema.String,
  }),
);
export type TrajectoryFullReadPointer =
  typeof TrajectoryFullReadPointer.Type;

const trajectoryRecordIdentity = {
  id: Schema.String,
  sequence: NonNegativeInteger,
  timestamp: Schema.optional(Schema.String),
  fullRead: TrajectoryFullReadPointer,
} as const;

const trajectorySourceRecordIdentity = {
  ...trajectoryRecordIdentity,
  sourceSequence: NonNegativeInteger,
  sourceEventId: Schema.String,
} as const;

export const TrajectorySessionMetadata = Schema.Struct({
  sourceProtocolVersion: Schema.Literal(NORMALIZED_SESSION_PROTOCOL_VERSION),
  provider: Provider,
  projectKey: Schema.String,
  projectPath: Schema.optional(Schema.String),
  agentName: Schema.String,
  title: Schema.optional(Schema.String),
  startedAt: Schema.optional(Schema.String),
  updatedAt: Schema.optional(Schema.String),
  model: Schema.optional(Schema.String),
  modelProvider: Schema.optional(Schema.String),
  assignment: Schema.optional(AgentAssignment),
  parentSessionId: Schema.optional(Schema.String),
  normalizationVersion: PositiveInteger,
});
export type TrajectorySessionMetadata =
  typeof TrajectorySessionMetadata.Type;

export const TrajectorySessionMetaRecord = Schema.Struct({
  ...trajectoryRecordIdentity,
  role: Schema.Literal("meta"),
  category: Schema.Literal("session"),
  metadata: TrajectorySessionMetadata,
});
export type TrajectorySessionMetaRecord =
  typeof TrajectorySessionMetaRecord.Type;

export const TrajectoryEventMetaRecord = Schema.Struct({
  ...trajectorySourceRecordIdentity,
  role: Schema.Literal("meta"),
  category: Schema.Literal("event"),
  sourceRole: SessionRole,
  eventKind: SessionEventKind,
  content: Schema.String,
});
export type TrajectoryEventMetaRecord =
  typeof TrajectoryEventMetaRecord.Type;

export const TrajectoryUserRecord = Schema.Struct({
  ...trajectorySourceRecordIdentity,
  role: Schema.Literal("user"),
  content: Schema.String,
});
export type TrajectoryUserRecord = typeof TrajectoryUserRecord.Type;

export const TrajectoryAssistantRecord = Schema.Struct({
  ...trajectorySourceRecordIdentity,
  role: Schema.Literal("assistant"),
  content: Schema.String,
});
export type TrajectoryAssistantRecord =
  typeof TrajectoryAssistantRecord.Type;

export const TrajectoryReasoningRecord = Schema.Struct({
  ...trajectorySourceRecordIdentity,
  role: Schema.Literal("reasoning"),
  content: Schema.String,
});
export type TrajectoryReasoningRecord =
  typeof TrajectoryReasoningRecord.Type;

export const TrajectoryToolCallRecord = Schema.Struct({
  ...trajectorySourceRecordIdentity,
  role: Schema.Literal("tool_call"),
  toolCallId: Schema.String,
  name: Schema.String,
  arguments: Schema.String,
  status: Schema.optional(Schema.String),
});
export type TrajectoryToolCallRecord =
  typeof TrajectoryToolCallRecord.Type;

export const TrajectoryToolResultRecord = Schema.Struct({
  ...trajectorySourceRecordIdentity,
  role: Schema.Literal("tool_result"),
  toolCallId: Schema.String,
  content: Schema.String,
  status: Schema.optional(Schema.String),
  originalBytes: NonNegativeInteger,
  returnedBytes: NonNegativeInteger,
  contentHash: Schema.String,
  truncated: Schema.Boolean,
});
export type TrajectoryToolResultRecord =
  typeof TrajectoryToolResultRecord.Type;

export const TrajectoryRecord = Schema.Union(
  TrajectorySessionMetaRecord,
  TrajectoryEventMetaRecord,
  TrajectoryUserRecord,
  TrajectoryAssistantRecord,
  TrajectoryReasoningRecord,
  TrajectoryToolCallRecord,
  TrajectoryToolResultRecord,
);
export type TrajectoryRecord = typeof TrajectoryRecord.Type;

const TrajectoryOmittedLoss = Schema.Struct({
  kind: Schema.Literal("omitted"),
  sourceKind: Schema.Literal(
    "event",
    "content_block",
    "tool_result",
    "usage_record",
    "session_edge",
    "artifact",
    "execution_context",
  ),
  sourceId: Schema.String,
  reason: Schema.Literal(
    "excluded_by_option",
    "not_selected_for_agent_projection",
    "unsupported_content_block",
  ),
  fullRead: TrajectoryFullReadPointer,
});

const TrajectoryTruncatedLoss = Schema.Struct({
  kind: Schema.Literal("truncated"),
  sourceKind: Schema.Literal("tool_result"),
  sourceId: Schema.String,
  reason: Schema.Literal("tool_result_truncated"),
  recordId: Schema.String,
  originalBytes: NonNegativeInteger,
  returnedBytes: NonNegativeInteger,
  contentHash: Schema.String,
  fullRead: TrajectoryFullReadPointer,
});

export const TrajectoryLoss = Schema.Union(
  TrajectoryOmittedLoss,
  TrajectoryTruncatedLoss,
);
export type TrajectoryLoss = typeof TrajectoryLoss.Type;

export const TrajectoryCounts = Schema.Struct({
  sourceEvents: NonNegativeInteger,
  sourceToolCalls: NonNegativeInteger,
  records: PositiveInteger,
  omittedFacts: NonNegativeInteger,
  truncatedRecords: NonNegativeInteger,
});
export type TrajectoryCounts = typeof TrajectoryCounts.Type;

const trajectoryInvariant = (trajectory: {
  readonly sessionId: string;
  readonly records: ReadonlyArray<TrajectoryRecord>;
  readonly losses: ReadonlyArray<TrajectoryLoss>;
  readonly counts: TrajectoryCounts;
}): true | string => {
  const [first] = trajectory.records;
  if (first?.role !== "meta" || first.category !== "session") {
    return "the first trajectory record must be session metadata";
  }
  const ids = new Set<string>();
  const seenToolCalls = new Set<string>();
  const seenToolResults = new Set<string>();
  for (const [index, record] of trajectory.records.entries()) {
    if (record.sequence !== index) {
      return `trajectory sequence must be dense at index ${index}`;
    }
    if (ids.has(record.id)) return `duplicate trajectory record id: ${record.id}`;
    ids.add(record.id);
    if (record.fullRead.sessionId !== trajectory.sessionId) {
      return `record ${record.id} points at another session`;
    }
    if (
      index > 0
      && record.role === "meta"
      && record.category === "session"
    ) {
      return "session metadata may appear only as the first record";
    }
    if (
      record.role !== "meta"
      || record.category === "event"
    ) {
      if (
        record.fullRead.eventId !== undefined
        && record.fullRead.eventId !== record.sourceEventId
      ) {
        return `record ${record.id} points at another source event`;
      }
    }
    if (record.role === "tool_call") {
      if (seenToolCalls.has(record.toolCallId)) {
        return `duplicate trajectory tool call: ${record.toolCallId}`;
      }
      if (
        record.fullRead.resource !== "tool-call"
        || record.fullRead.toolCallId !== record.toolCallId
      ) {
        return `tool call ${record.id} has an invalid full-read pointer`;
      }
      seenToolCalls.add(record.toolCallId);
    }
    if (
      record.role === "tool_result"
      && !seenToolCalls.has(record.toolCallId)
    ) {
      return `tool result ${record.id} has no earlier tool call`;
    }
    if (record.role === "tool_result") {
      if (seenToolResults.has(record.toolCallId)) {
        return `duplicate trajectory tool result: ${record.toolCallId}`;
      }
      if (
        record.fullRead.resource !== "tool-call"
        || record.fullRead.toolCallId !== record.toolCallId
      ) {
        return `tool result ${record.id} has an invalid full-read pointer`;
      }
      if (
        record.returnedBytes !== Buffer.byteLength(record.content)
        || record.returnedBytes > record.originalBytes
        || record.truncated !== (record.returnedBytes < record.originalBytes)
      ) {
        return `tool result ${record.id} has inconsistent byte metadata`;
      }
      seenToolResults.add(record.toolCallId);
    }
  }
  if (trajectory.counts.records !== trajectory.records.length) {
    return "counts.records must equal records.length";
  }
  const omittedFacts = trajectory.losses.filter((loss) =>
    loss.kind === "omitted"
  ).length;
  const truncatedRecords = trajectory.losses.filter((loss) =>
    loss.kind === "truncated"
  ).length;
  if (trajectory.counts.omittedFacts !== omittedFacts) {
    return "counts.omittedFacts must equal omitted losses";
  }
  if (trajectory.counts.truncatedRecords !== truncatedRecords) {
    return "counts.truncatedRecords must equal truncated losses";
  }
  const recordById = new Map(
    trajectory.records.map((record) => [record.id, record]),
  );
  for (const loss of trajectory.losses) {
    if (loss.fullRead.sessionId !== trajectory.sessionId) {
      return `loss ${loss.sourceId} points at another session`;
    }
    if (loss.kind !== "truncated") continue;
    const record = recordById.get(loss.recordId);
    if (
      record?.role !== "tool_result"
      || record.toolCallId !== loss.sourceId
      || !record.truncated
      || record.originalBytes !== loss.originalBytes
      || record.returnedBytes !== loss.returnedBytes
      || record.contentHash !== loss.contentHash
    ) {
      return `truncation loss ${loss.sourceId} does not match its record`;
    }
  }
  return true;
};

const QuasarTrajectoryShape = Schema.Struct({
  protocolVersion: Schema.Literal(QUASAR_TRAJECTORY_VERSION),
  sourceProtocolVersion: Schema.Literal(NORMALIZED_SESSION_PROTOCOL_VERSION),
  sessionId: Schema.String,
  projectKey: Schema.String,
  provider: Provider,
  projection: TrajectoryProjectionOptions,
  records: Schema.Array(TrajectoryRecord),
  losses: Schema.Array(TrajectoryLoss),
  counts: TrajectoryCounts,
});

export const QuasarTrajectory = QuasarTrajectoryShape.pipe(
  Schema.filter(trajectoryInvariant),
).annotations({
  identifier: "QuasarTrajectoryV1",
  title: "Quasar agent-readable trajectory v1",
  description:
    "A deterministic, source-linked agent projection over normalized Quasar session facts.",
  parseOptions: strictParseOptions,
});
export type QuasarTrajectory = typeof QuasarTrajectory.Type;
export type QuasarTrajectoryEncoded = typeof QuasarTrajectory.Encoded;

export const decodeQuasarTrajectory = Schema.decodeUnknown(
  QuasarTrajectory,
  strictParseOptions,
);
export const decodeQuasarTrajectorySync = Schema.decodeUnknownSync(
  QuasarTrajectory,
  strictParseOptions,
);

const normalizedOptions = (
  input: TrajectoryProjectionInput = {},
): TrajectoryProjectionOptions => {
  const options = {
    includeReasoning: input.includeReasoning ?? true,
    includeToolResults: input.includeToolResults ?? true,
    ...(input.toolResultMaxBytes !== undefined
      ? { toolResultMaxBytes: input.toolResultMaxBytes }
      : {}),
  };
  return Schema.decodeUnknownSync(
    TrajectoryProjectionOptions,
    strictParseOptions,
  )(options);
};

const nonEmpty = (value: string | undefined): string | undefined =>
  value !== undefined && value.trim().length > 0 ? value : undefined;

const blockText = (block: ContentBlock): string | undefined => {
  if (block.kind === "text") return nonEmpty(block.text);
  if (block.kind === "markdown") return nonEmpty(block.markdown);
  if (block.kind === "thinking") return nonEmpty(block.thinking);
  return undefined;
};

const visibleEventText = (event: SessionEvent): string | undefined => {
  // Same kind-gated derivation as eventMessageText / mapSession (not field-priority soup).
  return nonEmpty(eventMessageText(event));
};

const sha256 = (value: string): string =>
  createHash("sha256").update(value, "utf8").digest("hex");

const utf8PrefixAtMost = (text: string, maximumBytes: number): string => {
  let bytes = 0;
  let end = 0;
  for (const codePoint of text) {
    const codePointBytes = Buffer.byteLength(codePoint);
    if (bytes + codePointBytes > maximumBytes) break;
    bytes += codePointBytes;
    end += codePoint.length;
  }
  return text.slice(0, end);
};

const stableRecordId = (
  role: TrajectoryRecord["role"],
  sourceId: string,
): string => `trajectory:${role}:${encodeURIComponent(sourceId)}`;

const sessionPointer = (
  sessionId: string,
  eventId?: string,
): TrajectoryFullReadPointer => ({
  resource: "session-detail",
  sessionId,
  ...(eventId !== undefined ? { eventId } : {}),
});

const toolPointer = (
  sessionId: string,
  toolCallId: string,
  eventId?: string,
): TrajectoryFullReadPointer => ({
  resource: "tool-call",
  sessionId,
  toolCallId,
  ...(eventId !== undefined ? { eventId } : {}),
});

type WithoutSequence<Record> = Record extends unknown
  ? Omit<Record, "sequence">
  : never;
type RecordWithoutSequence = WithoutSequence<TrajectoryRecord>;

interface OrderedRecord {
  readonly sourceSequence: number;
  readonly suborder: number;
  readonly record: RecordWithoutSequence;
}

const resultEventFor = (
  events: readonly SessionEvent[],
  toolCall: ToolCallRow,
): SessionEvent | undefined =>
  events.find((event) =>
    event.id !== toolCall.eventId
    &&
    event.toolCallId === toolCall.id
    && (event.kind === "tool_result" || event.role === "tool")
  );

const eventMetaKind = (event: SessionEvent): boolean =>
  event.role === "developer"
  || event.role === "system"
  || event.kind === "preamble"
  || event.kind === "system"
  || event.kind === "summary";

export const projectQuasarTrajectory = (
  input: MappedSessionType,
  projectionInput: TrajectoryProjectionInput = {},
): QuasarTrajectory => {
  const mapped = decodeMappedSessionSync(input);
  const projection = normalizedOptions(projectionInput);
  const sessionId = mapped.session.sessionId;
  const ordered: OrderedRecord[] = [];
  const losses: TrajectoryLoss[] = [];
  const representedEventIds = new Set<string>();

  ordered.push({
    sourceSequence: -1,
    suborder: 0,
    record: {
      id: stableRecordId("meta", `${sessionId}:session`),
      role: "meta",
      category: "session",
      timestamp: mapped.session.startedAt,
      fullRead: sessionPointer(sessionId),
      metadata: {
        sourceProtocolVersion: NORMALIZED_SESSION_PROTOCOL_VERSION,
        provider: mapped.session.provider,
        projectKey: mapped.session.projectKey,
        ...(mapped.project.rawPath !== undefined
          ? { projectPath: mapped.project.rawPath }
          : {}),
        agentName: mapped.session.agentName,
        ...(mapped.session.title !== undefined
          ? { title: mapped.session.title }
          : {}),
        ...(mapped.session.startedAt !== undefined
          ? { startedAt: mapped.session.startedAt }
          : {}),
        ...(mapped.session.updatedAt !== undefined
          ? { updatedAt: mapped.session.updatedAt }
          : {}),
        ...(mapped.session.model !== undefined
          ? { model: mapped.session.model }
          : {}),
        ...(mapped.session.modelProvider !== undefined
          ? { modelProvider: mapped.session.modelProvider }
          : {}),
        ...(mapped.assignment !== undefined
          ? { assignment: mapped.assignment }
          : {}),
        ...(mapped.session.parentSessionId !== undefined
          ? { parentSessionId: mapped.session.parentSessionId }
          : {}),
        normalizationVersion: mapped.session.normalizationVersion,
      },
    },
  });

  for (const event of mapped.events) {
    const pointer = sessionPointer(sessionId, event.id);
    const sourceFields = {
      sourceSequence: event.sequence,
      sourceEventId: event.id,
      ...(event.timestamp !== undefined ? { timestamp: event.timestamp } : {}),
      fullRead: pointer,
    };
    const text = visibleEventText(event);

    if (event.kind === "reasoning" || event.role === "thinking") {
      if (text !== undefined && projection.includeReasoning) {
        ordered.push({
          sourceSequence: event.sequence,
          suborder: 10,
          record: {
            id: stableRecordId("reasoning", event.id),
            role: "reasoning",
            content: text,
            ...sourceFields,
          },
        });
        representedEventIds.add(event.id);
      } else if (text !== undefined) {
        losses.push({
          kind: "omitted",
          sourceKind: "event",
          sourceId: event.id,
          reason: "excluded_by_option",
          fullRead: pointer,
        });
      }
    } else if (eventMetaKind(event) && text !== undefined) {
      ordered.push({
        sourceSequence: event.sequence,
        suborder: 20,
        record: {
          id: stableRecordId("meta", event.id),
          role: "meta",
          category: "event",
          sourceRole: event.role,
          eventKind: event.kind,
          content: text,
          ...sourceFields,
        },
      });
      representedEventIds.add(event.id);
    } else if (
      event.kind !== "tool_result"
      && text !== undefined
      && event.role === "user"
    ) {
      ordered.push({
        sourceSequence: event.sequence,
        suborder: 20,
        record: {
          id: stableRecordId("user", event.id),
          role: "user",
          content: text,
          ...sourceFields,
        },
      });
      representedEventIds.add(event.id);
    } else if (
      event.kind !== "tool_result"
      && text !== undefined
      && event.role === "assistant"
    ) {
      ordered.push({
        sourceSequence: event.sequence,
        suborder: 20,
        record: {
          id: stableRecordId("assistant", event.id),
          role: "assistant",
          content: text,
          ...sourceFields,
        },
      });
      representedEventIds.add(event.id);
    }

    if (!(event.kind === "reasoning" || event.role === "thinking")) {
      for (const block of event.contentBlocks) {
        const reasoning = block.kind === "thinking"
          ? blockText(block)
          : undefined;
        if (reasoning !== undefined) {
          if (projection.includeReasoning) {
            ordered.push({
              sourceSequence: event.sequence,
              suborder: 10 + block.sequence,
              record: {
                id: stableRecordId("reasoning", block.id),
                role: "reasoning",
                content: reasoning,
                ...sourceFields,
              },
            });
            representedEventIds.add(event.id);
          } else {
            losses.push({
              kind: "omitted",
              sourceKind: "content_block",
              sourceId: block.id,
              reason: "excluded_by_option",
              fullRead: pointer,
            });
          }
        } else if (
          block.kind === "image"
          || block.kind === "file"
          || block.kind === "json"
        ) {
          losses.push({
            kind: "omitted",
            sourceKind: "content_block",
            sourceId: block.id,
            reason: "unsupported_content_block",
            fullRead: pointer,
          });
        }
      }
    }
  }

  const toolCalls = [...mapped.toolCalls].sort((left, right) =>
    left.seq - right.seq || left.id.localeCompare(right.id)
  );
  for (const toolCall of toolCalls) {
    const callEvent = mapped.events.find((event) =>
      event.id === toolCall.eventId
    )!;
    const callPointer = toolPointer(sessionId, toolCall.id, callEvent.id);
    const timestamp = toolCall.startedAt ?? callEvent.timestamp;
    const callId = stableRecordId("tool_call", toolCall.id);
    ordered.push({
      sourceSequence: callEvent.sequence,
      suborder: 100,
      record: {
        id: callId,
        role: "tool_call",
        toolCallId: toolCall.id,
        name: toolCall.toolName,
        arguments: toolCall.inputText,
        ...(toolCall.status !== undefined ? { status: toolCall.status } : {}),
        sourceSequence: callEvent.sequence,
        sourceEventId: callEvent.id,
        ...(timestamp !== undefined ? { timestamp } : {}),
        fullRead: callPointer,
      },
    });
    representedEventIds.add(callEvent.id);

    const resultEvent = resultEventFor(mapped.events, toolCall);
    const resultObserved = resultEvent !== undefined
      || toolCall.outputText !== ""
      || toolCall.completedAt !== undefined;
    if (!resultObserved) continue;
    const resultPointer = toolPointer(
      sessionId,
      toolCall.id,
      resultEvent?.id ?? callEvent.id,
    );
    if (!projection.includeToolResults) {
      losses.push({
        kind: "omitted",
        sourceKind: "tool_result",
        sourceId: toolCall.id,
        reason: "excluded_by_option",
        fullRead: resultPointer,
      });
      continue;
    }

    const content = toolCall.outputText !== ""
      ? toolCall.outputText
      : resultEvent === undefined
        ? ""
        : visibleEventText(resultEvent) ?? "";
    const originalBytes = Buffer.byteLength(content);
    const returned = projection.toolResultMaxBytes !== undefined
      && originalBytes > projection.toolResultMaxBytes
      ? utf8PrefixAtMost(content, projection.toolResultMaxBytes)
      : content;
    const returnedBytes = Buffer.byteLength(returned);
    const truncated = returnedBytes < originalBytes;
    const resultId = stableRecordId("tool_result", toolCall.id);
    const resultSequence = resultEvent?.sequence ?? callEvent.sequence;
    ordered.push({
      sourceSequence: resultSequence,
      suborder: resultEvent === undefined ? 110 : 100,
      record: {
        id: resultId,
        role: "tool_result",
        toolCallId: toolCall.id,
        content: returned,
        ...(toolCall.status !== undefined ? { status: toolCall.status } : {}),
        originalBytes,
        returnedBytes,
        contentHash: sha256(content),
        truncated,
        sourceSequence: resultSequence,
        sourceEventId: resultEvent?.id ?? callEvent.id,
        ...((toolCall.completedAt ?? resultEvent?.timestamp) !== undefined
          ? { timestamp: toolCall.completedAt ?? resultEvent?.timestamp }
          : {}),
        fullRead: resultPointer,
      },
    });
    if (resultEvent !== undefined) representedEventIds.add(resultEvent.id);
    if (truncated) {
      losses.push({
        kind: "truncated",
        sourceKind: "tool_result",
        sourceId: toolCall.id,
        reason: "tool_result_truncated",
        recordId: resultId,
        originalBytes,
        returnedBytes,
        contentHash: sha256(content),
        fullRead: resultPointer,
      });
    }
  }

  for (const event of mapped.events) {
    if (
      !representedEventIds.has(event.id)
      && !losses.some((loss) =>
        loss.sourceKind === "event" && loss.sourceId === event.id
      )
    ) {
      losses.push({
        kind: "omitted",
        sourceKind: "event",
        sourceId: event.id,
        reason: "not_selected_for_agent_projection",
        fullRead: sessionPointer(sessionId, event.id),
      });
    }
  }
  for (const [sourceKind, facts] of [
    ["usage_record", mapped.usageRecords],
    ["session_edge", mapped.sessionEdges],
    ["artifact", mapped.artifacts],
    ["execution_context", mapped.executionContexts],
  ] as const) {
    for (const fact of facts) {
      losses.push({
        kind: "omitted",
        sourceKind,
        sourceId: fact.id,
        reason: "not_selected_for_agent_projection",
        fullRead: sessionPointer(sessionId),
      });
    }
  }

  const records = ordered
    .sort((left, right) =>
      left.sourceSequence - right.sourceSequence
      || left.suborder - right.suborder
      || left.record.id.localeCompare(right.record.id)
    )
    .map(({ record }, sequence) => ({ ...record, sequence })) as
      unknown as readonly TrajectoryRecord[];
  const trajectory = {
    protocolVersion: QUASAR_TRAJECTORY_VERSION,
    sourceProtocolVersion: NORMALIZED_SESSION_PROTOCOL_VERSION,
    sessionId,
    projectKey: mapped.session.projectKey,
    provider: mapped.session.provider,
    projection,
    records,
    losses,
    counts: {
      sourceEvents: mapped.events.length,
      sourceToolCalls: mapped.toolCalls.length,
      records: records.length,
      omittedFacts: losses.filter((loss) => loss.kind === "omitted").length,
      truncatedRecords: losses.filter((loss) => loss.kind === "truncated")
        .length,
    },
  };
  return decodeQuasarTrajectorySync(trajectory);
};

const ISO_TIMESTAMP =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})$/;
const LettaTimestamp = Schema.String.pipe(Schema.pattern(ISO_TIMESTAMP));

export const LettaMetaRecord = Schema.Struct({
  role: Schema.Literal("meta"),
  source: Schema.String.pipe(Schema.minLength(1)),
  cwd: Schema.optional(Schema.String),
  git_branch: Schema.optional(Schema.String),
  model: Schema.optional(Schema.String),
});

export const LettaUserRecord = Schema.Struct({
  role: Schema.Literal("user"),
  content: Schema.String,
  timestamp: LettaTimestamp,
});

export const LettaReasoningRecord = Schema.Struct({
  role: Schema.Literal("reasoning"),
  content: Schema.String,
  timestamp: LettaTimestamp,
});

export const LettaToolCall = Schema.Struct({
  id: Schema.String.pipe(Schema.minLength(1)),
  name: Schema.String.pipe(Schema.minLength(1)),
  args: Schema.String,
});

export const LettaAssistantRecord = Schema.Union(
  Schema.Struct({
    role: Schema.Literal("assistant"),
    content: Schema.String.pipe(Schema.minLength(1)),
    timestamp: LettaTimestamp,
  }),
  Schema.Struct({
    role: Schema.Literal("assistant"),
    content: Schema.Null,
    tool_calls: Schema.Array(LettaToolCall).pipe(Schema.minItems(1)),
    timestamp: LettaTimestamp,
  }),
);

export const LettaToolRecord = Schema.Struct({
  role: Schema.Literal("tool"),
  tool_call_id: Schema.String.pipe(Schema.minLength(1)),
  content: Schema.String,
  timestamp: LettaTimestamp,
});

export const LettaTrajectoryRecord = Schema.Union(
  LettaMetaRecord,
  LettaUserRecord,
  LettaReasoningRecord,
  LettaAssistantRecord,
  LettaToolRecord,
);
export type LettaTrajectoryRecord = typeof LettaTrajectoryRecord.Type;

export const LettaTrajectory = Schema.Array(LettaTrajectoryRecord).pipe(
  Schema.minItems(1),
).annotations({
  identifier: "LettaTrajectoryV1",
  title: "Letta Trajectory v1",
  description:
    "Compatibility schema mirroring the official Letta trajectory-v1 JSON Schema.",
  parseOptions: strictParseOptions,
});
export type LettaTrajectory = typeof LettaTrajectory.Type;

export const decodeLettaTrajectorySync = Schema.decodeUnknownSync(
  LettaTrajectory,
  strictParseOptions,
);

export const LettaCompatibilityIssue = Schema.Struct({
  kind: Schema.Literal(
    "mixed_assistant_split",
    "event_meta_omitted",
    "missing_or_invalid_timestamp",
    "quasar_metadata_omitted",
    "tool_result_truncated",
    "tool_call_timestamps_coalesced",
  ),
  sourceRecordId: Schema.optional(Schema.String),
  detail: Schema.String,
});
export type LettaCompatibilityIssue =
  typeof LettaCompatibilityIssue.Type;

export const LettaTrajectoryExport = Schema.Struct({
  format: Schema.Literal("letta.trajectory/v1"),
  schemaId: Schema.Literal(LETTA_TRAJECTORY_SCHEMA_ID),
  sourceTrajectoryVersion: Schema.Literal(QUASAR_TRAJECTORY_VERSION),
  trajectory: LettaTrajectory,
  compatibility: Schema.Struct({
    valid: Schema.Literal(true),
    issues: Schema.Array(LettaCompatibilityIssue),
  }),
});
export type LettaTrajectoryExport = typeof LettaTrajectoryExport.Type;

const validLettaTimestamp = (
  value: string | undefined,
): value is string => value !== undefined && ISO_TIMESTAMP.test(value);

export const toLettaTrajectory = (
  trajectoryInput: QuasarTrajectory,
): LettaTrajectoryExport => {
  const trajectory = decodeQuasarTrajectorySync(trajectoryInput);
  const sessionMeta = trajectory.records[0] as TrajectorySessionMetaRecord;
  const records: LettaTrajectoryRecord[] = [{
    role: "meta",
    source: sessionMeta.metadata.provider,
    ...(sessionMeta.metadata.projectPath !== undefined
      ? { cwd: sessionMeta.metadata.projectPath }
      : {}),
    ...(sessionMeta.metadata.model !== undefined
      ? { model: sessionMeta.metadata.model }
      : {}),
  }];
  const issues: LettaCompatibilityIssue[] = [{
    kind: "quasar_metadata_omitted",
    sourceRecordId: sessionMeta.id,
    detail:
      "Letta meta cannot carry Quasar source identity, project key, assignment, lineage, or normalization version.",
  }];
  const emittedToolGroups = new Set<string>();

  for (const record of trajectory.records.slice(1)) {
    if (record.role === "meta") {
      issues.push({
        kind: "event_meta_omitted",
        sourceRecordId: record.id,
        detail: "Letta v1 has no event-level meta record.",
      });
      continue;
    }
    if (!validLettaTimestamp(record.timestamp)) {
      issues.push({
        kind: "missing_or_invalid_timestamp",
        sourceRecordId: record.id,
        detail:
          "Letta v1 requires an observed ISO timestamp; Quasar did not fabricate one.",
      });
      continue;
    }
    if (
      record.role === "user"
      || record.role === "reasoning"
      || record.role === "assistant"
    ) {
      records.push({
        role: record.role,
        content: record.content,
        timestamp: record.timestamp,
      });
      continue;
    }
    if (record.role === "tool_call") {
      const groupId = record.sourceEventId ?? record.id;
      if (emittedToolGroups.has(groupId)) continue;
      emittedToolGroups.add(groupId);
      const calls = trajectory.records.filter((candidate) =>
        candidate.role === "tool_call"
        && (candidate.sourceEventId ?? candidate.id) === groupId
      ) as readonly TrajectoryToolCallRecord[];
      records.push({
        role: "assistant",
        content: null,
        tool_calls: calls.map((call) => ({
          id: call.toolCallId,
          name: call.name,
          args: call.arguments,
        })),
        timestamp: record.timestamp,
      });
      if (
        trajectory.records.some((candidate) =>
          candidate.role === "assistant"
          && candidate.sourceEventId === record.sourceEventId
        )
      ) {
        issues.push({
          kind: "mixed_assistant_split",
          sourceRecordId: record.id,
          detail:
            "Visible assistant text and tool calls were split because Letta v1 requires null assistant content when tool_calls are present.",
        });
      }
      if (new Set(calls.map((call) => call.timestamp)).size > 1) {
        issues.push({
          kind: "tool_call_timestamps_coalesced",
          sourceRecordId: record.id,
          detail:
            "Letta v1 groups calls in one assistant record, so their distinct observed timestamps were represented by the first call timestamp.",
        });
      }
      continue;
    }
    records.push({
      role: "tool",
      tool_call_id: record.toolCallId,
      content: record.content,
      timestamp: record.timestamp,
    });
    if (record.truncated) {
      issues.push({
        kind: "tool_result_truncated",
        sourceRecordId: record.id,
        detail:
          `Tool result returned ${record.returnedBytes} of ${record.originalBytes} bytes; use the Quasar full-read pointer for the complete payload.`,
      });
    }
  }

  const exportValue = {
    format: "letta.trajectory/v1",
    schemaId: LETTA_TRAJECTORY_SCHEMA_ID,
    sourceTrajectoryVersion: QUASAR_TRAJECTORY_VERSION,
    trajectory: decodeLettaTrajectorySync(records),
    compatibility: { valid: true, issues },
  } as const;
  return Schema.decodeUnknownSync(
    LettaTrajectoryExport,
    strictParseOptions,
  )(exportValue);
};

const trajectoryExampleSource = decodeMappedSessionSync(
  mappedSessionExamples[0]!.input,
);

export const trajectoryExamples = [{
  name: "agent-readable source-linked trajectory",
  input: projectQuasarTrajectory(trajectoryExampleSource),
}] as const;

export const lettaTrajectoryExamples = [{
  name: "Letta-compatible trajectory export",
  input: toLettaTrajectory(projectQuasarTrajectory(trajectoryExampleSource)),
}] as const;
