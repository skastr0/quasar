import { Schema } from "effect";

/**
 * On-disk wire-record schema for the Kimi adapter (QSR-220 fail-closed boundary).
 *
 * Grounded against real ~/.kimi-code/sessions/<wd>/<session>/agents/<id>/wire.jsonl:
 * every line is a JSON object with a string `type` discriminator. `time` is an
 * epoch-ms number on most records but ABSENT on bootstrap records (e.g. the
 * leading `metadata` line). Everything else this adapter reads off a wire record
 * (`message`, `event`, `usage`, `summary`, `origin`) is free-form and validated
 * structurally at use-time, so the boundary schema only declares the
 * load-bearing discriminator + the optional ordering key.
 *
 * Records are decoded through `decodeOrDrop` (diagnostic
 * `kimi.wire.decode_failed`): a line that is not an object, or whose `type` is
 * not a string, becomes a NAMED diagnostic + a dropped record — never a throw
 * that aborts the agent's wire, never a silently coerced half-record. The decode
 * is lenient about excess properties (Effect ignores them) but strict about the
 * one field that decides how a record is mapped.
 */
export const KimiWireRecordSchema = Schema.Struct({
  /** The record discriminator — load-bearing; decides the mapped kind. */
  type: Schema.String,
  /** Epoch-ms ordering key; absent on bootstrap records. */
  time: Schema.optional(Schema.Number),
});

export type KimiWireRecord = typeof KimiWireRecordSchema.Type;
