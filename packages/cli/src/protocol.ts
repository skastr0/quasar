import { Schema } from "effect";

import { Provider } from "@skastr0/quasar-core";

const NonNegativeInteger = Schema.Number.pipe(
  Schema.filter((value) => Number.isInteger(value) && value >= 0, {
    message: () => "Expected a non-negative integer",
  }),
);

const PositiveInteger = Schema.Number.pipe(
  Schema.filter((value) => Number.isInteger(value) && value > 0, {
    message: () => "Expected a positive integer",
  }),
);

export const DiscoverOptions = Schema.Struct({
  providers: Schema.optional(Schema.Array(Provider)),
  includeExperimental: Schema.optional(Schema.Boolean),
  limit: Schema.optional(PositiveInteger),
  skip: Schema.optional(NonNegativeInteger),
  roots: Schema.optional(Schema.partial(Schema.Record({ key: Provider, value: Schema.String }))),
  logicalRoots: Schema.optional(Schema.partial(Schema.Record({ key: Provider, value: Schema.String }))),
});
export type DiscoverOptions = typeof DiscoverOptions.Type;
