# Staged upgrade: normalization v13 and ingestion/search repairs

## Execution contract

This is a handoff plan, **not evidence that the upgrade has run**. Writing,
committing, or pushing this document does not authorize stopping daemons,
deploying, re-ingesting, or restoring production data. Obtain explicit execution
approval before state-changing steps, including phase 0 staging; include the
ledger deletions and rollback policy below in that approval. Read-only inventory
can proceed independently. Obtain separate approval for a destructive database
rollback unless that exact contingency was approved in advance.

Outcome: the existing Docker deployment and all ingestion clients run the
reviewed code; session history and identities remain intact; ingestion resumes
without unexplained deletions, duplicate identities, or search regressions.

The executing agent must read `AGENTS.md` and the Quasar, Tailscale SSH operation,
and Signal 20 skills. Use the existing SSH connection and Docker Compose service.
Do not introduce a native server, another production database, custom LaunchAgents,
new scheduled ingestion, package publishing, or a different embedding provider.
Keep tokens, hostnames, session IDs/text, backups, and operational receipts outside
Git in private storage. Do not delegate production execution to another agent.

## Scope and known data changes

The reviewed application target is
[`168fcf8`](https://github.com/skastr0/quasar/commit/168fcf83072928304fa7e299cff5de072562ee64),
including these six commits:

| Commit | Change |
| --- | --- |
| [2eeabf0](https://github.com/skastr0/quasar/commit/2eeabf0) | Correct an operations test's receipt-path expectation. |
| [b3502ae](https://github.com/skastr0/quasar/commit/b3502ae) | Separate record warnings from failures; preserve failed-source retries and pre-write file stats. |
| [c020ee5](https://github.com/skastr0/quasar/commit/c020ee5) | Detect Hermes/OpenCode WAL and SHM changes. |
| [44b0671](https://github.com/skastr0/quasar/commit/44b0671) | Preserve source-omitted media; bump normalization 12 → 13. |
| [abe06dc](https://github.com/skastr0/quasar/commit/abe06dc) | SQLite busy timeout, additive ingest ledger schema, startup ledger cleanup. |
| [168fcf8](https://github.com/skastr0/quasar/commit/168fcf8) | Bound abandoned vector scans and restore worker capacity. |

- Server startup adds nullable `ingest_runs.updated_at` and `reason`, plus an
  index. It marks running ledger rows older than six hours failed and deletes
  terminal ledger rows older than 30 days. These are operational records, not
  conversations. The six-hour rule is a heuristic: clients write at start/end,
  not periodic heartbeats. Do not use it to prove a process has stopped.
- Updated clients invalidate v12 manifest entries and reprocess available sources.
  The server reconciles each submitted session: unchanged rows survive, changed
  rows are replaced, and rows absent from the incoming session can be deleted.
  A version-only change does not itself replace every message or vector.
- Changed/deleted messages invalidate their vectors; changed semantic messages
  enqueue embedding work. Enrichments are outside source reconciliation. Provider
  source files are read, not rewritten. Sessions never submitted are not globally
  swept just because normalization changed.
- A session apply spans multiple transactions. An interrupted apply leaves an
  `applying:` fingerprint for retry; it is not a session-wide atomic rollback.
  A consistent SQLite backup can still contain an interrupted application.
- Code rollback alone does not undo re-ingestion or ledger deletion. Mixed v12/v13
  writers are unsafe during the cutover: the fingerprint gate accepts any version
  difference, including a downgrade.

Source owners: [ledger migration and reconciliation](../../packages/server/src/store.ts),
[startup cleanup](../../packages/server/src/services.ts),
[cleanup defaults](../../packages/server/src/config.ts),
[ingest finalization and embedding fan-out](../../packages/server/src/ingest.ts),
[client manifest invalidation](../../packages/cli/src/ingest.ts), and
[daemon lifecycle](../../packages/cli/src/cli.ts).

### Prior evidence — refresh, do not treat as current state

Read-only inspection at **2026-09-04 22:43 UTC** found the Docker service healthy,
normalization v12 in the running image, and no new ledger columns. The deployed
store differed from the local pre-change store only in comments; the checked
vector/protocol/config files matched the pre-change versions. Checkout HEAD alone
was not used as evidence of the running image's contents.

At that instant, default startup cleanup would reap **36** running records and
prune **68,378** terminal records. Session version counts were: v0 **801**, v4
**52**, v8 **28**, v12 **23,290**. These are historical observations, not acceptance
targets. The previous local validation reported **1,064 passing tests** and passing
typechecks; no production rehearsal or restore test was performed.

## 0. Prepare before the maintenance window

1. Inventory **every writer**, including MacBook, Mac mini, other clients, manual
   ingestion, cron, and agent-triggered imports. Record owner, binary realpath and
   checksum, daemon interval/home, provider roots, server destination, and identity
   location. Read `quasar daemon status` on each client. Do not print raw launchctl
   output: its environment contains the ingest token.
2. Privately preserve each client's plist, config, `machine.json`, and
   `ingest-manifest.json`, including custom locations. Preserve executable artifacts
   and their dependencies, not just symlinks. Defaults are the LaunchAgent under
   `~/Library/LaunchAgents/com.quasar.remote-ingest.plist` and client files under
   `~/.config/quasar`; discover overrides before assuming these paths.
3. On the server, record the actual Compose project/service, container image ID,
   image source hashes, volume mounted at `/data/quasar`, and embedding profile.
   Preserve the private `.env` and the deployed Compose file. Never infer the
   container's source revision from checkout HEAD or `quasar-server:latest`.
4. Refresh remote refs and inspect divergence without resetting either checkout.
   Prepare a separate worktree at the exact target above; do not run a blind
   `git pull` into a dirty deployment checkout. If the running code contains other
   substantive changes, reconcile the deployment delta before proceeding.
5. In that target worktree, run `bun install --frozen-lockfile`, then
   `bun run typecheck && bun run test`. Build the server and native client binaries
   **without installing or launching them**. Record source revision and checksums;
   package version `0.5.3` alone cannot distinguish these builds.

   ```bash
   # Candidate worktree, not a checkout whose dist binary a daemon currently uses.
   bun run --cwd packages/cli build
   docker build -f platform/server/Dockerfile -t "$CANDIDATE_IMAGE" .
   ```

6. Save the running image under a unique rollback tag and export it with
   `docker image save`. Ensure disk space for the image, backup, rehearsal copy,
   and optional restore volume. Preserve the old image before any build overwrites
   the mutable tag. Choose a maintenance window that allows a full rehearsal;
   the simple sequence below keeps production stopped after backup.

Use one private execution receipt to record the variables below. They are operator-
resolved values, **not literal placeholders to execute**. Run shell examples in
Bash, from the live repository unless a step says otherwise. Set `umask 077` and
`set -euo pipefail` before running a phase; a failed guard must prevent later writes.

| Variable | Meaning |
| --- | --- |
| `LIVE_REPO`, `CANDIDATE_DIR` | Absolute live and pinned candidate checkout paths on the server. |
| `PROJECT`, `CONTAINER`, `DATA_VOLUME` | Discovered live Compose project, server container, and truth volume. |
| `OLD_IMAGE`, `CANDIDATE_IMAGE` | Unique retained old-image and candidate-image tags, with recorded immutable IDs. |
| `BACKUP_DIR` | New private directory outside all repositories; never reuse it. |
| `PROD_URL` | Existing canonical production endpoint, not a newly invented route. |
| `NEW_CLI`, `OLD_CLI` | Verified absolute candidate and retained old executable paths on each client. |

**Gate:** writer inventory complete, artifacts/configs retained, exact candidate
validated, sufficient disk, and execution/retention approval recorded.

## 1. Pause all senders and establish quiescence

For each client, preserve its configuration first, then use the supported CLI:

```bash
quasar daemon uninstall
quasar daemon status
```

There is no `daemon stop`/`start` command. Uninstall removes the plist, not the
identity or manifest. It attempts to unload launchd but does not check bootout's
exit code, so require `installed=false`, `loaded=false`, and `running=false` and
independently check that no `daemon run` or direct `ingest` process remains. It may
interrupt an active tick; allow any remaining requests to settle. Do not delete a
lock merely because the ledger calls its run stale. Suspend other inventoried
schedulers using their existing management interface; do not create replacements.

Pause other production mutations, including enrichment writes, for the window.
Read-only clients can remain active until the server stops. Preserve the ability
to recover any approved writes that occur after the backup.

Inspect the server's ingress logs and ledger:

```bash
quasar ingest-runs --server "$PROD_URL" --status running --limit 100 --offset 0
bun run server:status
bun scripts/server-ops.mjs logs --no-follow
```

Repeat after at least the longest configured sender interval and any observed
request timeout. No new ingest starts/writes may appear. Old running ledger rows
may remain. Using a **read-only** SQLite connection, check:

```sql
SELECT COUNT(*) AS interrupted FROM sessions
WHERE source_fingerprint LIKE 'applying:%';
SELECT status, COUNT(*) FROM queue_jobs GROUP BY status;
```

**Gate:** no live senders or in-flight ingestion, no `applying:` sessions. If an
interrupted session exists, recover it using the retained client/source through
the existing ingest path, then repeat quiescence checks. If recovery needs a
broader replay than approved, stop and ask. Record any embedding backlog; do not
discard queue jobs to manufacture an empty queue.

## 2. Back up, stop the server, and verify the recovery artifact

Use the existing backup command while the old server is running and ingestion is
quiescent. It uses SQLite `VACUUM INTO`, not a raw copy of a live WAL database.
It writes a fixed archive name, so protect any earlier archive before invoking it.

```bash
test ! -e ./quasar-truth-backup.tar
bun run server:backup
mv ./quasar-truth-backup.tar "$BACKUP_DIR/quasar-truth-backup.tar"
shasum -a 256 "$BACKUP_DIR/quasar-truth-backup.tar" > "$BACKUP_DIR/archive.sha256"
docker compose --env-file "$LIVE_REPO/platform/server/.env" \
  -f "$LIVE_REPO/platform/server/compose.yaml" -p "$PROJECT" stop server
```

Check every command's exit status; stop on failure. Do not use `down -v`, remove
the data volume, or start a native server. Confirm the server container is stopped
and no other container/process mounts the truth volume for writing.

List the archive before extraction; it must contain only the expected relative
`quasar.sqlite` and `machine.json` entries (and directory entries). Extract into a
new private `BACKUP_DIR/extracted` directory. Open that SQLite file with
`new Database(path, { readonly: true })` from `bun:sqlite`, **not the store service**:

- Require `PRAGMA integrity_check` to return `ok` and `PRAGMA foreign_key_check`
  to return no violations. Require no `applying:` fingerprints.
- Verify a valid preserved machine identity without printing its value.
- Record table counts and deterministic row hashes for sessions, messages, tool
  calls, source-fact tables, and enrichments. Retain per-session message/tool counts
  and content hashes, normalization distribution, vector/profile counts, and queue
  status. Counts alone cannot detect replacements or losses hidden by inserts.
- Copy the archive and checksum to a second approved private location; verify its
  checksum there. Never upload it to Git or attach session data to a public receipt.

The archive includes embeddings, enrichments, and queue/ledger rows in SQLite;
server and client configs/executables remain separate rollback prerequisites.

**Gate:** verified snapshot and retained old runtime/config; production stopped.
Do not proceed on the strength of the backup command's exit code alone.

## 3. Rehearse migration and ingestion on a disposable copy

1. Create a uniquely named **rehearsal volume**, never the production volume.
   Populate it from the verified extracted backup using a one-shot Docker helper
   with networking disabled and a read-only backup mount. Use the retained image
   and override its entrypoint so the server does not start while copying:

   ```bash
   docker volume create "$REHEARSAL_VOLUME"
   docker run --rm --network none --entrypoint bun \
     --mount "type=bind,src=$BACKUP_DIR/extracted,dst=/backup,readonly" \
     --mount "type=volume,src=$REHEARSAL_VOLUME,dst=/restore" \
     "$OLD_IMAGE" -e '
       import { copyFileSync, readdirSync } from "node:fs";
       if (readdirSync("/restore").length) throw new Error("destination is not empty");
       for (const name of ["quasar.sqlite", "machine.json"])
         copyFileSync(`/backup/${name}`, `/restore/${name}`);
     '
   ```

2. Prepare a private rehearsal env file with the **same embedding profile** as
   production, a **different ingest token**, and no production client routing or
   OTLP destination. Confirm approval for any external embedding calls/costs from
   copied pending jobs. Set `QUASAR_HOME`, `QUASAR_LOCAL_HOME`, and
   `QUASAR_LOCAL_SQLITE` to `/data/quasar`, `/data/quasar`, and
   `/data/quasar/quasar.sqlite`. Set `QUASAR_EMBEDDING_PROVIDER=synthetic` and copy
   the remaining active profile settings explicitly; do not silently use defaults.
3. Start only the candidate image, on a verified unused **loopback** port:

   ```bash
   docker run -d --name "$REHEARSAL_CONTAINER" \
     --env-file "$REHEARSAL_ENV" \
     --mount "type=volume,src=$REHEARSAL_VOLUME,dst=/data/quasar" \
     -p "127.0.0.1:$REHEARSAL_PORT:6180" "$CANDIDATE_IMAGE"
   ```

   Inspect the actual mounts and bindings before sending any data. Reach this
   loopback endpoint through an existing approved SSH tunnel for remote clients;
   do not publish it to the tailnet or change production routing.
4. Verify readiness and migration. Recompute expected stale/prune counts at the
   rehearsal startup time using the actual configured windows; compare to startup
   logs. Require the two columns/index and zero changes in source-history/enrichment
   hashes **before any replay**. Existing background queue processing can change
   vectors/queue records; account for those separately. Run lexical, semantic,
   fusion, session, and tool-call retrieval against known pre-upgrade examples.
5. On each source client, use a **separate rehearsal manifest and config**, but copy
   its existing `machine.json` into the rehearsal identity directory. Creating a
   fresh identity would invalidate the comparison. Preserve original source paths
   where adapters derive IDs/fingerprints from them; copying files to a different
   root can create different sessions. Never copy only the main file of a live
   provider SQLite database and ignore its WAL.

   ```bash
   # All STAGE paths are private, distinct from production; execute on the source client.
   QUASAR_HOME="$STAGE_IDENTITY" \
   QUASAR_DAEMON_HOME="$STAGE_MANIFEST_HOME" \
   QUASAR_CONFIG="$STAGE_CONFIG" \
   QUASAR_INGEST_TOKEN="$REHEARSAL_TOKEN" \
   "$NEW_CLI" ingest --server "$REHEARSAL_URL" --provider "$PROVIDER" --limit 5
   ```

   The CLI has no ingest `--session` or `--root`. `--limit` bounds enumeration, not
   the identity of the selected sessions. Provider roots use `QUASAR_<PROVIDER>_ROOT`.
   Inspect returned session IDs to confirm coverage; do not label the first five
   arbitrary sessions a media/WAL regression test. Use complete sessions, not
   truncated input assembled to fit a sample. Do not use `--force` by default.
6. Cover ordinary text, source-omitted/nested media, warning-only records, a
   failed-source retry, and Hermes/OpenCode WAL-only updates. Use existing synthetic
   tests for destructive fault injection; do not corrupt actual provider data or
   kill workers on production. Where corpus cases are unavailable, record that
   gap explicitly rather than claiming live coverage.
7. Compare replayed session IDs and row/content hashes with the backup and source.
   Inspect every deletion and unexpected replacement: no legitimate text/tool
   history loss, no duplicated identities, enrichments preserved, unchanged
   messages/vectors preserved, changed embeddings progressing. Replay the same
   stable sample normally a second time and require unchanged-source skipping.
   For actively growing sources, compare deltas instead of expecting a zero delta.
8. Stop the rehearsal server and repeat SQLite integrity/foreign-key checks on its
   volume using an isolated helper. Then perform a **restore rehearsal**: populate
   another empty volume from the original snapshot and boot `OLD_IMAGE` on another
   isolated loopback endpoint. Verify baseline hashes, retrieval, and identity.

**Gate:** migration and replay deltas explained, search works, recovery rehearsal
passes. Record timings, image IDs, checksums, and any gaps. On failure, leave
clients paused and use the rollback path; do not proceed to production to debug.

## 4. Upgrade the production server, with clients still paused

Use the candidate Compose definition with the **existing project, volume, private
env, endpoint, and embedding profile**. Create a private override containing:

```yaml
services:
  server:
    image: REPLACE_WITH_VERIFIED_CANDIDATE_IMAGE_TAG
```

Set `PRODUCTION_OVERRIDE` to that file after replacing the placeholder. Inspect
the merged config privately: it contains secrets. Confirm the original truth
volume still resolves to `/data/quasar`; no new production volume may be created.
The explicit project directory below keeps relative `env_file: ./.env` resolution
on the live configuration, not the candidate worktree. `--env-file` alone controls
interpolation and does not relocate a service's `env_file`.

```bash
docker compose --env-file "$LIVE_REPO/platform/server/.env" \
  --project-directory "$LIVE_REPO/platform/server" \
  -f "$CANDIDATE_DIR/platform/server/compose.yaml" \
  -f "$PRODUCTION_OVERRIDE" -p "$PROJECT" \
  up -d --no-build --force-recreate --no-deps server
```

This deploys the **tested image** rather than rebuilding a mutable tag. Recheck
the running image ID, mounts, `/ready`, `/status`, and startup logs. Compare source
and enrichment hashes before resuming any clients; explain ledger changes against
the snapshot and elapsed time. Account for embedding queue progress separately.
Check representative search/session/tool reads through the existing external URL.
Retain the candidate checkout and override at durable paths and record this exact
invocation as the active deployment command. The old live checkout's generic
`server:deploy` must not be used to rebuild/revert the service inadvertently.

**Gate:** same production volume/identity, expected schema and ledger changes,
unchanged source history, usable reads, no unexplained startup failures.

## 5. Resume clients gradually, then restore scheduling

1. While all daemons remain uninstalled, stage the verified native candidate binary
   at a durable, versioned path on **every** sending machine. Do not assume an npm
   install gets these commits; publishing is outside this runbook. Do not point a
   daemon at a transient worktree's `dist` binary. Verify executable permissions,
   platform compatibility/signing, checksum, and read-only CLI calls before use.
2. Keep the original production identity, provider roots, config, and manifest.
   Run a bounded one-shot against production from one client/provider first:

   ```bash
   "$NEW_CLI" ingest --server "$PROD_URL" --provider "$PROVIDER" --limit 5
   ```

   Use the same approved token resolution as the former daemon. Preserve the full
   private report (not only `--summary`) to inspect session-level deltas. Check the
   returned IDs, deletions, errors, identity continuity, and embedding progress as
   in rehearsal. Then run that provider without the limit and recheck. Continue
   one provider/client at a time. Do not run old and new clients concurrently.
3. After all provider passes are explained, restore each original daemon through
   the **CLI**, using its recorded interval, home, URL, and token, but the new binary:

   ```bash
   QUASAR_DAEMON_HOME="$ORIGINAL_DAEMON_HOME" \
   QUASAR_INGEST_TOKEN="$TOKEN" \
   "$NEW_CLI" daemon install --binary "$NEW_CLI" \
     --server "$PROD_URL" --interval-seconds "$ORIGINAL_INTERVAL"
   QUASAR_DAEMON_HOME="$ORIGINAL_DAEMON_HOME" "$NEW_CLI" daemon status
   ```

   **Install starts ingestion immediately and enables future login/timer starts.**
   There is no provider filter on the daemon: each tick ingests all stable providers.
   Do not install it during canary selection. Do not hand-author a replacement plist.
   If the preserved configuration has custom settings the CLI cannot reproduce,
   stop and resolve that gap rather than silently dropping them.
4. Restore other approved ingestion entrypoints only after ensuring they resolve
   to the same candidate code and canonical endpoint. Observe at least two complete
   scheduled ticks on each host and the first full normalization pass. Check for
   persistent retries, writer contention, unbounded queues, worker scan failures,
   and unexplained history deltas. Any longer unattended monitoring requires an
   explicitly authorized schedule, not a background polling script.

**Completion:** all senders accounted for, new code/identity verified, normal
incremental skipping restored, ledger status sane, search/retrieval usable, and
any embedding backlog bounded and making measured progress. Keep backup and old
artifacts until the operator accepts the upgrade; do not silently delete them.

## Rollback — never replace files under a running server

Do **not** use the historical restore sequence that deleted the volume, started
the server, and then replaced `/data/quasar`. That sequence permits concurrent
writes during restore. Use this stopped-writer procedure instead.

1. Pause all senders again, verify process/request quiescence, and stop the server.
   Preserve the failed-upgrade volume and diagnostics; do not overwrite or delete
   them. Record whether production ingestion resumed and what changed after backup.
2. **Before candidate production startup:** the untouched production volume can
   be restarted with the saved old image/config. No database restore is required.
3. **After candidate production startup:** do not assume code-only rollback restores
   prior state. It cannot reverse ledger cleanup, re-ingestion, or row deletion.
   Agree whether losing post-backup changes is acceptable; source replays may recover
   provider facts but not necessarily later enrichment writes. If uncertain, keep
   senders paused and ask rather than discarding data.
4. For an approved full restore, create a fresh, uniquely named restore volume.
   Repeat phase 3's empty-volume copy from the verified **original** backup using
   that new volume as destination, with the server stopped. Verify integrity and
   baseline source/enrichment hashes before boot. Never mix old `-wal`/`-shm` files
   with the restored SQLite file; the new empty volume avoids that hazard.
5. Use the retained old Compose/config plus a private override like this, replacing
   both placeholders with the saved old image and the newly populated volume:

   ```yaml
   services:
     server:
       image: REPLACE_WITH_SAVED_OLD_IMAGE_TAG
       volumes:
         - restored-truth:/data/quasar
   volumes:
     restored-truth:
       external: true
       name: REPLACE_WITH_NEW_RESTORE_VOLUME_NAME
   ```

   Verify the merged service has **exactly one** mount at `/data/quasar`, pointing
   to the restored volume. Start the old image with `up -d --no-build
   --force-recreate --no-deps server` using the retained Compose file, private env,
   project name, and rollback override. Set `--project-directory` to the retained
   configuration directory so its relative `env_file` resolves correctly; verify
   it before starting. Do not use `server:up` or `server:deploy`
   here: both rebuild, which can defeat the pinned-image rollback.
6. Verify readiness, identity, source/enrichment hashes, search, and retrieval.
   Restore each client's pre-upgrade manifest alongside its old binary/config and
   original machine identity before reinstalling its daemon. A new manifest can
   wrongly suppress data needed after database rollback; retaining the original
   manifest is part of the recovery contract. Reconcile any post-backup work under
   explicit approval before reopening all senders.
7. Keep both old and failed-upgrade volumes and the backup until recovery is
   accepted. If a volume override remains active, record its exact invocation as
   the current deployment command so a later unqualified Compose deploy cannot
   accidentally reconnect the abandoned volume.

## Final handoff receipt

Report only: deployed source/image and client checksums; backup locations/checksums
(private); rehearsal and restore verdicts; actual ledger/re-ingest deltas and any
losses; daemon state per host; search/queue health; remaining risks and rollback
artifacts. Mark unexecuted steps explicitly. If any gate fails, state the phase
and whether the server and senders are running or paused.
