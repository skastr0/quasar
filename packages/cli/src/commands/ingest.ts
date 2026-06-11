import { Args, Command } from "@effect/cli";
import { Effect } from "effect";

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
      Effect.map(() => ({
        status: "not_ready" as const,
        direction: "quasar-sync/v2",
        message:
          "Live ingest is gated until the quasar-sync/v2 contract lands. See docs/architecture/quasar-v2-greenfield-plan-2026-06-10.md.",
      })),
    ),
  ),
).pipe(Command.withDescription("Ingest is gated until the v2 sync contract lands."));
