import { Database } from "bun:sqlite";
import { Effect, Layer, Ref, Schedule, Schema } from "effect";
import { createHash } from "node:crypto";

import { embeddingProfileFromEnv, embeddingProviderFromEnv, queryEmbeddingProviderFromEnv, type EmbeddingProfile } from "./embeddingProfiles";
import type { MessageRow, QueueJobRow } from "./model";
import { ensureParentDir, sqlitePath } from "./paths";
import { isSemanticSearchDocument } from "./searchPolicy";
import { DurableQueue, Embeddings, type EmbeddingCacheRow, type EmbeddingReadinessStatus } from "./services";
import { LocalStore } from "./store";
import { makeLocalOnnxEmbedder } from "./localOnnxEmbeddings";
import { makeSyntheticEmbedder, SyntheticEmbeddingError } from "./syntheticEmbeddings";

// Provider prefix of a sessionId (matches fts5.providerFromSessionId); kept
// local to avoid importing the search layer into the embed worker.
const providerForSessionId = (sessionId: string): string => {
  const colon = sessionId.indexOf(":");
  return colon === -1 ? sessionId : sessionId.slice(0, colon);
};

const textEncoder = new TextEncoder();
const DEFAULT_EMBEDDING_API_BATCH_SIZE = 100;
const DEFAULT_EMBEDDING_DOCUMENT_CHUNK_CHARS = 12_000;
const DEFAULT_EMBEDDING_READINESS_CACHE_TTL_MS = 30_000;
const RETRYABLE_EMBEDDING_BASE_DELAY_MS = 30_000;
const RETRYABLE_EMBEDDING_MAX_DELAY_MS = 10 * 60_000;

export class EmbeddingError extends Schema.TaggedError<EmbeddingError>()(
  "EmbeddingError",
  {
    operation: Schema.String,
    message: Schema.String,
    cause: Schema.optional(Schema.Unknown),
  },
) {}

export interface Embedder {
  readonly embedMany: (values: readonly string[]) => Promise<readonly (readonly number[])[]>;
}

export interface EmbeddingsLayerOptions {
  readonly sqlite?: string;
  readonly profile?: EmbeddingProfile;
  readonly embedder?: Embedder;
  /** Test seam for the local query pipeline. Production always builds the
   * fp32 ONNX pipeline; injecting here exercises the eager-load switch
   * without ONNX. */
  readonly localQueryEmbedder?: Embedder;
}

/** Query-side ONNX dtype is PINNED to fp32: q8 query vectors fail retrieval
 * parity against the synthetic-embedded matrix (overlap@10 0.77 < 0.8 gate),
 * and fp16 needs graph optimizations disabled to dodge an onnxruntime
 * LayerNormFusion bug. Receipts: docs/proofs/query-embed-parity-2026-07-04.json
 * and query-embed-parity-fp32-2026-07-04.json. Never make this configurable.
 * Exported so the Docker build's model-baking step (scripts/bake-onnx-model.ts)
 * warms the exact dtype this layer will load at runtime — one pin, not two. */
export const QUERY_EMBEDDING_ONNX_DTYPE = "fp32";

const nowIso = () => new Date().toISOString();

const contentHashForText = (text: string) =>
  createHash("sha256").update(text).digest("hex");

const embeddingMigrate = (db: Database): void => {
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
    CREATE TABLE IF NOT EXISTS embedding_cache (
      model TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      dimensions INTEGER NOT NULL,
      text_bytes INTEGER NOT NULL,
      vector_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (model, content_hash)
    );
    CREATE INDEX IF NOT EXISTS embedding_cache_updated ON embedding_cache(model, updated_at);
  `);
};

const tryEmbedding = <A>(operation: string, run: () => A): Effect.Effect<A, EmbeddingError> =>
  Effect.try({
    try: run,
    catch: (cause) =>
      new EmbeddingError({
        operation,
        message: cause instanceof Error ? cause.message : String(cause),
        cause,
      }),
  });

const toCacheRow = (row: Record<string, unknown>): EmbeddingCacheRow => ({
  model: row.model as string,
  contentHash: row.contentHash as string,
  dimensions: row.dimensions as number,
  textBytes: row.textBytes as number,
  vector: JSON.parse(row.vectorJson as string) as readonly number[],
  createdAt: row.createdAt as string,
  updatedAt: row.updatedAt as string,
});

const liveEmbedderForProfile = (profile: EmbeddingProfile): Embedder =>
  embeddingProviderFromEnv() === "synthetic"
    ? makeSyntheticEmbedder(profile)
    : makeLocalOnnxEmbedder(profile, {
        cacheDir: process.env.QUASAR_EMBEDDING_MODEL_CACHE_DIR?.trim() || undefined,
      });

const assertVectorDimensions = (operation: string, profile: EmbeddingProfile, vector: readonly number[]): Effect.Effect<void, EmbeddingError> =>
  vector.length === profile.dimensions
    ? Effect.void
    : Effect.fail(
        new EmbeddingError({
          operation,
          message: `embedding vector has dimension ${vector.length}; expected ${profile.dimensions}`,
        }),
      );

const isEmbedMessagePayload = (payload: unknown): payload is {
  readonly sessionId: string;
  readonly seq: number;
  readonly contentHash: string;
  readonly embeddingProfile: string;
} =>
  typeof payload === "object" &&
  payload !== null &&
  typeof (payload as { sessionId?: unknown }).sessionId === "string" &&
  typeof (payload as { seq?: unknown }).seq === "number" &&
  typeof (payload as { contentHash?: unknown }).contentHash === "string" &&
  typeof (payload as { embeddingProfile?: unknown }).embeddingProfile === "string";

const positiveIntEnv = (name: string, fallback: number): number => {
  const raw = process.env[name]?.trim();
  if (raw === undefined || raw === "") return fallback;
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
};

const retryDelayMs = (attempts: number, retryable: boolean): number => {
  if (!retryable) return 30_000;
  const base = positiveIntEnv("QUASAR_EMBEDDING_RETRY_BASE_MS", RETRYABLE_EMBEDDING_BASE_DELAY_MS);
  const max = positiveIntEnv("QUASAR_EMBEDDING_RETRY_MAX_MS", RETRYABLE_EMBEDDING_MAX_DELAY_MS);
  const exponent = Math.max(0, Math.min(attempts - 1, 8));
  return Math.min(max, base * 2 ** exponent);
};

const chunksOf = <A>(items: readonly A[], size: number): readonly (readonly A[])[] => {
  const chunks: A[][] = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
};

const chunkText = (text: string, size: number): readonly string[] => {
  if (text.length <= size) return [text];
  const chunks: string[] = [];
  for (let index = 0; index < text.length; index += size) {
    chunks.push(text.slice(index, index + size));
  }
  return chunks;
};

const averageVectors = (vectors: readonly (readonly number[])[]): readonly number[] => {
  if (vectors.length === 0) return [];
  const dimensions = vectors[0]?.length ?? 0;
  const total = Array.from({ length: dimensions }, () => 0);
  for (const vector of vectors) {
    for (let index = 0; index < dimensions; index += 1) {
      total[index] += vector[index] ?? 0;
    }
  }
  return total.map((value) => value / vectors.length);
};

const isRetryableEmbeddingError = (message: string): boolean =>
  /quota|rate.?limit|too many requests|resource exhausted|429/i.test(message);

const isRetryableEmbeddingCause = (cause: unknown): boolean => {
  if (cause instanceof SyntheticEmbeddingError) {
    return cause.status === 429 || cause.status === 500 || cause.status === 502 || cause.status === 503 || cause.status === 504;
  }
  const message = cause instanceof Error ? cause.message : String(cause);
  return isRetryableEmbeddingError(message);
};

const prefixed = (prefix: string | undefined, text: string): string =>
  prefix === undefined || prefix.length === 0 ? text : `${prefix}${text}`;

const readinessProbeText = "quasar readiness probe";

const readinessCacheTtlMs = (): number =>
  positiveIntEnv("QUASAR_EMBEDDING_READINESS_CACHE_TTL_MS", DEFAULT_EMBEDDING_READINESS_CACHE_TTL_MS);

const probeEmbeddingAvailability = (
  embedder: Embedder,
  profile: EmbeddingProfile,
): Effect.Effect<EmbeddingReadinessStatus, never> =>
  Effect.suspend(() =>
    Effect.tryPromise({
      try: async () => {
        const input = prefixed(profile.queryPrefix, readinessProbeText);
        const vectors = await embedder.embedMany([input]);
        const vector = vectors[0];
        if (vectors.length !== 1 || vector === undefined) {
          throw new Error("embedder returned no readiness vector");
        }
        if (vector.length !== profile.dimensions) {
          throw new Error(`embedding vector has dimension ${vector.length}; expected ${profile.dimensions}`);
        }
        return { ok: true, checkedAt: nowIso() } satisfies EmbeddingReadinessStatus;
      },
      catch: (cause) => cause,
    }).pipe(
      Effect.catchAll((cause) =>
        Effect.succeed({
          ok: false,
          checkedAt: nowIso(),
          reason: cause instanceof Error ? cause.message : String(cause),
        } satisfies EmbeddingReadinessStatus),
      ),
    ));

export const makeEmbeddingsLayer = (options: EmbeddingsLayerOptions = {}): Layer.Layer<Embeddings, never, LocalStore | DurableQueue> => {
  const profile = options.profile ?? embeddingProfileFromEnv();
  const embedder = options.embedder ?? liveEmbedderForProfile(profile);
  const path = options.sqlite ?? sqlitePath();

  return Layer.scoped(
    Embeddings,
    Effect.acquireRelease(
      Effect.sync(() => {
        ensureParentDir(path);
        const db = new Database(path, { create: true });
        embeddingMigrate(db);
        return db;
      }),
      (db) => Effect.sync(() => db.close()),
    ).pipe(
      Effect.flatMap((db) =>
        Effect.gen(function* () {
          const store = yield* LocalStore;
          const queue = yield* DurableQueue;

          // --- query-side embedder (D8b): local fp32, eager background load ---
          // Boot and lexical are never gated on the ~35s pipeline load. Until
          // the load finishes (or if it fails), queries fall back to the
          // bounded synthetic path. Query vectors from either source share the
          // one embedding_cache namespace: fp32-local and synthetic query
          // vectors are retrieval-interchangeable (parity receipts).
          const queryProvider = queryEmbeddingProviderFromEnv();
          const queryFallbackEmbedder: Embedder =
            options.embedder ?? (embeddingProviderFromEnv() === "synthetic" ? embedder : makeSyntheticEmbedder(profile));
          const queryState: {
            active: "local" | "synthetic";
            local: Embedder | undefined;
            loadedAt: string | undefined;
            loadMs: number | undefined;
            loadFailure: string | undefined;
          } = { active: "synthetic", local: undefined, loadedAt: undefined, loadMs: undefined, loadFailure: undefined };
          const activeQueryEmbedder = (): Embedder =>
            queryState.active === "local" && queryState.local !== undefined ? queryState.local : queryFallbackEmbedder;

          // Build the local pipeline only when queries are configured local
          // AND this layer is not running with an injected unit-test embedder
          // (a real ONNX load inside unit tests would be a contract breach).
          const localQueryPipeline: Embedder | undefined =
            queryProvider !== "local"
              ? undefined
              : options.localQueryEmbedder
                ?? (options.embedder === undefined
                  ? makeLocalOnnxEmbedder(profile, {
                    dtype: QUERY_EMBEDDING_ONNX_DTYPE,
                    cacheDir: process.env.QUASAR_EMBEDDING_MODEL_CACHE_DIR?.trim() || undefined,
                  })
                  : undefined);
          if (localQueryPipeline !== undefined) {
            yield* Effect.forkScoped(
              Effect.gen(function* () {
                const started = performance.now();
                const warm = yield* Effect.tryPromise({
                  try: () => localQueryPipeline.embedMany([prefixed(profile.queryPrefix, "quasar query embedder warmup")]),
                  catch: (cause) => cause,
                }).pipe(Effect.either);
                const loadMs = Math.round(performance.now() - started);
                if (warm._tag === "Left") {
                  queryState.loadFailure = warm.left instanceof Error ? warm.left.message : String(warm.left);
                  console.error(JSON.stringify({
                    event: "query_embedder.local_load_failed",
                    at: nowIso(),
                    loadMs,
                    detail: queryState.loadFailure,
                  }));
                  return;
                }
                const vector = warm.right[0];
                if (vector === undefined || vector.length !== profile.dimensions) {
                  queryState.loadFailure = `local query pipeline warmup returned dimension ${vector?.length ?? "none"}; expected ${profile.dimensions}`;
                  console.error(JSON.stringify({
                    event: "query_embedder.local_load_failed",
                    at: nowIso(),
                    loadMs,
                    detail: queryState.loadFailure,
                  }));
                  return;
                }
                queryState.local = localQueryPipeline;
                queryState.active = "local";
                queryState.loadedAt = nowIso();
                queryState.loadMs = loadMs;
                console.log(JSON.stringify({
                  event: "query_embedder.local_active",
                  at: queryState.loadedAt,
                  dtype: QUERY_EMBEDDING_ONNX_DTYPE,
                  loadMs,
                }));
              }),
            );
          }
          // Background Ref: probe fires on a fixed schedule (every readinessCacheTtlMs() ms),
          // with the first probe delayed by one full interval. The initial state is
          // "probe pending" (ok: false). The hot path (now only /ready) reads the Ref
          // synchronously — never a per-query network call. Deferring the first probe
          // avoids spurious embedder calls during layer construction in tests.
          const readinessRef = yield* Ref.make<EmbeddingReadinessStatus>({
            ok: false,
            checkedAt: nowIso(),
            reason: "embedding readiness probe pending",
          });
          yield* Effect.sleep(`${readinessCacheTtlMs()} millis`).pipe(
            Effect.flatMap(() => probeEmbeddingAvailability(embedder, profile)),
            Effect.flatMap((s) => Ref.set(readinessRef, s)),
            Effect.repeat(Schedule.spaced(`${readinessCacheTtlMs()} millis`)),
            Effect.forkScoped,
          );
          const selectCached = db.prepare(
            "SELECT model, content_hash AS contentHash, dimensions, text_bytes AS textBytes, vector_json AS vectorJson, created_at AS createdAt, updated_at AS updatedAt FROM embedding_cache WHERE model = ? AND content_hash = ?",
          );
          const upsertCached = db.prepare(
            `INSERT INTO embedding_cache(model, content_hash, dimensions, text_bytes, vector_json, created_at, updated_at)
             VALUES ($model, $contentHash, $dimensions, $textBytes, $vectorJson, $createdAt, $updatedAt)
             ON CONFLICT(model, content_hash) DO UPDATE SET dimensions = excluded.dimensions, text_bytes = excluded.text_bytes, vector_json = excluded.vector_json, updated_at = excluded.updated_at`,
          );

          const getCached = (contentHash: string) =>
            tryEmbedding("getCached", () => {
              const row = selectCached.get(profile.cacheNamespace, contentHash) as Record<string, unknown> | null;
              if (row === null) return undefined;
              const cached = toCacheRow(row);
              return cached.dimensions === profile.dimensions ? cached : undefined;
            });

          const putCached = (row: { readonly contentHash: string; readonly text: string; readonly vector: readonly number[]; readonly now?: string }) =>
            Effect.gen(function* () {
              yield* assertVectorDimensions("putCached", profile, row.vector);
              return yield* tryEmbedding("putCached", () => {
              const at = row.now ?? nowIso();
              const existing = selectCached.get(profile.cacheNamespace, row.contentHash) as Record<string, unknown> | null;
              upsertCached.run({
                $model: profile.cacheNamespace,
                $contentHash: row.contentHash,
                $dimensions: row.vector.length,
                $textBytes: textEncoder.encode(row.text).byteLength,
                $vectorJson: JSON.stringify(row.vector),
                $createdAt: existing === null ? at : existing.createdAt as string,
                $updatedAt: at,
              });
              return toCacheRow(selectCached.get(profile.cacheNamespace, row.contentHash) as Record<string, unknown>);
              });
            });

          const toSqliteVectorRow = (message: MessageRow, vector: readonly number[], now?: string) => ({
            model: profile.cacheNamespace,
            modality: "text" as const,
            sessionId: message.sessionId,
            seq: message.seq,
            role: message.role,
            projectKey: message.projectKey,
            contentHash: message.contentHash,
            documentHash: documentCacheHash(message),
            provider: providerForSessionId(message.sessionId),
            vector,
            now,
          });

          const documentInputs = (text: string) =>
            chunkText(text, positiveIntEnv("QUASAR_EMBEDDING_DOCUMENT_CHUNK_CHARS", DEFAULT_EMBEDDING_DOCUMENT_CHUNK_CHARS))
              .map((chunk) => prefixed(profile.documentPrefix, chunk));

          const documentCacheHash = (message: Pick<MessageRow, "contentHash" | "text">): string => {
            const input = prefixed(profile.documentPrefix, message.text);
            return profile.documentPrefix === undefined ? message.contentHash : contentHashForText(input);
          };

          const embedInputsAdaptive: (inputs: readonly string[]) => Effect.Effect<readonly (readonly number[])[], unknown> = (inputs) =>
            Effect.gen(function* () {
              const result = yield* Effect.tryPromise({
                try: () => embedder.embedMany(inputs),
                catch: (cause) => cause,
              }).pipe(Effect.either);
              if (result._tag === "Right") return result.right;
              if (isRetryableEmbeddingCause(result.left) && inputs.length > 1) {
                const splitAt = Math.ceil(inputs.length / 2);
                const halves = [inputs.slice(0, splitAt), inputs.slice(splitAt)].filter((split) => split.length > 0);
                const vectors = yield* Effect.forEach(halves, embedInputsAdaptive, { concurrency: 1 });
                return vectors.flat();
              }
              return yield* Effect.fail(result.left);
            });

          const embedDocument = (text: string) =>
            Effect.gen(function* () {
              const inputs = documentInputs(text);
              const vectors = yield* Effect.forEach(
                chunksOf(inputs, positiveIntEnv("QUASAR_EMBEDDING_API_BATCH_SIZE", DEFAULT_EMBEDDING_API_BATCH_SIZE)),
                embedInputsAdaptive,
                { concurrency: 1 },
              ).pipe(Effect.map((chunks) => chunks.flat()));
              if (vectors.length < inputs.length) {
                return yield* Effect.fail(new Error("embedder returned fewer vectors than requested"));
              }
              return averageVectors(vectors);
            });

          const upsertAllSqliteVectors = (operation: string, rows: readonly ReturnType<typeof toSqliteVectorRow>[]) =>
            Effect.gen(function* () {
              if (rows.length === 0) return 0;
              const accepted = yield* store.upsertMessageVectors(rows);
              if (accepted !== rows.length) {
                return yield* Effect.fail(
                  new EmbeddingError({
                    operation,
                    message: `SQLite accepted ${accepted} of ${rows.length} message vector rows; source messages changed during embedding`,
                  }),
                );
              }
              return accepted;
            });

          const elapsedSince = (started: number) =>
            Math.round((performance.now() - started) * 100) / 100;

          return Embeddings.of({
            model: profile.model,
            profile,
            embedText: (text) =>
              Effect.gen(function* () {
                const input = prefixed(profile.queryPrefix, text);
                const contentHash = contentHashForText(input);
                const cached = yield* getCached(contentHash);
                if (cached !== undefined) return cached.vector;
                const vectors = yield* Effect.tryPromise({
                  try: () => activeQueryEmbedder().embedMany([input]),
                  catch: (cause) => cause,
                });
                const vector = vectors[0];
                if (vector === undefined) {
                  return yield* Effect.fail(
                    new EmbeddingError({
                      operation: "embedText",
                      message: "embedder returned no vector",
                    }),
                  );
                }
                const row = yield* putCached({ contentHash, text: input, vector });
                return row.vector;
              }),
            getCached,
            putCached,
            processBatch: ({ workerId, limit, leaseMs, now = nowIso() }) =>
              Effect.gen(function* () {
                yield* queue.recoverStaleLeases(now);
                const jobs = yield* queue.leaseBatch({ workerId, kind: "embed-message", limit, leaseMs, now });
                let cacheHits = 0;
                let cacheMisses = 0;
                let embedded = 0;
                let skipped = 0;
                let retried = 0;
                let failed = 0;
                let sqliteVectorsUpserted = 0;
                const misses: Array<{ job: QueueJobRow; message: MessageRow }> = [];
                const cachedSqliteRows: Array<ReturnType<typeof toSqliteVectorRow>> = [];
                const cachedJobIds: string[] = [];
                const retryOrFail = (job: QueueJobRow, error: string, retryable: boolean) =>
                  job.attempts >= job.maxAttempts
                    ? queue.fail(job.jobId, error, now).pipe(Effect.as("failed" as const))
                    : queue.retry(job.jobId, {
                        error,
                        delayMs: retryDelayMs(job.attempts, retryable),
                        now,
                      }).pipe(Effect.as("retried" as const));

                for (const job of jobs) {
                  if (job.kind !== "embed-message" || !isEmbedMessagePayload(job.payload)) {
                    yield* queue.fail(job.jobId, "invalid embed-message payload", now);
                    failed += 1;
                    continue;
                  }
                  if (job.payload.embeddingProfile !== profile.cacheNamespace) {
                    yield* queue.fail(job.jobId, `embed-message profile mismatch: job=${job.payload.embeddingProfile} active=${profile.cacheNamespace}`, now);
                    failed += 1;
                    continue;
                  }
                  const message = yield* store.getMessage({
                    sessionId: job.payload.sessionId,
                    seq: job.payload.seq,
                    contentHash: job.payload.contentHash,
                  });
                  if (message == null) {
                    yield* queue.ack(job.jobId, now);
                    skipped += 1;
                    continue;
                  }
                  if (!isSemanticSearchDocument(message)) {
                    yield* queue.ack(job.jobId, now);
                    skipped += 1;
                    continue;
                  }
                  const cached = yield* getCached(documentCacheHash(message));
                  if (cached !== undefined) {
                    cachedSqliteRows.push(toSqliteVectorRow(message, cached.vector, now));
                    cachedJobIds.push(job.jobId);
                    cacheHits += 1;
                    continue;
                  }
                  cacheMisses += 1;
                  misses.push({ job, message });
                }

                if (cachedSqliteRows.length > 0) {
                  sqliteVectorsUpserted += yield* upsertAllSqliteVectors("processBatch.cacheHit.upsertMessageVectors", cachedSqliteRows);
                  for (const jobId of cachedJobIds) {
                    yield* queue.ack(jobId, now);
                  }
                }

                if (misses.length > 0) {
                  type EmbeddingMiss = { readonly job: QueueJobRow; readonly message: MessageRow };
                  type ChunkReport = { readonly embedded: number; readonly retried: number; readonly failed: number };
                  const emptyChunkReport: ChunkReport = { embedded: 0, retried: 0, failed: 0 };
                  const mergeChunkReport = (total: ChunkReport, report: ChunkReport): ChunkReport => ({
                    embedded: total.embedded + report.embedded,
                    retried: total.retried + report.retried,
                    failed: total.failed + report.failed,
                  });
                  const processMissChunk: (chunk: readonly EmbeddingMiss[]) => Effect.Effect<ChunkReport, unknown> = (chunk) =>
                    Effect.gen(function* () {
                      let chunkEmbedded = 0;
                      let chunkRetried = 0;
                      let chunkFailed = 0;
                      if (chunk.some((miss) => documentInputs(miss.message.text).length > 1) && chunk.length > 1) {
                        const splitAt = Math.ceil(chunk.length / 2);
                        const splitReports = yield* Effect.forEach(
                          [chunk.slice(0, splitAt), chunk.slice(splitAt)].filter((split) => split.length > 0),
                          processMissChunk,
                          { concurrency: 1 },
                        );
                        return splitReports.reduce(mergeChunkReport, emptyChunkReport);
                      }
                      const result = yield* (
                        chunk.length === 1 && documentInputs(chunk[0]?.message.text ?? "").length > 1
                          ? embedDocument(chunk[0]?.message.text ?? "").pipe(Effect.map((vector) => [vector]))
                          : embedInputsAdaptive(chunk.map((miss) => prefixed(profile.documentPrefix, miss.message.text)))
                      ).pipe(Effect.either);

                      if (result._tag === "Left") {
                        const retryable = isRetryableEmbeddingCause(result.left);
                        if (retryable && chunk.length > 1) {
                          const splitAt = Math.ceil(chunk.length / 2);
                          const splitReports = yield* Effect.forEach(
                            [chunk.slice(0, splitAt), chunk.slice(splitAt)].filter((split) => split.length > 0),
                            processMissChunk,
                            { concurrency: 1 },
                          );
                          return splitReports.reduce(mergeChunkReport, emptyChunkReport);
                        }
                        const error = result.left instanceof Error ? result.left.message : String(result.left);
                        for (const { job } of chunk) {
                          const outcome = yield* retryOrFail(job, error, retryable);
                          if (outcome === "failed") {
                            chunkFailed += 1;
                          } else {
                            chunkRetried += 1;
                          }
                        }
                        return { embedded: chunkEmbedded, retried: chunkRetried, failed: chunkFailed };
                      }

                      const sqliteRows = [];
                      const ackJobIds = [];
                      for (let index = 0; index < chunk.length; index += 1) {
                        const miss = chunk[index];
                        const vector = result.right[index];
                        if (miss === undefined) continue;
                        if (vector === undefined) {
                          const outcome = yield* retryOrFail(miss.job, "embedder returned fewer vectors than requested", false);
                          if (outcome === "failed") chunkFailed += 1;
                          else chunkRetried += 1;
                          continue;
                        }
                        const input = prefixed(profile.documentPrefix, miss.message.text);
                        const cached = yield* putCached({
                          contentHash: documentCacheHash(miss.message),
                          text: input,
                          vector,
                          now,
                        });
                        sqliteRows.push(toSqliteVectorRow(miss.message, cached.vector, now));
                        ackJobIds.push(miss.job.jobId);
                      }
                      if (sqliteRows.length > 0) {
                        sqliteVectorsUpserted += yield* upsertAllSqliteVectors("processBatch.cacheMiss.upsertMessageVectors", sqliteRows);
                      }
                      for (const jobId of ackJobIds) {
                        yield* queue.ack(jobId, now);
                        chunkEmbedded += 1;
                      }
                      return { embedded: chunkEmbedded, retried: chunkRetried, failed: chunkFailed };
                    });

                  const chunkReports = yield* Effect.forEach(
                    chunksOf(misses, positiveIntEnv("QUASAR_EMBEDDING_API_BATCH_SIZE", DEFAULT_EMBEDDING_API_BATCH_SIZE)),
                    processMissChunk,
                    { concurrency: positiveIntEnv("QUASAR_EMBEDDING_API_CONCURRENCY", 4) },
                  );
                  for (const chunkReport of chunkReports) {
                    embedded += chunkReport.embedded;
                    retried += chunkReport.retried;
                    failed += chunkReport.failed;
                  }
                }

                return { leased: jobs.length, cacheHits, cacheMisses, embedded, skipped, retried, failed, sqliteVectorsUpserted };
              }),
            materializeCachedVectors: ({ limit = 1_000, now = nowIso() } = {}) =>
              Effect.gen(function* () {
                const messages = yield* store.listMessagesMissingVector({ model: profile.cacheNamespace, limit });
                let cacheHits = 0;
                let missingCache = 0;
                const rows = [];
                for (const message of messages) {
                  if (!isSemanticSearchDocument(message)) continue;
                  const cached = yield* getCached(documentCacheHash(message));
                  if (cached === undefined) {
                    missingCache += 1;
                    continue;
                  }
                  cacheHits += 1;
                  rows.push(toSqliteVectorRow(message, cached.vector, now));
                }
                const sqliteVectorsUpserted = yield* upsertAllSqliteVectors("materializeCachedVectors.upsertMessageVectors", rows);
                return {
                  scanned: messages.length,
                  cacheHits,
                  missingCache,
                  sqliteVectorsUpserted,
                };
              }),
            materializeMissingVectorsToSqlite: (options = {}) =>
              Effect.gen(function* () {
                const started = performance.now();
                const startedAt = options.now ?? nowIso();
                const materializationLimit = options.limit ?? 1_000;
                const messages = yield* store.listMessagesMissingVector({
                  model: profile.cacheNamespace,
                  limit: materializationLimit,
                });
                let cacheHits = 0;
                let cacheMisses = 0;
                let embedded = 0;
                let skipped = 0;
                let sqliteVectorsUpserted = 0;
                const cachedSqliteRows: Array<ReturnType<typeof toSqliteVectorRow>> = [];
                const misses: MessageRow[] = [];

                for (const message of messages) {
                  if (!isSemanticSearchDocument(message)) {
                    skipped += 1;
                    continue;
                  }
                  const cached = yield* getCached(documentCacheHash(message));
                  if (cached !== undefined) {
                    cachedSqliteRows.push(toSqliteVectorRow(message, cached.vector, startedAt));
                    cacheHits += 1;
                    continue;
                  }
                  cacheMisses += 1;
                  misses.push(message);
                }

                sqliteVectorsUpserted += yield* upsertAllSqliteVectors(
                  "materializeMissingVectorsToSqlite.cacheHit.upsertMessageVectors",
                  cachedSqliteRows,
                );

                type MaterializeSqliteChunkReport = {
                  readonly embedded: number;
                  readonly sqliteVectorsUpserted: number;
                };
                const emptyMaterializeSqliteChunkReport: MaterializeSqliteChunkReport = {
                  embedded: 0,
                  sqliteVectorsUpserted: 0,
                };
                const mergeMaterializeSqliteChunkReport = (
                  total: MaterializeSqliteChunkReport,
                  report: MaterializeSqliteChunkReport,
                ): MaterializeSqliteChunkReport => ({
                  embedded: total.embedded + report.embedded,
                  sqliteVectorsUpserted: total.sqliteVectorsUpserted + report.sqliteVectorsUpserted,
                });
                const processMissChunk: (chunk: readonly MessageRow[]) => Effect.Effect<MaterializeSqliteChunkReport, unknown> = (chunk) =>
                  Effect.gen(function* () {
                    if (chunk.length === 0) return emptyMaterializeSqliteChunkReport;
                    if (chunk.some((message) => documentInputs(message.text).length > 1) && chunk.length > 1) {
                      const splitAt = Math.ceil(chunk.length / 2);
                      const splitReports = yield* Effect.forEach(
                        [chunk.slice(0, splitAt), chunk.slice(splitAt)].filter((split) => split.length > 0),
                        processMissChunk,
                        { concurrency: 1 },
                      );
                      return splitReports.reduce(mergeMaterializeSqliteChunkReport, emptyMaterializeSqliteChunkReport);
                    }

                    const result = yield* (
                      chunk.length === 1 && documentInputs(chunk[0]?.text ?? "").length > 1
                        ? embedDocument(chunk[0]?.text ?? "").pipe(Effect.map((vector) => [vector]))
                        : embedInputsAdaptive(chunk.map((message) => prefixed(profile.documentPrefix, message.text)))
                    ).pipe(Effect.either);

                    if (result._tag === "Left") {
                      if (isRetryableEmbeddingCause(result.left) && chunk.length > 1) {
                        const splitAt = Math.ceil(chunk.length / 2);
                        const splitReports = yield* Effect.forEach(
                          [chunk.slice(0, splitAt), chunk.slice(splitAt)].filter((split) => split.length > 0),
                          processMissChunk,
                          { concurrency: 1 },
                        );
                        return splitReports.reduce(mergeMaterializeSqliteChunkReport, emptyMaterializeSqliteChunkReport);
                      }
                      return yield* Effect.fail(
                        new EmbeddingError({
                          operation: "materializeMissingVectorsToSqlite.embed",
                          message: result.left instanceof Error ? result.left.message : String(result.left),
                          cause: result.left,
                        }),
                      );
                    }

                    const sqliteRows = [];
                    for (let index = 0; index < chunk.length; index += 1) {
                      const message = chunk[index];
                      const vector = result.right[index];
                      if (message === undefined) continue;
                      if (vector === undefined) {
                        return yield* Effect.fail(
                          new EmbeddingError({
                            operation: "materializeMissingVectorsToSqlite.embed",
                            message: "embedder returned fewer vectors than requested",
                          }),
                        );
                      }
                      const input = prefixed(profile.documentPrefix, message.text);
                      const cached = yield* putCached({
                        contentHash: documentCacheHash(message),
                        text: input,
                        vector,
                        now: startedAt,
                      });
                      sqliteRows.push(toSqliteVectorRow(message, cached.vector, startedAt));
                    }
                    const sqliteAccepted = yield* upsertAllSqliteVectors(
                      "materializeMissingVectorsToSqlite.cacheMiss.upsertMessageVectors",
                      sqliteRows,
                    );
                    return {
                      embedded: sqliteRows.length,
                      sqliteVectorsUpserted: sqliteAccepted,
                    };
                  });

                const chunkReports = yield* Effect.forEach(
                  chunksOf(misses, positiveIntEnv("QUASAR_EMBEDDING_API_BATCH_SIZE", DEFAULT_EMBEDDING_API_BATCH_SIZE)),
                  processMissChunk,
                  { concurrency: positiveIntEnv("QUASAR_EMBEDDING_API_CONCURRENCY", 4) },
                );
                for (const chunkReport of chunkReports) {
                  embedded += chunkReport.embedded;
                  sqliteVectorsUpserted += chunkReport.sqliteVectorsUpserted;
                }

                return {
                  scanned: messages.length,
                  cacheHits,
                  cacheMisses,
                  embedded,
                  skipped,
                  sqliteVectorsUpserted,
                  startedAt,
                  finishedAt: options.now ?? nowIso(),
                  elapsedMs: elapsedSince(started),
                };
              }),
            status: tryEmbedding("status", () => {
              const cached = (db.query("SELECT COUNT(*) AS count FROM embedding_cache WHERE model = ?").get(profile.cacheNamespace) as { count: number }).count;
              return {
                cached,
                pending: 0,
                profile,
                queryEmbedder: {
                  provider: queryProvider,
                  active: queryState.active,
                  loadedAt: queryState.loadedAt,
                  loadMs: queryState.loadMs,
                  loadFailure: queryState.loadFailure,
                },
              };
            }),
            readiness: Ref.get(readinessRef),
          });
        }),
      ),
    ),
  );
};
