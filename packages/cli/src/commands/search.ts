import { Args, Command } from "@effect/cli";
import { Effect, Schema } from "effect";

import { requestJson } from "../api";
import { loadJsonInput } from "../json";
import { executeJsonCommand } from "../output";
import { SearchInput } from "../protocol";

const inputArg = Args.text({ name: "input" });

const makeSearchCommand = (mode: "text" | "semantic" | "fusion") =>
  Command.make(mode, { input: inputArg }, ({ input }) =>
    executeJsonCommand(
      `search ${mode}`,
      Effect.gen(function* () {
        const body = yield* loadJsonInput(SearchInput, input);
        return yield* requestJson({
          method: mode === "text" ? "POST" : "POST",
          path: `/api/search/${mode}`,
          body,
          responseSchema: Schema.Unknown,
        });
      }),
    ),
  );

export const searchCommand = Command.make("search").pipe(
  Command.withSubcommands([
    makeSearchCommand("text"),
    makeSearchCommand("semantic"),
    makeSearchCommand("fusion"),
  ]),
);
