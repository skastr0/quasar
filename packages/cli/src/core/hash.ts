export const stableHash = (value: string) => {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
};

export const stableWideHash = (value: string) =>
  [
    stableHash(`a:${value}`),
    stableHash(`b:${value}`),
    stableHash(`c:${value}`),
    stableHash(`d:${value}`),
  ].join("");

export const stableJsonHash = (value: unknown) =>
  stableWideHash(JSON.stringify(value));

export const stableCanonicalJsonHash = (value: unknown) =>
  stableWideHash(JSON.stringify(canonicalJsonValue(value)));

const canonicalJsonValue = (value: unknown): unknown => {
  if (value === undefined || typeof value === "function" || typeof value === "symbol") {
    return undefined;
  }
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) {
    return value.map((item) => {
      const canonical = canonicalJsonValue(item);
      return canonical === undefined ? null : canonical;
    });
  }
  const record = value as Record<string, unknown>;
  const entries = Object.keys(record)
    .sort()
    .flatMap((key) => {
      const canonical = canonicalJsonValue(record[key]);
      return canonical === undefined ? [] : [[key, canonical] as const];
    });
  return Object.fromEntries(entries);
};
