#!/usr/bin/env bun

import { Command } from "@effect/cli";
import { BunContext, BunRuntime } from "@effect/platform-bun";
import { Effect } from "effect";

import { daemonCommand } from "./commands/daemon";
import { capabilitiesCommand, doctorCommand } from "./commands/discovery";
import { ingestCommand } from "./commands/ingest";
import { projectsCommand, sessionsCommand, toolCallsCommand } from "./commands/read";
import { examplesCommand, schemaCommand } from "./commands/schema";
import { searchCommand } from "./commands/search";
import { searchMaintainCommand } from "./commands/search-maint";
import { scanCommand } from "./commands/scan";
import { sourcesCommand } from "./commands/sources";
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
  "ingest",
  "daemon",
  "search",
  "maintain",
  "projects",
  "sessions",
  "tool-calls",
  "scan",
]);

const userArgs = (args: readonly string[]) => args.slice(2);
const unknownRootCommand = (args: readonly string[]) => {
  const command = userArgs(args).find((arg) => !arg.startsWith("-"));
  return command !== undefined && !publicCommands.has(command)
    ? command
    : undefined;
};
const asError = (error: unknown): Error =>
  error instanceof Error ? error : new Error(String(error));

export const rootCommand = Command.make(CLI_NAME).pipe(
  Command.withDescription("Local-first AI session repository CLI"),
  Command.withSubcommands([
    doctorCommand,
    capabilitiesCommand,
    schemaCommand,
    examplesCommand,
    sourcesCommand,
    ingestCommand,
    scanCommand,
    daemonCommand,
    searchCommand,
    searchMaintainCommand,
    projectsCommand,
    sessionsCommand,
    toolCallsCommand,
  ]),
);

const cli = Command.run(rootCommand, { name: CLI_NAME, version: CLI_VERSION });
const runtimeLayer = BunContext.layer;

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
      setExitCode(1).pipe(
        Effect.zipRight(writeFailureEnvelope(CLI_NAME, asError(error))),
      ),
    ),
    Effect.catchAllCause((cause) =>
      setExitCode(1).pipe(
        Effect.zipRight(writeCauseEnvelope(CLI_NAME, cause as never)),
      ),
    ),
    Effect.provide(runtimeLayer),
  );

BunRuntime.runMain(runCli(Bun.argv) as Effect.Effect<void, never, never>);
