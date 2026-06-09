import { Args, Command } from "@effect/cli";
import { Duration, Effect, Schema } from "effect";

import {
  buildIngestBatch,
  createSourceSafetyReport,
  ImportJobStartResponse,
  ImportJobStatusResponse,
  SESSION_INTELLIGENCE_CONTRACT_VERSION,
  jsonByteLength,
  loadMachineIdentity,
  manifestFromBatch,
  QuasarApiPaths,
  resnapshotSourceManifestEntries,
  snapshotIngestSourceManifest,
  stableJsonHash,
  streamIngestBatches,
  type IngestBatch,
  type IngestManifest,
  type MachineIdentity,
  type NormalizedSession,
  type SourceManifestEntry,
  type StreamIngestBatchOptions,
  sanitizeIngestBatchForTransport,
  summarizeBatch,
} from "@skastr0/quasar-core";

import { requestJson } from "../api";
import { loadJsonInput, loadOptionalJsonInput } from "../json";
import { executeJsonCommand } from "../output";
import { IngestOptions } from "../protocol";

const inputArg = Args.text({ name: "input" }).pipe(Args.optional);
const requiredInputArg = Args.text({ name: "input" });

const IngestWaitInput = Schema.Struct({
  importJobId: Schema.String,
  pollIntervalMs: Schema.optional(Schema.Number),
  timeoutMs: Schema.optional(Schema.Number),
});

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

const buildBatchWithSourceSnapshotEffect = (input: string | undefined) =>
  Effect.gen(function* () {
    const options = yield* loadOptions(input);
    const batch = yield* Effect.tryPromise({
      try: () =>
        buildIngestBatch({
          providers: options.providers,
          includeExperimental: options.includeExperimental,
          limit: options.limit,
          roots: options.roots,
        }),
      catch: (error) => (error instanceof Error ? error : new Error(String(error))),
    });
    const before = snapshotIngestSourceManifest(batch);
    return { options, before, batch };
  });

const readImportJob = (
  importJobId: string,
  requestClient: IngestRequestClient = requestJson,
) =>
  requestClient({
    method: "GET",
    path: QuasarApiPaths.ingestJobs,
    query: { importJobId },
    responseSchema: ImportJobStatusResponse,
  }).pipe(
    Effect.map((status) => ({
      ...status,
      importJobId,
      jobStatus: jobStatusFromPayload(status.job),
    })),
  );

const jobStatusFromPayload = (job: unknown) => {
  if (job !== null && typeof job === "object" && "status" in job) {
    const status = (job as Record<string, unknown>).status;
    if (typeof status === "string") return status;
  }
  return "unknown";
};

const validateCommand = Command.make("validate", { input: inputArg }, ({ input }) =>
  executeJsonCommand(
    "ingest validate",
    buildBatchWithSourceSnapshotEffect(toUndefined(input)).pipe(
      Effect.map(({ before, batch: rawBatch }) => {
        const batch = sanitizeIngestBatchForTransport(rawBatch);
        const after = snapshotIngestSourceManifest(batch);
        return {
          ...summarizeBatch(batch),
          sourceSafetyReport: createSourceSafetyReport({
            batch,
            before,
            after,
            quasarStateWrites: false,
          }),
        };
      }),
    ),
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

type IngestRequestClient = typeof requestJson;
const IngestRequestClientSchema = Schema.instanceOf(Function);

export const runIngestEffect = (
  input: string | undefined,
  requestClient: IngestRequestClient = requestJson,
) =>
  Effect.gen(function* () {
    const client = (yield* Schema.decodeUnknown(IngestRequestClientSchema)(
      requestClient,
    )) as IngestRequestClient;
    const options = yield* loadOptions(input);
    if (options.dryRun === true) {
      const { before, batch: rawBatch } = yield* buildBatchWithSourceSnapshotEffect(input);
      const batch = sanitizeIngestBatchForTransport(rawBatch);
      const after = snapshotIngestSourceManifest(batch);
      return {
        dryRun: true,
        summary: summarizeBatch(batch),
        sourceSafetyReport: createSourceSafetyReport({
          batch,
          before,
          after,
          quasarStateWrites: false,
        }),
      };
    }
    const machine = loadMachineIdentity();
    const generatedAt = new Date().toISOString();
    const streamOptions = {
      providers: options.providers,
      includeExperimental: options.includeExperimental,
      limit: options.limit,
      roots: options.roots,
      machine,
      generatedAt,
    };
    const chunkOptions = chunkOptionsFromEnv();
    const plan = yield* planStreamedIngest(streamOptions, chunkOptions);
    const job = yield* client({
      method: "POST",
      path: QuasarApiPaths.ingestJobs,
      body: {
        manifest: plan.manifest,
        idempotencyKey: plan.idempotencyKey,
        expectedChunkCount: plan.expectedChunkCount,
      },
      responseSchema: ImportJobStartResponse,
    });
    const chunkDelayMs = envPositiveInteger(
      "QUASAR_INGEST_CHUNK_DELAY_MS",
      DEFAULT_CHUNK_DELAY_MS,
    );
    const upload = yield* uploadStreamedIngest({
      streamOptions,
      chunkOptions,
      plan,
      client,
      importJobId: job.importJobId,
      uploadGroupSize: uploadGroupSizeFromEnv(),
      chunkDelayMs,
    });
    const status = yield* readImportJob(job.importJobId, client);
    const after = resnapshotSourceManifestEntries(plan.sourceBefore);
    return {
      ...summaryFromManifest(plan.manifest),
      importJobId: job.importJobId,
      jobStatus: status.jobStatus,
      chunkCount: plan.expectedChunkCount,
      uploadedChunkCount: upload.uploadedChunkCount,
      uploadGroupCount: upload.uploadGroupCount,
      status,
      sourceSafetyReport: createSourceSafetyReport({
        before: plan.sourceBefore,
        after,
        quasarStateWrites: true,
      }),
    };
  });

const runCommand = Command.make("run", { input: inputArg }, ({ input }) =>
  executeJsonCommand("ingest run", runIngestEffect(toUndefined(input))),
);

export const MAX_EVENTS_PER_CHUNK = 50;
export const MAX_OPERATIONS_PER_CHUNK = 120;
export const DEFAULT_CHUNK_DELAY_MS = 750;
export const DEFAULT_UPLOAD_GROUP_SIZE = 10;
export const MAX_UPLOAD_CHUNK_BATCH_BYTES = 768 * 1024;
export const MAX_BULK_UPLOAD_BODY_BYTES = 3_500_000;

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

const uploadGroupSizeFromEnv = () =>
  Math.max(
    1,
    envPositiveInteger("QUASAR_INGEST_UPLOAD_GROUP_SIZE", DEFAULT_UPLOAD_GROUP_SIZE),
  );

type StreamIngestOptions = StreamIngestBatchOptions & {
  readonly machine: MachineIdentity;
  readonly generatedAt: string;
};

type StreamIngestPlan = {
  readonly manifest: IngestManifest;
  readonly expectedChunkCount: number;
  readonly chunkPayloadHashes: readonly string[];
  readonly idempotencyKey: string;
  readonly sourceBefore: readonly SourceManifestEntry[];
};

type IngestManifestDraft = {
  protocolVersion: "quasar.ingest-manifest/v1";
  machine: IngestManifest["machine"];
  sourceRoots: IngestManifest["sourceRoots"][number][];
  sessions: IngestManifest["sessions"][number][];
  diagnostics: IngestManifest["diagnostics"][number][];
  generatedAt: string;
  sessionCount: number;
  eventCount: number;
  toolCallCount: number;
  contentBlockCount: number;
  sessionEdgeCount: number;
  usageRecordCount: number;
  artifactCount: number;
};

const planStreamedIngest = (
  streamOptions: StreamIngestOptions,
  chunkOptions: Required<ChunkOptions>,
) =>
  Effect.tryPromise({
    try: async () => {
      const manifest = emptyIngestManifest(streamOptions.machine, streamOptions.generatedAt);
      const sourceBefore = new Map<string, SourceManifestEntry>();
      const chunkPayloadHashes: string[] = [];
      for await (const batch of streamIngestBatches(streamOptions)) {
        mergeManifest(manifest, manifestFromBatch(batch));
        for (const entry of snapshotIngestSourceManifest(batch)) {
          sourceBefore.set(sourceManifestKey(entry), entry);
        }
        const chunks = chunkIngestBatch(batch, chunkOptions);
        validateChunkPayloads(chunks);
        for (const chunk of chunks) {
          chunkPayloadHashes.push(stableJsonHash(batchPayloadIdentity(chunk)));
        }
      }
      const plannedManifest: IngestManifest = manifest;
      return {
        manifest: plannedManifest,
        expectedChunkCount: chunkPayloadHashes.length,
        chunkPayloadHashes,
        idempotencyKey: streamedIngestJobIdempotencyKey(plannedManifest, chunkPayloadHashes),
        sourceBefore: sortedSourceManifestEntries(sourceBefore.values()),
      };
    },
    catch: (error) => (error instanceof Error ? error : new Error(String(error))),
  });

const uploadStreamedIngest = (input: {
  readonly streamOptions: StreamIngestOptions;
  readonly chunkOptions: Required<ChunkOptions>;
  readonly plan: StreamIngestPlan;
  readonly client: IngestRequestClient;
  readonly importJobId: string;
  readonly uploadGroupSize: number;
  readonly chunkDelayMs: number;
}) =>
  Effect.gen(function* () {
    const iterator = streamChunkBatches(input.streamOptions, input.chunkOptions)[Symbol.asyncIterator]();
    let group: Array<{ chunk: IngestBatch; index: number }> = [];
    let uploadedChunkCount = 0;
    let uploadGroupCount = 0;
    let index = 0;
    while (true) {
      const next = yield* Effect.tryPromise({
        try: () => iterator.next(),
        catch: (error) => (error instanceof Error ? error : new Error(String(error))),
      });
      if (next.done === true) break;
      const chunk = next.value;
      assertJsonBudget(chunk, MAX_UPLOAD_CHUNK_BATCH_BYTES, `chunk ${index}`);
      const expectedHash = input.plan.chunkPayloadHashes[index];
      const actualHash = stableJsonHash(batchPayloadIdentity(chunk));
      if (expectedHash !== actualHash) {
        throw new Error(`ingest source changed between planning and upload at chunk ${index}`);
      }
      const item = { chunk, index };
      const candidate = [...group, item];
      const nextBytes = jsonByteLength(
        bulkUploadRequestBody(input.importJobId, input.plan.expectedChunkCount, candidate),
      );
      if (
        group.length > 0 &&
        (group.length >= input.uploadGroupSize || nextBytes > MAX_BULK_UPLOAD_BODY_BYTES)
      ) {
        yield* uploadChunkGroup(input, group);
        uploadedChunkCount += group.length;
        uploadGroupCount += 1;
        group = [item];
      } else {
        group = candidate;
      }
      index += 1;
    }
    if (group.length > 0) {
      yield* uploadChunkGroup(input, group);
      uploadedChunkCount += group.length;
      uploadGroupCount += 1;
    }
    if (index !== input.plan.expectedChunkCount) {
      throw new Error(
        `ingest planned ${input.plan.expectedChunkCount} chunks but uploaded ${index}`,
      );
    }
    return { uploadedChunkCount, uploadGroupCount };
  });

const uploadChunkGroup = (
  input: {
    readonly client: IngestRequestClient;
    readonly importJobId: string;
    readonly plan: StreamIngestPlan;
    readonly chunkDelayMs: number;
  },
  group: readonly { chunk: IngestBatch; index: number }[],
) =>
  Effect.gen(function* () {
    const requestBody = bulkUploadRequestBody(
      input.importJobId,
      input.plan.expectedChunkCount,
      group,
    );
    assertJsonBudget(
      requestBody,
      MAX_BULK_UPLOAD_BODY_BYTES,
      `bulk upload group ending at chunk ${group.at(-1)?.index ?? 0}`,
    );
    yield* input.client({
      method: "POST",
      path: QuasarApiPaths.ingestJobChunksBulk,
      body: requestBody,
      responseSchema: Schema.Unknown,
    });
    if (group.at(-1)?.index !== input.plan.expectedChunkCount - 1 && input.chunkDelayMs > 0) {
      yield* Effect.sleep(Duration.millis(input.chunkDelayMs));
    }
  });

async function* streamChunkBatches(
  streamOptions: StreamIngestOptions,
  chunkOptions: Required<ChunkOptions>,
): AsyncGenerator<IngestBatch> {
  for await (const batch of streamIngestBatches(streamOptions)) {
    for (const chunk of chunkIngestBatch(batch, chunkOptions)) {
      yield chunk;
    }
  }
}

const emptyIngestManifest = (
  machine: StreamIngestOptions["machine"],
  generatedAt: string,
): IngestManifestDraft => ({
  protocolVersion: "quasar.ingest-manifest/v1",
  machine,
  sourceRoots: [],
  sessions: [],
  diagnostics: [],
  generatedAt,
  sessionCount: 0,
  eventCount: 0,
  toolCallCount: 0,
  contentBlockCount: 0,
  sessionEdgeCount: 0,
  usageRecordCount: 0,
  artifactCount: 0,
});

const mergeManifest = (target: IngestManifestDraft, batch: IngestManifest) => {
  target.sourceRoots.push(...batch.sourceRoots);
  target.sessions.push(...batch.sessions);
  target.diagnostics.push(...batch.diagnostics);
  target.sessionCount += batch.sessionCount;
  target.eventCount += batch.eventCount;
  target.toolCallCount += batch.toolCallCount;
  target.contentBlockCount += batch.contentBlockCount;
  target.sessionEdgeCount += batch.sessionEdgeCount;
  target.usageRecordCount += batch.usageRecordCount;
  target.artifactCount += batch.artifactCount;
};

const summaryFromManifest = (manifest: IngestManifest) => ({
  machine: manifest.machine,
  generatedAt: manifest.generatedAt,
  sourceRootCount: manifest.sourceRoots.length,
  sessionCount: manifest.sessionCount,
  eventCount: manifest.eventCount,
  toolCallCount: manifest.toolCallCount,
  contentBlockCount: manifest.contentBlockCount,
  sessionEdgeCount: manifest.sessionEdgeCount,
  usageRecordCount: manifest.usageRecordCount,
  artifactCount: manifest.artifactCount,
  diagnostics: manifest.diagnostics,
});

const streamedIngestJobIdempotencyKey = (
  manifest: IngestManifest,
  chunkPayloadHashes: readonly string[],
) =>
  `import-job:${stableJsonHash([
    SESSION_INTELLIGENCE_CONTRACT_VERSION,
    manifestIdentityFromManifest(manifest),
    chunkPayloadHashes.map((hash, sequence) => [sequence, hash]),
  ])}`;

const manifestIdentityFromManifest = (manifest: IngestManifest) => ({
  ...manifest,
  generatedAt: undefined,
});

const sourceManifestKey = (entry: SourceManifestEntry) => `${entry.role}:${entry.path}`;

const sortedSourceManifestEntries = (entries: Iterable<SourceManifestEntry>) =>
  [...entries].sort((left, right) =>
    `${left.role}:${left.path}`.localeCompare(`${right.role}:${right.path}`),
  );

const bulkUploadRequestBody = (
  importJobId: string,
  expectedChunkCount: number,
  group: readonly { chunk: IngestBatch; index: number }[],
) => ({
  importJobId,
  expectedChunkCount,
  chunks: group.map(({ chunk, index }) => ({
    batch: chunk,
    sequence: index,
    completeJob: index === expectedChunkCount - 1,
  })),
});

const validateChunkPayloads = (chunks: readonly IngestBatch[]) => {
  for (let index = 0; index < chunks.length; index += 1) {
    assertJsonBudget(
      chunks[index],
      MAX_UPLOAD_CHUNK_BATCH_BYTES,
      `chunk ${index}`,
    );
  }
};

const assertJsonBudget = (value: unknown, maxBytes: number, label: string) => {
  const bytes = jsonByteLength(value);
  if (bytes > maxBytes) {
    throw new Error(`${label} is ${bytes} bytes; maximum is ${maxBytes} bytes.`);
  }
};

export const ingestJobIdempotencyKey = (
  batch: IngestBatch,
  chunks: readonly IngestBatch[],
) =>
  streamedIngestJobIdempotencyKey(
    manifestFromBatch(batch),
    chunks.map((chunk) => stableJsonHash(batchPayloadIdentity(chunk))),
  );

const batchPayloadIdentity = (batch: IngestBatch) => ({
  ...batch,
  generatedAt: undefined,
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

const waitCommand = Command.make("wait", { input: requiredInputArg }, ({ input }) =>
  executeJsonCommand(
    "ingest wait",
    Effect.gen(function* () {
      const options = yield* loadJsonInput(IngestWaitInput, input);
      const pollIntervalMs = positiveInteger(options.pollIntervalMs, 2_000);
      const timeoutMs = positiveInteger(options.timeoutMs, 10 * 60_000);
      const startedAt = Date.now();
      while (true) {
        const status = yield* readImportJob(options.importJobId);
        if (isFinalJobStatus(status.jobStatus)) return { timedOut: false, ...status };
        if (Date.now() - startedAt >= timeoutMs) return { timedOut: true, ...status };
        yield* Effect.sleep(Duration.millis(pollIntervalMs));
      }
    }),
  ),
);

const eventsCommand = Command.make("events", { input: inputArg }, ({ input }) =>
  executeJsonCommand(
    "ingest events",
    Effect.gen(function* () {
      const maybeInput = toUndefined(input);
      if (maybeInput === undefined) {
        return yield* requestJson({
          method: "GET",
          path: QuasarApiPaths.ingestJobs,
          responseSchema: Schema.Unknown,
        });
      }
      const options = yield* loadJsonInput(
        Schema.Struct({ importJobId: Schema.String }),
        maybeInput,
      );
      return yield* readImportJob(options.importJobId);
    }),
  ),
);

const isFinalJobStatus = (status: string) =>
  status === "succeeded" || status === "partial_failure" || status === "failed";

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
