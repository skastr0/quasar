import * as Cause from "effect/Cause";
import { Effect } from "effect";

export interface SuccessEnvelope {
  readonly ok: true;
  readonly command: string;
  readonly data: unknown;
}

export interface FailureEnvelope {
  readonly ok: false;
  readonly command: string;
  readonly error: {
    readonly type: string;
    readonly message: string;
    readonly details?: unknown;
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
  error: unknown,
): error is Error & { _tag: string; [key: string]: unknown } =>
  error instanceof Error &&
  "_tag" in error &&
  typeof (error as Record<string, unknown>)._tag === "string";

export const errorDetails = (error: unknown): FailureEnvelope["error"] => {
  if (isTaggedError(error)) {
    if (error._tag === "ConfigurationError") {
      return {
        type: error._tag,
        message: error.message,
        details: { field: error.field },
      };
    }
    if (error._tag === "MissingApiKeyError") {
      return {
        type: error._tag,
        message: `${String(error.envVar)} is not configured`,
        details: { env_var: error.envVar, hint: error.hint },
      };
    }
    if (error._tag === "JsonInputError") {
      return {
        type: error._tag,
        message: error.message,
        details: { source: error.source, reason: error.reason },
      };
    }
    if (error._tag === "CommandInputError") {
      return {
        type: error._tag,
        message: error.message,
        details: { field: error.field },
      };
    }
    if (error._tag === "ApiRequestError") {
      return {
        type: error._tag,
        message: error.message,
        details: {
          method: error.method,
          path: error.path,
          reason: error.reason,
        },
      };
    }
    if (error._tag === "ApiResponseError") {
      return {
        type: error._tag,
        message: error.message,
        details: {
          method: error.method,
          path: error.path,
          status: error.status,
          body: error.body,
        },
      };
    }
    if (error._tag === "ApiDecodeError") {
      return {
        type: error._tag,
        message: error.message,
        details: { method: error.method, path: error.path },
      };
    }
  }
  if (error instanceof Error) {
    return { type: error.name || "Error", message: error.message };
  }
  return { type: "Error", message: String(error) };
};

export const renderSuccessEnvelope = (command: string, data: unknown) =>
  JSON.stringify({ ok: true, command, data } satisfies SuccessEnvelope, null, 2);

export const renderFailureEnvelope = (command: string, error: unknown) =>
  JSON.stringify(
    { ok: false, command, error: errorDetails(error) } satisfies FailureEnvelope,
    null,
    2,
  );

export const writeSuccessEnvelope = (command: string, data: unknown) =>
  writeLine(process.stdout, renderSuccessEnvelope(command, data));

export const writeFailureEnvelope = (command: string, error: unknown) =>
  writeLine(process.stderr, renderFailureEnvelope(command, error));

export const writeCauseEnvelope = (command: string, cause: Cause.Cause<unknown>) =>
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
    Effect.flatMap((data) => writeSuccessEnvelope(command, data)),
    Effect.catchAll((error) =>
      setExitCode(1).pipe(Effect.zipRight(writeFailureEnvelope(command, error))),
    ),
  );
