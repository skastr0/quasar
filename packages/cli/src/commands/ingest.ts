import { Args, Command } from "@effect/cli";
import { Effect, Schema } from "effect";

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
      const chunks = chunkIngestBatch(batch);
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
        if (index < chunks.length - 1) yield* Effect.sleep("750 millis");
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

export const chunkIngestBatch = (batch: IngestBatch): IngestBatch[] => {
  const chunks: IngestBatch[] = [];
  for (const session of batch.sessions) {
    const sessionChunks = chunkSession(session);
    for (const sessionChunk of sessionChunks) {
      chunks.push({ ...batch, sessions: [sessionChunk] });
    }
  }
  return chunks.length === 0 ? [{ ...batch, sessions: [] }] : chunks;
};

const chunkSession = (session: NormalizedSession): NormalizedSession[] => {
  if (session.events.length <= MAX_EVENTS_PER_CHUNK) return [sessionWithExpectedIds(session)];
  const chunks: NormalizedSession[] = [];
  for (let start = 0; start < session.events.length; start += MAX_EVENTS_PER_CHUNK) {
    const events = session.events.slice(start, start + MAX_EVENTS_PER_CHUNK);
    const eventIds = new Set(events.map((event) => event.id));
    const isLast = start + MAX_EVENTS_PER_CHUNK >= session.events.length;
    chunks.push(
      sessionWithExpectedIds(
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
      ),
    );
  }
  return chunks;
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
