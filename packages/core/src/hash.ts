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
