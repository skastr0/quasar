# Quasar local-server runbook

This is the operational path for Quasar on the Mac mini.

- Docker supervises the Effect local server.
- SQLite in `/data/quasar/quasar.sqlite` is OLTP truth.
- LanceDB in `/data/quasar/search.lance` is derived search state.
- Access is by direct Tailscale IP first, e.g. `http://100.96.152.41:6180`.
- `platform/local-server/.env` is local-only and must not be committed.

## One-time setup

```bash
cp platform/local-server/.env.example platform/local-server/.env
chmod 600 platform/local-server/.env
```

Set at least:

- `QUASAR_PUBLISH_HOST=0.0.0.0` unless Docker can bind the Tailscale IP directly.
- `QUASAR_LOCAL_PORT=6180`.
- `QUASAR_*_ROOT` paths for each local history source.
- `QUASAR_EMBEDDING_PROVIDER=synthetic` and Synthetic/Nomic profile values for bulk text embeddings.
- `SYNTHETIC_API_KEY` in the environment or the invoking shell. `scripts/local-server-ops.mjs deploy` will also read it from the Mac mini interactive zsh environment when it is not already exported.

Keep `QUASAR_HOME=/data/quasar` pinned in compose. That preserves Quasar's machine identity and idempotency across container rebuilds.

## Daily commands

Use package scripts from the repo root:

```bash
bun run local-server:deploy      # build/recreate service after code/env changes
bun run local-server:ps          # compose service state
bun run local-server:logs        # follow logs
bun run local-server:health      # lightweight health check
bun run local-server:status      # SQLite/queue/cache status
bun run local-server:lance       # direct LanceDB table/index inventory
bun run local-server:ingest      # run full provider ingest inside the container
bun run local-server:sync-tick   # cheap incremental tick for cron/launchd
bun run local-server:maintain    # LanceDB indexes/optimize inside container
bun run local-server:backup      # write ./quasar-data-backup.tgz
```

Raw helper form:

```bash
bun scripts/local-server-ops.mjs status --lance
bun scripts/local-server-ops.mjs lance
bun scripts/local-server-ops.mjs ingest --provider claude --limit 50
bun scripts/local-server-ops.mjs exec -- sh -lc 'du -sh /data/quasar/*'
```

## Deploy / update flow

1. Pull or checkout the desired code.
2. Run validation when code changed:

   ```bash
   bun run typecheck
   bun run --cwd packages/local-server test
   ```

3. Rebuild/recreate Docker:

   ```bash
   bun run local-server:deploy
   ```

4. Verify:

   ```bash
   bun run local-server:ps
   bun run local-server:health
   bun run local-server:status
   bun run local-server:lance
   ```

5. From another Tailnet client, verify direct Tailscale IP access:

   ```bash
   curl -fsS http://100.96.152.41:6180/health
   curl -fsS http://100.96.152.41:6180/status
   ```

Do not make MagicDNS the proof boundary. It can work, but the known-good operator URL is the Mac mini Tailscale IP.

## Incremental sync story

Keep this simple:

1. Docker keeps the server and enabled background workers alive.
2. A host scheduler periodically runs one cheap sync tick:

   ```bash
   cd /Users/guilhermecastro/Projects/quasar
   bun run local-server:sync-tick
   ```

3. The sync tick runs inside the container against the mounted read-only history roots:
   - `ingest --provider all`
   - `freshness --limit ${QUASAR_SYNC_FRESHNESS_LIMIT:-500}`
   - `repair-index --limit ${QUASAR_SYNC_REPAIR_LIMIT:-500}`
   - `stats` for a compact receipt

4. Embedding is not a cron shell loop. The server-owned embedding worker leases queued `embed-message` jobs, batches provider calls, uses the cache, and backs off on retryable provider limits.

Recommended schedule:

- every 15 minutes: `bun run local-server:sync-tick`
- daily or after large ingests: `bun run local-server:maintain`
- before risky changes: `bun run local-server:backup`

Launchd/cron should call only the package script; it should not inline Docker commands or provider logic. Example cron entry:

```cron
*/15 * * * * cd /Users/guilhermecastro/Projects/quasar && /opt/homebrew/bin/bun run local-server:sync-tick >> logs/local-server-sync.log 2>&1
```

## Worker policy

Use one active embedding profile per running server process. For the Mac mini default:

```env
QUASAR_EMBEDDING_PROVIDER=synthetic
QUASAR_EMBEDDING_MODEL=hf:nomic-ai/nomic-embed-text-v1.5
QUASAR_EMBEDDING_DIMENSIONS=768
QUASAR_EMBEDDING_TASK=search_document
QUASAR_EMBEDDING_DOCUMENT_PREFIX="search_document: "
QUASAR_EMBEDDING_QUERY_PREFIX="search_query: "
QUASAR_EMBEDDING_WORKER_ENABLED=true
QUASAR_INDEX_REPAIR_WORKER_ENABLED=false
QUASAR_FRESHNESS_WORKER_ENABLED=false
QUASAR_MAINTENANCE_WORKER_ENABLED=false
```

The cache namespace and vector table are profile-scoped. Quasar does not intentionally embed one message into multiple provider spaces during ordinary operation. Side-by-side provider comparison is an explicit proof workflow, not daemon behavior.

## Maintenance

LanceDB maintenance is the derived-store hygiene pass:

- ensure lexical FTS index exists on the shared `messages` table,
- ensure vector index exists on the active profile table,
- optimize/compact fragments,
- report row/index/fragment stats.

Run it inside the container:

```bash
bun run local-server:maintain
```

Avoid the HTTP maintenance endpoint for long optimize runs. HTTP is fine for small inspection and repair endpoints, but optimize can outlive request lifetimes while the server itself remains healthy.

Healthy proof shape:

- active profile vector table has `vector_idx` and `text_idx`,
- `numUnindexedRows` is `0`,
- lexical `messages` table has `text_idx`,
- queue has `0` failed jobs unless investigating a provider outage.

Inspect with:

```bash
bun run local-server:lance
```

## Backup / restore

Backup:

```bash
bun run local-server:backup
```

This writes `./quasar-data-backup.tgz` from `/data/quasar` inside the container.

Restore is intentionally manual because it replaces the truth store:

```bash
bun run local-server:down
docker volume rm quasar-local-server_quasar-data
bun run local-server:up
bun scripts/local-server-ops.mjs exec -- sh -lc 'rm -rf /data/quasar'
docker compose --env-file platform/local-server/.env -f platform/local-server/compose.yaml cp ./quasar-data-backup.tgz local-server:/tmp/quasar-data-backup.tgz
bun scripts/local-server-ops.mjs exec -- sh -lc 'tar -xzf /tmp/quasar-data-backup.tgz -C /data'
bun run local-server:restart
```

## Troubleshooting checklist

1. `bun run local-server:ps` — container running and healthy?
2. `bun run local-server:logs` — crash loop, provider errors, SQLite/LanceDB errors?
3. `bun run local-server:status` — queue pending/leased/failed counts?
4. `bun run local-server:lance` — all LanceDB tables, indexes, and unindexed rows?
5. `bun scripts/local-server-ops.mjs exec -- sh -lc 'du -sh /data/quasar/*'` — disk growth sane?
6. If jobs are leased forever after a crash, run:

   ```bash
   bun scripts/local-server-ops.mjs exec -- sh -lc 'cd /app && bun packages/local-server/src/cli.ts recover-leases'
   ```

7. If search misses fresh sessions, run:

   ```bash
   bun run local-server:sync-tick
   bun run local-server:maintain
   ```

## Production proof artifacts

- `docs/proofs/local-server-production-proof-2026-06-19.md`
- `docs/proofs/embedding-retrieval-comparison-2026-06-19.md`
- `docs/proofs/embedding-retrieval-comparison-2026-06-19.json`
