# Quasar Search

Private in-repo LanceDB client for Quasar search indexing.

The default data directory is `~/.config/quasar/search.lance`. Set
`QUASAR_SEARCH_DATA_DIR` to point the client at another local LanceDB directory.

Convex actions should create one runtime at module scope and reuse it:

```ts
import { Effect } from "effect";
import { makeLanceDbRuntime, LanceDb } from "@skastr0/quasar-search";

const searchRuntime = makeLanceDbRuntime();

export const actionBody = async () =>
  searchRuntime.runPromise(
    Effect.gen(function* () {
      const search = yield* LanceDb;
      return yield* search.readRows({ limit: 1 });
    }),
  );
```
