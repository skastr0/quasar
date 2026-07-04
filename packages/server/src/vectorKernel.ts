// f16 cosine kernel for the resident vector matrix (QSR rearchitecture D7).
//
// Two implementations of one spec:
//   - reference: pure-JS cosine over decoded f16 pairs. This is the SPEC the
//     property tests hold the native kernel to, and the last-resort fallback.
//   - native: simsimd's dynamic-dispatch C ABI (simsimd_cos_f16) dlopen'd via
//     bun:ffi. NEON f16 on arm64; per-pair calls, sharded across workers by
//     vectorMatrix.
//
// Zero-vector semantics (pinned by simsimd, adopted by the reference):
//   both vectors zero-norm  -> similarity 1 (identical)
//   exactly one zero-norm   -> similarity 0
// NaN/Inf query components are a contract breach rejected at the boundary
// (encodeQueryVectorF16); stored rows are validated at encode time by
// vectorBlob's encodeFloat16Vector.
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { dlopen, FFIType, ptr, type Pointer } from "bun:ffi";

import { float16BitsToFloat32, float32ToFloat16Bits } from "./vectorBlob";

export class VectorKernelError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VectorKernelError";
  }
}

/** Cosine similarity between two f16-encoded vectors — the kernel spec. */
export const cosineSimilarityF16Reference = (a: Uint16Array, b: Uint16Array): number => {
  if (a.length !== b.length) {
    throw new VectorKernelError(`vector length mismatch: ${a.length} vs ${b.length}`);
  }
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let index = 0; index < a.length; index += 1) {
    const x = float16BitsToFloat32(a[index] ?? 0);
    const y = float16BitsToFloat32(b[index] ?? 0);
    dot += x * y;
    normA += x * x;
    normB += y * y;
  }
  if (normA === 0 && normB === 0) return 1;
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
};

/** Encode a query vector to f16 bits, rejecting contract breaches loudly:
 * wrong dimensionality, non-finite components, zero norm. */
export const encodeQueryVectorF16 = (vector: readonly number[], dimensions: number): Uint16Array => {
  if (vector.length !== dimensions) {
    throw new VectorKernelError(`query vector has dimension ${vector.length}; expected ${dimensions}`);
  }
  const encoded = new Uint16Array(dimensions);
  let norm = 0;
  for (let index = 0; index < dimensions; index += 1) {
    const value = vector[index] ?? 0;
    if (!Number.isFinite(value)) {
      throw new VectorKernelError(`query vector component at index ${index} is not finite`);
    }
    const bits = float32ToFloat16Bits(value);
    if ((bits & 0x7fff) === 0x7c00) {
      throw new VectorKernelError(`query vector component at index ${index} overflows f16 range`);
    }
    encoded[index] = bits;
    const projected = float16BitsToFloat32(bits);
    norm += projected * projected;
  }
  if (norm === 0) {
    throw new VectorKernelError("query vector has zero norm after f16 projection");
  }
  return encoded;
};

export interface NativeSimsimd {
  readonly libraryPath: string;
  readonly capabilities: { readonly neon: boolean; readonly neonF16: boolean };
  /** simsimd_cos_f16(a, b, n, out): writes cosine DISTANCE (1 - similarity) to out. */
  readonly cosineDistanceF16: (a: Pointer, b: Pointer, n: number, out: Pointer) => void;
}

const packageRootFrom = (startDir: string): string | undefined => {
  let dir = startDir;
  for (let depth = 0; depth < 10; depth += 1) {
    const candidate = join(dir, "node_modules", "simsimd");
    if (existsSync(join(candidate, "package.json"))) return candidate;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
  return undefined;
};

/** Locate a dlopen-able simsimd shared library for this platform:
 * the npm package's prebuild (linux) or the local darwin build produced by
 * scripts/ensure-simsimd-native.mjs. */
export const resolveSimsimdLibraryPath = (): string | undefined => {
  const packageRoot = packageRootFrom(import.meta.dir);
  if (packageRoot === undefined) return undefined;
  const prebuild = join(packageRoot, "prebuilds", `${process.platform}-${process.arch}`, "simsimd.node");
  if (existsSync(prebuild)) return prebuild;
  const version = (JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")) as { version: string }).version;
  const extension = process.platform === "darwin" ? "dylib" : "so";
  const local = join(
    dirname(dirname(packageRoot)),
    ".native",
    `libsimsimd-v${version}-${process.platform}-${process.arch}.${extension}`,
  );
  return existsSync(local) ? local : undefined;
};

/** dlopen the simsimd C ABI and self-check it against the reference on a known
 * pair before trusting it. Returns undefined (with a named diagnostic) when no
 * usable library exists — callers fall back to the reference kernel. */
export const loadNativeSimsimd = (libraryPath = resolveSimsimdLibraryPath()): NativeSimsimd | undefined => {
  if (libraryPath === undefined) {
    console.error(JSON.stringify({
      event: "vector_kernel.native_unavailable",
      at: new Date().toISOString(),
      diagnostic: "no simsimd shared library for this platform; run scripts/ensure-simsimd-native.mjs",
    }));
    return undefined;
  }
  try {
    const library = dlopen(libraryPath, {
      simsimd_cos_f16: {
        args: [FFIType.ptr, FFIType.ptr, FFIType.u64_fast, FFIType.ptr],
        returns: FFIType.void,
      },
      simsimd_uses_neon: { args: [], returns: FFIType.i32 },
      simsimd_uses_neon_f16: { args: [], returns: FFIType.i32 },
    });
    const cosineDistanceF16 = library.symbols.simsimd_cos_f16 as NativeSimsimd["cosineDistanceF16"];
    const probeA = encodeQueryVectorF16([0.25, -0.5, 0.75, 1], 4);
    const probeB = encodeQueryVectorF16([0.5, -1, 1.5, 2], 4);
    const out = new Float64Array(1);
    cosineDistanceF16(ptr(probeA), ptr(probeB), 4, ptr(out));
    const native = 1 - (out[0] ?? Number.NaN);
    const expected = cosineSimilarityF16Reference(probeA, probeB);
    if (!Number.isFinite(native) || Math.abs(native - expected) > 1e-4) {
      throw new VectorKernelError(`self-check failed: native=${native} reference=${expected}`);
    }
    return {
      libraryPath,
      capabilities: {
        neon: library.symbols.simsimd_uses_neon() === 1,
        neonF16: library.symbols.simsimd_uses_neon_f16() === 1,
      },
      cosineDistanceF16,
    };
  } catch (cause) {
    console.error(JSON.stringify({
      event: "vector_kernel.native_load_failed",
      at: new Date().toISOString(),
      libraryPath,
      diagnostic: cause instanceof Error ? cause.message : String(cause),
    }));
    return undefined;
  }
};
