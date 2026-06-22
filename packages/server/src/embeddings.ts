import { google, type GoogleEmbeddingModelOptions } from "@ai-sdk/google";
import { LanceDb, type SearchRole } from "./lancedb";
import { embedMany } from "ai";
import { Database } from "bun:sqlite";
import { Effect, Layer, Schema } from "effect";
import { createHash } from "node:crypto";

import { embeddingProfileFromEnv, embeddingProfileSearchTable, type EmbeddingProfile } from "./embeddingProfiles";
import type { MessageRow, QueueJobRow } from "./model";
import { ensureParentDir, sqlitePath } from "./paths";
import { isSemanticSearchDocument } from "./searchPolicy";
import { DurableQueue, Embeddings, type EmbeddingCacheRow } from "./services";
import { LocalStore } from "./store";

// Provider prefix of a sessionId (matches search.providerFromSessionId); kept
// local to avoid importing the search layer into the embed worker.
const providerForSessionId = (sessionId: string): string => {
  const colon = sessionId.indexOf(":");
  return colon === -1 ? sessionId : sessionId.slice(0, colon);
};
import { makeSyntheticEmbedder, SyntheticEmbeddingError } from "./syntheticEmbeddings";

const textEncoder = new TextEncoder();
const DEFAULT_EMBEDDING_API_BATCH_SIZE = 100;
const DEFAULT_EMBEDDING_DOCUMENT_CHUNK_CHARS = 12_000;
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
}

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

const liveGeminiEmbedder = (profile: EmbeddingProfile): Embedder => ({
  embedMany: async (values) => {
    const { embeddings } = await embedMany({
      model: google.embedding(profile.model),
      values: [...values],
      providerOptions: {
        google: {
          outputDimensionality: profile.dimensions,
          taskType: profile.task as GoogleEmbeddingModelOptions["taskType"],
        } satisfies GoogleEmbeddingModelOptions,
      },
    });
    return embeddings;
  },
});

const liveEmbedderForProfile = (profile: EmbeddingProfile): Embedder => {
  if (profile.provider === "gemini") return liveGeminiEmbedder(profile);
  if (profile.provider === "synthetic") return makeSyntheticEmbedder(profile);
  return { embedMany: async () => { throw new Error(`Embedding provider ${profile.provider} is not configured in this build`); } };
};

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

export const makeEmbeddingsLayer = (options: EmbeddingsLayerOptions = {}): Layer.Layer<Embeddings, never, LocalStore | DurableQueue | LanceDb> => {
  const profile = options.profile ?? embeddingProfileFromEnv();
  const embedder = options.embedder ?? liveEmbedderForProfile(profile);
  const path = options.sqlite ?? sqlitePath();
  const tableName = embeddingProfileSearchTable(profile);

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
          const search = yield* LanceDb;
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

          const toVectorRow = (message: MessageRow, vector: readonly number[]) => ({
            sessionId: message.sessionId,
            seq: message.seq,
            role: message.role as SearchRole,
            projectKey: message.projectKey,
            text: message.text,
            contentHash: message.contentHash,
            provider: providerForSessionId(message.sessionId),
            vector,
          });

          const documentInputs = (text: string) =>
            chunkText(text, positiveIntEnv("QUASAR_EMBEDDING_DOCUMENT_CHUNK_CHARS", DEFAULT_EMBEDDING_DOCUMENT_CHUNK_CHARS))
              .map((chunk) => prefixed(profile.documentPrefix, chunk));

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
                  try: () => embedder.embedMany([input]),
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
                const misses: Array<{ job: QueueJobRow; message: MessageRow }> = [];
                const cachedVectorRows: Array<ReturnType<typeof toVectorRow>> = [];
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
                  const input = prefixed(profile.documentPrefix, message.text);
                  const cacheHash = profile.documentPrefix === undefined ? message.contentHash : contentHashForText(input);
                  const cached = yield* getCached(cacheHash);
                  if (cached !== undefined) {
                    cachedVectorRows.push(toVectorRow(message, cached.vector));
                    cachedJobIds.push(job.jobId);
                    cacheHits += 1;
                    continue;
                  }
                  cacheMisses += 1;
                  misses.push({ job, message });
                }

                if (cachedVectorRows.length > 0) {
                  yield* search.upsertMessageRows({ rows: cachedVectorRows, tableName, vectorDimension: profile.dimensions });
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

                      const vectorRows = [];
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
                          contentHash: profile.documentPrefix === undefined ? miss.message.contentHash : contentHashForText(input),
                          text: input,
                          vector,
                          now,
                        });
                        vectorRows.push(toVectorRow(miss.message, cached.vector));
                        ackJobIds.push(miss.job.jobId);
                      }
                      if (vectorRows.length > 0) {
                        yield* search.upsertMessageRows({ rows: vectorRows, tableName, vectorDimension: profile.dimensions });
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

                return { leased: jobs.length, cacheHits, cacheMisses, embedded, skipped, retried, failed };
              }),
            status: tryEmbedding("status", () => {
              const cached = (db.query("SELECT COUNT(*) AS count FROM embedding_cache WHERE model = ?").get(profile.cacheNamespace) as { count: number }).count;
              return { cached, pending: 0, profile };
            }),
          });
        }),
      ),
    ),
  );
};
