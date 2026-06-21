import { Schema } from "effect";

/**
 * Fail-closed Effect Schema for the codex `session_meta` record — the first
 * JSON record of every rollout-*.jsonl file (QSR-220).
 *
 * Grounded against the real on-disk shape (~/.codex/sessions/.../rollout-*.jsonl
 * line 1): `{ type: "session_meta", payload: { id, timestamp, cwd, originator,
 * cli_version, source, ... } }`. The load-bearing fields are `type` (must be the
 * literal `session_meta`) and `payload.id` (the bare UUIDv7 = the codex native
 * session id). Everything else this adapter reads is optional/nullable and the
 * decode is lenient about excess properties (Effect ignores them by default), so
 * a real-world record carrying many more keys still decodes.
 *
 * Subagent lineage lives at
 * `payload.source.subagent.thread_spawn.parent_thread_id` (the parent native id)
 * with the agent identity at `payload.source.subagent.agent_nickname` (human
 * label) / `agent_role` (fallback). These are present ONLY on subagent rollouts;
 * a main-session rollout carries no `source.subagent`, which the schema admits
 * by leaving the whole branch optional.
 *
 * A record failing this schema becomes the NAMED diagnostic
 * `codex.session_meta.decode_failed` + a dropped record via `decodeOrDrop`
 * (the boundary doctrine: never throw, never silently coerce).
 */

/** The `thread_spawn` block on a subagent rollout carrying the parent native id. */
const CodexThreadSpawnSchema = Schema.Struct({
  // The parent rollout's native id (its session_meta.payload.id). Present on
  // subagent rollouts; this is the SESSION-to-SESSION lineage signal.
  parent_thread_id: Schema.optional(Schema.NullOr(Schema.String)),
});

/** The `subagent` block: agent identity plus the thread_spawn lineage pointer. */
const CodexSubagentSchema = Schema.Struct({
  // Human-readable nickname for the spawned agent; the preferred agentName.
  agent_nickname: Schema.optional(Schema.NullOr(Schema.String)),
  // Structural role; the agentName fallback when no nickname is present.
  agent_role: Schema.optional(Schema.NullOr(Schema.String)),
  thread_spawn: Schema.optional(Schema.NullOr(CodexThreadSpawnSchema)),
});

/** The `source` block on the session_meta payload (cli/subagent provenance). */
const CodexSourceSchema = Schema.Struct({
  subagent: Schema.optional(Schema.NullOr(CodexSubagentSchema)),
});

const CodexSessionMetaPayloadSchema = Schema.Struct({
  // payload.id is the bare UUIDv7 — the load-bearing native session id.
  id: Schema.String,
  timestamp: Schema.optional(Schema.NullOr(Schema.String)),
  cwd: Schema.optional(Schema.NullOr(Schema.String)),
  working_dir: Schema.optional(Schema.NullOr(Schema.String)),
  originator: Schema.optional(Schema.NullOr(Schema.String)),
  cli_version: Schema.optional(Schema.NullOr(Schema.String)),
  source: Schema.optional(Schema.NullOr(CodexSourceSchema)),
});

export const CodexSessionMetaSchema = Schema.Struct({
  // The record discriminator — must be the literal session_meta.
  type: Schema.Literal("session_meta"),
  timestamp: Schema.optional(Schema.NullOr(Schema.String)),
  payload: CodexSessionMetaPayloadSchema,
});

export type CodexSessionMeta = typeof CodexSessionMetaSchema.Type;

/** Stable diagnostic name for a session_meta that fails the schema. */
export const CODEX_SESSION_META_DECODE_FAILED = "codex.session_meta.decode_failed";
