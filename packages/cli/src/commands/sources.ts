import { Args, Command } from "@effect/cli";
import { Effect } from "effect";

import { summarizeIngestBatches } from "@skastr0/quasar-core";

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
          const inputText = toUndefined(input);
          const options = yield* loadOptionalJsonInput(
            IngestOptions,
            inputText,
            { includeExperimental: true },
          );
          const effectiveLimit = options.limit ?? 1;
          const summary = yield* Effect.tryPromise({
            try: () =>
              summarizeIngestBatches({
                providers: options.providers,
                includeExperimental: options.includeExperimental ?? true,
                limit: effectiveLimit,
                skip: options.skip,
                roots: options.roots,
                logicalRoots: options.logicalRoots,
              }),
            catch: (error) => (error instanceof Error ? error : new Error(String(error))),
          });
          return {
            ...summary,
            selection: {
              limit: effectiveLimit,
              skip: options.skip ?? 0,
              defaultLimitApplied: options.limit === undefined,
            },
          };
        }),
      ),
    ),
  ]),
);
