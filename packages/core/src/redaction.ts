import type { IngestBatch } from "./schemas";

const REDACTED = "[redacted]";
const SENSITIVE_KEY =
  /(authorization|password|passwd|secret|api[_-]?key|access[_-]?token|refresh[_-]?token|bearer|cookie|credential|private[_-]?key)/i;

const redactString = (value: string) =>
  value
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/g, "Bearer [redacted]")
    .replace(/AIza[0-9A-Za-z_-]{20,}/g, REDACTED)
    .replace(/sk-[A-Za-z0-9_-]{20,}/g, REDACTED);

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
    rawMetadata: redactSensitive(session.rawMetadata),
    events: session.events.map((event) => ({
      ...event,
      content: redactSensitive(event.content),
      raw: undefined,
    })),
    toolCalls: session.toolCalls.map((toolCall) => ({
      ...toolCall,
      input: redactSensitive(toolCall.input),
      output: redactSensitive(toolCall.output),
      raw: undefined,
    })),
  })),
});
