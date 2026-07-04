import { Context, Effect, Layer } from "effect";

import { LocalStore, type SearchHit } from "./store";

export interface DerivedSearchService {
  readonly lexicalSearch: (request: {
    readonly query: string;
    readonly projectKey?: string;
    readonly role?: string;
    /** Optional allow-list of provider names (e.g. ["codex", "opencode"]). Empty or omitted = all providers. */
    readonly providers?: readonly string[];
    readonly limit?: number;
  }) => Effect.Effect<readonly SearchHit[], unknown>;
}

export class DerivedSearch extends Context.Tag("@quasar/DerivedSearch")<
  DerivedSearch,
  DerivedSearchService
>() {}

/** Lexical search serves straight from the SQLite messages truth table (FTS is
 * trigger-maintained by the store); there is no derived index to build or gate. */
export const DerivedSearchLive = Layer.effect(
  DerivedSearch,
  Effect.gen(function* () {
    const store = yield* LocalStore;
    return DerivedSearch.of({
      lexicalSearch: (request) => store.lexicalSearch(request),
    });
  }),
);
