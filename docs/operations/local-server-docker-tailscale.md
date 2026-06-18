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
```

Then verify manually:

```bash
curl -fsS http://127.0.0.1:6180/health
curl -fsS http://127.0.0.1:6180/status
docker compose --env-file platform/local-server/.env -f platform/local-server/compose.yaml exec local-server \
  bun run --cwd packages/local-server src/cli.ts worker-tick
```

Enable workers only after `/status` shows the expected SQLite path, LanceDB path, and queue state:

```env
QUASAR_WORKERS_ENABLED=true
```

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
4. Enable `QUASAR_WORKERS_ENABLED=true` and recreate the container.
5. Leave old Convex code and data on disk, but do not route active Quasar clients to it.

Do not delete historical data during QSR-107. The production proof glyph owns wipe/re-ingest decisions.
