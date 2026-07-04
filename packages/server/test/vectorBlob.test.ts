import { describe, expect, test } from "bun:test";

import {
  decodeFloat16Vector,
  encodeFloat16Vector,
  float16BitsToFloat32,
  float32ToFloat16Bits,
} from "../src/vectorBlob";

describe("vectorBlob", () => {
  test("encodes vectors as little-endian f16 blobs", () => {
    const encoded = encodeFloat16Vector([1, -2, 0.5]);

    expect([...encoded]).toEqual([0, 60, 0, 192, 0, 56]);
    expect(decodeFloat16Vector(encoded, 3)).toEqual([1, -2, 0.5]);
  });

  test("rounds float32 values to f16 precision", () => {
    const decoded = decodeFloat16Vector(encodeFloat16Vector([0.33325, -0.125, 12.75]));

    expect(decoded[0]).toBeCloseTo(0.33325, 3);
    expect(decoded[1]).toBe(-0.125);
    expect(decoded[2]).toBe(12.75);
  });

  test("carries mantissa rounding across exponent boundaries", () => {
    expect(float16BitsToFloat32(float32ToFloat16Bits(1.9999))).toBe(2);
    expect(float16BitsToFloat32(float32ToFloat16Bits(3.9999))).toBe(4);
    expect(float32ToFloat16Bits(65504)).toBe(0x7bff);
    expect(float32ToFloat16Bits(65520)).toBe(0x7c00);
  });

  test("rejects non-finite values and dimension mismatches", () => {
    expect(() => encodeFloat16Vector([Number.NaN])).toThrow("cannot encode non-finite vector value at index 0");
    expect(() => decodeFloat16Vector(new Uint8Array([0, 60]), 2)).toThrow("f16 vector blob has dimension 1; expected 2");
  });

  test("converts scalar f16 boundary values", () => {
    expect(float32ToFloat16Bits(Infinity)).toBe(0x7c00);
    expect(float16BitsToFloat32(0x7c00)).toBe(Infinity);
    expect(float16BitsToFloat32(0xfc00)).toBe(-Infinity);
  });
});
