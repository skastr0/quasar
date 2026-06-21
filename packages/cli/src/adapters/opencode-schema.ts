import { Schema } from "effect";

import { type DecodeDiagnostic, decodeOrDrop, isSignal } from "./harness-schema";

// ---------------------------------------------------------------------------
// On-disk row schemas (QSR-220 fail-closed boundary)
//
// Grounded against the real ~/.local/share/opencode/opencode.db `.schema`:
//   session: id TEXT PRIMARY KEY, project_id TEXT NOT NULL, directory TEXT
//            NOT NULL, title TEXT NOT NULL, time_created INTEGER NOT NULL,
//            time_updated INTEGER NOT NULL; parent_id TEXT (nullable, the
//            subagent's own parent ses_ id), agent TEXT (nullable, the named
//            subagent role), path TEXT (nullable, newer DBs only).
//   message: id TEXT PRIMARY KEY, time_created INTEGER, data TEXT (JSON blob),
//            plus an adapter-projected raw_bytes (pre-prune byte length).
//
// Both `parent_id` and `agent` are absent on older DB files
// (opencode-local.db predates the `agent` column), so the SELECT projects them
// conditionally and the schema admits them as optional+nullable. Rows are
// decoded through `decodeOrDrop`: a malformed/garbage row becomes a NAMED
// diagnostic (`opencode.row.decode_failed`) + a dropped record — never a throw
// that aborts the whole file, never a silently coerced half-row. SQLite hands
// back numbers for INTEGER and strings for TEXT; nullable/absent columns
// arrive as `null`/missing. Effect ignores excess columns by default, so the
// schema is lenient about extra columns but strict about the load-bearing
// identity/ordering fields.
// ---------------------------------------------------------------------------

/** A SQLite TEXT column that may be absent or NULL. */
const NullableText = Schema.optional(Schema.NullOr(Schema.String));
/** A SQLite numeric (INTEGER/REAL) column that may be absent or NULL. */
const NullableNumeric = Schema.optional(Schema.NullOr(Schema.Number));

export const OpenCodeSessionRowSchema = Schema.Struct({
  // session.id is TEXT PRIMARY KEY — the load-bearing native id.
  id: Schema.String,
  // title/directory are NOT NULL TEXT; the ordering key time_updated is NOT NULL.
  title: Schema.String,
  directory: Schema.String,
  time_created: Schema.Number,
  time_updated: Schema.Number,
  // path is nullable and only present on newer DBs; the SELECT aliases
  // path|directory to this column, so it is always a string in practice but
  // declared nullable for the boundary.
  path: NullableText,
  // parent_id: the subagent's own parent ses_ id (NULL for a root session).
  parent_id: NullableText,
  // agent: the named subagent role (NULL on root sessions and older DBs).
  agent: NullableText,
});

export const OpenCodeMessageRowSchema = Schema.Struct({
  // message.id is TEXT PRIMARY KEY.
  id: Schema.String,
  // time_created is the ordering key.
  time_created: Schema.Number,
  // data is the JSON message envelope (post-prune projection).
  data: Schema.String,
  // raw_bytes is the adapter-projected pre-prune byte length.
  raw_bytes: NullableNumeric,
});

export type OpenCodeSessionRow = typeof OpenCodeSessionRowSchema.Type;
export type OpenCodeMessageRow = typeof OpenCodeMessageRowSchema.Type;

/** Raw reads return UNVALIDATED rows; decoding happens at the boundary. */
export type OpenCodeRawRow = Record<string, unknown>;

const OPENCODE_ROW_DIAGNOSTIC = "opencode.row.decode_failed" as const;

/**
 * Decode the raw session-window rows fail-closed: valid rows pass through,
 * malformed rows become a named diagnostic in `diagnostics` and are dropped
 * from the window.
 */
export const decodeSessionRows = (
  rows: readonly OpenCodeRawRow[],
  diagnostics: DecodeDiagnostic[],
): OpenCodeSessionRow[] =>
  rows.flatMap((row) => {
    const decision = decodeOrDrop(OpenCodeSessionRowSchema, row, {
      kind: "session" as const,
      diagnosticName: OPENCODE_ROW_DIAGNOSTIC,
      diagnostics,
    });
    return isSignal(decision) ? [decision.value] : [];
  });

/** Decode the raw message rows for a session fail-closed; drops are named. */
export const decodeMessageRows = (
  rows: readonly OpenCodeRawRow[],
  diagnostics: DecodeDiagnostic[],
): OpenCodeMessageRow[] =>
  rows.flatMap((row) => {
    const decision = decodeOrDrop(OpenCodeMessageRowSchema, row, {
      kind: "message" as const,
      diagnosticName: OPENCODE_ROW_DIAGNOSTIC,
      diagnostics,
    });
    return isSignal(decision) ? [decision.value] : [];
  });
