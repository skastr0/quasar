import { Args, Command } from "@effect/cli";
import { Effect } from "effect";

import { executeJsonCommand } from "../output";

const schemas = [
  {
    schema_id: "quasar.sources.discover/v1",
    command: "sources discover",
    description: "Discover local provider session sources, read-only.",
    example: { providers: ["codex"], limit: 5 },
  },
];

const schemaIdArg = Args.text({ name: "schemaId" });

const listCommand = Command.make("list", {}, () =>
  executeJsonCommand(
    "schema list",
    Effect.succeed({
      schemas: schemas.map(({ schema_id, command, description }) => ({
        schema_id,
        command,
        description,
      })),
    }),
  ),
);

const showCommand = Command.make("show", { schemaId: schemaIdArg }, ({ schemaId }) =>
  executeJsonCommand(
    "schema show",
    Effect.succeed(schemas.find((schema) => schema.schema_id === schemaId) ?? null),
  ),
);

export const schemaCommand = Command.make("schema").pipe(
  Command.withSubcommands([listCommand, showCommand]),
);

const examples = schemas.map(({ command, example, schema_id }) => ({
  command,
  schema_id,
  examples: [{ name: "default", input: example }],
}));

const exampleIdArg = Args.text({ name: "command" });

const examplesListCommand = Command.make("list", {}, () =>
  executeJsonCommand("examples list", Effect.succeed({ examples })),
);

const examplesShowCommand = Command.make(
  "show",
  { command: exampleIdArg },
  ({ command }) =>
    executeJsonCommand(
      "examples show",
      Effect.succeed(
        examples.find(
          (entry) => entry.command === command || entry.schema_id === command,
        ) ?? null,
      ),
    ),
);

export const examplesCommand = Command.make("examples").pipe(
  Command.withSubcommands([examplesListCommand, examplesShowCommand]),
);
