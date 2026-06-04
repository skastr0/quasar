import { Args, Command } from "@effect/cli";
import { Effect, Schema } from "effect";

import { requestJson } from "../api";
import { loadJsonInput } from "../json";
import { executeJsonCommand } from "../output";
import { ProjectAliasInput } from "../protocol";

const inputArg = Args.text({ name: "input" });

const listCommand = Command.make("list", {}, () =>
  executeJsonCommand(
    "projects list",
    requestJson({
      method: "GET",
      path: "/api/projects",
      responseSchema: Schema.Unknown,
    }),
  ),
);

const aliasCommand = Command.make("alias", { input: inputArg }, ({ input }) =>
  executeJsonCommand(
    "projects alias",
    Effect.gen(function* () {
      const body = yield* loadJsonInput(ProjectAliasInput, input);
      return yield* requestJson({
        method: "POST",
        path: "/api/projects/alias",
        body,
        responseSchema: Schema.Unknown,
      });
    }),
  ),
);

export const projectsCommand = Command.make("projects").pipe(
  Command.withSubcommands([listCommand, aliasCommand]),
);
