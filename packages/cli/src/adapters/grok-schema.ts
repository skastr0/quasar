import { Schema } from "effect";

import { decodeOrDrop, isSignal, type DecodeDiagnostic } from "./harness-schema";

/**
 * Grok subagent manifest (`<parent-uuid>/subagents/<child-uuid>/meta.json`),
 * decoded fail-closed (QSR-220). A manifest links a CHILD session to its PARENT
 * session and names the subagent role. Grok writes the child as its own
 * top-level session directory (own UUIDv7 + own `chat_history.jsonl`); the only
 * record of the parent relationship is this manifest, so it is the sole source
 * of session-to-session lineage for grok.
 *
 * Only the three fields that carry lineage are required; everything else in the
 * real file (description, prompt, status, timings, tool_calls, model id, ...) is
 * ignored. A manifest missing any required field is provider garbage: it becomes
 * a NAMED diagnostic (`grok.record.decode_failed`) and is dropped — never
 * silently coerced into a half-built edge (AGENTS.md boundary doctrine).
 */
export const GrokSubagentManifest = Schema.Struct({
  /** Native UUIDv7 of the PARENT session whose dir contains this manifest. */
  parent_session_id: Schema.NonEmptyString,
  /** Native UUIDv7 of the CHILD (subagent) session this manifest describes. */
  child_session_id: Schema.NonEmptyString,
  /** The subagent role, projected onto the child session's `agentName`. */
  subagent_type: Schema.NonEmptyString,
});
export type GrokSubagentManifest = typeof GrokSubagentManifest.Type;

/** Stable diagnostic name for a grok on-disk record that fails to decode. */
export const GROK_DECODE_FAILED = "grok.record.decode_failed";

/**
 * Decode one subagent manifest fail-closed. On success returns the typed
 * manifest; on failure pushes a named `grok.record.decode_failed` diagnostic and
 * returns `undefined` (the dropped record), never throwing.
 */
export const decodeGrokSubagentManifest = (
  record: unknown,
  diagnostics?: DecodeDiagnostic[],
): GrokSubagentManifest | undefined => {
  const decision = decodeOrDrop(GrokSubagentManifest, record, {
    kind: "subagent_of",
    diagnosticName: GROK_DECODE_FAILED,
    ...(diagnostics !== undefined ? { diagnostics } : {}),
  });
  return isSignal(decision) ? decision.value : undefined;
};
