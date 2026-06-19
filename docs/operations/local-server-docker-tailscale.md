# Quasar local-server Docker + Tailscale runbook

Quasar's active production path is the Effect local server:

- SQLite stores OLTP truth: projects, sessions, messages, tool calls, ingest runs, queue jobs, embedding cache.
- LanceDB stores derived search rows and indexes under `search.lance`.
- Docker owns process restart, data volume persistence, and container logs on the Mac mini.
- Tailscale access is by the Mac mini's Tailscale IP first. MagicDNS is optional proof, never assumed.

## Files

- `platform/local-server/Dockerfile`
- `platform/local-server/compose.yaml`
- `platform/local-server/.env.example`

Copy the env template before first boot:

```bash
cp platform/local-server/.env.example platform/local-server/.env
chmod 600 platform/local-server/.env
```

Fill in:

- `GOOGLE_GENERATIVE_AI_API_KEY`
- `QUASAR_*_ROOT` host paths for the agent histories on that Mac
- `QUASAR_PUBLISH_HOST`

## Tailscale networking decision

Preferred client URL:

```text
http://<mac-mini-tailscale-ip>:6180
```

Find the IP on the Mac mini:

```bash
tailscale ip -4
```

Docker publishes the container port to the Mac mini host. In `platform/local-server/.env`:

```env
QUASAR_PUBLISH_HOST=0.0.0.0
QUASAR_LOCAL_PORT=6180
```

If Docker Desktop can bind the Tailscale interface directly, use the Tailscale IP as `QUASAR_PUBLISH_HOST`. If it cannot, keep `0.0.0.0` and restrict reachability with Tailscale ACLs and macOS firewall rules. Do not rely on MagicDNS for the production proof; test it only after IP access works.

The compose file pins `QUASAR_HOME=/data/quasar` inside the container. This is
required for ingest idempotency because provider session IDs include Quasar's
machine identity; if machine identity lives in the disposable container root,
container recreation can make the same source corpus look like a new machine's
sessions.

Remote proof from the MacBook:

```bash
curl -fsS http://<mac-mini-tailscale-ip>:6180/health
curl -fsS http://<mac-mini-tailscale-ip>:6180/status
```

Optional MagicDNS proof:

```bash
curl -fsS http://<mac-mini-magicdns-name>:6180/health
```

## Start / stop / restart

From repo root on the Mac mini:

```bash
docker compose --env-file platform/local-server/.env -f platform/local-server/compose.yaml up -d --build
docker compose --env-file platform/local-server/.env -f platform/local-server/compose.yaml ps
docker compose --env-file platform/local-server/.env -f platform/local-server/compose.yaml logs -f --tail=200 local-server
```

Stop:

```bash
docker compose --env-file platform/local-server/.env -f platform/local-server/compose.yaml down
```

Restart after code/env changes:

```bash
docker compose --env-file platform/local-server/.env -f platform/local-server/compose.yaml up -d --build --force-recreate
```

## First boot sequence

Keep background workers disabled at first:

```env
QUASAR_WORKERS_ENABLED=false
QUASAR_EMBEDDING_WORKER_ENABLED=false
QUASAR_INDEX_REPAIR_WORKER_ENABLED=false
QUASAR_FRESHNESS_WORKER_ENABLED=false
QUASAR_MAINTENANCE_WORKER_ENABLED=false
```

Then verify manually:

```bash
curl -fsS http://127.0.0.1:6180/health
curl -fsS http://127.0.0.1:6180/status
docker compose --env-file platform/local-server/.env -f platform/local-server/compose.yaml exec local-server \
  bun run --cwd packages/local-server src/cli.ts worker-tick
```

`/status` is intentionally lightweight by default; pass `?lance=true` only when you need LanceDB table stats, because fragmented Lance tables can make that scan slow during a full drain.

Enable only the lanes needed for the current operation. During a large embedding drain, run the embedding worker alone so maintenance and freshness scans do not compete with provider throughput:

```env
QUASAR_WORKERS_ENABLED=false
QUASAR_EMBEDDING_WORKER_ENABLED=true
QUASAR_INDEX_REPAIR_WORKER_ENABLED=false
QUASAR_FRESHNESS_WORKER_ENABLED=false
QUASAR_MAINTENANCE_WORKER_ENABLED=false
QUASAR_EMBEDDING_WORKER_LIMIT=1000
QUASAR_EMBEDDING_JOB_MAX_ATTEMPTS=12
QUASAR_EMBEDDING_API_BATCH_SIZE=100
QUASAR_EMBEDDING_API_CONCURRENCY=4
QUASAR_WORKER_LEASE_MS=600000
QUASAR_WORKER_BUSY_INTERVAL_MS=100
QUASAR_EMBEDDING_RETRY_BASE_MS=30000
QUASAR_EMBEDDING_RETRY_MAX_MS=600000
```

The server leases ready embedding jobs continuously, uses the embedding cache before calling the provider, and retries retryable provider failures with exponential backoff. This replaces long-lived shell loops; `embed-batch` remains an operator/debug tool.

## Ingest and search operations

Run read/search commands against the server from any Tailscale client:

```bash
export QUASAR_LOCAL_SERVER_URL=http://<mac-mini-tailscale-ip>:6180
bun run --cwd packages/local-server src/cli.ts stats --server "$QUASAR_LOCAL_SERVER_URL"
bun run --cwd packages/local-server src/cli.ts search --server "$QUASAR_LOCAL_SERVER_URL" --mode lexical --query "project identity"
```

Run ingest inside the container so mounted history paths are consistent:

```bash
docker compose --env-file platform/local-server/.env -f platform/local-server/compose.yaml exec local-server \
  bun run --cwd packages/local-server src/cli.ts ingest --provider all
```

## Embedding profile safety

Normal runtime has exactly one active semantic embedding profile, selected by the
`QUASAR_EMBEDDING_*` environment variables at process start. Ingest enqueues
semantic jobs only for that active profile. Quasar does not fan out one message to
multiple providers, and workers fail closed if a queued embedding job belongs to a
different profile than the running process.

The embedding profile is part of both cost and vector-space identity:

- queue idempotency: `embed-message:<profile-cache-namespace>:<content-hash>`
- cache key: `(profile-cache-namespace, content_hash)`
- vector table: the active profile table, while lexical/FTS rows stay shared

This means reruns for the same profile/text use the cache and do not call the
embedding API again. Side-by-side Gemini/Nomic comparison is an explicit proof
operation: switch the active profile deliberately, rebuild that profile's index,
and compare result artifacts. It is not daemon-default behavior.

Maintenance proof:

```bash
docker compose --env-file platform/local-server/.env -f platform/local-server/compose.yaml exec local-server \
  bun run --cwd packages/local-server src/cli.ts freshness --limit 500

docker compose --env-file platform/local-server/.env -f platform/local-server/compose.yaml exec local-server \
  bun run --cwd packages/local-server src/cli.ts maintain --vector true --optimize true
```

## Backup / restore

SQLite and LanceDB live in the `quasar-data` Docker volume at `/data/quasar`. Logs are read through Docker's logging driver:

```bash
docker compose --env-file platform/local-server/.env -f platform/local-server/compose.yaml logs --tail=500 local-server
```

Backup:

```bash
docker compose --env-file platform/local-server/.env -f platform/local-server/compose.yaml exec local-server \
  tar -czf /tmp/quasar-data-backup.tgz -C /data quasar

docker cp "$(docker compose --env-file platform/local-server/.env -f platform/local-server/compose.yaml ps -q local-server)":/tmp/quasar-data-backup.tgz ./quasar-data-backup.tgz
```

Restore into a stopped service:

```bash
docker compose --env-file platform/local-server/.env -f platform/local-server/compose.yaml down
docker volume rm quasar-local-server_quasar-data
docker compose --env-file platform/local-server/.env -f platform/local-server/compose.yaml up -d --no-start
docker cp ./quasar-data-backup.tgz "$(docker compose --env-file platform/local-server/.env -f platform/local-server/compose.yaml ps -aq local-server)":/tmp/quasar-data-backup.tgz
docker compose --env-file platform/local-server/.env -f platform/local-server/compose.yaml start local-server
docker compose --env-file platform/local-server/.env -f platform/local-server/compose.yaml exec local-server \
  sh -lc 'rm -rf /data/quasar && tar -xzf /tmp/quasar-data-backup.tgz -C /data'
docker compose --env-file platform/local-server/.env -f platform/local-server/compose.yaml restart local-server
```

## Launchd cutover

Docker replaces launchd as the local-server supervisor. During cutover:

1. Park old Quasar Convex with
   [the non-destructive parking procedure](park-quasar-convex.md). This targets
   `com.quasar.convex-local-backend` and the `platform/convex` compose project
   only; leave Tower/Booth siblings alone.
2. Start Docker compose with workers disabled.
3. Prove `/health`, `/status`, and a manual `worker-tick`.
4. Enable only the worker lane needed for the current operation and recreate the container. For embedding drains, prefer `QUASAR_EMBEDDING_WORKER_ENABLED=true` with the other lanes disabled until the queue is empty.
5. Leave old Convex code and data on disk, but do not route active Quasar clients to it.

Do not delete historical data during QSR-107. The production proof glyph owns wipe/re-ingest decisions.
