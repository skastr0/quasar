# Quasar local-server runbook

This is the operational path for Quasar on the Mac mini.

- Docker supervises the Effect local server.
- SQLite in `/data/quasar/quasar.sqlite` is OLTP truth.
- LanceDB in `/data/quasar/search.lance` is derived search state.
- Access is by direct Tailscale IP first, e.g. `http://<mac-mini-tailscale-ip>:6180`.
- `platform/local-server/.env` is local-only and must not be committed.

## One-time setup

```bash
cp platform/local-server/.env.example platform/local-server/.env
chmod 600 platform/local-server/.env
```

Set at least:

- `QUASAR_PUBLISH_HOST=0.0.0.0` unless Docker can bind the Tailscale IP directly.
- `QUASAR_LOCAL_PORT=6180`.
- `QUASAR_INGEST_TOKEN=<long random token>`. Remote write ingest is disabled unless this is configured, and client machines must send the same token.
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
bun run local-server:sync-status # launchd schedule status
bun run local-server:maintain    # LanceDB indexes/optimize inside container
bun run local-server:backup      # write ./quasar-truth-backup.tar
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
   curl -fsS http://<mac-mini-tailscale-ip>:6180/health
   curl -fsS http://<mac-mini-tailscale-ip>:6180/status
   ```

Do not make MagicDNS the proof boundary. It can work, but the known-good operator URL is the Mac mini Tailscale IP.

## Agent / MCP serving contract

Agent clients should treat the Docker local-server HTTP API as the canonical data
plane and set the client wrapper environment to the Mac mini Tailscale IP:

```bash
export QUASAR_LOCAL_SERVER_URL=http://<mac-mini-tailscale-ip>:6180
```

The `quasar` CLI mirrors the HTTP API and is safe to wrap as MCP tools. The
serving surface is read/search only:

| Agent job | CLI wrapper | HTTP route | Filters |
| --- | --- | --- | --- |
| Project list | `projects` | `GET /projects` | `limit`, `offset` |
| Session list | `sessions` | `GET /sessions` | `projectKey`, `provider`, `limit`, `offset` |
| Session read | `messages --session-id <id>` | `GET /messages` | `sessionId`, `limit` |
| Search | `search --query <text> --mode lexical\|semantic\|fusion` | `GET /search/<mode>` | `q`/`query`, `projectKey`, `role=user\|assistant`, `limit` |
| Tool-call list | `tool-calls` | `GET /tool-calls` | `sessionId`, `projectKey`, `provider`, `toolName`, `limit`, `offset` |
| Tool-call read | `tool-call --id <id>` | `GET /tool-call` | `id` |
| Remote ingest | `ingest --provider all` | `POST /ingest/session` | operator only; set `QUASAR_LOCAL_SERVER_URL` and `QUASAR_INGEST_TOKEN` |

Notes for wrappers:

- Use `projectKey` at the HTTP layer and `--project-key` at the CLI layer.
- `role` applies to indexed message search documents (`user`, `assistant`).
  The current semantic corpus embeds `user` and `assistant` message rows; tool-call
  input/output remains structural/lexical evidence, not semantic embeddings.
- Operator-only commands: agent wrappers should not expose ingest, embedding,
  maintenance, or backfill as default tools. Those remain operator actions.
- If a wrapper cannot reach `QUASAR_LOCAL_SERVER_URL`, fail closed with a connection
  error instead of falling back to stale data.

## Incremental sync story

Keep this simple:

1. Docker keeps the server and enabled background workers alive.
2. A host scheduler periodically runs one cheap sync tick:

   ```bash
   cd /Users/guilhermecastro/Projects/quasar
   bun run local-server:sync-tick
   ```

3. The sync tick runs inside the container against the mounted read-only history roots:
   - default: `operator-ingest --provider all --summary`
   - emergency/operator override: set `QUASAR_SYNC_INGEST_LIMIT=<n>` to cap a tick while diagnosing a bad source

4. Freshness repair, LanceDB optimize, and index maintenance are explicit operations, not part of the minute tick. Run `bun run local-server:maintain` after large ingests or when `local-server:status` shows queued repair/index work that is not draining.

5. Embedding is not a cron shell loop. The server-owned embedding worker leases queued `embed-message` jobs, batches provider calls, uses the cache, and backs off on retryable provider limits.

The scheduled tick is intentionally uncapped by default and relies on adapter `shouldParseSession` probes to skip unchanged sources before expensive parse work. It emits summary JSON so per-minute logs stay small, disables one-shot workers in the CLI process, and leaves embedding/index draining/backoff to the long-running Docker service.

## Ingesting from another Tailscale machine

Install the released CLI on the other machine, point it at the Mac mini's direct
Tailscale IP, then run ingest. The CLI reads local history folders on that
machine and POSTs mapped sessions to the Mac mini server. The server is still
the authority for idempotency, SQLite writes, embedding-cache lookup, and
LanceDB/index queue draining.

```bash
npm install -g @skastr0/quasar-cli
export QUASAR_LOCAL_SERVER_URL=http://<mac-mini-tailscale-ip>:6180
export QUASAR_INGEST_TOKEN=<same-token-as-mac-mini-platform-local-server-env>

# Optional when provider roots are non-standard on that machine.
export QUASAR_CODEX_ROOT="$HOME/.codex"
export QUASAR_CLAUDE_ROOT="$HOME/.claude"
export QUASAR_OPENCODE_ROOT="$HOME/.local/share/opencode"
export QUASAR_GROK_ROOT="$HOME/.grok"
export QUASAR_HERMES_ROOT="$HOME/.hermes"

# First smoke test.
quasar stats
quasar search --mode fusion --query "quasar local server" --limit 3

# Ingest this machine's corpus into the Mac mini server.
quasar ingest --provider all --summary

# Watch server-owned workers drain embeddings/indexing.
quasar workers
quasar stats
```

You may pass `--server http://<mac-mini-tailscale-ip>:6180` and
`--ingest-token <token>` instead of exporting `QUASAR_LOCAL_SERVER_URL` and
`QUASAR_INGEST_TOKEN`. Do not use MagicDNS as the proof boundary; the known
operator URL is the direct Tailscale IP. The read/search API remains reachable
without this token; `POST /ingest/session` fails closed without it.

Recommended schedule:

- every 60 seconds: `bun run local-server:sync-tick`
- daily or after large ingests: `bun run local-server:maintain`
- before risky changes: `bun run local-server:backup`

On remote Macs, use the released CLI's production daemon installer. It installs a
user LaunchAgent with `StartInterval=60` by default. The LaunchAgent calls
`quasar daemon run`, which holds a local lock and then runs the remote ingest
path (`quasar ingest --provider all --summary --server ...`) so a slow first
ingest cannot overlap the next minute tick.

```bash
npm install -g @skastr0/quasar-cli
export QUASAR_LOCAL_SERVER_URL=http://<mac-mini-tailscale-ip>:6180
export QUASAR_INGEST_TOKEN=<same-token-as-mac-mini-platform-local-server-env>

quasar daemon install --interval-seconds 60
quasar daemon status
```

Override through flags when you do not want to export environment variables:

```bash
quasar daemon install \
  --server http://<mac-mini-tailscale-ip>:6180 \
  --ingest-token <token> \
  --interval-seconds 60
```

Uninstall:

```bash
quasar daemon uninstall
```

The Mac mini repo-local `bun run local-server:sync-install` helper is only for
the server host's own mounted corpus. Do not use it for remote client machines.

Equivalent cron entry if launchd is not desired; replace the repo and Bun paths for the host:

```cron
* * * * * cd /path/to/quasar && /path/to/bun run local-server:sync-tick >> logs/local-server-sync.log 2>&1
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
QUASAR_WORKERS_ENABLED=true
QUASAR_EMBEDDING_WORKER_ENABLED=true
QUASAR_INDEX_REPAIR_WORKER_ENABLED=true
QUASAR_FRESHNESS_WORKER_ENABLED=false
QUASAR_MAINTENANCE_WORKER_ENABLED=false
```

The embedding worker drains `embed-message` jobs; the index repair worker drains `index-session` jobs into LanceDB. The cache namespace and vector table are profile-scoped. Quasar does not intentionally embed one message into multiple provider spaces during ordinary operation. Side-by-side provider comparison is an explicit proof workflow, not daemon behavior.

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

This writes `./quasar-truth-backup.tar` with:

- `quasar.sqlite`, produced by SQLite `VACUUM INTO` so the snapshot is coherent while the server is running,
- `machine.json`, so provider session IDs remain stable after restore.

It intentionally does **not** archive `search.lance` by default. LanceDB is derived from SQLite message/search state and is rebuilt with `sync-tick`, server workers, and `maintain`; backing up it by default turns a truth backup into a slow multi-GB derived-index copy.

Restore is intentionally manual because it replaces the truth store:

```bash
bun run local-server:down
docker volume rm quasar-local-server_quasar-data
bun run local-server:up
bun scripts/local-server-ops.mjs exec -- sh -lc 'rm -rf /data/quasar'
docker compose --env-file platform/local-server/.env -f platform/local-server/compose.yaml cp ./quasar-truth-backup.tar local-server:/tmp/quasar-truth-backup.tar
bun scripts/local-server-ops.mjs exec -- sh -lc 'mkdir -p /data/quasar && tar -xf /tmp/quasar-truth-backup.tar -C /data/quasar'
bun run local-server:restart
bun run local-server:sync-tick
bun run local-server:maintain
```

## Troubleshooting checklist

1. `bun run local-server:ps` — container running and healthy?
2. `bun run local-server:logs` — crash loop, provider errors, SQLite/LanceDB errors?
3. `bun run local-server:status` — queue pending/leased/failed counts?
4. `bun run local-server:lance` — all LanceDB tables, indexes, and unindexed rows?
5. `bun scripts/local-server-ops.mjs exec -- sh -lc 'du -sh /data/quasar/*'` — disk growth sane?
6. If jobs are leased forever after a crash, run:

   ```bash
   bun scripts/local-server-ops.mjs exec -- sh -lc 'cd /app && bun packages/cli/src/cli.ts operator-recover-leases'
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
