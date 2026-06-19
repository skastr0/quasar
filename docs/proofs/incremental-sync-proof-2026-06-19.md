# Incremental sync proof — 2026-06-19

## Scope

Proof for the local-server incremental sync path after switching scheduled ingest to:

- one-minute launchd cadence
- uncapped changed-session ingest by default
- adapter `shouldParseSession` pre-parse fingerprint skips
- server-owned embedding/index workers
- summary-only scheduled ingest output

## Code proof

- `packages/local-server/src/ingest.ts` passes `shouldParseSession` to provider streams unless `--force` is set.
- unchanged session probes are counted as `skipped` before adapter parse/yield work.
- `packages/local-server/src/embeddings.ts` acknowledges stale embed jobs whose `(sessionId, seq, contentHash)` no longer exists in SQLite truth; these are superseded jobs, not provider failures.
- `scripts/local-server-ops.mjs syncTick` runs `ingest --provider all --summary` without a default `--limit`.
- `scripts/install-local-server-sync.mjs` installs launchd with `StartInterval=60` unless overridden.

## Automated validation

```bash
bun test packages/local-server/test/ingest.test.ts packages/local-server/test/embeddings.test.ts packages/local-server/test/ops-config.test.ts
```

Result: 32 pass, 0 fail.

```bash
bun run --cwd packages/local-server test
```

Result: 62 pass, 0 fail.

```bash
bun run typecheck
```

Result: pass across `packages/core`, `packages/search`, `packages/local-server`, and `packages/cli`.

```bash
pulsar score --diff HEAD~1..HEAD --changed-only --agent-view .
```

Result: Pulsar routed one changed-scope warning for the already-hot `packages/local-server/src/embeddings.ts` file; no new functional failure was reported.

Full root `bun run test` caveat: `packages/search/test/lancedb.test.ts` currently expects a reported `vector_idx`, while LanceDB reports only `text_idx` in three search-package tests. That failure is outside the incremental-sync slice and does not affect local-server ingest tests.

## Live Mac mini proof

Docker service was rebuilt and recreated:

```bash
bun run local-server:deploy
```

Health/status after deploy:

```json
{
  "projects": 100,
  "sessions": 3725,
  "messages": 135971,
  "toolCalls": 136232,
  "queue": { "pending": 0, "leased": 0, "failed": 0 },
  "embeddingProvider": "synthetic",
  "embeddingModel": "hf:nomic-ai/nomic-embed-text-v1.5",
  "workers": ["embeddings", "index-repair"]
}
```

Manual uncapped sync tick:

```bash
/usr/bin/time -l bun run local-server:sync-tick
```

Observed result:

- wall time: 5.15s for the first run after deploy
- one changed/new session was ingested
- counts moved to `sessions=3726`, `messages=135977`, `toolCalls=136275`
- queued downstream work: 6 `embed-message`, 1 `index-session`
- failed queue jobs: 0

After server workers drained:

```json
{
  "sessions": 3726,
  "messages": 135977,
  "toolCalls": 136275,
  "queue": { "pending": 0, "leased": 0, "failed": 0 },
  "embeddingCacheRows": 62777
}
```

Second uncapped summary sync tick after all sources were unchanged:

```bash
/usr/bin/time -l bun run local-server:sync-tick
```

Observed result:

- wall time: 4.42s
- all discovered sessions skipped by fingerprint
- `sessionsWritten=0`
- `jobsEnqueued=0`
- output was provider summaries only, not per-session ledgers
- queue remained `pending=0`, `leased=0`, `failed=0`

Launchd was reinstalled:

```bash
bun run local-server:sync-uninstall
bun run local-server:sync-install
bun run local-server:sync-status
```

Observed result:

- LaunchAgent: `com.quasar.local-server-sync`
- installed: true
- loaded: true
- run interval: 60 seconds
- last exit code after run: 0

## Verdict

QSR-117 behavior is live on the Mac mini: frequent uncapped polling is now bounded by cheap source fingerprints and server-owned worker backpressure, not by an arbitrary CLI session limit. Mutable sessions are handled by whole-session replacement when fingerprints change, while unchanged sessions skip before expensive parse work.
