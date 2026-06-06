import { Args, Command } from "@effect/cli";
import { Duration, Effect, Schema } from "effect";

import {
  buildIngestBatch,
  type IngestBatch,
  type NormalizedSession,
  sanitizeIngestBatchForTransport,
  summarizeBatch,
} from "@skastr0/quasar-core";

import { requestJson } from "../api";
import { loadOptionalJsonInput } from "../json";
import { executeJsonCommand } from "../output";
import { IngestOptions } from "../protocol";

const inputArg = Args.text({ name: "input" }).pipe(Args.optional);

const toUndefined = <A>(value: { _tag: "Some"; value: A } | { _tag: "None" }) =>
  value._tag === "Some" ? value.value : undefined;

const loadOptions = (input: string | undefined) =>
  loadOptionalJsonInput(IngestOptions, input, {});

const buildBatchEffect = (input: string | undefined) =>
  Effect.gen(function* () {
    const options = yield* loadOptions(input);
    return yield* Effect.tryPromise({
      try: () =>
        buildIngestBatch({
          providers: options.providers,
          includeExperimental: options.includeExperimental,
          limit: options.limit,
          roots: options.roots,
        }),
      catch: (error) => (error instanceof Error ? error : new Error(String(error))),
    });
  });

const validateCommand = Command.make("validate", { input: inputArg }, ({ input }) =>
  executeJsonCommand(
    "ingest validate",
    buildBatchEffect(toUndefined(input)).pipe(Effect.map(summarizeBatch)),
  ),
);

const planCommand = Command.make("plan", { input: inputArg }, ({ input }) =>
  executeJsonCommand(
    "ingest plan",
    buildBatchEffect(toUndefined(input)).pipe(
      Effect.map((batch) => ({
        ...summarizeBatch(batch),
        sessions: batch.sessions.map((session) => ({
          id: session.id,
          provider: session.provider,
          nativeSessionId: session.nativeSessionId,
          projectIdentity: session.projectIdentity,
          eventCount: session.events.length,
          sourcePath: session.sourcePath,
        })),
      })),
    ),
  ),
);

const runCommand = Command.make("run", { input: inputArg }, ({ input }) =>
  executeJsonCommand(
    "ingest run",
    Effect.gen(function* () {
      const options = yield* loadOptions(toUndefined(input));
      const batch = sanitizeIngestBatchForTransport(
        yield* buildBatchEffect(toUndefined(input)),
      );
      if (options.dryRun === true) {
        return { dryRun: true, summary: summarizeBatch(batch) };
      }
      const chunks = chunkIngestBatch(batch, chunkOptionsFromEnv());
      const chunkDelayMs = envPositiveInteger(
        "QUASAR_INGEST_CHUNK_DELAY_MS",
        DEFAULT_CHUNK_DELAY_MS,
      );
      const results = [];
      for (const [index, chunk] of chunks.entries()) {
        results.push(
          yield* requestJson({
            method: "POST",
            path: "/api/ingest/batches",
            body: chunk,
            responseSchema: Schema.Unknown,
          }),
        );
        if (index < chunks.length - 1 && chunkDelayMs > 0) {
          yield* Effect.sleep(Duration.millis(chunkDelayMs));
        }
      }
      return {
        ...summarizeBatch(batch),
        chunkCount: chunks.length,
        results,
      };
    }),
  ),
);

export const MAX_EVENTS_PER_CHUNK = 50;
export const MAX_OPERATIONS_PER_CHUNK = 120;
export const DEFAULT_CHUNK_DELAY_MS = 750;

export interface ChunkOptions {
  readonly maxEventsPerChunk?: number;
  readonly maxOperationsPerChunk?: number;
}

const chunkOptionsFromEnv = (): Required<ChunkOptions> => ({
  maxEventsPerChunk: envPositiveInteger(
    "QUASAR_INGEST_MAX_EVENTS_PER_CHUNK",
    MAX_EVENTS_PER_CHUNK,
  ),
  maxOperationsPerChunk: envPositiveInteger(
    "QUASAR_INGEST_MAX_OPERATIONS_PER_CHUNK",
    MAX_OPERATIONS_PER_CHUNK,
  ),
});

const envPositiveInteger = (name: string, fallback: number) => {
  const raw = process.env[name];
  if (raw === undefined || raw.trim().length === 0) return fallback;
  const value = Number.parseInt(raw, 10);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
};

export const chunkIngestBatch = (
  batch: IngestBatch,
  options: ChunkOptions = {},
): IngestBatch[] => {
  const chunks: IngestBatch[] = [];
  const chunkOptions = normalizeChunkOptions(options);
  for (const session of batch.sessions) {
    const sessionChunks = chunkSession(session, chunkOptions);
    for (const sessionChunk of sessionChunks) {
      chunks.push({ ...batch, sessions: [sessionChunk] });
    }
  }
  return chunks.length === 0 ? [{ ...batch, sessions: [] }] : chunks;
};

const normalizeChunkOptions = (
  options: ChunkOptions,
): Required<ChunkOptions> => ({
  maxEventsPerChunk: positiveInteger(
    options.maxEventsPerChunk,
    MAX_EVENTS_PER_CHUNK,
  ),
  maxOperationsPerChunk: positiveInteger(
    options.maxOperationsPerChunk,
    MAX_OPERATIONS_PER_CHUNK,
  ),
});

const positiveInteger = (value: number | undefined, fallback: number) =>
  value !== undefined && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : fallback;

const chunkSession = (
  session: NormalizedSession,
  options: Required<ChunkOptions>,
): NormalizedSession[] => {
  if (
    session.events.length <= options.maxEventsPerChunk &&
    estimatedChunkOperations(session, session.events, 0) <=
      options.maxOperationsPerChunk
  ) {
    return [sessionWithExpectedIds(session)];
  }
  const chunks: NormalizedSession[] = [];
  let start = 0;
  let operations = 0;

  for (let index = 0; index < session.events.length; index += 1) {
    const event = session.events[index]!;
    const eventOperations = estimatedEventOperations(session, event);
    const eventLimitReached = index - start >= options.maxEventsPerChunk;
    const operationLimitReached =
      index > start && operations + eventOperations > options.maxOperationsPerChunk;

    if (eventLimitReached || operationLimitReached) {
      chunks.push(sessionChunk(session, start, index));
      start = index;
      operations = 0;
    }

    operations += eventOperations;
  }

  if (start < session.events.length) {
    chunks.push(sessionChunk(session, start, session.events.length));
  }
  return chunks.length === 0 ? [sessionWithExpectedIds(session)] : chunks;
};

const sessionChunk = (
  session: NormalizedSession,
  start: number,
  end: number,
) => {
  const events = session.events.slice(start, end);
  const eventIds = new Set(events.map((event) => event.id));
  const isLast = end >= session.events.length;
  return sessionWithExpectedIds(
    {
      ...session,
      events,
      toolCalls: session.toolCalls.filter((toolCall) => eventIds.has(toolCall.eventId)),
      sessionEdges: session.sessionEdges.filter((edge) =>
        edgeBelongsToChunk(edge.fromEventId, edge.toEventId, eventIds),
      ),
      usageRecords: session.usageRecords.filter((usageRecord) =>
        usageRecord.eventId === undefined || eventIds.has(usageRecord.eventId),
      ),
      artifacts: session.artifacts.filter((artifact) =>
        artifact.eventId === undefined ? start === 0 : eventIds.has(artifact.eventId),
      ),
      ...(!isLast ? { partialSession: true } : {}),
    } as NormalizedSession & { partialSession?: boolean },
    session,
  );
};

const estimatedChunkOperations = (
  session: NormalizedSession,
  events: readonly NormalizedSession["events"][number][],
  start: number,
) => {
  const eventIds = new Set(events.map((event) => event.id));
  return (
    events.length +
    events.reduce((sum, event) => sum + event.contentBlocks.length, 0) +
    session.toolCalls.filter((toolCall) => eventIds.has(toolCall.eventId)).length +
    session.sessionEdges.filter((edge) =>
      edgeBelongsToChunk(edge.fromEventId, edge.toEventId, eventIds),
    ).length +
    session.usageRecords.filter((usageRecord) =>
      usageRecord.eventId === undefined || eventIds.has(usageRecord.eventId),
    ).length +
    session.artifacts.filter((artifact) =>
      artifact.eventId === undefined ? start === 0 : eventIds.has(artifact.eventId),
    ).length
  );
};

const estimatedEventOperations = (
  session: NormalizedSession,
  event: NormalizedSession["events"][number],
) => {
  const eventIds = new Set([event.id]);
  return estimatedChunkOperations(session, [event], session.events.indexOf(event));
};

const edgeBelongsToChunk = (
  fromEventId: string | undefined,
  toEventId: string | undefined,
  eventIds: Set<string>,
) =>
  (fromEventId !== undefined && eventIds.has(fromEventId)) ||
  (toEventId !== undefined && eventIds.has(toEventId)) ||
  (fromEventId === undefined && toEventId === undefined);

const sessionWithExpectedIds = (
  session: NormalizedSession & { partialSession?: boolean },
  fullSession: NormalizedSession = session,
) =>
  ({
    ...session,
    eventCount: fullSession.events.length,
    toolCallCount: fullSession.toolCalls.length,
    expectedEventIds: fullSession.events.map((event) => event.id),
    expectedToolCallIds: fullSession.toolCalls.map((toolCall) => toolCall.id),
    expectedContentBlockIds: fullSession.events.flatMap((event) =>
      event.contentBlocks.map((block) => block.id),
    ),
    expectedSessionEdgeIds: fullSession.sessionEdges.map((edge) => edge.id),
    expectedUsageRecordIds: fullSession.usageRecords.map((usageRecord) => usageRecord.id),
    expectedArtifactIds: fullSession.artifacts.map((artifact) => artifact.id),
    ...(session.partialSession === true ? { partialSession: true } : {}),
  }) as NormalizedSession;

const inspectCommand = Command.make("inspect", {}, () =>
  executeJsonCommand(
    "ingest inspect",
    requestJson({
      method: "GET",
      path: "/api/import-runs",
      responseSchema: Schema.Unknown,
    }),
  ),
);

const waitCommand = Command.make("wait", {}, () =>
  executeJsonCommand(
    "ingest wait",
    Effect.succeed({
      status: "unsupported",
      reason: "Server ingestion is synchronous in v1; inspect import runs instead.",
    }),
  ),
);

const eventsCommand = Command.make("events", {}, () =>
  executeJsonCommand(
    "ingest events",
    Effect.succeed({
      status: "unsupported",
      reason: "Streaming import events are not exposed in v1.",
    }),
  ),
);

export const ingestCommand = Command.make("ingest").pipe(
  Command.withSubcommands([
    validateCommand,
    planCommand,
    runCommand,
    inspectCommand,
    waitCommand,
    eventsCommand,
  ]),
);
