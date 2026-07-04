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
import { closeSync, existsSync, openSync, readFileSync, readSync } from "node:fs";
import { dirname, join } from "node:path";
import { CFunction, dlopen, FFIType, ptr, type Pointer } from "bun:ffi";

import { float16BitsToFloat32, float32ToFloat16Bits } from "./vectorBlob";

// simsimd ABI constants (include/simsimd/simsimd.h, pinned 6.5.5).
const SIMSIMD_METRIC_COS = 99; // simsimd_metric_cos_k = 'c'
const SIMSIMD_DATATYPE_F16 = 1 << 12;
const SIMSIMD_CAP_SERIAL = 1;
const SIMSIMD_CAP_ANY = 0x7fffffff;
const SIMSIMD_CAP_NEON = 1 << 20;
const SIMSIMD_CAP_NEON_F16 = 1 << 21;

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
  /** Resolved f16 cosine kernel (a, b, n, out): writes cosine DISTANCE
   * (1 - similarity) to out. This is the raw per-ISA kernel pointer resolved
   * through simsimd_find_kernel_punned, not the lazy dispatch wrapper. */
  readonly cosineDistanceF16: (a: Pointer, b: Pointer, n: number, out: Pointer) => void;
}

/** OS-attested fp16 SIMD support, used to repair simsimd's runtime probe
 * where `mrs` system-register reads trap inside VMs (observed under the
 * linux/arm64 container on Apple silicon: /proc/cpuinfo advertises
 * fphp+asimdhp but simsimd_capabilities() reports NEON-only, silently
 * dropping to the serial f16 kernel). */
const osAttestsNeonF16 = (): boolean => {
  if (process.arch !== "arm64" || process.platform !== "linux") return false;
  try {
    const cpuinfo = readFileSync("/proc/cpuinfo", "utf8");
    const features = cpuinfo.split("\n").find((line) => line.startsWith("Features"));
    return features !== undefined && features.includes("fphp") && features.includes("asimdhp");
  } catch {
    return false;
  }
};

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

/** ELF e_machine matches the running architecture. Guards against simsimd
 * 6.5.5's mislabeled prebuild: its linux-arm64 folder ships an x86_64 binary
 * (verified against the upstream tarball, 2026-07-04). Non-ELF files (mach-o)
 * are never prebuilds we trust — darwin always builds locally. */
const elfMachineMatchesArch = (path: string): boolean => {
  const header = Buffer.alloc(20);
  const fd = openSync(path, "r");
  try {
    readSync(fd, header, 0, 20, 0);
  } finally {
    closeSync(fd);
  }
  if (header.readUInt32BE(0) !== 0x7f454c46) return false;
  const machine = header.readUInt16LE(18);
  return (process.arch === "arm64" && machine === 0xb7) || (process.arch === "x64" && machine === 0x3e);
};

/** Locate a dlopen-able simsimd shared library for this platform: the npm
 * package's prebuild when its architecture checks out (linux), else the
 * local build produced by scripts/ensure-simsimd-native.mjs. */
export const resolveSimsimdLibraryPath = (): string | undefined => {
  const packageRoot = packageRootFrom(import.meta.dir);
  if (packageRoot === undefined) return undefined;
  const prebuild = join(packageRoot, "prebuilds", `${process.platform}-${process.arch}`, "simsimd.node");
  if (process.platform === "linux" && existsSync(prebuild) && elfMachineMatchesArch(prebuild)) {
    return prebuild;
  }
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
      simsimd_capabilities: { args: [], returns: FFIType.u32 },
      simsimd_find_kernel_punned: {
        args: [FFIType.i32, FFIType.i32, FFIType.u32, FFIType.u32, FFIType.ptr, FFIType.ptr],
        returns: FFIType.void,
      },
    });
    let capabilities = library.symbols.simsimd_capabilities() | SIMSIMD_CAP_SERIAL;
    if ((capabilities & SIMSIMD_CAP_NEON_F16) === 0 && osAttestsNeonF16()) {
      capabilities |= SIMSIMD_CAP_NEON | SIMSIMD_CAP_NEON_F16;
    }
    const kernelOut = new BigUint64Array(1);
    const capabilityOut = new Uint32Array(1);
    library.symbols.simsimd_find_kernel_punned(
      SIMSIMD_METRIC_COS,
      SIMSIMD_DATATYPE_F16,
      capabilities,
      SIMSIMD_CAP_ANY,
      ptr(kernelOut),
      ptr(capabilityOut),
    );
    const kernelPointer = kernelOut[0] ?? 0n;
    if (kernelPointer === 0n) {
      throw new VectorKernelError("simsimd resolved no f16 cosine kernel");
    }
    const cosineDistanceF16 = CFunction({
      ptr: Number(kernelPointer) as Pointer,
      args: [FFIType.ptr, FFIType.ptr, FFIType.u64_fast, FFIType.ptr],
      returns: FFIType.void,
    }) as unknown as NativeSimsimd["cosineDistanceF16"];
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
        neon: (capabilities & SIMSIMD_CAP_NEON) !== 0,
        neonF16: (capabilities & SIMSIMD_CAP_NEON_F16) !== 0,
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
