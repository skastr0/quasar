# Quasar Search

Private in-repo LanceDB client for Quasar search indexing.

The default data directory is `~/.config/quasar/search.lance`. Set
`QUASAR_SEARCH_DATA_DIR` to point the client at another local LanceDB directory.

The canonical message search table stores one user/assistant turn per row:
`sessionId`, `seq`, `role`, `projectKey`, `text`, `contentHash`, and
`vector`. Message writes enforce the Gemini embedding width, 1536 dimensions.
`ensureMessageTable` creates the table schema and LanceDB FTS/vector indexes.
When Gemini credentials are unavailable, callers may write lexical-only rows
with placeholder vectors and create only the FTS index; their content hashes are
marked so a later embedding-configured ingest replaces them with real vectors.

Long-lived processes should create one runtime at module scope and reuse it:

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
