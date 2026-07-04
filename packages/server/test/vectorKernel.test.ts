import { join } from "node:path";

import { beforeAll, describe, expect, test } from "bun:test";
import { ptr } from "bun:ffi";

import {
  cosineSimilarityF16Reference,
  encodeQueryVectorF16,
  loadNativeSimsimd,
  resolveSimsimdLibraryPath,
  type NativeSimsimd,
} from "../src/vectorKernel";
import { float32ToFloat16Bits } from "../src/vectorBlob";

const repoRoot = join(import.meta.dir, "..", "..", "..");

// Deterministic RNG so property failures are reproducible.
const mulberry32 = (seed: number) => () => {
  seed |= 0;
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

const encodeF16 = (values: readonly number[]): Uint16Array =>
  Uint16Array.from(values, float32ToFloat16Bits);

let native: NativeSimsimd;

const nativeSimilarity = (a: Uint16Array, b: Uint16Array): number => {
  const out = new Float64Array(1);
  native.cosineDistanceF16(ptr(a), ptr(b), a.length, ptr(out));
  return 1 - (out[0] ?? Number.NaN);
};

beforeAll(() => {
  // Self-heals the darwin-local build from the pinned package sources; a
  // no-op wherever the npm prebuild exists (linux-arm64/linux-x64).
  const ensure = Bun.spawnSync(["bun", join(repoRoot, "scripts", "ensure-simsimd-native.mjs")], { cwd: repoRoot });
  if (ensure.exitCode !== 0) {
    throw new Error(`ensure-simsimd-native failed: ${ensure.stderr.toString()}`);
  }
  const loaded = loadNativeSimsimd();
  if (loaded === undefined) {
    throw new Error("native simsimd kernel must load on this platform; run scripts/ensure-simsimd-native.mjs");
  }
  native = loaded;
});

describe("vectorKernel native/reference parity", () => {
  test("resolves a shared library for this platform", () => {
    expect(resolveSimsimdLibraryPath()).toBeDefined();
    expect(native.libraryPath).toBeDefined();
  });

  test("random vectors across scales agree within 1e-5", () => {
    const random = mulberry32(0xc0ffee);
    const scales = [1, 0.001, 100, 6e-5, 30000];
    for (let round = 0; round < 400; round += 1) {
      const dims = [8, 64, 768][round % 3]!;
      const scale = scales[round % scales.length]!;
      const a = encodeF16(Array.from({ length: dims }, () => (random() - 0.5) * scale));
      const b = encodeF16(Array.from({ length: dims }, () => (random() - 0.5) * scale));
      const expected = cosineSimilarityF16Reference(a, b);
      const actual = nativeSimilarity(a, b);
      if (Math.abs(actual - expected) > 1e-5) {
        throw new Error(`parity failure at round ${round}: native=${actual} reference=${expected}`);
      }
    }
  });

  test("sparse and mixed-magnitude vectors agree within 1e-5", () => {
    const random = mulberry32(0xbeef);
    for (let round = 0; round < 200; round += 1) {
      const dims = 768;
      const a = Array.from({ length: dims }, (_, index) => (index % 7 === 0 ? (random() - 0.5) * 2 : 0));
      const b = Array.from({ length: dims }, (_, index) => (index % 3 === 0 ? (random() - 0.5) * 1e-3 : random() - 0.5));
      const ea = encodeF16(a);
      const eb = encodeF16(b);
      expect(Math.abs(nativeSimilarity(ea, eb) - cosineSimilarityF16Reference(ea, eb))).toBeLessThan(1e-5);
    }
  });

  test("zero-vector semantics are pinned: both-zero -> 1, one-zero -> 0", () => {
    const zero = encodeF16(Array(768).fill(0));
    const some = encodeF16(Array.from({ length: 768 }, (_, index) => Math.sin(index + 1)));
    expect(cosineSimilarityF16Reference(zero, zero)).toBe(1);
    expect(cosineSimilarityF16Reference(zero, some)).toBe(0);
    expect(cosineSimilarityF16Reference(some, zero)).toBe(0);
    expect(nativeSimilarity(zero, zero)).toBe(1);
    expect(nativeSimilarity(zero, some)).toBe(0);
    expect(nativeSimilarity(some, zero)).toBe(0);
  });

  test("identical and opposite vectors hit the similarity poles", () => {
    const random = mulberry32(0xfeed);
    const values = Array.from({ length: 768 }, () => random() - 0.5);
    const v = encodeF16(values);
    const negated = encodeF16(values.map((value) => -value));
    expect(nativeSimilarity(v, v)).toBeCloseTo(1, 5);
    expect(nativeSimilarity(v, negated)).toBeCloseTo(-1, 5);
    expect(cosineSimilarityF16Reference(v, v)).toBeCloseTo(1, 5);
    expect(cosineSimilarityF16Reference(v, negated)).toBeCloseTo(-1, 5);
  });

  test("reference rejects length mismatches", () => {
    expect(() => cosineSimilarityF16Reference(new Uint16Array(3), new Uint16Array(4))).toThrow("vector length mismatch");
  });
});

describe("encodeQueryVectorF16 boundary", () => {
  test("encodes a valid query round-trippably", () => {
    const encoded = encodeQueryVectorF16([0.5, -0.25, 1, 2], 4);
    expect([...encoded]).toEqual([0.5, -0.25, 1, 2].map(float32ToFloat16Bits));
  });

  test("rejects dimension mismatches", () => {
    expect(() => encodeQueryVectorF16([1, 2], 3)).toThrow("query vector has dimension 2; expected 3");
  });

  test("rejects non-finite components", () => {
    expect(() => encodeQueryVectorF16([1, Number.NaN, 3], 3)).toThrow("not finite");
    expect(() => encodeQueryVectorF16([1, Number.POSITIVE_INFINITY, 3], 3)).toThrow("not finite");
  });

  test("rejects components that overflow f16", () => {
    expect(() => encodeQueryVectorF16([1, 70000, 3], 3)).toThrow("overflows f16 range");
  });

  test("rejects zero-norm queries, including denormal flush-to-zero", () => {
    expect(() => encodeQueryVectorF16([0, 0, 0], 3)).toThrow("zero norm");
    expect(() => encodeQueryVectorF16([1e-30, -1e-30, 1e-30], 3)).toThrow("zero norm");
  });
});
