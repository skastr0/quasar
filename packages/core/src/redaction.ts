import type { IngestBatch } from "./schemas";

const REDACTED = "[redacted]";
const SENSITIVE_KEY =
  /(authorization|password|passwd|secret|api[_-]?key|access[_-]?token|refresh[_-]?token|bearer|cookie|credential|private[_-]?key|encrypted[_-]?content|cipher[_-]?text)/i;
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

const redactString = (value: string) =>
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

export const sanitizeIngestBatchForTransport = (batch: IngestBatch): IngestBatch => ({
  ...batch,
  machine: redactSensitive(batch.machine) as IngestBatch["machine"],
  sourceRoots: redactSensitive(batch.sourceRoots) as IngestBatch["sourceRoots"],
  diagnostics: redactSensitive(batch.diagnostics) as IngestBatch["diagnostics"],
  sessions: batch.sessions.map((session) => ({
    ...session,
    events: session.events.map((event) => ({
      ...event,
      contentText:
        typeof event.contentText === "string"
          ? (redactSensitive(event.contentText) as string)
          : event.contentText,
      contentBlocks: redactSensitive(event.contentBlocks) as typeof event.contentBlocks,
    })),
    toolCalls: session.toolCalls.map((toolCall) => ({
      ...toolCall,
      input: redactSensitive(toolCall.input),
      output: redactSensitive(toolCall.output),
    })),
    sessionEdges: session.sessionEdges.map((edge) => ({
      ...edge,
      rawReference: redactSensitive(edge.rawReference),
      metadata: redactSensitive(edge.metadata),
    })),
    usageRecords: session.usageRecords,
    artifacts: session.artifacts.map((artifact) => ({
      ...artifact,
      metadata: redactSensitive(artifact.metadata),
    })),
  })),
});
