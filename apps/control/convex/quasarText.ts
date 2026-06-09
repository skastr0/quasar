export const MAX_SEARCH_TEXT_LENGTH = 64_000;
export const MAX_EMBEDDING_TEXT_BYTES = 16 * 1024;
export const MAX_SUMMARY_LENGTH = 1_000;

const REDACTED = "[redacted]";
const textEncoder = new TextEncoder();
const CONTROL_CHARS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;
const ESCAPED_CONTROL_CHARS = /\\u00(?:0[0-9a-f]|1[0-9a-f]|7f)/gi;
const REPLACEMENT_CHAR = /\ufffd/g;
const SESSION_TRASH_PATHS = [
  ["summary", "diffs"],
  ["summary", "diff"],
  ["summary", "patches"],
  ["summary", "snapshots"],
  ["summary", "cache"],
  ["summary", "state"],
  ["summary", "providerCache"],
  ["summary", "providerState"],
  ["workspace", "diffs"],
  ["workspace", "snapshot"],
  ["workspace", "snapshots"],
  ["workspace", "diff"],
  ["workspace", "diffs"],
  ["workspace", "patch"],
  ["workspace", "patches"],
  ["workspaceDiff"],
  ["workspaceSnapshot"],
  ["checkpoint"],
  ["checkpoints"],
] as const;
const NON_INDEXABLE_KEY =
  /(encrypted[_-]?content|cipher[_-]?text|provider[_-]?(cache|state)|workspaceSnapshot|workspaceDiff)/i;
const SENSITIVE_KEY =
  /(authorization|password|passwd|secret|api[_-]?key|access[_-]?token|refresh[_-]?token|bearer|cookie|credential|private[_-]?key|encrypted[_-]?content|cipher[_-]?text)/i;
const DATA_URI = /^data:[^,]{0,512},/i;
const DATA_URI_INLINE = /data:[^,\s"'<>]{0,512},[A-Za-z0-9+/=_-]{64,}/gi;
const BASE64ISH = /^[A-Za-z0-9+/=\s]+$/;
const SECRET_ENV_ASSIGNMENT =
  /\b([A-Z0-9_]*(?:PASSWORD|PASSWD|SECRET|TOKEN|API_KEY|ACCESS_KEY|PRIVATE_KEY|DATABASE_URL)[A-Z0-9_]*\s*=(?!=)\s*)([^\s"'`]+)/gi;
const CREDENTIAL_URL = /\b([a-z][a-z0-9+.-]*:\/\/[^:\s/@]+:)[^@\s"'`]+(@[^\s"'`]+)/gi;
const PEM_BOUNDARY = "-".repeat(5);
const PEM_PRIVATE_KEY_LABEL = ["PRIVATE", "KEY"].join(" ");
const PEM_PRIVATE_KEY = new RegExp(
  `${PEM_BOUNDARY}BEGIN [A-Z ]*${PEM_PRIVATE_KEY_LABEL}${PEM_BOUNDARY}[\\s\\S]*?${PEM_BOUNDARY}END [A-Z ]*${PEM_PRIVATE_KEY_LABEL}${PEM_BOUNDARY}`,
  "g",
);
const PEM_PRIVATE_KEY_REPLACEMENT = `${PEM_BOUNDARY}BEGIN ${PEM_PRIVATE_KEY_LABEL}${PEM_BOUNDARY}${REDACTED}${PEM_BOUNDARY}END ${PEM_PRIVATE_KEY_LABEL}${PEM_BOUNDARY}`;

const compactString = (value: string) => {
  if (isBinaryishString(value)) {
    return `[binary/base64 omitted bytes=${byteLength(value)} hash=${wideHash(value)}]`;
  }
  const controlCount =
    (value.match(CONTROL_CHARS)?.length ?? 0) +
    (value.match(ESCAPED_CONTROL_CHARS)?.length ?? 0) +
    (value.match(REPLACEMENT_CHAR)?.length ?? 0);
  if (value.length > 200 && controlCount > 20 && controlCount / value.length > 0.02) {
    return "[binary output omitted]";
  }
  return value
    .replace(DATA_URI_INLINE, (match) => `[data uri omitted bytes=${byteLength(match)} hash=${wideHash(match)}]`)
    .replace(CONTROL_CHARS, " ")
    .replace(/\s+/g, " ")
    .trim();
};

export const byteLength = (value: string) => textEncoder.encode(value).length;

const isBinaryishString = (value: string) => {
  if (DATA_URI.test(value)) return true;
  const compact = value.replace(/\s+/g, "");
  if (compact.length <= 4_096 || compact.length % 4 !== 0 || !BASE64ISH.test(compact)) {
    return false;
  }
  const alphaNumeric = (compact.match(/[A-Za-z0-9]/g)?.length ?? 0) / compact.length;
  const symbolRatio = (compact.match(/[+/=]/g)?.length ?? 0) / compact.length;
  const longWordRatio = (compact.match(/[A-Za-z]{80,}/g)?.join("").length ?? 0) / compact.length;
  return alphaNumeric > 0.9 && symbolRatio > 0.01 && longWordRatio > 0.5;
};

export const compactText = (value: unknown) => {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return compactString(value);
  try {
    return JSON.stringify(value).replace(/\s+/g, " ").trim();
  } catch {
    return String(value);
  }
};

export const redactString = (value: string) =>
  value
    .replace(PEM_PRIVATE_KEY, PEM_PRIVATE_KEY_REPLACEMENT)
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/g, "Bearer [redacted]")
    .replace(/AIza[0-9A-Za-z_-]{20,}/g, REDACTED)
    .replace(/sk-[A-Za-z0-9_-]{20,}/g, REDACTED)
    .replace(/gh[pousr]_[A-Za-z0-9_]{20,}/g, REDACTED)
    .replace(/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, REDACTED)
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, REDACTED)
    .replace(CREDENTIAL_URL, `$1${REDACTED}$2`)
    .replace(SECRET_ENV_ASSIGNMENT, `$1${REDACTED}`);

export const redactSensitive = (value: unknown, depth = 0): unknown => {
  if (depth > 8) return "[redacted:depth]";
  if (typeof value === "string") return redactString(value);
  if (value === null || value === undefined) return value;
  if (typeof value !== "object") return value;
  if (Array.isArray(value)) {
    return value.map((item) => redactSensitive(item, depth + 1));
  }
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, item]) => [
      key,
      SENSITIVE_KEY.test(key) ? REDACTED : redactSensitive(item, depth + 1),
    ]),
  );
};

type NativePath = readonly string[];

const pathKey = (path: NativePath) => path.join("\u0000");

const matchesNonIndexablePath = (path: NativePath) =>
  SESSION_TRASH_PATHS.some(
    (candidate) =>
      candidate.length <= path.length &&
      pathKey(path.slice(path.length - candidate.length)) === pathKey(candidate),
  );

export const stripNonIndexable = (
  value: unknown,
  depth = 0,
  path: NativePath = [],
): unknown => {
  if (depth > 8 || value === null || value === undefined) return value;
  if (typeof value !== "object") return value;
  if (Array.isArray(value)) {
    if (matchesNonIndexablePath(path)) return undefined;
    return value
      .map((item, index) => stripNonIndexable(item, depth + 1, [...path, String(index)]))
      .filter((item) => item !== undefined);
  }
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .flatMap(([key, item]) => {
        const childPath = [...path, key];
        if (matchesNonIndexablePath(childPath) || NON_INDEXABLE_KEY.test(key)) return [];
        const stripped = stripNonIndexable(item, depth + 1, childPath);
        return stripped === undefined ? [] : [[key, stripped]];
      }),
  );
};

export const compactSearchText = (value: unknown) =>
  compactText(stripNonIndexable(redactSensitive(value)));

export const safeSummary = (preferred: unknown, fallback: unknown) => {
  const text = compactSearchText(preferred);
  if (text.length > 0 && !NON_INDEXABLE_KEY.test(text)) return text;
  return compactSearchText(fallback);
};

export const truncate = (value: string, limit: number) => {
  if (byteLength(value) <= limit) return value;
  let output = "";
  let used = 0;
  for (const char of value) {
    const charBytes = byteLength(char);
    if (used + charBytes > limit) break;
    output += char;
    used += charBytes;
  }
  return output;
};

export const hashText = (value: string) => {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
};

export const wideHash = (value: string) =>
  [
    hashText(`a:${value}`),
    hashText(`b:${value}`),
    hashText(`c:${value}`),
    hashText(`d:${value}`),
  ].join("");
