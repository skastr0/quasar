import { FileSystem } from "@effect/platform";
import { Effect, Schema } from "effect";

import { JsonInputError } from "./errors";

export const decodeJsonText = <A, I, R>(
  schema: Schema.Schema<A, I, R>,
  text: string,
  source: string,
) =>
  Schema.decodeUnknown(Schema.parseJson(schema))(text).pipe(
    Effect.mapError(
      (error) =>
        new JsonInputError({
          source,
          reason: "InvalidJson",
          message: error.message,
        }),
    ),
  );

const readStdinText = Effect.tryPromise({
  try: () => new Response(Bun.stdin.stream()).text(),
  catch: (cause) =>
    new JsonInputError({
      source: "stdin",
      reason: "ReadFailed",
      message: cause instanceof Error ? cause.message : "Failed to read stdin",
    }),
});

export const loadJsonInput = <A, I, R>(
  schema: Schema.Schema<A, I, R>,
  input: string,
) =>
  Effect.gen(function* () {
    const trimmed = input.trim();
    if (trimmed.length === 0) {
      return yield* new JsonInputError({
        source: "inline",
        reason: "EmptyInput",
        message: "JSON input is empty",
      });
    }
    if (trimmed === "-" || trimmed === "@-") {
      const stdin = yield* readStdinText;
      return yield* decodeJsonText(schema, stdin, "stdin");
    }
    if (trimmed.startsWith("@")) {
      const path = trimmed.slice(1);
      if (path.length === 0) {
        return yield* new JsonInputError({
          source: input,
          reason: "MissingFilePath",
          message: "@file input is missing a file path",
        });
      }
      const fs = yield* FileSystem.FileSystem;
      const contents = yield* fs.readFileString(path).pipe(
        Effect.mapError(
          (error) =>
            new JsonInputError({
              source: path,
              reason: "ReadFailed",
              message: error.message,
            }),
        ),
      );
      return yield* decodeJsonText(schema, contents, path);
    }
    return yield* decodeJsonText(schema, trimmed, "inline");
  });

export const loadOptionalJsonInput = <A, I, R>(
  schema: Schema.Schema<A, I, R>,
  input: string | undefined,
  fallback: A,
) => (input === undefined ? Effect.succeed(fallback) : loadJsonInput(schema, input));
