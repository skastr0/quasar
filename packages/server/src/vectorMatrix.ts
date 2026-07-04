// Per-model resident vector matrix (QSR rearchitecture D7).
//
// One contiguous f16 matrix in a growable SharedArrayBuffer, boot-loaded from
// SQLite message_vectors and appended when new vectors are written through the
// single store write site. No vector index, no background maintenance, no
// state beyond the matrix + a watermark. Every query is an exact scan
// (recall 1.0), sharded across worker threads running the simsimd f16 cosine
// kernel (pure-JS fallback when no native library is available).
//
// Existence is decided at boot: the matrix exists iff boot-load found vector
// rows for the model. When it exists, appends keep it fresh (rows written
// while the process runs are appended or overwritten in place). When boot
// found nothing, semantic serving stays in its 503 degrade mode until the
// next boot — appends never resurrect an empty matrix mid-process, which is
// also what keeps the pinned HTTP contract (503 on empty-boot) stable.
//
// The matrix may run BEHIND SQLite (rows written mid-load behind the load
// cursor, capacity exhaustion, deletes): semantic then serves what is loaded
// — never a 503 once enabled — and the watermark records the drift honestly.
// A reboot reconciles.
import { performance } from "node:perf_hooks";
import { Context, Deferred, Effect, Layer, Schema } from "effect";

import { embeddingProfileFromEnv, type EmbeddingProfile } from "./embeddingProfiles";
import { LocalStore, type MessageVectorUpsert, type MessageVectorWriteEvent } from "./store";
import { encodeFloat16Vector, VECTOR_BLOB_ENCODING } from "./vectorBlob";
import { encodeQueryVectorF16, loadNativeSimsimd, VectorKernelError } from "./vectorKernel";

const LOAD_PAGE_ROWS = 8_192;
const MAX_TOP_K = 256;
const APPEND_HEADROOM_BYTES = 256 * 1024 * 1024;
const GROW_CHUNK_BYTES = 32 * 1024 * 1024;

export class VectorMatrixError extends Schema.TaggedError<VectorMatrixError>()(
  "VectorMatrixError",
  {
    operation: Schema.String,
    message: Schema.String,
    cause: Schema.optional(Schema.Unknown),
  },
) {}

/** The degrade mode: no resident matrix in this process (boot found none, or
 * load has not finished). HTTP maps this to the SemanticDisabled 503. */
export class VectorMatrixDisabledError extends Schema.TaggedError<VectorMatrixDisabledError>()(
  "VectorMatrixDisabledError",
  { message: Schema.String },
) {}

export type VectorMatrixKernel = "simsimd-ffi" | "js-fallback" | "none";

export interface VectorMatrixWatermark {
  readonly matrixRows: number;
  readonly sqliteRows: number;
  readonly checkedAt: string;
}

export interface VectorMatrixStatus {
  readonly enabled: boolean;
  readonly model: string;
  readonly dimensions: number;
  readonly rows: number;
  readonly kernel: VectorMatrixKernel;
  readonly workerCount: number;
  readonly loadedAt?: string;
  readonly loadMs?: number;
  readonly loadSkippedRows: number;
  readonly appendedRows: number;
  readonly overwrittenRows: number;
  readonly droppedAppends: number;
  readonly watermark: VectorMatrixWatermark;
}

export interface VectorMatrixHit {
  readonly sessionId: string;
  readonly seq: number;
  readonly score: number;
}

export interface VectorMatrixSearchRequest {
  readonly vector: readonly number[];
  readonly limit: number;
  /** Exact candidate allow-list from a SQL prefilter. undefined = unfiltered;
   * an empty list (or no candidate present in the matrix) short-circuits to []. */
  readonly candidates?: readonly { readonly sessionId: string; readonly seq: number }[];
}

export interface VectorMatrixService {
  readonly status: Effect.Effect<VectorMatrixStatus>;
  readonly search: (
    request: VectorMatrixSearchRequest,
  ) => Effect.Effect<readonly VectorMatrixHit[], VectorMatrixError | VectorMatrixDisabledError>;
  /** Resolves when the boot load has finished (enabled or empty). */
  readonly awaitLoaded: Effect.Effect<void>;
}

export class VectorMatrix extends Context.Tag("@quasar/VectorMatrix")<
  VectorMatrix,
  VectorMatrixService
>() {}

export interface VectorMatrixOptions {
  readonly profile?: EmbeddingProfile;
  /** "js" forces the pure-JS fallback kernel (used by parity tests). */
  readonly kernel?: "auto" | "js";
}

interface ScanPart {
  readonly rows: Uint32Array;
  readonly scores: Float64Array;
}

interface PendingScan {
  remaining: number;
  readonly parts: ScanPart[];
  readonly resolve: (parts: ScanPart[]) => void;
  readonly reject: (cause: Error) => void;
}

interface MatrixState {
  sab: SharedArrayBuffer | undefined;
  bytes: Uint8Array | undefined;
  rowCount: number;
  enabled: boolean;
  closed: boolean;
  kernel: VectorMatrixKernel;
  libraryPath: string | null;
  loadedAt: string | undefined;
  loadMs: number | undefined;
  loadSkippedRows: number;
  appendedRows: number;
  overwrittenRows: number;
  droppedAppends: number;
  watermark: VectorMatrixWatermark;
  sessionIds: string[];
  seqs: number[];
  rowIndex: Map<string, Map<number, number>>;
  workers: Worker[];
  pendingScans: Map<number, PendingScan>;
  nextScanId: number;
}

const nowIso = () => new Date().toISOString();

const diagnostic = (event: string, fields: Record<string, unknown>): void => {
  console.error(JSON.stringify({ event, at: nowIso(), ...fields }));
};

const info = (event: string, fields: Record<string, unknown>): void => {
  console.log(JSON.stringify({ event, at: nowIso(), ...fields }));
};

const workerCountForMachine = (): number => {
  const cores = typeof navigator !== "undefined" ? navigator.hardwareConcurrency : undefined;
  return Math.max(1, Math.min(8, cores ?? 4));
};

export const makeVectorMatrixLayer = (
  options: VectorMatrixOptions = {},
): Layer.Layer<VectorMatrix, never, LocalStore> =>
  Layer.scoped(
    VectorMatrix,
    Effect.gen(function* () {
      const store = yield* LocalStore;
      const profile = options.profile ?? embeddingProfileFromEnv();
      const model = profile.cacheNamespace;
      const dimensions = profile.dimensions;
      const rowBytes = dimensions * 2;
      const loadedSignal = yield* Deferred.make<void>();

      const state: MatrixState = {
        sab: undefined,
        bytes: undefined,
        rowCount: 0,
        enabled: false,
        closed: false,
        kernel: "none",
        libraryPath: null,
        loadedAt: undefined,
        loadMs: undefined,
        loadSkippedRows: 0,
        appendedRows: 0,
        overwrittenRows: 0,
        droppedAppends: 0,
        watermark: { matrixRows: 0, sqliteRows: 0, checkedAt: nowIso() },
        sessionIds: [],
        seqs: [],
        rowIndex: new Map(),
        workers: [],
        pendingScans: new Map(),
        nextScanId: 1,
      };

      const rowFor = (sessionId: string, seq: number): number | undefined =>
        state.rowIndex.get(sessionId)?.get(seq);

      const indexRow = (sessionId: string, seq: number, row: number): void => {
        let inner = state.rowIndex.get(sessionId);
        if (inner === undefined) {
          inner = new Map();
          state.rowIndex.set(sessionId, inner);
        }
        inner.set(seq, row);
        state.sessionIds[row] = sessionId;
        state.seqs[row] = seq;
      };

      const ensureRowCapacity = (rows: number): boolean => {
        const sab = state.sab;
        if (sab === undefined) return false;
        const needed = rows * rowBytes;
        if (needed <= sab.byteLength) return true;
        if (needed > sab.maxByteLength) return false;
        sab.grow(Math.min(sab.maxByteLength, Math.max(needed, sab.byteLength + GROW_CHUNK_BYTES)));
        return true;
      };

      const writeRowBytes = (row: number, blob: Uint8Array): void => {
        state.bytes!.set(blob, row * rowBytes);
      };

      // --- append path: the store's single vector-write site notifies here ---
      const applyVectorWrites = (event: MessageVectorWriteEvent): void => {
        if (state.closed || !state.enabled) return;
        let appended = 0;
        let overwritten = 0;
        for (const row of event.rows) {
          if (row.model !== model) continue;
          if (row.vector.length !== dimensions) {
            diagnostic("vector_matrix.append_rejected", {
              reason: "dimension_mismatch",
              expected: dimensions,
              received: row.vector.length,
            });
            continue;
          }
          let blob: Uint8Array;
          try {
            blob = encodeFloat16Vector(row.vector);
          } catch (cause) {
            diagnostic("vector_matrix.append_rejected", {
              reason: "non_finite_vector",
              detail: cause instanceof Error ? cause.message : String(cause),
            });
            continue;
          }
          const existing = rowFor(row.sessionId, row.seq);
          if (existing !== undefined) {
            writeRowBytes(existing, blob);
            overwritten += 1;
            continue;
          }
          if (!ensureRowCapacity(state.rowCount + 1)) {
            state.droppedAppends += 1;
            diagnostic("vector_matrix.append_dropped", {
              reason: "capacity_exhausted",
              rows: state.rowCount,
              droppedAppends: state.droppedAppends,
            });
            continue;
          }
          writeRowBytes(state.rowCount, blob);
          indexRow(row.sessionId, row.seq, state.rowCount);
          state.rowCount += 1;
          appended += 1;
        }
        state.appendedRows += appended;
        state.overwrittenRows += overwritten;
        const sqliteRows = event.sqliteRowsByModel[model];
        if (sqliteRows !== undefined) {
          state.watermark = { matrixRows: state.rowCount, sqliteRows, checkedAt: nowIso() };
          if (sqliteRows !== state.rowCount) {
            diagnostic("vector_matrix.watermark_drift", { matrixRows: state.rowCount, sqliteRows });
          }
        }
      };

      // --- worker pool ---
      const routeWorkerMessage = (message: { type: string; id?: number | null; rows?: Uint32Array; scores?: Float64Array; message?: string }): void => {
        if (message.type === "result" && typeof message.id === "number") {
          const pending = state.pendingScans.get(message.id);
          if (pending === undefined) return;
          pending.parts.push({ rows: message.rows ?? new Uint32Array(0), scores: message.scores ?? new Float64Array(0) });
          pending.remaining -= 1;
          if (pending.remaining === 0) {
            state.pendingScans.delete(message.id);
            pending.resolve(pending.parts);
          }
          return;
        }
        if (message.type === "error") {
          const failure = new Error(message.message ?? "vector scan worker error");
          if (typeof message.id === "number") {
            const pending = state.pendingScans.get(message.id);
            if (pending !== undefined) {
              state.pendingScans.delete(message.id);
              pending.reject(failure);
            }
            return;
          }
          for (const [id, pending] of state.pendingScans) {
            state.pendingScans.delete(id);
            pending.reject(failure);
          }
        }
      };

      const spawnWorkers = (sab: SharedArrayBuffer): Promise<void> => {
        const count = workerCountForMachine();
        const readiness: Promise<void>[] = [];
        for (let index = 0; index < count; index += 1) {
          const worker = new Worker(new URL("./vectorScanWorker.ts", import.meta.url));
          state.workers.push(worker);
          readiness.push(
            new Promise<void>((resolve, reject) => {
              const onFirstMessage = (event: MessageEvent) => {
                const data = event.data as { type: string; native?: boolean; message?: string };
                if (data.type === "ready") {
                  worker.onmessage = (next: MessageEvent) => routeWorkerMessage(next.data);
                  resolve();
                  return;
                }
                reject(new Error(data.message ?? "vector scan worker failed to initialize"));
              };
              worker.onmessage = onFirstMessage;
              worker.onerror = (event: ErrorEvent) => reject(new Error(event.message));
            }),
          );
          worker.postMessage({ type: "init", sab, dimensions, libraryPath: state.libraryPath });
        }
        return Promise.all(readiness).then(() => undefined);
      };

      const terminateWorkers = (): void => {
        for (const worker of state.workers) worker.terminate();
        state.workers = [];
        for (const [id, pending] of state.pendingScans) {
          state.pendingScans.delete(id);
          pending.reject(new Error("vector matrix closed"));
        }
      };

      const scanAll = (query: Uint16Array, rowCount: number, k: number, mask?: Uint8Array): Promise<ScanPart[]> =>
        new Promise<ScanPart[]>((resolve, reject) => {
          const workers = state.workers;
          const shard = Math.ceil(rowCount / workers.length);
          const id = state.nextScanId;
          state.nextScanId += 1;
          const messages: Array<{ worker: Worker; payload: Record<string, unknown>; transfer: Transferable[] }> = [];
          for (let index = 0; index < workers.length; index += 1) {
            const rowStart = index * shard;
            const rowEnd = Math.min(rowCount, rowStart + shard);
            if (rowStart >= rowEnd) break;
            const maskSlice = mask?.slice(rowStart, rowEnd);
            const querySlice = query.slice();
            const transfer: Transferable[] = [querySlice.buffer as ArrayBuffer];
            if (maskSlice !== undefined) transfer.push(maskSlice.buffer as ArrayBuffer);
            messages.push({
              worker: workers[index]!,
              payload: { type: "scan", id, rowStart, rowEnd, k, query: querySlice, mask: maskSlice ?? null },
              transfer,
            });
          }
          if (messages.length === 0) {
            resolve([]);
            return;
          }
          state.pendingScans.set(id, { remaining: messages.length, parts: [], resolve, reject });
          for (const message of messages) {
            message.worker.postMessage(message.payload, message.transfer);
          }
        });

      // --- boot load ---
      const load = Effect.gen(function* () {
        const started = performance.now();
        const total = yield* store.countMessageVectors(model);
        if (total === 0) {
          state.watermark = { matrixRows: 0, sqliteRows: 0, checkedAt: nowIso() };
          info("vector_matrix.empty_boot", { model, dimensions });
          return;
        }
        const native = options.kernel === "js" ? undefined : loadNativeSimsimd();
        state.libraryPath = native?.libraryPath ?? null;
        state.kernel = native !== undefined ? "simsimd-ffi" : "js-fallback";
        const sab = new SharedArrayBuffer(total * rowBytes, {
          maxByteLength: total * rowBytes + APPEND_HEADROOM_BYTES,
        });
        state.sab = sab;
        state.bytes = new Uint8Array(sab);
        let cursor: { sessionId: string; seq: number } | undefined;
        let lastSessionId: string | undefined;
        while (true) {
          const page = yield* store.listMessageVectorBlobsPage({
            model,
            afterSessionId: cursor?.sessionId,
            afterSeq: cursor?.seq,
            limit: LOAD_PAGE_ROWS,
          });
          if (page.length === 0) break;
          for (const row of page) {
            cursor = { sessionId: row.sessionId, seq: row.seq };
            if (row.encoding !== VECTOR_BLOB_ENCODING || row.dimensions !== dimensions || row.vectorBlob.byteLength !== rowBytes) {
              state.loadSkippedRows += 1;
              continue;
            }
            if (!ensureRowCapacity(state.rowCount + 1)) {
              state.loadSkippedRows += 1;
              continue;
            }
            const sessionId = row.sessionId === lastSessionId && lastSessionId !== undefined ? lastSessionId : row.sessionId;
            lastSessionId = sessionId;
            writeRowBytes(state.rowCount, row.vectorBlob);
            indexRow(sessionId, row.seq, state.rowCount);
            state.rowCount += 1;
          }
          if (page.length < LOAD_PAGE_ROWS) break;
          yield* Effect.yieldNow();
        }
        if (state.rowCount === 0) {
          diagnostic("vector_matrix.load_empty_after_validation", { model, skipped: state.loadSkippedRows });
          return;
        }
        yield* Effect.tryPromise({
          try: () => spawnWorkers(sab),
          catch: (cause) => new VectorMatrixError({
            operation: "load.spawnWorkers",
            message: cause instanceof Error ? cause.message : String(cause),
            cause,
          }),
        });
        state.enabled = true;
        state.loadedAt = nowIso();
        state.loadMs = Math.round((performance.now() - started) * 100) / 100;
        const sqliteRows = yield* store.countMessageVectors(model);
        state.watermark = { matrixRows: state.rowCount, sqliteRows, checkedAt: nowIso() };
        if (sqliteRows !== state.rowCount) {
          diagnostic("vector_matrix.watermark_drift", { matrixRows: state.rowCount, sqliteRows, phase: "boot" });
        }
        info("vector_matrix.loaded", {
          model,
          dimensions,
          rows: state.rowCount,
          skippedRows: state.loadSkippedRows,
          loadMs: state.loadMs,
          kernel: state.kernel,
          workers: state.workers.length,
        });
      }).pipe(
        Effect.catchAll((cause) =>
          Effect.sync(() =>
            diagnostic("vector_matrix.load_failed", {
              model,
              detail: cause instanceof Error ? cause.message : JSON.stringify(cause),
            }),
          ),
        ),
        Effect.ensuring(Deferred.succeed(loadedSignal, undefined)),
      );

      store.registerMessageVectorWriteListener(applyVectorWrites);
      yield* Effect.forkScoped(load);
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          state.closed = true;
          state.enabled = false;
          terminateWorkers();
        }),
      );

      const search = (request: VectorMatrixSearchRequest) =>
        Effect.gen(function* () {
          if (!state.enabled || state.sab === undefined) {
            return yield* new VectorMatrixDisabledError({
              message: "no resident vector matrix in this process (boot found no vectors or load pending)",
            });
          }
          let query: Uint16Array;
          try {
            query = encodeQueryVectorF16(request.vector, dimensions);
          } catch (cause) {
            return yield* new VectorMatrixError({
              operation: "search.encodeQuery",
              message: cause instanceof VectorKernelError ? cause.message : String(cause),
              cause,
            });
          }
          const rowCount = state.rowCount;
          const k = Math.min(Math.max(1, request.limit), MAX_TOP_K, rowCount);
          let mask: Uint8Array | undefined;
          if (request.candidates !== undefined) {
            mask = new Uint8Array(rowCount);
            let found = 0;
            for (const candidate of request.candidates) {
              const row = rowFor(candidate.sessionId, candidate.seq);
              if (row !== undefined && row < rowCount) {
                mask[row] = 1;
                found += 1;
              }
            }
            if (found === 0) return [] as const;
          }
          const parts = yield* Effect.tryPromise({
            try: () => scanAll(query, rowCount, k, mask),
            catch: (cause) => new VectorMatrixError({
              operation: "search.scan",
              message: cause instanceof Error ? cause.message : String(cause),
              cause,
            }),
          });
          const merged: Array<{ row: number; score: number }> = [];
          for (const part of parts) {
            for (let index = 0; index < part.rows.length; index += 1) {
              merged.push({ row: part.rows[index] ?? 0, score: part.scores[index] ?? 0 });
            }
          }
          merged.sort((left, right) => right.score - left.score || left.row - right.row);
          return merged.slice(0, k).map((entry) => ({
            sessionId: state.sessionIds[entry.row] ?? "",
            seq: state.seqs[entry.row] ?? 0,
            score: entry.score,
          }));
        });

      return VectorMatrix.of({
        status: Effect.sync(() => ({
          enabled: state.enabled,
          model,
          dimensions,
          rows: state.rowCount,
          kernel: state.kernel,
          workerCount: state.workers.length,
          loadedAt: state.loadedAt,
          loadMs: state.loadMs,
          loadSkippedRows: state.loadSkippedRows,
          appendedRows: state.appendedRows,
          overwrittenRows: state.overwrittenRows,
          droppedAppends: state.droppedAppends,
          watermark: state.watermark,
        })),
        search,
        awaitLoaded: Deferred.await(loadedSignal),
      });
    }),
  );
