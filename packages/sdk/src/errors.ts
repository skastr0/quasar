import { Schema } from "effect";

/** Configuration resolution failed: no serverUrl could be resolved from env
 * vars, config file, or defaults. */
export class QuasarConfigError extends Schema.TaggedError<QuasarConfigError>()(
  "QuasarConfigError",
  {
    message: Schema.String,
    details: Schema.optional(Schema.Unknown),
  },
) {}

/** Transport failed: fetch threw, timeout, socket reset, or other network error.
 * The SDK's HTTP retry already attempted transient-error backoff; this error
 * represents the final failure after retries exhausted. */
export class QuasarTransportError extends Schema.TaggedError<QuasarTransportError>()(
  "QuasarTransportError",
  {
    message: Schema.String,
    cause: Schema.optional(Schema.Unknown),
  },
) {}

/** Server returned ok:false envelope with a typed error. Carries the error
 * type (BadRequest, NotFound, Unauthorized, SemanticDisabled,
 * EmbeddingUnavailable, ServiceUnavailable) and httpStatus so the consumer
 * can branch (e.g., degrade semantic to lexical on SemanticDisabled). */
export class QuasarServerError extends Schema.TaggedError<QuasarServerError>()(
  "QuasarServerError",
  {
    type: Schema.String,
    message: Schema.String,
    httpStatus: Schema.Number,
    details: Schema.optional(Schema.Unknown),
  },
) {}

/** Envelope or row failed Effect Schema decode. Schema-decode strictness
 * means any server field rename turns a silent mismatch into a loud decode
 * error, which is desirable: contract drift is surfaced immediately. */
export class QuasarDecodeError extends Schema.TaggedError<QuasarDecodeError>()(
  "QuasarDecodeError",
  {
    message: Schema.String,
    cause: Schema.Unknown,
  },
) {}

export type QuasarError =
  | QuasarConfigError
  | QuasarTransportError
  | QuasarServerError
  | QuasarDecodeError;
