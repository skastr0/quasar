#!/usr/bin/env bun

import { Command } from "@effect/cli";
import { BunContext, BunRuntime } from "@effect/platform-bun";
import { Effect, Layer } from "effect";

import { AppLayer } from "./api";
import { capabilitiesCommand, doctorCommand } from "./commands/discovery";
import { examplesCommand, schemaCommand } from "./commands/schema";
import { ingestCommand } from "./commands/ingest";
import { projectsCommand } from "./commands/projects";
import { searchCommand } from "./commands/search";
import { sessionsCommand } from "./commands/sessions";
import { sourcesCommand } from "./commands/sources";
import { toolCallsCommand } from "./commands/tool-calls";
import { CLI_NAME, CLI_VERSION } from "./constants";
import { CommandInputError } from "./errors";
import {
  setExitCode,
  writeCauseEnvelope,
  writeFailureEnvelope,
} from "./output";

const publicCommands = new Set([
  "doctor",
  "capabilities",
  "schema",
  "examples",
  "sources",
  "projects",
  "ingest",
  "search",
  "sessions",
  "tool-calls",
]);

const userArgs = (args: readonly string[]) => args.slice(2);
const unknownRootCommand = (args: readonly string[]) => {
  const command = userArgs(args).find((arg) => !arg.startsWith("-"));
  return command !== undefined && !publicCommands.has(command)
    ? command
    : undefined;
};

export const rootCommand = Command.make(CLI_NAME).pipe(
  Command.withDescription("Local-first AI session repository CLI"),
  Command.withSubcommands([
    doctorCommand,
    capabilitiesCommand,
    schemaCommand,
    examplesCommand,
    sourcesCommand,
    projectsCommand,
    ingestCommand,
    searchCommand,
    sessionsCommand,
    toolCallsCommand,
  ]),
);

const cli = Command.run(rootCommand, { name: CLI_NAME, version: CLI_VERSION });
const runtimeLayer = Layer.mergeAll(BunContext.layer, AppLayer);

export const runCli = (args: readonly string[]) =>
  Effect.suspend(() => {
    const unknown = unknownRootCommand(args);
    if (unknown !== undefined) {
      return setExitCode(1).pipe(
        Effect.zipRight(
          writeFailureEnvelope(
            CLI_NAME,
            new CommandInputError({
              field: "command",
              message: `Unknown Quasar command: ${unknown}`,
            }),
          ),
        ),
      );
    }
    return cli(args);
  }).pipe(
    Effect.catchAll((error) =>
      setExitCode(1).pipe(Effect.zipRight(writeFailureEnvelope(CLI_NAME, error))),
    ),
    Effect.catchAllCause((cause) =>
      setExitCode(1).pipe(Effect.zipRight(writeCauseEnvelope(CLI_NAME, cause))),
    ),
    Effect.provide(runtimeLayer),
  );

BunRuntime.runMain(runCli(Bun.argv) as Effect.Effect<void, never, never>);
