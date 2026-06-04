import { Args, Command } from "@effect/cli";
import { Effect } from "effect";

import { executeJsonCommand } from "../output";

const schemas = [
  {
    schema_id: "quasar.ingest.options/v1",
    command: "ingest validate|plan|run",
    description: "Controls adapter selection, limits, roots, and dry-run behavior.",
    example: {
      providers: ["codex"],
      limit: 5,
      roots: { codex: "/Users/me/.codex" },
    },
  },
  {
    schema_id: "quasar.search.request/v1",
    command: "search text|semantic|fusion",
    description: "Search query and optional filters.",
    example: { query: "tool call failed", provider: "codex", limit: 10 },
  },
  {
    schema_id: "quasar.projects.alias/v1",
    command: "projects alias",
    description: "Merge one observed project identity into another canonical identity.",
    example: {
      sourceProjectIdentityKey: "path:machine-a:abc",
      targetProjectIdentityKey: "git:github.com/skastr0/quasar",
      reason: "Same repository on another machine",
    },
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
