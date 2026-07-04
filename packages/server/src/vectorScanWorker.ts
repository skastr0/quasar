// Shard scanner for the resident f16 vector matrix.
//
// Owns no state beyond an init-time view over the shared matrix. Each scan
// message names an absolute row range, a top-k budget, an f16 query, and an
// optional candidate mask (indexed relative to rowStart); the reply carries
// the shard's top-k rows. Kernel: simsimd_cos_f16 via bun:ffi when a library
// path is provided, else the pure-JS fallback (exact same spec as
// cosineSimilarityF16Reference, decoded through a f16->f32 lookup table).
// Non-finite similarities never enter the heap.
import { dlopen, FFIType, ptr, type Pointer } from "bun:ffi";

import { float16BitsToFloat32 } from "./vectorBlob";

declare var self: Worker;

interface InitMessage {
  readonly type: "init";
  readonly sab: SharedArrayBuffer;
  readonly dimensions: number;
  readonly libraryPath: string | null;
}

interface ScanMessage {
  readonly type: "scan";
  readonly id: number;
  readonly rowStart: number;
  readonly rowEnd: number;
  readonly k: number;
  readonly query: Uint16Array;
  readonly mask: Uint8Array | null;
}

type WorkerMessage = InitMessage | ScanMessage;

interface State {
  readonly matrix: Uint16Array;
  readonly dimensions: number;
  readonly cosineDistanceF16: ((a: Pointer, b: Pointer, n: number, out: Pointer) => void) | undefined;
  readonly decode: Float32Array | undefined;
}

let state: State | undefined;

const buildDecodeTable = (): Float32Array => {
  const table = new Float32Array(65536);
  for (let bits = 0; bits < 65536; bits += 1) {
    table[bits] = float16BitsToFloat32(bits);
  }
  return table;
};

interface TopK {
  readonly rows: Uint32Array;
  readonly scores: Float64Array;
  size: number;
}

const pushTopK = (heap: TopK, capacity: number, row: number, score: number): void => {
  if (!Number.isFinite(score)) return;
  if (heap.size < capacity) {
    let index = heap.size;
    heap.rows[index] = row;
    heap.scores[index] = score;
    heap.size += 1;
    while (index > 0) {
      const parent = (index - 1) >> 1;
      if ((heap.scores[parent] ?? 0) <= (heap.scores[index] ?? 0)) break;
      swap(heap, parent, index);
      index = parent;
    }
    return;
  }
  if (score <= (heap.scores[0] ?? Number.NEGATIVE_INFINITY)) return;
  heap.rows[0] = row;
  heap.scores[0] = score;
  let index = 0;
  while (true) {
    const left = index * 2 + 1;
    const right = left + 1;
    let smallest = index;
    if (left < heap.size && (heap.scores[left] ?? 0) < (heap.scores[smallest] ?? 0)) smallest = left;
    if (right < heap.size && (heap.scores[right] ?? 0) < (heap.scores[smallest] ?? 0)) smallest = right;
    if (smallest === index) return;
    swap(heap, smallest, index);
    index = smallest;
  }
};

const swap = (heap: TopK, a: number, b: number): void => {
  const row = heap.rows[a] ?? 0;
  const score = heap.scores[a] ?? 0;
  heap.rows[a] = heap.rows[b] ?? 0;
  heap.scores[a] = heap.scores[b] ?? 0;
  heap.rows[b] = row;
  heap.scores[b] = score;
};

const scanNative = (current: State, message: ScanMessage, heap: TopK, capacity: number): void => {
  const { rowStart, rowEnd, query, mask } = message;
  const dims = current.dimensions;
  const rowBytes = dims * 2;
  const basePointer = ptr(current.matrix);
  const queryPointer = ptr(query);
  const out = new Float64Array(1);
  const outPointer = ptr(out);
  const cosine = current.cosineDistanceF16!;
  for (let row = rowStart; row < rowEnd; row += 1) {
    if (mask !== null && mask[row - rowStart] === 0) continue;
    cosine(queryPointer, (basePointer + row * rowBytes) as Pointer, dims, outPointer);
    pushTopK(heap, capacity, row, 1 - (out[0] ?? Number.NaN));
  }
};

const scanFallback = (current: State, message: ScanMessage, heap: TopK, capacity: number): void => {
  const { rowStart, rowEnd, query, mask } = message;
  const dims = current.dimensions;
  const decode = current.decode!;
  const matrix = current.matrix;
  const decodedQuery = new Float32Array(dims);
  let queryNorm = 0;
  for (let index = 0; index < dims; index += 1) {
    const value = decode[query[index] ?? 0] ?? 0;
    decodedQuery[index] = value;
    queryNorm += value * value;
  }
  for (let row = rowStart; row < rowEnd; row += 1) {
    if (mask !== null && mask[row - rowStart] === 0) continue;
    const offset = row * dims;
    let dot = 0;
    let rowNorm = 0;
    for (let index = 0; index < dims; index += 1) {
      const value = decode[matrix[offset + index] ?? 0] ?? 0;
      dot += value * (decodedQuery[index] ?? 0);
      rowNorm += value * value;
    }
    const score = rowNorm === 0 && queryNorm === 0 ? 1 : rowNorm === 0 || queryNorm === 0 ? 0 : dot / (Math.sqrt(rowNorm) * Math.sqrt(queryNorm));
    pushTopK(heap, capacity, row, score);
  }
};

self.onmessage = (event: MessageEvent<WorkerMessage>) => {
  const message = event.data;
  try {
    if (message.type === "init") {
      let cosineDistanceF16: State["cosineDistanceF16"];
      if (message.libraryPath !== null) {
        const library = dlopen(message.libraryPath, {
          simsimd_cos_f16: {
            args: [FFIType.ptr, FFIType.ptr, FFIType.u64_fast, FFIType.ptr],
            returns: FFIType.void,
          },
        });
        cosineDistanceF16 = library.symbols.simsimd_cos_f16 as State["cosineDistanceF16"];
      }
      state = {
        matrix: new Uint16Array(message.sab),
        dimensions: message.dimensions,
        cosineDistanceF16,
        decode: cosineDistanceF16 === undefined ? buildDecodeTable() : undefined,
      };
      self.postMessage({ type: "ready", native: cosineDistanceF16 !== undefined });
      return;
    }
    if (state === undefined) {
      throw new Error("scan before init");
    }
    const capacity = Math.max(0, Math.min(message.k, message.rowEnd - message.rowStart));
    const heap: TopK = {
      rows: new Uint32Array(capacity),
      scores: new Float64Array(capacity),
      size: 0,
    };
    if (capacity > 0) {
      if (state.cosineDistanceF16 !== undefined) scanNative(state, message, heap, capacity);
      else scanFallback(state, message, heap, capacity);
    }
    const rows = heap.rows.slice(0, heap.size);
    const scores = heap.scores.slice(0, heap.size);
    self.postMessage({ type: "result", id: message.id, rows, scores }, [rows.buffer, scores.buffer]);
  } catch (cause) {
    self.postMessage({
      type: "error",
      id: message.type === "scan" ? message.id : null,
      message: cause instanceof Error ? cause.message : String(cause),
    });
  }
};
