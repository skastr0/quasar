import { Schema } from "effect";

export class JsonInputError extends Schema.TaggedError<JsonInputError>()(
  "JsonInputError",
  {
    source: Schema.String,
    reason: Schema.String,
    message: Schema.String,
  },
) {}

export class CommandInputError extends Schema.TaggedError<CommandInputError>()(
  "CommandInputError",
  {
    field: Schema.String,
    message: Schema.String,
  },
) {}

