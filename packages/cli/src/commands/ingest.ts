import { Args, Command } from "@effect/cli";
import { Effect, Schema } from "effect";

import {
  buildIngestBatch,
  sanitizeIngestBatchForTransport,
  summarizeBatch,
} from "@quasar/core";

import { requestJson } from "../api";
import { loadOptionalJsonInput } from "../json";
import { executeJsonCommand } from "../output";
import { IngestOptions } from "../protocol";

const inputArg = Args.text({ name: "input" }).pipe(Args.optional);

const toUndefined = <A>(value: { _tag: "Some"; value: A } | { _tag: "None" }) =>
  value._tag === "Some" ? value.value : undefined;

const loadOptions = (input: string | undefined) =>
  loadOptionalJsonInput(IngestOptions, input, {});

const buildBatchEffect = (input: string | undefined) =>
  Effect.gen(function* () {
    const options = yield* loadOptions(input);
    return yield* Effect.tryPromise({
      try: () =>
        buildIngestBatch({
          providers: options.providers,
          includeExperimental: options.includeExperimental,
          limit: options.limit,
          roots: options.roots,
        }),
      catch: (error) => (error instanceof Error ? error : new Error(String(error))),
    });
  });

const validateCommand = Command.make("validate", { input: inputArg }, ({ input }) =>
  executeJsonCommand(
    "ingest validate",
    buildBatchEffect(toUndefined(input)).pipe(Effect.map(summarizeBatch)),
  ),
);

const planCommand = Command.make("plan", { input: inputArg }, ({ input }) =>
  executeJsonCommand(
    "ingest plan",
    buildBatchEffect(toUndefined(input)).pipe(
      Effect.map((batch) => ({
        ...summarizeBatch(batch),
        sessions: batch.sessions.map((session) => ({
          id: session.id,
          provider: session.provider,
          nativeSessionId: session.nativeSessionId,
          projectIdentity: session.projectIdentity,
          eventCount: session.events.length,
          sourcePath: session.sourcePath,
        })),
      })),
    ),
  ),
);

const runCommand = Command.make("run", { input: inputArg }, ({ input }) =>
  executeJsonCommand(
    "ingest run",
    Effect.gen(function* () {
      const options = yield* loadOptions(toUndefined(input));
      const batch = sanitizeIngestBatchForTransport(
        yield* buildBatchEffect(toUndefined(input)),
      );
      if (options.dryRun === true) {
        return { dryRun: true, summary: summarizeBatch(batch) };
      }
      return yield* requestJson({
        method: "POST",
        path: "/api/ingest/batches",
        body: batch,
        responseSchema: Schema.Unknown,
      });
    }),
  ),
);

const inspectCommand = Command.make("inspect", {}, () =>
  executeJsonCommand(
    "ingest inspect",
    requestJson({
      method: "GET",
      path: "/api/import-runs",
      responseSchema: Schema.Unknown,
    }),
  ),
);

const waitCommand = Command.make("wait", {}, () =>
  executeJsonCommand(
    "ingest wait",
    Effect.succeed({
      status: "unsupported",
      reason: "Server ingestion is synchronous in v1; inspect import runs instead.",
    }),
  ),
);

const eventsCommand = Command.make("events", {}, () =>
  executeJsonCommand(
    "ingest events",
    Effect.succeed({
      status: "unsupported",
      reason: "Streaming import events are not exposed in v1.",
    }),
  ),
);

export const ingestCommand = Command.make("ingest").pipe(
  Command.withSubcommands([
    validateCommand,
    planCommand,
    runCommand,
    inspectCommand,
    waitCommand,
    eventsCommand,
  ]),
);
