import { Args, Command } from "@effect/cli";
import { Effect } from "effect";

import { runIngest } from "../ingest/runner";
import { loadOptionalJsonInput } from "../json";
import { executeJsonCommand } from "../output";
import { IngestOptions } from "../protocol";

const inputArg = Args.text({ name: "input" }).pipe(Args.optional);
const toUndefined = <A>(value: { _tag: "Some"; value: A } | { _tag: "None" }) =>
  value._tag === "Some" ? value.value : undefined;

export const ingestCommand = Command.make("ingest", { input: inputArg }, ({ input }) =>
  executeJsonCommand(
    "ingest",
    loadOptionalJsonInput(IngestOptions, toUndefined(input), {}).pipe(
      Effect.flatMap((options) => runIngest(options)),
    ),
  ),
).pipe(Command.withDescription("Stream provider records into Quasar."));
