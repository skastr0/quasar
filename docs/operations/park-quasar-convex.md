# Park Quasar Convex without deleting data

Quasar's active runtime is the Effect local server. This procedure parks only the
old Quasar Convex runtime surfaces. It does not delete repository code, SQLite
files, local storage, backups, or any sibling Tower/Booth Convex services.

## What belongs to old Quasar Convex

Launchd service:

- label: `com.quasar.convex-local-backend`
- plist: `~/Library/LaunchAgents/com.quasar.convex-local-backend.plist`
- logs: `logs/launchd-convex.out.log`, `logs/launchd-convex.err.log`
- installer: `scripts/install-launchd.mjs`
- process wrapper: `scripts/start-local-convex.mjs`

Local state paths:

- home root: `${QUASAR_HOME:-~/.config/quasar}`
- client config: `${QUASAR_CONFIG:-~/.config/quasar/config.json}`
- local backend root: `${QUASAR_CONVEX_LOCAL_ROOT:-~/.config/quasar/local/default}`
- backend config: `~/.config/quasar/local/default/config.json`
- backend SQLite: `~/.config/quasar/local/default/convex_local_backend.sqlite3`
- local storage: `~/.config/quasar/local/default/convex_local_storage/`
- backups: `${QUASAR_BACKUP_ROOT:-~/.config/quasar/backups/convex}`

Optional Docker platform files from the previous self-hosting probe:

- compose: `platform/convex/compose.yaml`
- env: `platform/convex/.env`
- project name: `quasar-convex`

The sibling Tower Control and Booth Control repositories have their own folders,
launchd labels, Docker projects, and state. Do not use broad `convex`, `launchd`,
or Docker prune commands during this procedure.

## Inventory

From the Quasar repo root:

```bash
bun run status:convex
```

This prints JSON with the Quasar-only launchd label, compose files, and state
paths. It is read-only.

Manual cross-checks:

```bash
launchctl print gui/$(id -u)/com.quasar.convex-local-backend 2>/dev/null || true
docker compose --env-file platform/convex/.env -f platform/convex/compose.yaml ps 2>/dev/null || true
ls -la ~/.config/quasar/local/default 2>/dev/null || true
ls -la ~/.config/quasar/backups/convex 2>/dev/null || true
```

## Park the runtime

```bash
bun run park:convex
```

The command only attempts to:

1. `launchctl bootout gui/$(id -u) ~/Library/LaunchAgents/com.quasar.convex-local-backend.plist`
2. `launchctl disable gui/$(id -u)/com.quasar.convex-local-backend`
3. `docker compose --env-file platform/convex/.env -f platform/convex/compose.yaml stop`

It does not remove the plist, Docker volume, local backend SQLite, local storage,
config, backups, or source code.

## Route active Quasar use to local-server

Use the Docker local-server runbook as the production path:

```bash
docker compose --env-file platform/local-server/.env -f platform/local-server/compose.yaml up -d --build
export QUASAR_LOCAL_SERVER_URL=http://<mac-mini-tailscale-ip>:6180
bun run --cwd packages/local-server src/cli.ts stats --server "$QUASAR_LOCAL_SERVER_URL"
```

The old `packages/cli` write/read/search commands are legacy during the local-server
cutover. Prefer `packages/local-server/src/cli.ts` for production ingest, read,
worker, maintenance, and search operations.

## Rollback / re-enable

Re-enable only if a specific recovery task needs the old backend data.

Launchd path:

```bash
bun scripts/init-local-convex.mjs
bun scripts/install-launchd.mjs
launchctl print gui/$(id -u)/com.quasar.convex-local-backend
```

Docker probe path:

```bash
docker compose --env-file platform/convex/.env -f platform/convex/compose.yaml up -d
docker compose --env-file platform/convex/.env -f platform/convex/compose.yaml ps
```

After rollback, keep active Quasar clients pointed at only one backend at a time.
Do not run local-server production ingest and old Convex ingest against the same
source roots as competing daemons.

## Future deletion trigger

Delete Quasar Convex code and data only after the production proof shows:

- full corpus re-ingest into SQLite succeeds,
- LanceDB lexical/vector/fusion search returns real hits,
- Docker/Tailscale access is stable from another tailnet device,
- backups of the local-server volume exist, and
- no active command, docs surface, workflow, or package import references the old
  Quasar Convex runtime.

Until then, parking is the canonical state: stopped, recoverable, and not on the
active path.
