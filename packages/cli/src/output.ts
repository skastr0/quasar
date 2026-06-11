import * as Cause from "effect/Cause";
import { Effect } from "effect";

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

export interface SuccessEnvelope {
  readonly ok: true;
  readonly command: string;
  readonly data: JsonValue;
}

export interface FailureEnvelope {
  readonly ok: false;
  readonly command: string;
  readonly error: {
    readonly type: string;
    readonly message: string;
    readonly details?: JsonValue;
  };
}

const writeLine = (stream: NodeJS.WriteStream, text: string) =>
  Effect.sync(() => {
    stream.write(`${text}\n`);
  });

export const setExitCode = (exitCode: number) =>
  Effect.sync(() => {
    process.exitCode = exitCode;
  });

const isTaggedError = (
  error: Error,
): error is Error & { _tag: string; [key: string]: unknown } =>
  "_tag" in error &&
  typeof (error as Record<string, unknown>)._tag === "string";

const toJsonValue = (value: unknown, depth = 0): JsonValue => {
  if (value === undefined || value === null) return null;
  if (typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Error) {
    return {
      name: value.name,
      message: value.message,
    };
  }
  if (Array.isArray(value)) {
    return depth > 8 ? "[truncated]" : value.map((item) => toJsonValue(item, depth + 1));
  }
  if (typeof value === "object") {
    if (depth > 8) return "[truncated]";
    const record: Record<string, JsonValue> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      if (item !== undefined) record[key] = toJsonValue(item, depth + 1);
    }
    return record;
  }
  return String(value);
};

const asError = (error: unknown): Error =>
  error instanceof Error ? error : new Error(String(error));

const errorDetails = (error: Error): FailureEnvelope["error"] => {
  if (isTaggedError(error)) return taggedErrorDetails(error);
  return { type: error.name || "Error", message: error.message };
};

const taggedErrorDetails = (
  error: Error & { _tag: string; [key: string]: unknown },
): FailureEnvelope["error"] => {
  switch (error._tag) {
    case "JsonInputError":
      return taggedDetails(error, {
        source: toJsonValue(error.source),
        reason: toJsonValue(error.reason),
      });
    case "CommandInputError":
      return taggedDetails(error, { field: toJsonValue(error.field) });
    default:
      return { type: error._tag, message: error.message };
  }
};

const taggedDetails = (
  error: Error & { _tag: string },
  details: JsonValue,
  message = error.message,
): FailureEnvelope["error"] => ({
  type: error._tag,
  message,
  details,
});

export const renderSuccessEnvelope = (command: string, data: JsonValue) =>
  JSON.stringify({ ok: true, command, data } satisfies SuccessEnvelope, null, 2);

export const renderFailureEnvelope = (
  command: string,
  error: FailureEnvelope["error"],
) =>
  JSON.stringify(
    { ok: false, command, error } satisfies FailureEnvelope,
    null,
    2,
  );

export const writeSuccessEnvelope = (command: string, data: JsonValue) =>
  writeLine(process.stdout, renderSuccessEnvelope(command, data));

export const writeFailureEnvelope = (command: string, error: Error) =>
  writeLine(process.stderr, renderFailureEnvelope(command, errorDetails(error)));

export const writeCauseEnvelope = (command: string, cause: Cause.Cause<never>) =>
  writeLine(
    process.stderr,
    JSON.stringify(
      {
        ok: false,
        command,
        error: { type: "UnexpectedError", message: Cause.pretty(cause) },
      } satisfies FailureEnvelope,
      null,
      2,
    ),
  );

export const executeJsonCommand = <A, E, R>(
  command: string,
  effect: Effect.Effect<A, E, R>,
) =>
  effect.pipe(
    Effect.flatMap((data) => writeSuccessEnvelope(command, toJsonValue(data))),
    Effect.catchAll((error) =>
      setExitCode(1).pipe(
        Effect.zipRight(writeFailureEnvelope(command, asError(error))),
      ),
    ),
  );
