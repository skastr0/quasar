import { Args, Command } from "@effect/cli";
import { Effect } from "effect";

import { buildIngestBatch, summarizeBatch } from "@skastr0/quasar-core";

import { loadOptionalJsonInput } from "../json";
import { executeJsonCommand } from "../output";
import { IngestOptions } from "../protocol";

const inputArg = Args.text({ name: "input" }).pipe(Args.optional);
const toUndefined = <A>(value: { _tag: "Some"; value: A } | { _tag: "None" }) =>
  value._tag === "Some" ? value.value : undefined;

export const sourcesCommand = Command.make("sources").pipe(
  Command.withSubcommands([
    Command.make("discover", { input: inputArg }, ({ input }) =>
      executeJsonCommand(
        "sources discover",
        Effect.gen(function* () {
          const options = yield* loadOptionalJsonInput(
            IngestOptions,
            toUndefined(input),
            { includeExperimental: true, limit: 1 },
          );
          const batch = yield* Effect.tryPromise({
            try: () =>
              buildIngestBatch({
                providers: options.providers,
                includeExperimental: options.includeExperimental ?? true,
                limit: options.limit ?? 1,
                skip: options.skip,
                roots: options.roots,
              }),
            catch: (error) => (error instanceof Error ? error : new Error(String(error))),
          });
          return summarizeBatch(batch);
        }),
      ),
    ),
  ]),
);
