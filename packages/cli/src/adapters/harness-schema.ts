import { Either, ParseResult, Schema } from "effect";

/**
 * Shared fail-closed decode + signal/drop base for per-harness on-disk record
 * schemas (QSR-220 foundation).
 *
 * Per-harness classifiers decode an unknown on-disk record through an Effect
 * Schema and must declare, for every record, whether it is SIGNAL (kept, with a
 * mapped kind) or a DROP (discarded, with a NAMED reason). The boundary doctrine
 * (AGENTS.md): provider garbage is rejected with a named diagnostic, never
 * silently coerced and never thrown in a way that aborts the whole file.
 *
 * This module is the reusable base only. Nothing harness-specific is wired here.
 */

/**
 * A classifier verdict for a single on-disk record. Either it is signal — the
 * decoded value plus the harness-mapped kind it represents — or it is a drop
 * carrying a named reason so the diagnostic is attributable. Making this an
 * explicit union forces per-harness classifiers to be declarative rather than
 * silently returning `undefined` for "not interesting".
 */
export type SignalDecision<A, K extends string = string> =
  | { readonly _tag: "signal"; readonly kind: K; readonly value: A }
  | { readonly _tag: "drop"; readonly reason: string };

/** Construct a SIGNAL decision: this record is kept under `kind` with `value`. */
export const signal = <A, K extends string>(kind: K, value: A): SignalDecision<A, K> => ({
  _tag: "signal",
  kind,
  value,
});

/** Construct a DROP decision: this record is discarded with a NAMED `reason`. */
export const drop = <A = never, K extends string = never>(
  reason: string,
): SignalDecision<A, K> => ({ _tag: "drop", reason });

/** Type guard narrowing a decision to the signal arm. */
export const isSignal = <A, K extends string>(
  decision: SignalDecision<A, K>,
): decision is { readonly _tag: "signal"; readonly kind: K; readonly value: A } =>
  decision._tag === "signal";

/** A named diagnostic produced when an on-disk record fails to decode. */
export interface DecodeDiagnostic {
  /** Stable diagnostic name, e.g. `"hermes.session.decode_failed"`. */
  readonly name: string;
  /** Human-readable formatted parse failure (TreeFormatter output). */
  readonly message: string;
}

/**
 * Decode an unknown on-disk record through an Effect Schema, FAIL-CLOSED: on
 * success yields a `signal` carrying the decoded value under `kind`; on failure
 * yields a `drop` carrying a named diagnostic via `onFailure`. It never throws
 * (the whole file keeps importing) and never silently coerces (a malformed
 * record becomes a named, attributable drop — not a half-built record).
 *
 * `diagnostics` accumulates every failure's named diagnostic so the caller can
 * surface them at the ingest boundary.
 */
export const decodeOrDrop = <A, I, K extends string>(
  schema: Schema.Schema<A, I>,
  record: unknown,
  options: {
    /** The harness-mapped kind to stamp on a successful decode. */
    readonly kind: K;
    /** Stable diagnostic name for a decode failure. */
    readonly diagnosticName: string;
    /** Sink that collects named diagnostics for failed records. */
    readonly diagnostics?: DecodeDiagnostic[];
  },
): SignalDecision<A, K> => {
  const decoded = Schema.decodeUnknownEither(schema)(record, { errors: "all" });
  if (Either.isRight(decoded)) {
    return signal(options.kind, decoded.right);
  }
  const message = ParseResult.TreeFormatter.formatErrorSync(decoded.left);
  options.diagnostics?.push({ name: options.diagnosticName, message });
  return drop(`${options.diagnosticName}: ${message}`);
};
