// Per-model resident vector matrix (QSR rearchitecture D7).
//
// One contiguous f16 matrix in a growable SharedArrayBuffer, boot-loaded from
// SQLite message_vectors and kept current by the store's single vector-
// mutation stream. No vector index, no background maintenance, no
// state beyond the matrix + a watermark. Every query is an exact scan
// (recall 1.0), sharded across worker threads running the simsimd f16 cosine
// kernel (pure-JS fallback when no native library is available).
//
// Existence is decided at boot: the matrix exists iff boot-load found vector
// rows for the model. When it exists, appends keep it fresh (rows written
// while the process runs are appended or overwritten in place). When boot
// found nothing, semantic serving stays in its 503 degrade mode until the
// next boot — upserts never resurrect an empty matrix mid-process, which is
// also what keeps the pinned HTTP contract (503 on empty-boot) stable.
//
// The matrix may run BEHIND SQLite (rows written mid-load behind the load
// cursor or capacity exhaustion): semantic then serves what is loaded — never
// a 503 once enabled — and the watermark records the drift honestly. Normal
// message updates/deletes are applied online through exact model-key
// invalidations; a reboot is not required for those mutations.
import { performance } from "node:perf_hooks";
import { Context, Deferred, Effect, Layer, Runtime, Schema } from "effect";

import { vectorScanDeadlineMs, vectorWorkerInitTimeoutMs } from "./config";
import { embeddingProfileFromEnv, type EmbeddingProfile } from "./embeddingProfiles";
import {
  LocalStore,
  type MessageVectorBlobRow,
  type MessageVectorMutationEvent,
  type MessageVectorUpsert,
} from "./store";
import { encodeFloat16Vector, VECTOR_BLOB_ENCODING } from "./vectorBlob";
import { encodeQueryVectorF16, loadNativeSimsimdEffect, VectorKernelError } from "./vectorKernel";
import {
  publishMatrixWatermarkGauges,
  recordAppendDropped,
  recordAppendRejected,
} from "./metrics";

const LOAD_PAGE_ROWS = 8_192;
const APPEND_HEADROOM_BYTES = 256 * 1024 * 1024;
const GROW_CHUNK_BYTES = 32 * 1024 * 1024;
/** Scan work unit: small enough that a preempted worker only delays one chunk
 * (work-stealing bounds the p95 tail under CPU contention), large enough that
 * per-chunk message overhead stays negligible. */
const SCAN_CHUNK_ROWS = 32_768;

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
  /** Scope filters, matched against per-slot dictionary-encoded arrays held
   * IN the matrix (no SQL, no store round trip). undefined = unfiltered; a
   * filter value never seen in this matrix (or an empty providers list)
   * short-circuits to []. */
  readonly projectKey?: string;
  readonly role?: string;
  readonly providers?: readonly string[];
  /** Exact session allow-list used for filters whose metadata lives on the
   * session row (agent assignment and model). The mask is applied before
   * top-k selection, so a filtered hit cannot disappear behind global top-k. */
  readonly sessionIds?: ReadonlySet<string>;
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
  /** Liveness deadline for one scan. Defaults to the configured value; tests
   * shorten it to exercise the backstop without waiting out the real budget. */
  readonly scanDeadlineMs?: number;
  /** Backstop for a worker's init handshake, so a thread that dies or wedges
   * before `ready` still settles its spawn. Tests shorten it. */
  readonly workerInitTimeoutMs?: number;
  /** Module the scan worker pool is spawned from. Defaults to the real
   * scanner; a fault-injecting worker is substituted to prove the pool
   * survives a worker dying mid-chunk. */
  readonly scanWorkerUrl?: URL;
}

interface ScanPart {
  readonly rows: Uint32Array;
  readonly scores: Float64Array;
}

interface ScanChunk {
  readonly rowStart: number;
  readonly rowEnd: number;
}

interface PendingScan {
  remaining: number;
  readonly queue: ScanChunk[];
  readonly k: number;
  readonly query: Uint16Array;
  readonly mask: Uint8Array | undefined;
  readonly parts: ScanPart[];
  readonly resolve: (parts: ScanPart[]) => void;
  readonly reject: (cause: Error) => void;
  timer: ReturnType<typeof setTimeout> | undefined;
}

/** One live worker thread plus the chunks it currently owns.
 *
 * `inFlight` is the whole point: a chunk handed to a worker that then dies is
 * otherwise unaccounted for, and the scan waiting on it never completes. At
 * most one chunk per scan id is outstanding on a worker (a chunk is dispatched
 * only at scan start or on that worker's previous result), so the map is keyed
 * by scan id. */
interface WorkerSlot {
  readonly worker: Worker;
  readonly slotId: number;
  /** Set when *we* take the worker out of service (shutdown, recycle). Death
   * events for a retired worker are expected and must not trigger recovery. */
  retired: boolean;
  readonly inFlight: Map<number, ScanChunk>;
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
  /** Per-slot scope filters, resident in the matrix (u8 provider/role
   * dictionary codes, u32 projectKey dictionary code) so a filtered search
   * masks in-process with zero SQL and zero store round trip. Parallel to
   * sessionIds/seqs; kept in sync through append, boot load, and compaction. */
  providerCodes: Uint8Array;
  roleCodes: Uint8Array;
  projectKeyCodes: Uint32Array;
  providerDict: string[];
  providerCodeByName: Map<string, number>;
  roleDict: string[];
  roleCodeByName: Map<string, number>;
  projectKeyDict: string[];
  projectKeyCodeByName: Map<string, number>;
  rowIndex: Map<string, Map<number, number>>;
  slots: WorkerSlot[];
  nextSlotId: number;
  /** In-flight pool refill, shared so concurrent searches await one respawn. */
  refill: Promise<void> | undefined;
  pendingScans: Map<number, PendingScan>;
  nextScanId: number;
}

/** u8 dictionary codes cap at 255 distinct values (provider/role cardinality
 * is a handful in real corpora); an overflow value is diagnosed and pinned to
 * a shared sentinel code that never matches an exact filter, rather than
 * growing unbounded or crashing. */
const U8_DICT_OVERFLOW_CODE = 255;
const U8_DICT_CAPACITY = 255;

const growUint8 = (current: Uint8Array, minLength: number): Uint8Array => {
  if (current.length >= minLength) return current;
  const next = new Uint8Array(minLength);
  next.set(current);
  return next;
};

const growUint32 = (current: Uint32Array, minLength: number): Uint32Array => {
  if (current.length >= minLength) return current;
  const next = new Uint32Array(minLength);
  next.set(current);
  return next;
};

const nowIso = () => new Date().toISOString();

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
      const scanDeadlineMs = options.scanDeadlineMs ?? vectorScanDeadlineMs();
      const workerInitTimeoutMs = options.workerInitTimeoutMs ?? vectorWorkerInitTimeoutMs();
      const scanWorkerUrl = options.scanWorkerUrl ?? new URL("./vectorScanWorker.ts", import.meta.url);
      const targetWorkerCount = workerCountForMachine();
      const loadedSignal = yield* Deferred.make<void>();
      const runtime = yield* Effect.runtime<never>();
      /** Fire-and-forget diagnostics from worker-lifecycle callbacks, which are
       * plain DOM event handlers with no fiber of their own. */
      const logAside = (effect: Effect.Effect<void>): void => {
        Runtime.runFork(runtime)(effect);
      };

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
        providerCodes: new Uint8Array(0),
        roleCodes: new Uint8Array(0),
        projectKeyCodes: new Uint32Array(0),
        providerDict: [],
        providerCodeByName: new Map(),
        roleDict: [],
        roleCodeByName: new Map(),
        projectKeyDict: [],
        projectKeyCodeByName: new Map(),
        rowIndex: new Map(),
        slots: [],
        nextSlotId: 1,
        refill: undefined,
        pendingScans: new Map(),
        nextScanId: 1,
      };

      const rowFor = (sessionId: string, seq: number): number | undefined =>
        state.rowIndex.get(sessionId)?.get(seq);

      /** Dictionary-encode a scope value into a u8 code, growing the dict on
       * first sight. Overflow past 255 distinct values is diagnosed and
       * pinned to a sentinel code that can never match an exact filter,
       * rather than growing unbounded (provider/role cardinality is a
       * handful in every real corpus; this is a safety net, not a design). */
      const internU8Code = (
        kind: "provider" | "role",
        dict: string[],
        byName: Map<string, number>,
        value: string,
      ): Effect.Effect<number> => {
        const existing = byName.get(value);
        if (existing !== undefined) return Effect.succeed(existing);
        if (dict.length >= U8_DICT_CAPACITY) {
          return Effect.logWarning("vector_matrix.scope_dict_overflow").pipe(
            Effect.annotateLogs({
              event: "vector_matrix.scope_dict_overflow",
              at: nowIso(),
              kind,
              value,
              capacity: U8_DICT_CAPACITY,
            }),
            Effect.as(U8_DICT_OVERFLOW_CODE),
          );
        }
        const code = dict.length;
        dict.push(value);
        byName.set(value, code);
        return Effect.succeed(code);
      };

      const internProjectKeyCode = (value: string): number => {
        const existing = state.projectKeyCodeByName.get(value);
        if (existing !== undefined) return existing;
        const code = state.projectKeyDict.length;
        state.projectKeyDict.push(value);
        state.projectKeyCodeByName.set(value, code);
        return code;
      };

      /** Write a row's scope codes into the per-slot dictionary arrays. Must
       * be called for every row written into `bytes` (boot pass 2 and every
       * append/overwrite) so the scope arrays never drift from the vector
       * matrix they mask. */
      const writeScopeCodes = (row: number, provider: string, role: string, projectKey: string): Effect.Effect<void> =>
        Effect.gen(function* () {
          state.providerCodes[row] = yield* internU8Code("provider", state.providerDict, state.providerCodeByName, provider);
          state.roleCodes[row] = yield* internU8Code("role", state.roleDict, state.roleCodeByName, role);
          state.projectKeyCodes[row] = internProjectKeyCode(projectKey);
        });

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
        if (needed > sab.byteLength) {
          if (needed > sab.maxByteLength) return false;
          sab.grow(Math.min(sab.maxByteLength, Math.max(needed, sab.byteLength + GROW_CHUNK_BYTES)));
        }
        // Scope arrays grow in lockstep with the row capacity the SAB now
        // provides, so an appended row always has a slot to write its scope
        // codes into (checked, not unconditionally reallocated: this runs on
        // every append).
        const capacityRows = sab.byteLength / rowBytes;
        if (state.providerCodes.length < capacityRows) state.providerCodes = growUint8(state.providerCodes, capacityRows);
        if (state.roleCodes.length < capacityRows) state.roleCodes = growUint8(state.roleCodes, capacityRows);
        if (state.projectKeyCodes.length < capacityRows) state.projectKeyCodes = growUint32(state.projectKeyCodes, capacityRows);
        return true;
      };

      const writeRowBytes = (row: number, blob: Uint8Array): void => {
        state.bytes!.set(blob, row * rowBytes);
      };

      /** Remove one key in O(rowBytes) by moving the last active row into its
       * slot. Every parallel metadata array and the reverse index moves with
       * the bytes, so scans never retain a tombstone or stale key. */
      const removeRow = (sessionId: string, seq: number): boolean => {
        const row = rowFor(sessionId, seq);
        if (row === undefined || state.rowCount === 0) return false;
        const last = state.rowCount - 1;
        const targetIndex = state.rowIndex.get(sessionId);
        targetIndex?.delete(seq);
        if (targetIndex !== undefined && targetIndex.size === 0) state.rowIndex.delete(sessionId);
        if (row !== last) {
          const movedSessionId = state.sessionIds[last]!;
          const movedSeq = state.seqs[last]!;
          state.bytes!.copyWithin(row * rowBytes, last * rowBytes, (last + 1) * rowBytes);
          state.providerCodes[row] = state.providerCodes[last] ?? 0;
          state.roleCodes[row] = state.roleCodes[last] ?? 0;
          state.projectKeyCodes[row] = state.projectKeyCodes[last] ?? 0;
          indexRow(movedSessionId, movedSeq, row);
        }
        state.sessionIds.pop();
        state.seqs.pop();
        state.rowCount = last;
        return true;
      };

      // --- online mutation path: the store's single mutation site notifies here ---
      const applyVectorMutations = (event: MessageVectorMutationEvent): Effect.Effect<void> => Effect.gen(function* () {
        if (state.closed || !state.enabled) return;
        const deletes = event.deletes.filter((row) => row.model === model);
        let removed = 0;
        for (const row of deletes) {
          if (removeRow(row.sessionId, row.seq)) removed += 1;
        }
        let appended = 0;
        let overwritten = 0;
        for (const row of event.upserts) {
          if (row.model !== model) continue;
          if (row.vector.length !== dimensions) {
            yield* Effect.logWarning("vector_matrix.append_rejected").pipe(
              Effect.annotateLogs({
                event: "vector_matrix.append_rejected",
                at: nowIso(),
                reason: "dimension_mismatch",
                expected: dimensions,
                received: row.vector.length,
              }),
            );
            yield* recordAppendRejected();
            continue;
          }
          let blob: Uint8Array;
          try {
            blob = encodeFloat16Vector(row.vector);
          } catch (cause) {
            yield* Effect.logWarning("vector_matrix.append_rejected").pipe(
              Effect.annotateLogs({
                event: "vector_matrix.append_rejected",
                at: nowIso(),
                reason: "non_finite_vector",
                detail: cause instanceof Error ? cause.message : String(cause),
              }),
            );
            yield* recordAppendRejected();
            continue;
          }
          const existing = rowFor(row.sessionId, row.seq);
          if (existing !== undefined) {
            writeRowBytes(existing, blob);
            yield* writeScopeCodes(existing, row.provider, row.role, row.projectKey);
            overwritten += 1;
            continue;
          }
          if (!ensureRowCapacity(state.rowCount + 1)) {
            state.droppedAppends += 1;
            yield* Effect.logWarning("vector_matrix.append_dropped").pipe(
              Effect.annotateLogs({
                event: "vector_matrix.append_dropped",
                at: nowIso(),
                reason: "capacity_exhausted",
                rows: state.rowCount,
                droppedAppends: state.droppedAppends,
              }),
            );
            yield* recordAppendDropped();
            continue;
          }
          writeRowBytes(state.rowCount, blob);
          yield* writeScopeCodes(state.rowCount, row.provider, row.role, row.projectKey);
          indexRow(row.sessionId, row.seq, state.rowCount);
          state.rowCount += 1;
          appended += 1;
        }
        state.appendedRows += appended;
        state.overwrittenRows += overwritten;
        const sqliteRows = event.sqliteRowsByModel[model]
          ?? (deletes.length > 0
            ? Math.max(0, state.watermark.sqliteRows - deletes.length)
            : undefined);
        if (sqliteRows !== undefined) {
          state.watermark = { matrixRows: state.rowCount, sqliteRows, checkedAt: nowIso() };
          if (sqliteRows !== state.rowCount) {
            yield* Effect.logWarning("vector_matrix.watermark_drift").pipe(
              Effect.annotateLogs({
                event: "vector_matrix.watermark_drift",
                at: nowIso(),
                matrixRows: state.rowCount,
                sqliteRows,
              }),
            );
          }
        }
        if (removed > 0 || appended > 0 || overwritten > 0 || sqliteRows !== undefined) {
          yield* publishMatrixWatermarkGauges({
            enabled: state.enabled,
            rows: state.rowCount,
            watermark: state.watermark,
            overwrittenRows: state.overwrittenRows,
            appendedRows: state.appendedRows,
            droppedAppends: state.droppedAppends,
          });
        }
      });

      // --- worker pool ---
      // One chunk per message; a worker that finishes a chunk immediately
      // receives the scan's next queued chunk (work-stealing), so a core lost
      // to another process delays one chunk, not a whole static shard.
      //
      // A worker can also stop existing (thread crash, OOM kill, uncaught
      // fault in the kernel). Every path that removes a chunk-holding worker
      // therefore settles the scans that worker owed: post-init error/close
      // handlers fail those scans immediately, and a per-scan deadline is the
      // backstop for a worker that goes quiet without emitting either event.
      // A scan never waits on a worker that no longer exists.
      const dispatchChunk = (slot: WorkerSlot, id: number, pending: PendingScan): void => {
        const chunk = pending.queue.shift();
        if (chunk === undefined) return;
        slot.inFlight.set(id, chunk);
        const query = pending.query.slice();
        const mask = pending.mask?.slice(chunk.rowStart, chunk.rowEnd);
        const transfer: Transferable[] = [query.buffer as ArrayBuffer];
        if (mask !== undefined) transfer.push(mask.buffer as ArrayBuffer);
        slot.worker.postMessage(
          { type: "scan", id, rowStart: chunk.rowStart, rowEnd: chunk.rowEnd, k: pending.k, query, mask: mask ?? null },
          transfer,
        );
      };

      /** Settle a scan exactly once, releasing its deadline and dropping every
       * worker's bookkeeping for it. Chunks still queued for it are abandoned
       * with it — a settled scan never gets more work dispatched. */
      const settleScan = (id: number, outcome: { readonly parts: ScanPart[] } | { readonly error: Error }): void => {
        const pending = state.pendingScans.get(id);
        if (pending === undefined) return;
        state.pendingScans.delete(id);
        if (pending.timer !== undefined) clearTimeout(pending.timer);
        pending.queue.length = 0;
        for (const slot of state.slots) slot.inFlight.delete(id);
        if ("error" in outcome) pending.reject(outcome.error);
        else pending.resolve(outcome.parts);
      };

      const routeWorkerMessage = (
        slot: WorkerSlot,
        message: { type: string; id?: number | null; rows?: Uint32Array; scores?: Float64Array; written?: number; skipped?: number; message?: string },
      ): void => {
        if (message.type === "result" && typeof message.id === "number") {
          slot.inFlight.delete(message.id);
          const pending = state.pendingScans.get(message.id);
          if (pending === undefined) return;
          pending.parts.push({ rows: message.rows ?? new Uint32Array(0), scores: message.scores ?? new Float64Array(0) });
          pending.remaining -= 1;
          if (pending.remaining === 0) {
            settleScan(message.id, { parts: pending.parts });
            return;
          }
          dispatchChunk(slot, message.id, pending);
          return;
        }
        if (message.type === "error") {
          const failure = new Error(message.message ?? "vector scan worker error");
          if (typeof message.id === "number") {
            slot.inFlight.delete(message.id);
            settleScan(message.id, { error: failure });
            return;
          }
          for (const id of [...state.pendingScans.keys()]) {
            settleScan(id, { error: failure });
          }
        }
      };

      /** Take a worker out of service on our own terms. Marking it retired
       * before terminate() is what keeps the resulting close event from being
       * read as a crash. */
      const retireSlot = (slot: WorkerSlot): void => {
        slot.retired = true;
        const index = state.slots.indexOf(slot);
        if (index !== -1) state.slots.splice(index, 1);
        try {
          slot.worker.terminate();
        } catch {
          // Already gone; termination is the goal, not the call succeeding.
        }
      };

      const spawnWorkerSlot = (sab: SharedArrayBuffer): Promise<WorkerSlot> =>
        new Promise<WorkerSlot>((resolve, reject) => {
          const worker = new Worker(scanWorkerUrl);
          const slot: WorkerSlot = {
            worker,
            slotId: state.nextSlotId,
            retired: false,
            inFlight: new Map(),
          };
          state.nextSlotId += 1;
          let ready = false;
          let settled = false;
          // The spawn promise must be TOTAL. A thread that dies during init
          // emits `close` and no `error`, and one that wedges emits neither —
          // either would leave this promise forever pending, and `refillPool`
          // caches it, so the pool could never heal again and the next scan
          // would await a dead promise past its own deadline.
          let initTimer: ReturnType<typeof setTimeout> | undefined;
          const failInit = (message: string) => {
            if (settled) return;
            settled = true;
            ready = true;
            slot.retired = true;
            if (initTimer !== undefined) clearTimeout(initTimer);
            try {
              worker.terminate();
            } catch {
              // nothing to clean up
            }
            reject(new Error(message));
          };
          const succeedInit = () => {
            if (settled) return;
            settled = true;
            ready = true;
            if (initTimer !== undefined) clearTimeout(initTimer);
            resolve(slot);
          };
          initTimer = setTimeout(
            () => failInit(`vector scan worker did not initialize within ${workerInitTimeoutMs}ms`),
            workerInitTimeoutMs,
          );
          worker.onmessage = (event: MessageEvent) => {
            const data = event.data as { type: string; native?: boolean; message?: string };
            if (!ready) {
              if (data.type !== "ready") {
                failInit(data.message ?? "vector scan worker failed to initialize");
                return;
              }
              succeedInit();
              return;
            }
            routeWorkerMessage(slot, data as Parameters<typeof routeWorkerMessage>[1]);
          };
          worker.onerror = (event: ErrorEvent) => {
            if (!ready) {
              failInit(event.message ?? "vector scan worker failed to initialize");
              return;
            }
            handleWorkerDeath(slot, `error: ${event.message ?? "unknown"}`);
          };
          // A thread that exits without an error event still owes its chunks —
          // and one that exits BEFORE `ready` owes this promise a rejection.
          worker.addEventListener("close", () => {
            if (!ready) {
              failInit("vector scan worker exited during init");
              return;
            }
            handleWorkerDeath(slot, "exit");
          });
          worker.postMessage({ type: "init", sab, dimensions, libraryPath: state.libraryPath });
        });

      /** Bring the pool back to strength. Concurrent callers share one refill
       * so a burst of deaths does not spawn a burst of pools. Never rejects:
       * the caller decides what an empty pool means, from `state.slots`. */
      const refillPool = (): Promise<void> => {
        if (state.closed || !state.enabled) return Promise.resolve();
        const sab = state.sab;
        if (sab === undefined) return Promise.resolve();
        const missing = targetWorkerCount - state.slots.length;
        if (missing <= 0) return Promise.resolve();
        const inFlight = state.refill;
        if (inFlight !== undefined) return inFlight;
        const task = (async () => {
          const settled = await Promise.allSettled(
            Array.from({ length: missing }, () => spawnWorkerSlot(sab)),
          );
          const failures: string[] = [];
          for (const outcome of settled) {
            if (outcome.status === "rejected") {
              failures.push(outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason));
              continue;
            }
            if (state.closed || !state.enabled) {
              retireSlot(outcome.value);
              continue;
            }
            state.slots.push(outcome.value);
          }
          if (failures.length > 0) {
            logAside(
              Effect.logError("vector_matrix.worker_respawn_failed").pipe(
                Effect.annotateLogs({
                  event: "vector_matrix.worker_respawn_failed",
                  at: nowIso(),
                  model,
                  failed: failures.length,
                  detail: failures[0],
                  workers: state.slots.length,
                }),
              ),
            );
          }
        })().finally(() => {
          state.refill = undefined;
        });
        state.refill = task;
        return task;
      };

      /** Refill from a worker-death or deadline callback, which has no caller
       * to return a promise to. `refillPool` routes its own spawn failures
       * into a diagnostic, so the only thing left here is the defect channel:
       * an unexpected rejection is logged rather than escaping as an unhandled
       * rejection that would take the process down. */
      const scheduleRefill = (): void => {
        refillPool().catch((cause: unknown) => {
          logAside(
            Effect.logError("vector_matrix.worker_refill_defect").pipe(
              Effect.annotateLogs({
                event: "vector_matrix.worker_refill_defect",
                at: nowIso(),
                model,
                detail: cause instanceof Error ? cause.message : String(cause),
              }),
            ),
          );
        });
      };

      /** A worker died on its own. Fail the scans it owed chunks for — the
       * results it was carrying are gone, and a partial merge would silently
       * return a wrong top-k — then rebuild the pool so the next query runs. */
      function handleWorkerDeath(slot: WorkerSlot, reason: string): void {
        if (slot.retired) return;
        retireSlot(slot);
        const orphaned = [...slot.inFlight.keys()];
        slot.inFlight.clear();
        logAside(
          Effect.logError("vector_matrix.worker_died").pipe(
            Effect.annotateLogs({
              event: "vector_matrix.worker_died",
              at: nowIso(),
              model,
              slotId: slot.slotId,
              reason,
              orphanedScans: orphaned.length,
              workers: state.slots.length,
            }),
          ),
        );
        for (const id of orphaned) {
          settleScan(id, {
            error: new Error(`vector scan worker died mid-chunk (${reason})`),
          });
        }
        scheduleRefill();
      }

      const spawnWorkers = async (sab: SharedArrayBuffer): Promise<void> => {
        const settled = await Promise.allSettled(
          Array.from({ length: targetWorkerCount }, () => spawnWorkerSlot(sab)),
        );
        // Adopt every thread that did come up BEFORE failing, so the load
        // failure path's terminateWorkers() reclaims them instead of leaving
        // orphaned threads behind a partially failed pool.
        for (const outcome of settled) {
          if (outcome.status === "fulfilled") state.slots.push(outcome.value);
        }
        const failure = settled.find((outcome) => outcome.status === "rejected");
        if (failure !== undefined && failure.status === "rejected") {
          throw failure.reason instanceof Error ? failure.reason : new Error(String(failure.reason));
        }
      };

      const terminateWorkers = (): void => {
        for (const slot of [...state.slots]) retireSlot(slot);
        state.slots = [];
        for (const id of [...state.pendingScans.keys()]) {
          settleScan(id, { error: new Error("vector matrix closed") });
        }
      };

      /** Wait for `task`, but never longer than `ms`. The caller then decides
       * from observable state (`state.slots`) what the timeout means. */
      const raceDeadline = async (task: Promise<void>, ms: number): Promise<void> => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([
            task,
            new Promise<void>((settle) => {
              timer = setTimeout(settle, ms);
            }),
          ]);
        } finally {
          if (timer !== undefined) clearTimeout(timer);
        }
      };

      const scanAll = async (
        query: Uint16Array,
        rowCount: number,
        k: number,
        mask?: Uint8Array,
      ): Promise<ScanPart[]> => {
        const queue: ScanChunk[] = [];
        for (let rowStart = 0; rowStart < rowCount; rowStart += SCAN_CHUNK_ROWS) {
          queue.push({ rowStart, rowEnd: Math.min(rowCount, rowStart + SCAN_CHUNK_ROWS) });
        }
        if (queue.length === 0) return [];
        if (state.slots.length < targetWorkerCount) {
          // A pool with survivors serves the query now and heals behind it; an
          // empty pool has nothing to dispatch to, so wait out the respawn
          // rather than fail a query the matrix can still answer. The wait is
          // bounded by the scan's own deadline: the per-scan timer is armed
          // AFTER this point, so an unbounded wait here would escape it.
          const healing = refillPool();
          if (state.slots.length === 0) await raceDeadline(healing, scanDeadlineMs);
        }
        if (state.slots.length === 0) {
          throw new Error("no live vector scan workers (respawn failed)");
        }
        return await new Promise<ScanPart[]>((resolve, reject) => {
          const id = state.nextScanId;
          state.nextScanId += 1;
          const pending: PendingScan = {
            remaining: queue.length,
            queue,
            k,
            query,
            mask,
            parts: [],
            resolve,
            reject,
            timer: undefined,
          };
          // Backstop for a worker that neither answers nor reports its death.
          // Recycle whoever still holds this scan's chunks: a worker past this
          // deadline is wedged or gone, and keeping it would leak the next
          // scan's chunks into the same hole.
          pending.timer = setTimeout(() => {
            if (!state.pendingScans.has(id)) return;
            // Recycling a slot destroys the chunks it held for OTHER scans too.
            // Those scans must fail here with the true cause, not sit waiting
            // on a worker that no longer exists until their own deadline —
            // "a scan never waits on a worker that no longer exists".
            const collateral = new Set<number>();
            for (const slot of [...state.slots]) {
              if (!slot.inFlight.has(id)) continue;
              for (const owed of slot.inFlight.keys()) collateral.add(owed);
              slot.inFlight.clear();
              retireSlot(slot);
              logAside(
                Effect.logError("vector_matrix.scan_deadline_exceeded").pipe(
                  Effect.annotateLogs({
                    event: "vector_matrix.scan_deadline_exceeded",
                    at: nowIso(),
                    model,
                    slotId: slot.slotId,
                    deadlineMs: scanDeadlineMs,
                    collateralScans: collateral.size - (collateral.has(id) ? 1 : 0),
                  }),
                ),
              );
            }
            collateral.delete(id);
            for (const owed of collateral) {
              settleScan(owed, {
                error: new Error(
                  `vector scan worker was recycled at another scan's ${scanDeadlineMs}ms deadline`,
                ),
              });
            }
            settleScan(id, {
              error: new Error(`vector scan exceeded its ${scanDeadlineMs}ms deadline`),
            });
            scheduleRefill();
          }, scanDeadlineMs);
          state.pendingScans.set(id, pending);
          for (const slot of [...state.slots]) {
            if (pending.queue.length === 0) break;
            dispatchChunk(slot, id, pending);
          }
        });
      };

      // Compact validation holes left by pass 2: stable forward pass keeps the
      // (session_id, seq) row order for every surviving row. No-op (zero
      // copies) when every slot was filled.
      const compactHoles = (slots: number, filled: Uint8Array): number => {
        const bytes = state.bytes!;
        let write = 0;
        for (let read = 0; read < slots; read += 1) {
          const sessionId = state.sessionIds[read]!;
          const seq = state.seqs[read]!;
          if (filled[read] !== 1) {
            const inner = state.rowIndex.get(sessionId);
            inner?.delete(seq);
            if (inner !== undefined && inner.size === 0) state.rowIndex.delete(sessionId);
            continue;
          }
          if (write !== read) {
            bytes.copyWithin(write * rowBytes, read * rowBytes, (read + 1) * rowBytes);
            state.sessionIds[write] = sessionId;
            state.seqs[write] = seq;
            state.providerCodes[write] = state.providerCodes[read] ?? 0;
            state.roleCodes[write] = state.roleCodes[read] ?? 0;
            state.projectKeyCodes[write] = state.projectKeyCodes[read] ?? 0;
            state.rowIndex.get(sessionId)!.set(seq, write);
          }
          write += 1;
        }
        state.sessionIds.length = write;
        state.seqs.length = write;
        return write;
      };

      // --- boot load: two passes on the store's single connection ---
      // Pass 1 walks the (model, session_id, seq) covering index once and
      // assigns every key its matrix slot in canonical (session_id, seq)
      // order. Pass 2 walks the table in rowid order — sequential IO — and
      // writes each blob into its pre-assigned slot; walking blobs in index
      // order instead degrades into random table-page reads at corpus scale.
      // (No parallel connections: fresh bun:sqlite connections against a live
      // WAL database tear intermittently at open time — reproduced
      // 2026-07-04 — so all SQLite IO stays on the store connection.)
      // Rows written after the key snapshot have no slot and are skipped —
      // concurrent writes can never shift layout; validation failures leave
      // holes that compact away afterwards.
      const load = Effect.gen(function* () {
        const started = performance.now();
        const total = yield* store.countMessageVectors(model);
        if (total === 0) {
          state.watermark = { matrixRows: 0, sqliteRows: 0, checkedAt: nowIso() };
          // Honest not-ready gauges: never leave drift at 0/0 as false healthy.
          yield* publishMatrixWatermarkGauges({
            enabled: false,
            rows: 0,
            watermark: state.watermark,
            overwrittenRows: state.overwrittenRows,
            appendedRows: state.appendedRows,
            droppedAppends: state.droppedAppends,
          });
          yield* Effect.logInfo("vector_matrix.empty_boot").pipe(
            Effect.annotateLogs({
              event: "vector_matrix.empty_boot",
              at: nowIso(),
              model,
              dimensions,
            }),
          );
          return;
        }
        const native = options.kernel === "js" ? undefined : yield* loadNativeSimsimdEffect();
        state.libraryPath = native?.libraryPath ?? null;
        state.kernel = native !== undefined ? "simsimd-ffi" : "js-fallback";

        const keys = yield* store.listMessageVectorKeys({ model });
        const slots = keys.length;
        const sab = new SharedArrayBuffer(slots * rowBytes, {
          maxByteLength: slots * rowBytes + APPEND_HEADROOM_BYTES,
        });
        state.sab = sab;
        state.bytes = new Uint8Array(sab);
        state.providerCodes = new Uint8Array(slots);
        state.roleCodes = new Uint8Array(slots);
        state.projectKeyCodes = new Uint32Array(slots);
        let lastSessionId: string | undefined;
        for (let slot = 0; slot < slots; slot += 1) {
          const key = keys[slot]!;
          const sessionId = key.sessionId === lastSessionId && lastSessionId !== undefined ? lastSessionId : key.sessionId;
          lastSessionId = sessionId;
          indexRow(sessionId, key.seq, slot);
        }

        const filled = new Uint8Array(slots);
        let afterRowid = 0;
        while (true) {
          const page = yield* store.listMessageVectorBlobsByRowidPage({
            model,
            afterRowid,
            limit: LOAD_PAGE_ROWS,
          });
          if (page.length === 0) break;
          const validRows: Array<{
            readonly row: MessageVectorBlobRow;
            readonly slot: number;
          }> = [];
          for (const row of page) {
            afterRowid = row.rowid;
            const slot = rowFor(row.sessionId, row.seq);
            if (slot === undefined || slot >= slots) continue; // row appeared after the key snapshot
            if (row.encoding !== VECTOR_BLOB_ENCODING || row.dimensions !== dimensions || row.vectorBlob.byteLength !== rowBytes) {
              state.loadSkippedRows += 1;
              continue;
            }
            validRows.push({ row, slot });
          }

          // Intern the page's handful of provider/role values once, then keep
          // the 8k-row copy loop synchronous. Yielding an Effect per row here
          // previously added scheduler work for every vector in the corpus.
          for (const provider of new Set(validRows.map(({ row }) => row.provider))) {
            yield* internU8Code(
              "provider",
              state.providerDict,
              state.providerCodeByName,
              provider,
            );
          }
          for (const role of new Set(validRows.map(({ row }) => row.role))) {
            yield* internU8Code(
              "role",
              state.roleDict,
              state.roleCodeByName,
              role,
            );
          }
          for (const { row, slot } of validRows) {
            writeRowBytes(slot, row.vectorBlob);
            state.providerCodes[slot] =
              state.providerCodeByName.get(row.provider) ?? U8_DICT_OVERFLOW_CODE;
            state.roleCodes[slot] =
              state.roleCodeByName.get(row.role) ?? U8_DICT_OVERFLOW_CODE;
            state.projectKeyCodes[slot] = internProjectKeyCode(row.projectKey);
            filled[slot] = 1;
          }
          if (page.length < LOAD_PAGE_ROWS) break;
          yield* Effect.yieldNow();
        }
        state.rowCount = compactHoles(slots, filled);
        if (state.rowCount === 0) {
          state.watermark = { matrixRows: 0, sqliteRows: total, checkedAt: nowIso() };
          yield* publishMatrixWatermarkGauges({
            enabled: false,
            rows: 0,
            watermark: state.watermark,
            overwrittenRows: state.overwrittenRows,
            appendedRows: state.appendedRows,
            droppedAppends: state.droppedAppends,
          });
          yield* Effect.logWarning("vector_matrix.load_empty_after_validation").pipe(
            Effect.annotateLogs({
              event: "vector_matrix.load_empty_after_validation",
              at: nowIso(),
              model,
              skipped: state.loadSkippedRows,
            }),
          );
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
          yield* Effect.logWarning("vector_matrix.watermark_drift").pipe(
            Effect.annotateLogs({
              event: "vector_matrix.watermark_drift",
              at: nowIso(),
              matrixRows: state.rowCount,
              sqliteRows,
              phase: "boot",
            }),
          );
        }
        yield* publishMatrixWatermarkGauges({
          enabled: true,
          rows: state.rowCount,
          watermark: state.watermark,
          overwrittenRows: state.overwrittenRows,
          appendedRows: state.appendedRows,
          droppedAppends: state.droppedAppends,
        });
        yield* Effect.logInfo("vector_matrix.loaded").pipe(
          Effect.annotateLogs({
            event: "vector_matrix.loaded",
            at: nowIso(),
            model,
            dimensions,
            rows: state.rowCount,
            skippedRows: state.loadSkippedRows,
            loadMs: state.loadMs,
            kernel: state.kernel,
            workers: state.slots.length,
          }),
        );
      }).pipe(
        Effect.catchAll((cause) =>
          Effect.logError("vector_matrix.load_failed").pipe(
            Effect.annotateLogs({
              event: "vector_matrix.load_failed",
              at: nowIso(),
              model,
              detail: cause instanceof Error ? cause.message : JSON.stringify(cause),
            }),
            Effect.zipRight(Effect.sync(() => {
              terminateWorkers();
            })),
          ),
        ),
        Effect.ensuring(Deferred.succeed(loadedSignal, undefined)),
      );

      store.registerMessageVectorMutationListener(applyVectorMutations);
      yield* Effect.forkScoped(load);
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          state.closed = true;
          state.enabled = false;
          terminateWorkers();
        }),
      );

      // One stage-level span for the whole matrix search — never per-row
      // inside the scan loop (60ms p95 scan budget).
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
          const k = Math.min(Math.max(1, request.limit), rowCount);
          const filtered = request.projectKey !== undefined
            || request.role !== undefined
            || request.providers !== undefined
            || request.sessionIds !== undefined;
          let mask: Uint8Array | undefined;
          if (filtered) {
            // Resolve each requested scope value to its in-matrix dictionary
            // code up front. A value never seen by this matrix (or an empty
            // providers list) can never match any row: short-circuit to []
            // without scanning.
            const projectKeyCode = request.projectKey !== undefined
              ? state.projectKeyCodeByName.get(request.projectKey)
              : undefined;
            if (request.projectKey !== undefined && projectKeyCode === undefined) return [] as const;
            const roleCode = request.role !== undefined ? state.roleCodeByName.get(request.role) : undefined;
            if (request.role !== undefined && roleCode === undefined) return [] as const;
            let providerCodes: Set<number> | undefined;
            if (request.providers !== undefined) {
              providerCodes = new Set(
                request.providers
                  .map((provider) => state.providerCodeByName.get(provider))
                  .filter((code): code is number => code !== undefined),
              );
              if (providerCodes.size === 0) return [] as const;
            }
            if (request.sessionIds !== undefined && request.sessionIds.size === 0) {
              return [] as const;
            }
            mask = new Uint8Array(rowCount);
            let found = 0;
            for (let row = 0; row < rowCount; row += 1) {
              if (projectKeyCode !== undefined && state.projectKeyCodes[row] !== projectKeyCode) continue;
              if (roleCode !== undefined && state.roleCodes[row] !== roleCode) continue;
              if (providerCodes !== undefined && !providerCodes.has(state.providerCodes[row] ?? 0)) continue;
              if (
                request.sessionIds !== undefined
                && !request.sessionIds.has(state.sessionIds[row]!)
              ) continue;
              mask[row] = 1;
              found += 1;
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
        }).pipe(
          Effect.withSpan("search.matrixScan", {
            attributes: {
              limit: request.limit,
              filtered: request.projectKey !== undefined || request.role !== undefined || request.providers !== undefined,
            },
          }),
        );

      return VectorMatrix.of({
        status: Effect.sync(() => ({
          enabled: state.enabled,
          model,
          dimensions,
          rows: state.rowCount,
          kernel: state.kernel,
          workerCount: state.slots.length,
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
