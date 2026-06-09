import { internal } from "./_generated/api";
import type { Doc } from "./_generated/dataModel";
import type { ActionCtx, MutationCtx, QueryCtx } from "./_generated/server";
import {
  decodeBoundarySync,
  type AdapterDiagnosticBoundary,
  ReadImportJobInput,
  type SourceRootBoundary,
  StartImportJobInput,
  SubmitImportChunkInput,
  SubmitImportChunksInput,
  type IngestBatchBoundary as IngestBatchBoundaryValue,
  type IngestManifestBoundary,
  type ProviderSchema,
  type StartImportJobInput as StartImportJobInputValue,
} from "./quasarDomainSchemas";
import { sanitizeIngestBoundaryBatch } from "./quasarIngestContract";
import { readinessCounts } from "./quasarEmbeddingReadiness";
import { redactSensitive, wideHash } from "./quasarText";
import { stableCanonicalJsonHash } from "@skastr0/quasar-core/hash";
import {
  streamedIngestJobIdempotencyKey,
  STREAM_INGEST_UPLOAD_IDENTITY_VERSION,
} from "@skastr0/quasar-core/ingest-identity";
import {
  sanitizeSessionIntelligenceDiagnostics,
  SESSION_INTELLIGENCE_CONTRACT_VERSION,
} from "@skastr0/quasar-core/session-intelligence";

type ImportJobStatus = "queued" | "running" | "succeeded" | "partial_failure" | "failed";
type ImportChunkStatus = "pending" | "running" | "succeeded" | "failed" | "dead_letter";

type StartImportJobResult = {
  readonly importJobId: string;
  readonly status: ImportJobStatus;
  readonly chunkCount: number;
  readonly expectedChunkCount?: number;
  readonly sourceIdentityKey?: string;
  readonly attemptNumber?: number;
};

type SubmitImportChunkResult = {
  readonly importJobId: string;
  readonly chunkId: string;
  readonly status: ImportChunkStatus;
  readonly jobStatus: ImportJobStatus;
  readonly enqueued?: boolean;
  readonly stale?: boolean;
};

type SanitizedSubmitImportChunkInput = {
  readonly importJobId: string;
  readonly batch: IngestBatchBoundaryValue;
  readonly chunkId?: string;
  readonly idempotencyKey?: string;
  readonly sequence?: number;
  readonly expectedChunkCount?: number;
  readonly completeJob?: boolean;
};

type ReadImportJobResult = {
  readonly job: ReturnType<typeof statusJob>;
  readonly chunks: ReturnType<typeof statusChunk>[];
  readonly failures: Doc<"importFailures">[];
  readonly readiness: Awaited<ReturnType<typeof embeddingReadiness>>;
  readonly pagination: {
    readonly chunks: {
      readonly isDone: boolean;
      readonly continueCursor: string;
    };
    readonly failures: {
      readonly isDone: boolean;
      readonly continueCursor: string;
    };
  };
} | null;

type IngestManifest = {
  readonly machineId: string;
  readonly generatedAt: string;
  readonly sourceRoots: readonly SourceRootBoundary[];
  readonly sessions: readonly IngestManifestSession[];
  readonly providerSummaries?: readonly IngestManifestProviderSummary[];
  readonly diagnostics: readonly AdapterDiagnosticBoundary[];
  readonly sessionCount: number;
  readonly eventCount: number;
  readonly toolCallCount: number;
  readonly contentBlockCount: number;
  readonly sessionEdgeCount: number;
  readonly usageRecordCount: number;
  readonly artifactCount: number;
};

type IngestManifestProviderSummary = {
  readonly provider: ProviderSchema;
  readonly sessionCount: number;
  readonly eventCount: number;
  readonly toolCallCount: number;
  readonly contentBlockCount: number;
  readonly sessionEdgeCount: number;
  readonly usageRecordCount: number;
  readonly artifactCount: number;
};

type IngestManifestSession = {
  readonly id: string;
  readonly nativeSessionId: string;
  readonly provider: ProviderSchema;
  readonly machineId: string;
  readonly projectIdentityKey: string;
  readonly sourceRoot: string;
  readonly sourcePath: string;
  readonly eventCount: number;
  readonly toolCallCount: number;
  readonly contentBlockCount: number;
  readonly sessionEdgeCount: number;
  readonly usageRecordCount: number;
  readonly artifactCount: number;
};

const IMPORT_CHUNK_LEASE_MS = 5 * 60_000;
const IMPORT_JOB_WORKER_LEASE_MS = 2 * 60_000;
const IMPORT_CHUNK_MAX_ATTEMPTS = 5;
const IMPORT_WORKER_BATCH_LIMIT = 24;
const IMPORT_WORKER_SCHEDULE_DELAY_MS = 1_000;
const IMPORT_CANCEL_CLEANUP_BATCH_LIMIT = 100;
const IMPORT_JOB_STALE_ATTEMPT_MS = IMPORT_JOB_WORKER_LEASE_MS * 2;
const MAX_IMPORT_JOB_INPUT_BYTES = 3_500_000;
const MAX_IMPORT_CHUNK_BATCH_BYTES = 768 * 1024;
const MAX_IMPORT_BULK_INPUT_BYTES = 3_500_000;
const textEncoder = new TextEncoder();

export const startImportJobHandler = async (
  ctx: MutationCtx,
  args: { input: unknown },
): Promise<StartImportJobResult> => {
  const decoded = decodeBoundarySync(StartImportJobInput, args.input, "start import job input");
  const input =
    decoded.batch === undefined
      ? decoded
      : {
          ...decoded,
          batch: sanitizeIngestBoundaryBatch(decoded.batch, "start import job batch"),
  };
  assertJsonByteBudget(input, MAX_IMPORT_JOB_INPUT_BYTES, "start import job input");
  const manifest = manifestForStart(input);
  const planIdentity = planIdentityForStart(input, manifest);
  const planIdentityKey = planIdentity.planIdentityKey;
  const sourceIdentityKey = input.sourceIdentityKey ?? planIdentityKey;
  const now = Date.now();
  const latestAttempt = await findLatestImportJobAttempt(ctx, sourceIdentityKey);
  const existing = latestAttempt === null
    ? null
    : await failStaleImportJobAttempt(ctx, latestAttempt, now);
  if (existing !== null) {
    assertImportJobPlanCompatible(existing, planIdentityKey);
    if (!isUnsuccessfulImportJob(existing)) {
      const expectedChunkCount = await expectedChunkCountForExistingJob(
        ctx,
        existing,
        input.expectedChunkCount,
      );
      return {
        importJobId: existing.importJobId,
        status: existing.status,
        chunkCount: existing.chunkCount,
        expectedChunkCount,
        sourceIdentityKey,
        attemptNumber: existing.attemptNumber,
      };
    }
  }

  const attemptNumber = existing === null ? 0 : (existing.attemptNumber ?? 0) + 1;
  const idempotencyKey = importJobAttemptIdempotencyKey(sourceIdentityKey, attemptNumber);
  const importJobId = `job:${wideHash(idempotencyKey)}`;
  await ctx.db.insert("importJobs", {
    importJobId,
    idempotencyKey,
    planIdentityKey,
    chunkPayloadFingerprint: planIdentity.chunkPayloadFingerprint,
    sourceIdentityKey,
    attemptNumber,
    machineId: manifest.machineId,
    status: "queued",
    generatedAt: manifest.generatedAt,
    sourceRootCount: manifest.sourceRoots.length,
    sessionCount: manifest.sessionCount,
    eventCount: manifest.eventCount,
    toolCallCount: manifest.toolCallCount,
    contentBlockCount: manifest.contentBlockCount,
    sessionEdgeCount: manifest.sessionEdgeCount,
    usageRecordCount: manifest.usageRecordCount,
    artifactCount: manifest.artifactCount,
    chunkCount: 0,
    expectedChunkCount: input.expectedChunkCount,
    uploadedChunkCount: 0,
    succeededChunkCount: 0,
    succeededPrefixCount: 0,
    failedChunkCount: 0,
    terminalChunkSequenceSum: 0,
    diagnostics: sanitizeDiagnosticsForStorage(manifest.diagnostics),
    startedAt: now,
    createdAt: now,
    updatedAt: now,
  });
  await upsertImportShards(ctx, importJobId, manifest, now);
  return {
    importJobId,
    status: "queued" as const,
    chunkCount: 0,
    expectedChunkCount: input.expectedChunkCount,
    sourceIdentityKey,
    attemptNumber,
  };
};

const planIdentityForStart = (
  input: StartImportJobInputValue,
  manifest: IngestManifest,
) => {
  if (input.batch !== undefined) {
    if (input.chunkPayloadFingerprint !== undefined) {
      throw new Error("Import job chunkPayloadFingerprint is only accepted for manifest imports.");
    }
    const planIdentityKey = importJobIdempotencyKey(manifest, input.batch);
    assertStartIdempotencyKey(input.idempotencyKey, planIdentityKey);
    return { planIdentityKey };
  }

  if (input.manifest !== undefined && input.chunkPayloadFingerprint !== undefined) {
    const planIdentityKey = streamedIngestJobIdempotencyKey(
      input.manifest,
      input.chunkPayloadFingerprint,
    );
    assertStartIdempotencyKey(input.idempotencyKey, planIdentityKey);
    return { planIdentityKey, chunkPayloadFingerprint: input.chunkPayloadFingerprint };
  }

  const planIdentityKey = importJobIdempotencyKey(manifest, undefined);
  assertStartIdempotencyKey(input.idempotencyKey, planIdentityKey);
  return { planIdentityKey };
};

const assertStartIdempotencyKey = (
  supplied: string | undefined,
  expected: string,
) => {
  if (supplied !== undefined && supplied !== expected) {
    throw new Error("Import job idempotencyKey does not match its derived plan identity.");
  }
};

const failStaleImportJobAttempt = async (
  ctx: MutationCtx,
  job: Doc<"importJobs">,
  now: number,
) => {
  if (isClosedImportJob(job) || isUnsuccessfulImportJob(job)) return job;
  if (now - job.updatedAt < IMPORT_JOB_STALE_ATTEMPT_MS) return job;
  await ctx.db.patch(job._id, {
    status: "failed",
    error: "Import job attempt became stale before completion.",
    completedAt: now,
    updatedAt: now,
  });
  const lease = await findImportWorkerLease(ctx, job.importJobId);
  if (lease !== null) await ctx.db.delete(lease._id);
  return {
    ...job,
    status: "failed" as const,
    error: "Import job attempt became stale before completion.",
    completedAt: now,
    updatedAt: now,
  };
};

export const submitImportChunkHandler = async (
  ctx: ActionCtx,
  args: { input: unknown },
): Promise<SubmitImportChunkResult> => {
  const decoded = decodeBoundarySync(SubmitImportChunkInput, args.input, "submit import chunk input");
  const input = {
    ...decoded,
    batch: sanitizeIngestBoundaryBatch(decoded.batch, "import chunk batch"),
  };
  assertJsonByteBudget(input.batch, MAX_IMPORT_CHUNK_BATCH_BYTES, "import chunk batch");
  const result = (await ctx.runMutation(internal.quasar.enqueueImportChunkInternal, {
    input: {
      importJobId: input.importJobId,
      batch: input.batch,
      chunkId: input.chunkId,
      idempotencyKey: input.idempotencyKey,
      sequence: input.sequence,
      expectedChunkCount: input.expectedChunkCount,
      completeJob: input.completeJob,
    },
  })) as SubmitImportChunkResult;
  return { ...result, enqueued: result.status !== "succeeded" };
};

export const submitImportChunksHandler = async (
  ctx: ActionCtx,
  args: { input: unknown },
): Promise<{
  readonly importJobId: string;
  readonly enqueuedCount: number;
  readonly results: readonly SubmitImportChunkResult[];
}> => {
  const decoded = decodeBoundarySync(SubmitImportChunksInput, args.input, "submit import chunks input");
  const input = {
    ...decoded,
    chunks: decoded.chunks.map((chunk, index) => ({
      ...chunk,
      batch: sanitizeIngestBoundaryBatch(chunk.batch, `bulk import chunk batch ${index}`),
    })),
  };
  assertJsonByteBudget(input, MAX_IMPORT_BULK_INPUT_BYTES, "bulk import chunk input");
  const results: SubmitImportChunkResult[] = [];
  for (const chunk of input.chunks) {
    assertJsonByteBudget(chunk.batch, MAX_IMPORT_CHUNK_BATCH_BYTES, "bulk import chunk batch");
    results.push(
      (await ctx.runMutation(internal.quasar.enqueueImportChunkInternal, {
        scheduleWorker: false,
        input: {
          importJobId: input.importJobId,
          batch: chunk.batch,
          chunkId: chunk.chunkId,
          idempotencyKey: chunk.idempotencyKey,
          sequence: chunk.sequence,
          expectedChunkCount: input.expectedChunkCount,
          completeJob: chunk.completeJob,
        },
      })) as SubmitImportChunkResult,
    );
  }
  if (input.scheduleWorker !== false && input.chunks.length > 0) {
    await ctx.runMutation(internal.quasar.scheduleImportWorkerInternal, {
      importJobId: input.importJobId,
      delayMs: 0,
    });
  }
  return { importJobId: input.importJobId, enqueuedCount: results.length, results };
};

export const enqueueImportChunkHandler = async (
  ctx: MutationCtx,
  args: { input: unknown; scheduleWorker?: boolean },
): Promise<SubmitImportChunkResult> => {
  const decoded = decodeBoundarySync(SubmitImportChunkInput, args.input, "submit import chunk input");
  const input = {
    ...decoded,
    batch: sanitizeIngestBoundaryBatch(decoded.batch, "import chunk batch"),
  };
  assertJsonByteBudget(input.batch, MAX_IMPORT_CHUNK_BATCH_BYTES, "import chunk batch");
  const now = Date.now();
  const request = await resolveImportChunkRequest(ctx, input);
  if (isClosedImportJob(request.job) && request.existing?.status !== "succeeded") {
    throw new Error("Import job is no longer accepting chunks.");
  }
  if (request.existing?.status === "succeeded") {
    await maybeFinalizeImportJob(ctx, input.importJobId, now);
    return {
      importJobId: input.importJobId,
      chunkId: request.existing.chunkId,
      status: request.existing.status,
      jobStatus: (await findImportJob(ctx, input.importJobId))?.status ?? "running",
    };
  }
  await patchExpectedChunkCount(ctx, request.job, request.expectedChunkCount, now);

  const chunkPatch = {
    chunkId: request.chunkId,
    importJobId: input.importJobId,
    idempotencyKey: request.idempotencyKey,
    sequence: request.sequence,
    status: "pending" as const,
    sessionCount: request.summary.sessionCount,
    eventCount: request.summary.eventCount,
    toolCallCount: request.summary.toolCallCount,
    contentBlockCount: request.summary.contentBlockCount,
    sessionEdgeCount: request.summary.sessionEdgeCount,
    usageRecordCount: request.summary.usageRecordCount,
    artifactCount: request.summary.artifactCount,
    maxAttempts: IMPORT_CHUNK_MAX_ATTEMPTS,
    payloadHash: request.payloadHash,
    payloadBytes: request.payloadBytes,
    error: undefined,
    nextAttemptAt: now,
    leaseExpiresAt: undefined,
    leaseToken: undefined,
    payloadStoredAt: now,
    updatedAt: now,
  };
  if (request.existing === null) {
    await ctx.db.insert("importChunks", {
      ...chunkPatch,
      attempts: 0,
      createdAt: now,
    });
    await patchImportJobCounters(ctx, input.importJobId, {
      chunkCount: 1,
      uploadedChunkCount: 1,
      status: "running",
      now,
    });
  } else {
    await ctx.db.patch(request.existing._id, {
      ...chunkPatch,
      attempts: request.existing.attempts,
      completedAt: undefined,
    });
    if (isTerminalFailed(request.existing.status)) {
      await patchImportJobCounters(ctx, input.importJobId, {
        failedChunkCount: -1,
        terminalChunkSequenceSum: -request.existing.sequence,
        status: "running",
        now,
      });
    } else {
      await patchImportJobStatus(ctx, input.importJobId, "running", now);
    }
  }
  await upsertChunkPayload(ctx, {
    chunkId: request.chunkId,
    importJobId: input.importJobId,
    payloadHash: request.payloadHash,
    payloadBytes: request.payloadBytes,
    batch: input.batch,
    now,
  });
  if (args.scheduleWorker !== false) await scheduleImportWorker(ctx, input.importJobId, 0);
  return {
    importJobId: input.importJobId,
    chunkId: request.chunkId,
    status: "pending",
    jobStatus: "running",
    enqueued: true,
  };
};

const resolveImportChunkRequest = async (
  ctx: MutationCtx,
  input: SanitizedSubmitImportChunkInput,
) => {
  const job = await findImportJob(ctx, input.importJobId);
  if (job === null) throw new Error("Import job was not found.");
  const summary = summarizeBatch(input.batch);
  const sequence = input.sequence ?? job.chunkCount;
  assertNonNegativeInteger(sequence, "Import chunk sequence");
  const expectedChunkCount =
    input.expectedChunkCount ?? (input.completeJob === true ? sequence + 1 : undefined);
  if (expectedChunkCount !== undefined) {
    assertPositiveInteger(expectedChunkCount, "Import expectedChunkCount");
  }
  if (expectedChunkCount !== undefined && sequence >= expectedChunkCount) {
    throw new Error("Import chunk sequence must be less than expectedChunkCount.");
  }
  const payloadBytes = jsonByteLength(input.batch);
  const payloadHash = payloadHashForBatch(input.batch);
  const expectedIdempotencyKey = importChunkIdempotencyKey(
    input.importJobId,
    sequence,
    payloadHash,
  );
  if (input.idempotencyKey !== undefined && input.idempotencyKey !== expectedIdempotencyKey) {
    throw new Error("Import chunk idempotencyKey does not match its job, sequence, and payload.");
  }
  const idempotencyKey = expectedIdempotencyKey;
  const chunkId = input.chunkId ?? `chunk:${wideHash(idempotencyKey)}`;
  const existingBySequence = await ctx.db
    .query("importChunks")
    .withIndex("by_job_sequence", (q) =>
      q.eq("importJobId", input.importJobId).eq("sequence", sequence),
    )
    .unique();
  const existing = await ctx.db
    .query("importChunks")
    .withIndex("by_idempotencyKey", (q) => q.eq("idempotencyKey", idempotencyKey))
    .unique();
  if (existingBySequence !== null && existingBySequence.idempotencyKey !== idempotencyKey) {
    throw new Error("Import chunk sequence is already occupied by a different chunk.");
  }
  if (existing !== null) {
    assertExistingChunkMatchesRequest(existing, input.importJobId, sequence, payloadHash);
  }
  return {
    job,
    summary,
    sequence,
    expectedChunkCount,
    payloadBytes,
    payloadHash,
    idempotencyKey,
    chunkId,
    existing,
  };
};

export const scheduleImportWorkerMutationHandler = async (
  ctx: MutationCtx,
  args: { importJobId: string; delayMs?: number },
): Promise<{ readonly scheduled: true }> => {
  await scheduleImportWorker(ctx, args.importJobId, args.delayMs ?? 0);
  return { scheduled: true as const };
};

export const cancelImportJobHandler = async (
  ctx: MutationCtx,
  args: { importJobId: string; reason?: string },
): Promise<{
  readonly importJobId: string;
  readonly status: ImportJobStatus;
  readonly cancelled: boolean;
  readonly cleanedChunkCount?: number;
  readonly deletedPayloadCount?: number;
  readonly cleanupDone?: boolean;
}> => {
  const now = Date.now();
  const job = await findImportJob(ctx, args.importJobId);
  if (job === null) throw new Error("Import job was not found.");
  if (isClosedImportJob(job)) {
    return { importJobId: args.importJobId, status: job.status, cancelled: false };
  }
  await ctx.db.patch(job._id, {
    status: "failed",
    error: args.reason ?? "Import job cancelled.",
    completedAt: now,
    updatedAt: now,
  });
  const lease = await findImportWorkerLease(ctx, args.importJobId);
  if (lease !== null) await ctx.db.delete(lease._id);
  const cleanup = await cleanupCancelledImportJobRows(ctx, args.importJobId, args.reason ?? "Import job cancelled.", now);
  if (!cleanup.done) await scheduleCancelledImportCleanup(ctx, args.importJobId);
  return {
    importJobId: args.importJobId,
    status: "failed",
    cancelled: true,
    cleanedChunkCount: cleanup.cleanedChunkCount,
    deletedPayloadCount: cleanup.deletedPayloadCount,
    cleanupDone: cleanup.done,
  };
};

export const cleanupCancelledImportJobHandler = async (
  ctx: MutationCtx,
  args: { importJobId: string },
): Promise<{
  readonly importJobId: string;
  readonly cleanedChunkCount: number;
  readonly deletedPayloadCount: number;
  readonly done: boolean;
}> => {
  const job = await findImportJob(ctx, args.importJobId);
  if (job === null) throw new Error("Import job was not found.");
  if (!isClosedImportJob(job)) {
    return { importJobId: args.importJobId, cleanedChunkCount: 0, deletedPayloadCount: 0, done: true };
  }
  const cleanup = await cleanupCancelledImportJobRows(
    ctx,
    args.importJobId,
    job.error ?? "Import job cancelled.",
    Date.now(),
  );
  if (!cleanup.done) await scheduleCancelledImportCleanup(ctx, args.importJobId);
  return { importJobId: args.importJobId, ...cleanup };
};

export const processImportJobChunksHandler = async (
  ctx: ActionCtx,
  args: { importJobId?: string; limit?: number },
): Promise<{ readonly processed: number }> => {
  const workerLease = (await ctx.runMutation(internal.quasar.claimImportJobWorkerInternal, {
    importJobId: args.importJobId,
    now: Date.now(),
  })) as { importJobId?: string; leaseToken: string } | null;
  if (workerLease === null) return { processed: 0 };
  const limit = Math.max(
    1,
    Math.min(IMPORT_WORKER_BATCH_LIMIT, Math.trunc(args.limit ?? IMPORT_WORKER_BATCH_LIMIT)),
  );
  let processed = 0;
  try {
    for (let index = 0; index < limit; index += 1) {
      const claim = (await ctx.runMutation(internal.quasar.claimImportChunkInternal, {
        importJobId: args.importJobId,
        now: Date.now(),
      })) as
        | {
            chunkId: string;
            importJobId: string;
            batch: IngestBatchBoundaryValue;
            attempts: number;
            leaseToken: string;
          }
        | null;
      if (claim === null) break;
      processed += 1;
      try {
        await ctx.runMutation(internal.quasar.ingestBatchInternal, {
          batch: claim.batch,
          importJobId: claim.importJobId,
          importChunkId: claim.chunkId,
          leaseToken: claim.leaseToken,
        });
        await ctx.runMutation(internal.quasar.markImportChunkSucceededInternal, {
          importJobId: claim.importJobId,
          chunkId: claim.chunkId,
          leaseToken: claim.leaseToken,
        });
      } catch (error) {
        const failure = importChunkWorkerFailure(error);
        await ctx.runMutation(internal.quasar.markImportChunkFailedInternal, {
          importJobId: claim.importJobId,
          chunkId: claim.chunkId,
          leaseToken: claim.leaseToken,
          error: failure.error,
        });
      }
    }
    if (processed === limit) {
      await ctx.scheduler.runAfter(IMPORT_WORKER_SCHEDULE_DELAY_MS, internal.quasar.processImportJobChunksInternal, {
        importJobId: args.importJobId,
        limit,
      });
    }
    return { processed };
  } finally {
    await ctx.runMutation(internal.quasar.releaseImportJobWorkerInternal, {
      importJobId: workerLease.importJobId,
      leaseToken: workerLease.leaseToken,
    });
  }
};

export const claimImportJobWorkerHandler = async (
  ctx: MutationCtx,
  args: { importJobId?: string; now: number },
): Promise<{ readonly importJobId?: string; readonly leaseToken: string } | null> => {
  if (args.importJobId === undefined) return { leaseToken: "unscoped" };
  const existing = await findImportWorkerLease(ctx, args.importJobId);
  if (existing !== null && existing.leaseExpiresAt > args.now) return null;
  const leaseToken = `job-worker:${crypto.randomUUID?.() ?? `${args.now}:${Math.random()}`}`;
  const patch = {
    leaseToken,
    leaseExpiresAt: args.now + IMPORT_JOB_WORKER_LEASE_MS,
    updatedAt: args.now,
  };
  if (existing === null) {
    await ctx.db.insert("importWorkerLeases", {
      importJobId: args.importJobId,
      ...patch,
      createdAt: args.now,
    });
  } else {
    await ctx.db.patch(existing._id, patch);
  }
  return { importJobId: args.importJobId, leaseToken };
};

export const releaseImportJobWorkerHandler = async (
  ctx: MutationCtx,
  args: { importJobId?: string; leaseToken: string },
): Promise<{ readonly released: boolean }> => {
  if (args.importJobId === undefined) return { released: true };
  const existing = await findImportWorkerLease(ctx, args.importJobId);
  if (existing === null || existing.leaseToken !== args.leaseToken) return { released: false };
  await ctx.db.delete(existing._id);
  return { released: true };
};

export const claimImportChunkHandler = async (
  ctx: MutationCtx,
  args: { importJobId?: string; now: number },
): Promise<{
  readonly chunkId: string;
  readonly importJobId: string;
  readonly batch: IngestBatchBoundaryValue;
  readonly attempts: number;
  readonly leaseToken: string;
} | null> => {
  let job: Doc<"importJobs"> | null = null;
  if (args.importJobId !== undefined) {
    job = await findImportJob(ctx, args.importJobId);
    if (job === null || isClosedImportJob(job)) return null;
  }
  const candidate = await findClaimableChunk(ctx, job, args.importJobId, args.now);
  if (candidate === null) return null;
  const { chunk, batch } = candidate;
  if (batch === undefined) {
    await markChunkTerminalFailure(ctx, chunk, "Import chunk has no stored payload.", args.now);
    return null;
  }
  const attempts = chunk.attempts + 1;
  const leaseToken = `chunk-lease:${crypto.randomUUID?.() ?? `${args.now}:${Math.random()}`}`;
  await ctx.db.patch(chunk._id, {
    status: "running",
    attempts,
    startedAt: args.now,
    leaseExpiresAt: args.now + IMPORT_CHUNK_LEASE_MS,
    leaseToken,
    updatedAt: args.now,
  });
  await patchImportJobStatus(ctx, chunk.importJobId, "running", args.now);
  return {
    chunkId: chunk.chunkId,
    importJobId: chunk.importJobId,
    batch,
    attempts,
    leaseToken,
  };
};

export const markImportChunkSucceededHandler = async (
  ctx: MutationCtx,
  args: { importJobId: string; chunkId: string; leaseToken: string },
): Promise<SubmitImportChunkResult> => {
  const now = Date.now();
  const chunk = await findImportChunk(ctx, args.chunkId);
  if (chunk === null) throw new Error("Import chunk was not found.");
  const stale = staleChunkClaim(chunk, args.importJobId, args.leaseToken);
  if (stale !== null) {
    const job = await findImportJob(ctx, args.importJobId);
    return { ...stale, jobStatus: job?.status ?? stale.jobStatus };
  }
  const job = await findImportJob(ctx, args.importJobId);
  if (job === null || isClosedImportJob(job)) {
    await releaseChunkForClosedJob(ctx, chunk, job?.error ?? "Import job closed before chunk completed.", now);
    return {
      importJobId: args.importJobId,
      chunkId: args.chunkId,
      status: "dead_letter" as const,
      jobStatus: job?.status ?? "failed",
      stale: true,
    };
  }
  const oldStatus = chunk.status;
  await ctx.db.patch(chunk._id, {
    status: "succeeded",
    completedAt: now,
    error: undefined,
    leaseExpiresAt: undefined,
    leaseToken: undefined,
    payloadStoredAt: undefined,
    updatedAt: now,
  });
  await deleteChunkPayload(ctx, chunk.chunkId);
  const succeededPrefixCount = await nextSucceededPrefixCount(ctx, args.importJobId, chunk);
  await patchImportJobCounters(ctx, args.importJobId, {
    succeededChunkCount: oldStatus === "succeeded" ? 0 : 1,
    succeededPrefixCount,
    failedChunkCount: isTerminalFailed(oldStatus) ? -1 : 0,
    terminalChunkSequenceSum: isTerminal(oldStatus) ? 0 : chunk.sequence,
    now,
  });
  const jobStatus = await maybeFinalizeImportJob(ctx, args.importJobId, now);
  return {
    importJobId: args.importJobId,
    chunkId: args.chunkId,
    status: "succeeded" as const,
    jobStatus,
  };
};

export const markImportChunkFailedHandler = async (
  ctx: MutationCtx,
  args: { importJobId: string; chunkId: string; leaseToken: string; error: string },
): Promise<void> => {
  const now = Date.now();
  const chunk = await findImportChunk(ctx, args.chunkId);
  if (chunk === null) return;
  if (staleChunkClaim(chunk, args.importJobId, args.leaseToken) !== null) return;
  const job = await findImportJob(ctx, args.importJobId);
  if (job === null || isClosedImportJob(job)) {
    await releaseChunkForClosedJob(ctx, chunk, job?.error ?? args.error, now);
    return;
  }
  const maxAttempts = chunk.maxAttempts ?? IMPORT_CHUNK_MAX_ATTEMPTS;
  const exhausted = chunk.attempts >= maxAttempts;
  const nextStatus: ImportChunkStatus = exhausted ? "dead_letter" : "pending";
  await ctx.db.patch(chunk._id, {
    status: nextStatus,
    error: args.error,
    completedAt: exhausted ? now : undefined,
    leaseExpiresAt: undefined,
    leaseToken: undefined,
    nextAttemptAt: exhausted ? undefined : now + retryDelayMs(chunk.attempts),
    payloadStoredAt: exhausted ? undefined : chunk.payloadStoredAt,
    updatedAt: now,
  });
  if (exhausted) await deleteChunkPayload(ctx, chunk.chunkId);
  await ctx.db.insert("importFailures", {
    failureId: `failure:${wideHash(`${args.importJobId}\u001f${args.chunkId}\u001f${now}`)}`,
    importJobId: args.importJobId,
    chunkId: args.chunkId,
    error: args.error,
    retryable: !exhausted,
    createdAt: now,
    updatedAt: now,
  });
  if (exhausted && !isTerminalFailed(chunk.status)) {
    await patchImportJobCounters(ctx, args.importJobId, {
      failedChunkCount: 1,
      terminalChunkSequenceSum: chunk.sequence,
      status: "partial_failure",
      now,
    });
  } else {
    await patchImportJobStatus(ctx, args.importJobId, "running", now);
    await scheduleImportWorker(ctx, args.importJobId, retryDelayMs(chunk.attempts));
  }
  await maybeFinalizeImportJob(ctx, args.importJobId, now);
};

export const readImportJobHandler = async (
  ctx: QueryCtx,
  args: { input: unknown },
): Promise<ReadImportJobResult> => {
  const input = decodeBoundarySync(ReadImportJobInput, args.input, "read import job input");
  const job = await ctx.db
    .query("importJobs")
    .withIndex("by_importJobId", (q) => q.eq("importJobId", input.importJobId))
    .unique();
  if (job === null) return null;
  const limit = boundedStatusLimit(input.limit);
  const pageFailures = input.failureCursor !== undefined && input.failureCursor !== null;
  const chunks = pageFailures
    ? {
        page: await ctx.db
          .query("importChunks")
          .withIndex("by_job_sequence", (q) => q.eq("importJobId", input.importJobId))
          .take(limit),
        isDone: true,
        continueCursor: "",
      }
    : await ctx.db
        .query("importChunks")
        .withIndex("by_job_sequence", (q) => q.eq("importJobId", input.importJobId))
        .paginate({ cursor: input.chunkCursor ?? null, numItems: limit });
  const failures = pageFailures
    ? await ctx.db
        .query("importFailures")
        .withIndex("by_importJobId", (q) => q.eq("importJobId", input.importJobId))
        .paginate({ cursor: input.failureCursor ?? null, numItems: Math.min(100, limit) })
    : {
        page: await ctx.db
          .query("importFailures")
          .withIndex("by_importJobId", (q) => q.eq("importJobId", input.importJobId))
          .take(Math.min(100, limit)),
        isDone: true,
        continueCursor: "",
      };
  const readiness = await embeddingReadiness(ctx, input.importJobId);
  return {
    job: statusJob(job),
    chunks: chunks.page.map(statusChunk),
    failures: failures.page,
    readiness,
    pagination: {
      chunks: {
        isDone: chunks.isDone,
        continueCursor: chunks.continueCursor,
      },
      failures: {
        isDone: failures.isDone,
        continueCursor: failures.continueCursor,
      },
    },
  };
};

export const listImportJobsHandler = async (
  ctx: QueryCtx,
  args: { limit?: number },
): Promise<readonly { readonly job: unknown; readonly readiness: unknown }[]> => {
  const jobs = await ctx.db
    .query("importJobs")
    .withIndex("by_createdAt")
    .order("desc")
    .take(Math.min(50, Math.max(1, Math.trunc(args.limit ?? 25))));
  const summaries = [];
  for (const job of jobs) {
    summaries.push({
      job,
      readiness: await embeddingReadiness(ctx, job.importJobId),
    });
  }
  return summaries;
};

const findImportJob = async (ctx: MutationCtx, importJobId: string) =>
  await ctx.db
    .query("importJobs")
    .withIndex("by_importJobId", (q) => q.eq("importJobId", importJobId))
    .unique();

const findLatestImportJobAttempt = async (
  ctx: MutationCtx,
  sourceIdentityKey: string,
) => {
  const attempts = await ctx.db
    .query("importJobs")
    .withIndex("by_sourceIdentity_attempt", (q) => q.eq("sourceIdentityKey", sourceIdentityKey))
    .collect();
  return attempts.reduce<Doc<"importJobs"> | null>((latest, job) => {
    if (latest === null) return job;
    return (job.attemptNumber ?? 0) > (latest.attemptNumber ?? 0) ? job : latest;
  }, null);
};

const assertImportJobPlanCompatible = (
  job: Doc<"importJobs">,
  planIdentityKey: string,
) => {
  const existingPlanIdentityKey = job.planIdentityKey ?? job.sourceIdentityKey;
  if (existingPlanIdentityKey !== planIdentityKey) {
    throw new Error("Import sourceIdentityKey is already bound to a different ingest plan.");
  }
};

const findImportChunk = async (ctx: MutationCtx, chunkId: string) =>
  await ctx.db
    .query("importChunks")
    .withIndex("by_chunkId", (q) => q.eq("chunkId", chunkId))
    .unique();

const findChunkPayload = async (ctx: MutationCtx, chunkId: string) =>
  await ctx.db
    .query("importChunkPayloads")
    .withIndex("by_chunkId", (q) => q.eq("chunkId", chunkId))
    .unique();

const findImportWorkerLease = async (ctx: MutationCtx, importJobId: string) =>
  await ctx.db
    .query("importWorkerLeases")
    .withIndex("by_importJobId", (q) => q.eq("importJobId", importJobId))
    .unique();

const upsertChunkPayload = async (
  ctx: MutationCtx,
  input: {
    readonly chunkId: string;
    readonly importJobId: string;
    readonly payloadHash: string;
    readonly payloadBytes: number;
    readonly batch: IngestBatchBoundaryValue;
    readonly now: number;
  },
) => {
  const existing = await findChunkPayload(ctx, input.chunkId);
  const patch = {
    importJobId: input.importJobId,
    payloadHash: input.payloadHash,
    payloadBytes: input.payloadBytes,
    batch: input.batch,
    updatedAt: input.now,
  };
  if (existing === null) {
    await ctx.db.insert("importChunkPayloads", {
      chunkId: input.chunkId,
      ...patch,
      createdAt: input.now,
    });
  } else {
    await ctx.db.patch(existing._id, patch);
  }
};

const deleteChunkPayload = async (ctx: MutationCtx, chunkId: string) => {
  const existing = await findChunkPayload(ctx, chunkId);
  if (existing !== null) await ctx.db.delete(existing._id);
};

const expectedChunkCountForExistingJob = async (
  ctx: MutationCtx,
  job: Doc<"importJobs">,
  requested: number | undefined,
) => {
  if (requested === undefined) return job.expectedChunkCount;
  await patchExpectedChunkCount(ctx, job, requested, Date.now());
  return requested;
};

const patchExpectedChunkCount = async (
  ctx: MutationCtx,
  job: Doc<"importJobs">,
  requested: number | undefined,
  now: number,
) => {
  if (requested === undefined) return;
  assertPositiveInteger(requested, "Import expectedChunkCount");
  if (job.expectedChunkCount !== undefined && job.expectedChunkCount !== requested) {
    throw new Error("Import job expectedChunkCount is immutable once set.");
  }
  if (job.expectedChunkCount === undefined) {
    await ctx.db.patch(job._id, { expectedChunkCount: requested, updatedAt: now });
  }
};

const findDuePendingChunk = async (
  ctx: MutationCtx,
  importJobId: string | undefined,
  now: number,
) =>
  importJobId === undefined
    ? await ctx.db
        .query("importChunks")
        .withIndex("by_status_nextAttempt", (q) => q.eq("status", "pending").lte("nextAttemptAt", now))
        .first()
    : await ctx.db
        .query("importChunks")
        .withIndex("by_job_status_nextAttempt", (q) =>
          q.eq("importJobId", importJobId).eq("status", "pending").lte("nextAttemptAt", now),
        )
        .first();

const IMPORT_WORKER_CLAIM_SCAN_LIMIT = 50;

const findClaimableChunk = async (
  ctx: MutationCtx,
  job: Doc<"importJobs"> | null,
  importJobId: string | undefined,
  now: number,
) => {
  if (importJobId === undefined) {
    const pending = await ctx.db
      .query("importChunks")
      .withIndex("by_status_nextAttempt", (q) => q.eq("status", "pending").lte("nextAttemptAt", now))
      .take(IMPORT_WORKER_CLAIM_SCAN_LIMIT);
    for (const chunk of pending) {
      const candidate = await materializeClaimableChunk(ctx, chunk);
      if (candidate !== null) return candidate;
    }
    const staleRunning = await ctx.db
      .query("importChunks")
      .withIndex("by_status_lease", (q) => q.eq("status", "running").lte("leaseExpiresAt", now))
      .take(IMPORT_WORKER_CLAIM_SCAN_LIMIT);
    for (const chunk of staleRunning) {
      const candidate = await materializeClaimableChunk(ctx, chunk);
      if (candidate !== null) return candidate;
    }
    return null;
  }
  if (job === null) return null;
  const pending = await ctx.db
    .query("importChunks")
    .withIndex("by_job_status_nextAttempt", (q) =>
      q.eq("importJobId", importJobId).eq("status", "pending").lte("nextAttemptAt", now),
    )
    .take(IMPORT_WORKER_CLAIM_SCAN_LIMIT);
  for (const chunk of pending) {
    const candidate = await materializeClaimableChunk(ctx, chunk, job);
    if (candidate !== null) return candidate;
  }
  const staleRunning = await ctx.db
    .query("importChunks")
    .withIndex("by_job_status_lease", (q) =>
      q.eq("importJobId", importJobId).eq("status", "running").lte("leaseExpiresAt", now),
    )
    .take(IMPORT_WORKER_CLAIM_SCAN_LIMIT);
  for (const chunk of staleRunning) {
    const candidate = await materializeClaimableChunk(ctx, chunk, job);
    if (candidate !== null) return candidate;
  }
  return null;
};

const materializeClaimableChunk = async (
  ctx: MutationCtx,
  chunk: Doc<"importChunks">,
  knownJob?: Doc<"importJobs">,
) => {
  const job = knownJob ?? await findImportJob(ctx, chunk.importJobId);
  if (job === null || isClosedImportJob(job)) return null;
  const payload = await findChunkPayload(ctx, chunk.chunkId);
  const batch = (payload?.batch ?? chunk.batch) as IngestBatchBoundaryValue | undefined;
  if (!(await canClaimImportChunk(ctx, job, chunk, batch))) return null;
  return { chunk, payload, batch };
};

const canClaimImportChunk = async (
  ctx: MutationCtx,
  job: Doc<"importJobs">,
  chunk: Doc<"importChunks">,
  batch: IngestBatchBoundaryValue | undefined,
) => !chunkCanRunCleanup(batch) || await canClaimCleanupChunk(ctx, job, chunk);

const chunkCanRunCleanup = (batch: IngestBatchBoundaryValue | undefined) =>
  batch === undefined ||
  batch.sessions.some(
    (session) => session.partialSession !== true && session.deferCleanup !== true,
  );

const canClaimCleanupChunk = async (
  ctx: MutationCtx,
  job: Doc<"importJobs">,
  chunk: Doc<"importChunks">,
) => {
  if (chunk.sequence <= 0) return true;
  if (job.failedChunkCount > 0) return false;
  const current = job.succeededPrefixCount ?? 0;
  const prefix = await computeSucceededPrefixCount(ctx, chunk.importJobId, current);
  if (prefix > current) {
    await ctx.db.patch(job._id, {
      succeededPrefixCount: prefix,
      updatedAt: Date.now(),
    });
  }
  return prefix >= chunk.sequence;
};

const nextSucceededPrefixCount = async (
  ctx: MutationCtx,
  importJobId: string,
  chunk: Doc<"importChunks">,
) => {
  const job = await findImportJob(ctx, importJobId);
  if (job?.succeededPrefixCount === undefined) {
    return await computeSucceededPrefixCount(ctx, importJobId, 0);
  }
  const current = job?.succeededPrefixCount ?? 0;
  if (chunk.sequence > current) return current;
  return await computeSucceededPrefixCount(ctx, importJobId, current);
};

const computeSucceededPrefixCount = async (
  ctx: MutationCtx,
  importJobId: string,
  start: number,
) => {
  let prefix = Math.max(0, start);
  while (true) {
    const chunk = await ctx.db
      .query("importChunks")
      .withIndex("by_job_sequence", (q) =>
        q.eq("importJobId", importJobId).eq("sequence", prefix),
      )
      .unique();
    if (chunk?.status !== "succeeded") return prefix;
    prefix += 1;
  }
};

const findStaleRunningChunk = async (
  ctx: MutationCtx,
  importJobId: string | undefined,
  now: number,
) =>
  importJobId === undefined
    ? await ctx.db
        .query("importChunks")
        .withIndex("by_status_lease", (q) => q.eq("status", "running").lte("leaseExpiresAt", now))
        .first()
    : await ctx.db
        .query("importChunks")
        .withIndex("by_job_status_lease", (q) =>
          q.eq("importJobId", importJobId).eq("status", "running").lte("leaseExpiresAt", now),
        )
        .first();

const patchImportJobCounters = async (
  ctx: MutationCtx,
  importJobId: string,
  delta: {
    readonly chunkCount?: number;
    readonly uploadedChunkCount?: number;
    readonly succeededChunkCount?: number;
    readonly succeededPrefixCount?: number;
    readonly failedChunkCount?: number;
    readonly terminalChunkSequenceSum?: number;
    readonly status?: ImportJobStatus;
    readonly now: number;
  },
) => {
  const job = await findImportJob(ctx, importJobId);
  if (job === null) throw new Error("Import job was not found.");
  const closed = isClosedImportJob(job);
  const patch = {
    chunkCount: Math.max(0, job.chunkCount + (delta.chunkCount ?? 0)),
    uploadedChunkCount: Math.max(0, (job.uploadedChunkCount ?? job.chunkCount) + (delta.uploadedChunkCount ?? 0)),
    succeededChunkCount: Math.max(0, job.succeededChunkCount + (delta.succeededChunkCount ?? 0)),
    failedChunkCount: Math.max(0, job.failedChunkCount + (delta.failedChunkCount ?? 0)),
    terminalChunkSequenceSum: Math.max(
      0,
      (job.terminalChunkSequenceSum ?? 0) + (delta.terminalChunkSequenceSum ?? 0),
    ),
    status: closed ? job.status : delta.status ?? job.status,
    completedAt: closed ? job.completedAt : undefined,
    updatedAt: delta.now,
  };
  await ctx.db.patch(job._id, {
    ...patch,
    ...(delta.succeededPrefixCount !== undefined || job.succeededPrefixCount !== undefined
      ? {
          succeededPrefixCount: Math.max(
            job.succeededPrefixCount ?? 0,
            delta.succeededPrefixCount ?? 0,
          ),
        }
      : {}),
  });
};

const patchImportJobStatus = async (
  ctx: MutationCtx,
  importJobId: string,
  status: ImportJobStatus,
  now: number,
) => {
  const job = await findImportJob(ctx, importJobId);
  if (job !== null && !isClosedImportJob(job) && job.status !== status) {
    await ctx.db.patch(job._id, { status, updatedAt: now });
  }
};

const maybeFinalizeImportJob = async (
  ctx: MutationCtx,
  importJobId: string,
  now: number,
): Promise<ImportJobStatus> => {
  const job = await findImportJob(ctx, importJobId);
  if (job === null) throw new Error("Import job was not found.");
  if (isClosedImportJob(job)) return job.status;
  const expected = job.expectedChunkCount;
  const uploaded = job.uploadedChunkCount ?? job.chunkCount;
  const terminalCount = job.succeededChunkCount + job.failedChunkCount;
  const terminalSequenceSum = job.terminalChunkSequenceSum ?? -1;
  const expectedSequenceSum = expected === undefined ? undefined : (expected * (expected - 1)) / 2;
  const complete =
    expected !== undefined &&
    expected > 0 &&
    uploaded >= expected &&
    terminalCount >= expected &&
    terminalSequenceSum === expectedSequenceSum;
  if (!complete) return job.status === "queued" ? "running" : job.status;
  const status = job.failedChunkCount > 0 ? "partial_failure" : "succeeded";
  await ctx.db.patch(job._id, {
    status,
    completedAt: now,
    updatedAt: now,
  });
  return status;
};

const markChunkTerminalFailure = async (
  ctx: MutationCtx,
  chunk: Doc<"importChunks">,
  error: string,
  now: number,
) => {
  await ctx.db.patch(chunk._id, {
    status: "dead_letter",
    error,
    completedAt: now,
    leaseToken: undefined,
    payloadStoredAt: undefined,
    updatedAt: now,
  });
  await deleteChunkPayload(ctx, chunk.chunkId);
  if (!isTerminalFailed(chunk.status)) {
    await patchImportJobCounters(ctx, chunk.importJobId, {
      failedChunkCount: 1,
      terminalChunkSequenceSum: chunk.sequence,
      status: "partial_failure",
      now,
    });
  }
};

const releaseChunkForClosedJob = async (
  ctx: MutationCtx,
  chunk: Doc<"importChunks">,
  error: string,
  now: number,
) => {
  await ctx.db.patch(chunk._id, {
    status: "dead_letter",
    error,
    completedAt: now,
    leaseExpiresAt: undefined,
    leaseToken: undefined,
    payloadStoredAt: undefined,
    updatedAt: now,
  });
  await deleteChunkPayload(ctx, chunk.chunkId);
  if (!isTerminal(chunk.status)) {
    await patchImportJobCounters(ctx, chunk.importJobId, {
      failedChunkCount: 1,
      terminalChunkSequenceSum: chunk.sequence,
      now,
    });
  }
};

const cleanupCancelledImportJobRows = async (
  ctx: MutationCtx,
  importJobId: string,
  error: string,
  now: number,
) => {
  let cleanedChunkCount = 0;
  let terminalSequenceSum = 0;
  for (const status of ["pending", "running"] as const) {
    if (cleanedChunkCount >= IMPORT_CANCEL_CLEANUP_BATCH_LIMIT) break;
    const chunks = await ctx.db
      .query("importChunks")
      .withIndex("by_job_status", (q) => q.eq("importJobId", importJobId).eq("status", status))
      .take(IMPORT_CANCEL_CLEANUP_BATCH_LIMIT - cleanedChunkCount);
    for (const chunk of chunks) {
      await ctx.db.patch(chunk._id, {
        status: "dead_letter",
        error,
        completedAt: now,
        leaseExpiresAt: undefined,
        leaseToken: undefined,
        payloadStoredAt: undefined,
        updatedAt: now,
      });
      cleanedChunkCount += 1;
      terminalSequenceSum += chunk.sequence;
    }
  }
  if (cleanedChunkCount > 0) {
    await patchImportJobCounters(ctx, importJobId, {
      failedChunkCount: cleanedChunkCount,
      terminalChunkSequenceSum: terminalSequenceSum,
      now,
    });
  }

  let deletedPayloadCount = 0;
  const payloads = await ctx.db
    .query("importChunkPayloads")
    .withIndex("by_importJobId", (q) => q.eq("importJobId", importJobId))
    .take(IMPORT_CANCEL_CLEANUP_BATCH_LIMIT);
  for (const payload of payloads) {
    await ctx.db.delete(payload._id);
    deletedPayloadCount += 1;
  }

  return {
    cleanedChunkCount,
    deletedPayloadCount,
    done: cleanedChunkCount === 0 && deletedPayloadCount === 0,
  };
};

const scheduleCancelledImportCleanup = async (
  ctx: MutationCtx,
  importJobId: string,
) => {
  await ctx.scheduler.runAfter(
    IMPORT_WORKER_SCHEDULE_DELAY_MS,
    internal.quasar.cleanupCancelledImportJobInternal,
    { importJobId },
  );
};

const importChunkWorkerFailure = (error: unknown) => {
  if (error instanceof Error) {
    return { error: `${error.name}: ${error.message}` };
  }
  return { error: `NonError: ${String(error)}` };
};

const upsertImportShards = async (
  ctx: MutationCtx,
  importJobId: string,
  manifest: IngestManifest,
  now: number,
) => {
  for (const summary of providerSummariesForManifest(manifest)) {
    if (summary.sessionCount <= 0) continue;
    const shardId = `shard:${wideHash(`${importJobId}\u001f${summary.provider}`)}`;
    await ctx.db.insert("importShards", {
      shardId,
      importJobId,
      provider: summary.provider,
      machineId: manifest.machineId,
      status: "queued",
      sessionCount: summary.sessionCount,
      eventCount: summary.eventCount,
      createdAt: now,
      updatedAt: now,
    });
  }
};

const embeddingReadiness = async (ctx: QueryCtx, importJobId: string) => {
  const rows = await ctx.db
    .query("embeddingReadiness")
    .withIndex("by_job", (q) => q.eq("importJobId", importJobId))
    .take(1000);
  return readinessCounts(rows);
};

const manifestForStart = (input: StartImportJobInputValue): IngestManifest => {
  if (input.manifest !== undefined) return manifestFromBoundary(input.manifest);
  if (input.batch !== undefined) return manifestFromBatch(input.batch);
  throw new Error("start import job input requires either manifest or batch.");
};

const manifestFromBoundary = (manifest: IngestManifestBoundary): IngestManifest => {
  const output = {
    machineId: manifest.machine.machineId,
    generatedAt: manifest.generatedAt,
    sourceRoots: manifest.sourceRoots,
    sessions: manifest.sessions,
    providerSummaries: manifest.providerSummaries,
    diagnostics: sanitizeDiagnosticsForStorage(manifest.diagnostics),
    sessionCount: manifest.sessionCount,
    eventCount: manifest.eventCount,
    toolCallCount: manifest.toolCallCount,
    contentBlockCount: manifest.contentBlockCount,
    sessionEdgeCount: manifest.sessionEdgeCount,
    usageRecordCount: manifest.usageRecordCount,
    artifactCount: manifest.artifactCount,
  };
  assertExactManifestSummaries(output);
  return output;
};

const manifestFromBatch = (batch: IngestBatchBoundaryValue): IngestManifest => {
  const summary = summarizeBatch(batch);
  return {
    machineId: summary.machineId,
    generatedAt: batch.generatedAt,
    sourceRoots: batch.sourceRoots,
    sessions: batch.sessions.map((session) => ({
      id: session.id,
      nativeSessionId: session.nativeSessionId,
      provider: session.provider,
      machineId: session.machineId || summary.machineId,
      projectIdentityKey: session.projectIdentity.projectIdentityKey,
      sourceRoot: session.sourceRoot,
      sourcePath: session.sourcePath,
      eventCount: session.events.length,
      toolCallCount: session.toolCalls.length,
      contentBlockCount: session.events.reduce((sum, event) => sum + event.contentBlocks.length, 0),
      sessionEdgeCount: session.sessionEdges.length,
      usageRecordCount: session.usageRecords.length,
      artifactCount: session.artifacts.length,
    })),
    providerSummaries: providerSummariesFromSessions(batch.sessions),
    diagnostics: sanitizeDiagnosticsForStorage(batch.diagnostics),
    sessionCount: summary.sessionCount,
    eventCount: summary.eventCount,
    toolCallCount: summary.toolCallCount,
    contentBlockCount: summary.contentBlockCount,
    sessionEdgeCount: summary.sessionEdgeCount,
    usageRecordCount: summary.usageRecordCount,
    artifactCount: summary.artifactCount,
  };
};

const providerSummariesForManifest = (
  manifest: IngestManifest,
): readonly IngestManifestProviderSummary[] =>
  manifest.providerSummaries ?? providerSummariesFromManifestSessions(manifest.sessions);

const assertExactManifestSummaries = (manifest: IngestManifest) => {
  if (manifest.sessions.length > manifest.sessionCount) {
    throw new Error("manifest sessions cannot exceed sessionCount.");
  }
  const compactManifest = manifest.sessions.length < manifest.sessionCount;
  if (!compactManifest && manifest.providerSummaries === undefined) return;
  if (manifest.providerSummaries === undefined) {
    throw new Error("sampled ingest manifests require providerSummaries.");
  }
  const summary = manifest.providerSummaries.reduce(
    (current, provider) => ({
      sessionCount: current.sessionCount + provider.sessionCount,
      eventCount: current.eventCount + provider.eventCount,
      toolCallCount: current.toolCallCount + provider.toolCallCount,
      contentBlockCount: current.contentBlockCount + provider.contentBlockCount,
      sessionEdgeCount: current.sessionEdgeCount + provider.sessionEdgeCount,
      usageRecordCount: current.usageRecordCount + provider.usageRecordCount,
      artifactCount: current.artifactCount + provider.artifactCount,
    }),
    {
      sessionCount: 0,
      eventCount: 0,
      toolCallCount: 0,
      contentBlockCount: 0,
      sessionEdgeCount: 0,
      usageRecordCount: 0,
      artifactCount: 0,
    },
  );
  for (const key of [
    "sessionCount",
    "eventCount",
    "toolCallCount",
    "contentBlockCount",
    "sessionEdgeCount",
    "usageRecordCount",
    "artifactCount",
  ] as const) {
    if (summary[key] !== manifest[key]) {
      throw new Error(`manifest providerSummaries ${key} does not match manifest ${key}.`);
    }
  }
};

const providerSummariesFromManifestSessions = (
  sessions: readonly IngestManifestSession[],
): readonly IngestManifestProviderSummary[] => {
  const summaries = new Map<ProviderSchema, IngestManifestProviderSummary>();
  for (const session of sessions) {
    const current = summaries.get(session.provider) ?? {
      provider: session.provider,
      sessionCount: 0,
      eventCount: 0,
      toolCallCount: 0,
      contentBlockCount: 0,
      sessionEdgeCount: 0,
      usageRecordCount: 0,
      artifactCount: 0,
    };
    summaries.set(session.provider, {
      provider: session.provider,
      sessionCount: current.sessionCount + 1,
      eventCount: current.eventCount + session.eventCount,
      toolCallCount: current.toolCallCount + session.toolCallCount,
      contentBlockCount: current.contentBlockCount + session.contentBlockCount,
      sessionEdgeCount: current.sessionEdgeCount + session.sessionEdgeCount,
      usageRecordCount: current.usageRecordCount + session.usageRecordCount,
      artifactCount: current.artifactCount + session.artifactCount,
    });
  }
  return [...summaries.values()].sort((left, right) =>
    left.provider.localeCompare(right.provider),
  );
};

const providerSummariesFromSessions = (
  sessions: readonly IngestBatchBoundaryValue["sessions"][number][],
): readonly IngestManifestProviderSummary[] =>
  providerSummariesFromManifestSessions(
    sessions.map((session) => ({
      id: session.id,
      nativeSessionId: session.nativeSessionId,
      provider: session.provider,
      machineId: session.machineId,
      projectIdentityKey: session.projectIdentity.projectIdentityKey,
      sourceRoot: session.sourceRoot,
      sourcePath: session.sourcePath,
      eventCount: session.events.length,
      toolCallCount: session.toolCalls.length,
      contentBlockCount: session.events.reduce(
        (sum, event) => sum + event.contentBlocks.length,
        0,
      ),
      sessionEdgeCount: session.sessionEdges.length,
      usageRecordCount: session.usageRecords.length,
      artifactCount: session.artifacts.length,
    })),
  );

const sanitizeDiagnosticsForStorage = (
  diagnostics: readonly IngestManifestBoundary["diagnostics"][number][],
) =>
  redactSensitive(
    sanitizeSessionIntelligenceDiagnostics(diagnostics),
  ) as AdapterDiagnosticBoundary[];

const importJobIdempotencyKey = (
  manifest: IngestManifest,
  batch: IngestBatchBoundaryValue | undefined,
) => {
  const compactManifest = manifest.sessions.length < manifest.sessionCount;
  return `import-job:${wideHash(
    JSON.stringify([
      SESSION_INTELLIGENCE_CONTRACT_VERSION,
      batch === undefined ? undefined : payloadHashForBatch(batch),
      manifest.machineId,
      manifest.sourceRoots.map((root) => [root.provider, root.rootPath]),
      compactManifest
        ? providerSummariesForManifest(manifest).map((summary) => [
            summary.provider,
            summary.sessionCount,
            summary.eventCount,
            summary.toolCallCount,
            summary.contentBlockCount,
            summary.sessionEdgeCount,
            summary.usageRecordCount,
            summary.artifactCount,
          ])
        : undefined,
      compactManifest
        ? undefined
        : manifest.sessions.map((session) => [
            session.id,
            session.provider,
            session.machineId,
            session.sourcePath,
            session.eventCount,
          ]),
    ]),
  )}`;
};

const importChunkIdempotencyKey = (
  importJobId: string,
  sequence: number,
  payloadHash: string,
) =>
  `import-chunk:${wideHash(
    JSON.stringify([
      STREAM_INGEST_UPLOAD_IDENTITY_VERSION,
      SESSION_INTELLIGENCE_CONTRACT_VERSION,
      importJobId,
      sequence,
      payloadHash,
    ]),
  )}`;

const payloadHashForBatch = (batch: IngestBatchBoundaryValue) =>
  stableCanonicalJsonHash([SESSION_INTELLIGENCE_CONTRACT_VERSION, batchPayloadIdentity(batch)]);

const batchPayloadIdentity = (batch: IngestBatchBoundaryValue) => ({
  ...batch,
  generatedAt: undefined,
  sourceRoots: batch.sourceRoots.map(sourceRootPayloadIdentity),
});

const sourceRootPayloadIdentity = (root: IngestBatchBoundaryValue["sourceRoots"][number]) => ({
  ...root,
  discoveredAt: undefined,
});

const summarizeBatch = (batch: IngestBatchBoundaryValue) => ({
  machineId: batch.machine.machineId,
  sessionCount: batch.sessions.length,
  eventCount: sumNestedArrayLengths(batch.sessions, "events"),
  toolCallCount: sumNestedArrayLengths(batch.sessions, "toolCalls"),
  contentBlockCount: batch.sessions.reduce(
    (sum, session) =>
      sum +
      session.events.reduce((eventSum, event) => eventSum + event.contentBlocks.length, 0),
    0,
  ),
  sessionEdgeCount: sumNestedArrayLengths(batch.sessions, "sessionEdges"),
  usageRecordCount: sumNestedArrayLengths(batch.sessions, "usageRecords"),
  artifactCount: sumNestedArrayLengths(batch.sessions, "artifacts"),
});

const sumNestedArrayLengths = (
  records: readonly (IngestBatchBoundaryValue["sessions"][number])[],
  key: "events" | "toolCalls" | "sessionEdges" | "usageRecords" | "artifacts",
) => records.reduce((sum, record) => sum + record[key].length, 0);

const isTerminalFailed = (status: ImportChunkStatus) =>
  status === "failed" || status === "dead_letter";

const isTerminal = (status: ImportChunkStatus) =>
  status === "succeeded" || isTerminalFailed(status);

const isClosedImportJob = (job: Doc<"importJobs">) =>
  job.status === "failed" || job.completedAt !== undefined;

const isUnsuccessfulImportJob = (job: Doc<"importJobs">) =>
  job.status === "failed" || job.status === "partial_failure";

const importJobAttemptIdempotencyKey = (
  sourceIdentityKey: string,
  attemptNumber: number,
) =>
  `import-job-attempt:${wideHash(`${sourceIdentityKey}\u001f${attemptNumber}`)}`;

const assertNonNegativeInteger = (value: number, label: string) => {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative integer.`);
  }
};

const assertPositiveInteger = (value: number, label: string) => {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive integer.`);
  }
};

const staleChunkClaim = (
  chunk: Doc<"importChunks">,
  importJobId: string,
  leaseToken: string,
): SubmitImportChunkResult | null => {
  if (
    chunk.importJobId === importJobId &&
    chunk.status === "running" &&
    chunk.leaseToken === leaseToken
  ) {
    return null;
  }
  return {
    importJobId,
    chunkId: chunk.chunkId,
    status: chunk.status,
    jobStatus: "running",
    stale: true,
  };
};

const assertExistingChunkMatchesRequest = (
  chunk: Doc<"importChunks">,
  importJobId: string,
  sequence: number,
  payloadHash: string,
) => {
  if (
    chunk.importJobId !== importJobId ||
    chunk.sequence !== sequence ||
    chunk.payloadHash !== payloadHash
  ) {
    throw new Error("Import chunk idempotencyKey is already bound to a different chunk.");
  }
};

const retryDelayMs = (attempts: number) =>
  Math.min(15 * 60_000, 10_000 * 2 ** Math.min(6, attempts));

const boundedStatusLimit = (limit: number | undefined) =>
  Math.min(200, Math.max(1, Math.trunc(limit ?? 50)));

const jsonByteLength = (value: unknown) => {
  try {
    return textEncoder.encode(JSON.stringify(value)).length;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
};

const assertJsonByteBudget = (value: unknown, maxBytes: number, label: string) => {
  const bytes = jsonByteLength(value);
  if (bytes > maxBytes) {
    throw new Error(`${label} is ${bytes} bytes; maximum is ${maxBytes} bytes.`);
  }
};

const statusChunk = (chunk: Doc<"importChunks">) => {
  const { batch, ...rest } = chunk;
  return {
    ...rest,
    payloadStored: chunk.payloadStoredAt !== undefined || batch !== undefined,
    payloadBytes: chunk.payloadBytes,
  };
};

const statusJob = (job: Doc<"importJobs">) => {
  const { workerLeaseExpiresAt: _workerLeaseExpiresAt, workerLeaseToken: _workerLeaseToken, ...rest } = job;
  const uploadedChunkCount = job.uploadedChunkCount ?? job.chunkCount;
  const terminalChunkCount = job.succeededChunkCount + job.failedChunkCount;
  const missingUploadChunkCount = job.expectedChunkCount === undefined
    ? undefined
    : Math.max(0, job.expectedChunkCount - uploadedChunkCount);
  return {
    ...rest,
    uploadedChunkCount,
    terminalChunkCount,
    inFlightChunkCount: Math.max(0, uploadedChunkCount - terminalChunkCount),
    uploadComplete:
      job.expectedChunkCount !== undefined &&
      uploadedChunkCount >= job.expectedChunkCount,
    ...(missingUploadChunkCount !== undefined ? { missingUploadChunkCount } : {}),
  };
};

const scheduleImportWorker = async (
  ctx: MutationCtx,
  importJobId: string,
  delayMs: number,
) => {
  await ctx.scheduler.runAfter(Math.max(delayMs, IMPORT_WORKER_SCHEDULE_DELAY_MS), internal.quasar.processImportJobChunksInternal, {
    importJobId,
    limit: IMPORT_WORKER_BATCH_LIMIT,
  });
};
