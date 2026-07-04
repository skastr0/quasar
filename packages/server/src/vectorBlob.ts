export const VECTOR_BLOB_ENCODING = "f16le" as const;

export class VectorBlobError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VectorBlobError";
  }
}

const float32 = new Float32Array(1);
const uint32 = new Uint32Array(float32.buffer);

export const float32ToFloat16Bits = (value: number): number => {
  float32[0] = value;
  const bits = uint32[0] ?? 0;
  const sign = (bits >>> 16) & 0x8000;
  const exponent = (bits >>> 23) & 0xff;
  const mantissa = bits & 0x7fffff;

  if (exponent === 0xff) {
    return sign | (mantissa === 0 ? 0x7c00 : 0x7e00);
  }

  const halfExponent = exponent - 127 + 15;
  if (halfExponent >= 0x1f) {
    return sign | 0x7c00;
  }
  if (halfExponent <= 0) {
    if (halfExponent < -10) return sign;
    const shifted = (mantissa | 0x800000) >> (1 - halfExponent);
    return sign | ((shifted + 0x1000) >> 13);
  }

  let roundedMantissa = mantissa + 0x1000;
  let roundedExponent = halfExponent;
  if ((roundedMantissa & 0x800000) !== 0) {
    roundedMantissa = 0;
    roundedExponent += 1;
  }
  if (roundedExponent >= 0x1f) {
    return sign | 0x7c00;
  }
  return sign | (roundedExponent << 10) | (roundedMantissa >> 13);
};

export const float16BitsToFloat32 = (bits: number): number => {
  const sign = (bits & 0x8000) === 0 ? 1 : -1;
  const exponent = (bits >>> 10) & 0x1f;
  const mantissa = bits & 0x03ff;

  if (exponent === 0) {
    return mantissa === 0 ? sign * 0 : sign * 2 ** -14 * (mantissa / 1024);
  }
  if (exponent === 0x1f) {
    return mantissa === 0 ? sign * Infinity : NaN;
  }
  return sign * 2 ** (exponent - 15) * (1 + mantissa / 1024);
};

export const encodeFloat16Vector = (vector: readonly number[]): Uint8Array => {
  const bytes = new Uint8Array(vector.length * 2);
  const view = new DataView(bytes.buffer);
  for (let index = 0; index < vector.length; index += 1) {
    const value = vector[index] ?? 0;
    if (!Number.isFinite(value)) {
      throw new VectorBlobError(`cannot encode non-finite vector value at index ${index}`);
    }
    view.setUint16(index * 2, float32ToFloat16Bits(value), true);
  }
  return bytes;
};

export const decodeFloat16Vector = (blob: Uint8Array, dimensions?: number): readonly number[] => {
  if (blob.byteLength % 2 !== 0) {
    throw new VectorBlobError(`invalid f16 vector blob byte length ${blob.byteLength}`);
  }
  const length = blob.byteLength / 2;
  if (dimensions !== undefined && dimensions !== length) {
    throw new VectorBlobError(`f16 vector blob has dimension ${length}; expected ${dimensions}`);
  }
  const copy = new Uint8Array(blob.byteLength);
  copy.set(blob);
  const view = new DataView(copy.buffer);
  const vector: number[] = [];
  for (let index = 0; index < length; index += 1) {
    vector.push(float16BitsToFloat32(view.getUint16(index * 2, true)));
  }
  return vector;
};
