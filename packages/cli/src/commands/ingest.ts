import { Command } from "@effect/cli";
import { Effect } from "effect";

import { executeJsonCommand } from "../output";

export const ingestCommand = Command.make("ingest", {}, () =>
  executeJsonCommand(
    "ingest",
    Effect.succeed({
      mode: "record_stream",
      status: "not_ready",
    }),
  ),
).pipe(Command.withDescription("Stream provider rows into Quasar."));
