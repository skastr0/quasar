import {
  Provider,
} from "@skastr0/quasar-protocol";
import { Schema } from "effect";

export {
  AgentAssignment,
  Artifact,
  ContentBlock,
  ContentBlockKind,
  ExecutionContextRecord,
  ExecutionContextScope,
  MachineIdentity,
  NormalizedSession,
  ProjectIdentityConfidence,
  ProjectResolution,
  ProjectSignal,
  Provider,
  RawReference,
  SessionEdge,
  SessionEdgeKind,
  SessionEvent,
  SessionEventKind,
  SessionRole,
  SourceRoot,
  ToolCall,
  UsageRecord,
  decodeNormalizedSession,
  decodeNormalizedSessionSync,
} from "@skastr0/quasar-protocol";

export const AdapterStatus = Schema.Literal(
  "available",
  "no_data_found",
  "unsupported",
  "error",
);
export type AdapterStatus = typeof AdapterStatus.Type;

export const ParserConfidence = Schema.Literal(
  "documented",
  "observed",
  "brittle",
  "capture-file",
);
export type ParserConfidence = typeof ParserConfidence.Type;

/**
 * How much a diagnostic costs the run that produced it.
 *
 * - `info`    — nothing was lost (discovery counts, "root not found").
 * - `warning` — a RECORD was dropped with a named reason and the session it
 *               came from is still complete enough to ingest. The session
 *               SUCCEEDS; the drop is surfaced, never silent.
 * - `error`   — the SESSION could not be produced or written. It is counted
 *               failed and must be retried on the next run.
 *
 * `status` describes the adapter's health for a root; it is not a severity.
 * Conflating the two is what made every record-level Claude drop fail its whole
 * session (and, through the manifest gate, its whole provider walk).
 */
export const DiagnosticSeverity = Schema.Literal("info", "warning", "error");
export type DiagnosticSeverity = typeof DiagnosticSeverity.Type;

export const AdapterDiagnostic = Schema.Struct({
  adapterId: Schema.String,
  provider: Provider,
  status: AdapterStatus,
  /**
   * Decided by the emitting adapter, which is the only layer that knows whether
   * a drop cost a record or the whole session. Absent means "derive it from
   * `status`" (see `diagnosticSeverity`) — the pre-severity behaviour, kept as a
   * total default so a diagnostic can never arrive severity-less.
   */
  severity: Schema.optional(DiagnosticSeverity),
  parserConfidence: Schema.optional(ParserConfidence),
  rootPath: Schema.optional(Schema.String),
  message: Schema.String,
  details: Schema.optional(Schema.Unknown),
});
export type AdapterDiagnostic = typeof AdapterDiagnostic.Type;

/**
 * Total severity for any diagnostic. An adapter that states its severity is
 * believed; one that does not falls back to the `status` reading the ingest
 * engine used before severity existed (`error` fails the session, everything
 * else is informational).
 */
export const diagnosticSeverity = (diagnostic: {
  readonly status: AdapterStatus;
  readonly severity?: DiagnosticSeverity;
}): DiagnosticSeverity =>
  diagnostic.severity ?? (diagnostic.status === "error" ? "error" : "info");

/**
 * Presentation cap for diagnostic and failure MESSAGES.
 *
 * This is NOT a data-admission budget (AGENTS.md principle 1) — no session
 * content is rejected, clamped, or measured against it. It bounds only the
 * human/JSON-facing string a failure carries. Effect's `TreeFormatter` renders
 * the offending value inline ("Expected string, actual {...}"), so an
 * unconstrained message embeds an entire serialized session in every ingest
 * report and every daemon log line.
 */
export const DIAGNOSTIC_MESSAGE_MAX_BYTES = 4_096;

/** Explicit marker so a truncated message can never be mistaken for the whole one. */
export const DIAGNOSTIC_TRUNCATION_MARKER = "…[truncated]";

const utf8Encoder = new TextEncoder();
const utf8Decoder = new TextDecoder();

/**
 * Cut a diagnostic message to `maxBytes` UTF-8 bytes on a code-point boundary,
 * appending `DIAGNOSTIC_TRUNCATION_MARKER` plus the original length.
 *
 * Only the first `maxBytes` CHARACTERS can fit in `maxBytes` UTF-8 bytes, so the
 * encode is bounded even when the input is a hundred-megabyte provider payload.
 */
export const truncateDiagnosticMessage = (
  message: string,
  maxBytes: number = DIAGNOSTIC_MESSAGE_MAX_BYTES,
): string => {
  if (message.length <= maxBytes) {
    const encoded = utf8Encoder.encode(message);
    if (encoded.length <= maxBytes) return message;
    return `${cutOnBoundary(encoded, maxBytes)}${DIAGNOSTIC_TRUNCATION_MARKER} original ${message.length} chars`;
  }
  const encoded = utf8Encoder.encode(message.slice(0, maxBytes));
  return `${cutOnBoundary(encoded, maxBytes)}${DIAGNOSTIC_TRUNCATION_MARKER} original ${message.length} chars`;
};

const cutOnBoundary = (encoded: Uint8Array, maxBytes: number): string => {
  let cut = Math.min(maxBytes, encoded.length);
  // Back off out of a multi-byte sequence so the tail never decodes to U+FFFD.
  while (cut > 0 && (encoded[cut] ?? 0) >= 0x80 && (encoded[cut] ?? 0) < 0xc0) cut -= 1;
  return utf8Decoder.decode(encoded.subarray(0, cut));
};
