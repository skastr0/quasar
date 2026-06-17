# LanceDB unblock proof — 2026-06-17

## Summary

Quasar search is running through the launchd-managed local Convex backend and
Convex actions call the in-repo LanceDB worker directly. The old Convex
Searchlight/RAG path is not active.

Semantic search is unavailable on this machine because no Gemini embedding
credential is configured. That is an honest unavailable report: lexical and
fusion search still return substantive LanceDB FTS hits, and semantic returns a
stable empty report instead of crashing or returning placeholder-vector hits.

## Launchd observation

- Service: `com.quasar.convex-local-backend`
- Backend: launchd state `running`, pid `10006`
- Search data dir: `/Users/guilhermecastro/.config/quasar/search.lance`
- Observation start: `2026-06-17T06:08:16-0300`
- Observation end: `2026-06-17T08:37:26-0300`
- Duration: 149 minutes
- `logs/launchd-convex.err.log` start size: `55492` bytes
- `logs/launchd-convex.err.log` end size: `55492` bytes
- Appended `search_cache_cleaner|panicked` count after the start offset: `0`

Commands used:

```sh
launchctl print gui/$(id -u)/com.quasar.convex-local-backend | rg 'state =|pid =|runs =|QUASAR_SEARCH_DATA_DIR'
stat -f %z logs/launchd-convex.err.log
tail -c +55493 logs/launchd-convex.err.log | rg -c 'search_cache_cleaner|panicked'
```

Observed launchd output:

```text
state = running
QUASAR_SEARCH_DATA_DIR => /Users/guilhermecastro/.config/quasar/search.lance
runs = 2
pid = 10006
```

The same launchd-managed backend handled a full source re-ingest during the
observation window: Claude, Codex, OpenCode, Hermes, Grok, and Antigravity were
loaded from source into the rebuilt OLTP plus LanceDB search path.

## Start Script Cleanup

`scripts/start-local-convex.mjs` has no Searchlight-specific chmod watchdog or
cache-cleaner workaround. A search for `search_cache_cleaner`,
`archivePermissionInterval`, `Searchlight`, `RAG`, and `chmod` returned no
matches. The script still keeps the local Convex `TMPDIR` under Quasar state,
which is unrelated to Searchlight and remains useful for local backend temp
isolation.

## Data Directories

- LanceDB: `19G /Users/guilhermecastro/.config/quasar/search.lance`
- Old Convex search storage: `0B /Users/guilhermecastro/.config/quasar/local/default/convex_local_storage/search`

No old RAG vectors were exported or reused. The LanceDB directory was rebuilt by
source ingest. Rows are lexical-only while embeddings are unavailable.

## CLI Search Proof

Command:

```sh
CONVEX_SELF_HOSTED_URL=http://127.0.0.1:3217 bun packages/cli/src/cli.ts search --query 'stop hook blocked termination' --mode text --limit 3
```

Result:

```text
ok=true
diagnostics: textSearched=true semanticStatus=unavailable semanticSearched=false
matches=3
top hit: role=assistant textRank=1 score=20.023210525512695
top text: I have completed the requested adversarial review and analyzed the system state...
```

Command:

```sh
CONVEX_SELF_HOSTED_URL=http://127.0.0.1:3217 bun packages/cli/src/cli.ts search --query 'stop hook blocked termination' --mode semantic --limit 3
```

Result:

```text
ok=true
diagnostics: textSearched=false semanticStatus=unavailable semanticSearched=false
matches=0
```

Command:

```sh
CONVEX_SELF_HOSTED_URL=http://127.0.0.1:3217 bun packages/cli/src/cli.ts search --query 'stop hook blocked termination' --mode fusion --limit 3
```

Result:

```text
ok=true
diagnostics: textSearched=true semanticStatus=unavailable semanticSearched=false
matches=3
top hit: role=assistant textRank=1 score=20.023208618164062
top text: I have completed the requested adversarial review and analyzed the system state...
```

## Verification

`CONVEX_SELF_HOSTED_URL=http://127.0.0.1:3217 bun run verify` passed.

Static verification:

- package typechecks passed
- package tests passed
- Convex tests passed
- Convex lint passed

Live verification:

- reconciliation passed for Claude, Codex, OpenCode, Hermes, Grok, and Antigravity
- read fidelity passed for 12 deterministic samples
- relevance passed with substantive lexical/fusion hits for:
  - `stop hook blocked termination`
  - `terminal`
  - `Done Reading`
- semantic search returned the expected unavailable stable report
