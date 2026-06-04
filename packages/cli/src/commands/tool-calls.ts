import { Args, Command } from "@effect/cli";
import { Effect, Schema } from "effect";

import { requestJson } from "../api";
import { loadOptionalJsonInput } from "../json";
import { executeJsonCommand } from "../output";
import { ToolCallReadInput } from "../protocol";

const inputArg = Args.text({ name: "input" }).pipe(Args.optional);

const toUndefined = <A>(value: { _tag: "Some"; value: A } | { _tag: "None" }) =>
  value._tag === "Some" ? value.value : undefined;

const listCommand = Command.make("list", { input: inputArg }, ({ input }) =>
  executeJsonCommand(
    "tool-calls list",
    Effect.gen(function* () {
      const body = yield* loadOptionalJsonInput(
        ToolCallReadInput,
        toUndefined(input),
        {},
      );
      return yield* requestJson({
        method: "POST",
        path: "/api/tool-calls",
        body,
        responseSchema: Schema.Unknown,
      });
    }),
  ),
);

const readCommand = Command.make("read", { input: inputArg }, ({ input }) =>
  executeJsonCommand(
    "tool-calls read",
    Effect.gen(function* () {
      const body = yield* loadOptionalJsonInput(
        ToolCallReadInput,
        toUndefined(input),
        {},
      );
      return yield* requestJson({
        method: "POST",
        path: "/api/tool-calls",
        body,
        responseSchema: Schema.Unknown,
      });
    }),
  ),
);

export const toolCallsCommand = Command.make("tool-calls").pipe(
  Command.withSubcommands([listCommand, readCommand]),
);
