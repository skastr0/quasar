import { Args, Command } from "@effect/cli";
import { Effect, Schema } from "effect";

import { requestJson } from "../api";
import { loadJsonInput, loadOptionalJsonInput } from "../json";
import { executeJsonCommand } from "../output";
import { SessionReadInput } from "../protocol";

const inputArg = Args.text({ name: "input" });

const ListSessionsInput = Schema.Struct({
  projectIdentityKey: Schema.optional(Schema.String),
  machineId: Schema.optional(Schema.String),
  provider: Schema.optional(Schema.String),
  limit: Schema.optional(Schema.Number),
});

const listInputArg = Args.text({ name: "input" }).pipe(Args.optional);

const toUndefined = <A>(value: { _tag: "Some"; value: A } | { _tag: "None" }) =>
  value._tag === "Some" ? value.value : undefined;

const listCommand = Command.make("list", { input: listInputArg }, ({ input }) =>
  executeJsonCommand(
    "sessions list",
    Effect.gen(function* () {
      const body = yield* loadOptionalJsonInput(
        ListSessionsInput,
        toUndefined(input),
        {},
      );
      return yield* requestJson({
        method: "POST",
        path: "/api/sessions",
        body,
        responseSchema: Schema.Unknown,
      });
    }),
  ),
);

const readCommand = Command.make("read", { input: inputArg }, ({ input }) =>
  executeJsonCommand(
    "sessions read",
    Effect.gen(function* () {
      const body = yield* loadJsonInput(SessionReadInput, input);
      return yield* requestJson({
        method: "POST",
        path: "/api/sessions/read",
        body,
        responseSchema: Schema.Unknown,
      });
    }),
  ),
);

export const sessionsCommand = Command.make("sessions").pipe(
  Command.withSubcommands([listCommand, readCommand]),
);
