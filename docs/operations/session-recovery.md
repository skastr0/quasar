# Session recovery without corpus-wide normalization replay

Normalization remains **12**. The source-omitted media fix is additive; retrying
failed or missing sessions does not require invalidating every unchanged source.
The former v13 migration plan is superseded. Its global replay and multiple full
database copies are not prerequisites for this repair.

## Authority and ownership

Obtain execution approval for deployment and recovery writes. Preserve source
files, machine identities, enrichments, and the canonical Docker data volume.
Use `scripts/server-ops.mjs` / Docker Compose for the server and `quasar daemon`
for clients. Never start a native replacement server when Docker is unavailable.
Never change client routing to a different database as an outage workaround.
Coordinate separate source machines explicitly; no old and new writers at once.
Keep tokens, source data, identities, inventories and receipts outside Git.

## Establish the actual state

1. Verify machine identity, Git revision, executable version/checksum, server
   image ID, Compose project and mounted volume. Preserve divergent Git history
   before aligning a clean checkout with `origin/main`; do not force-push it.
2. Preserve each client's plist, config, identity, manifests and executable.
   Run `quasar daemon uninstall`; verify both daemon status and actual processes.
   A remaining lock directory is not proof that a process is running.
3. Inventory source sessions independently of the stat cache and server skips.
   Map through the adapters and canonical projection; retain diagnostics and
   per-session message/tool identities and content hashes. Compare both source
   machines against the canonical database. A missing local file is not itself
   proof of a missing canonical session.
4. Measure `applying:` fingerprints, actual child-row counts, source-fact counts,
   vectors and queue state. Declared session counts, a successful exit, `/ready`,
   or a high skip count cannot establish content completeness.

## Preserve within measured storage

Measure table allocation, freelist, WAL and available space before selecting a
backup method. `server:backup` currently uses `VACUUM INTO` plus an uncompressed
archive; do not run it blindly on a nearly full disk.

A compressed, consistent logical export of all source-history tables and
enrichments can preserve the irreplaceable data without copying free pages,
secondary indexes or rebuildable embeddings. Explicitly record exclusions: this
is not a full byte-for-byte database backup. Include schema, row counts and
checksums; verify the entire archive and its row hashes, and test restoration.
Label a sampled restore as sampled, not a full rehearsal. Existing storage on
another approved source machine can hold the artifact through private transfer.
Verify the destination checksum before removing a temporary local copy.

Retain the old image and configuration. No automatic database rollback: it can
discard post-backup writes. Never replace SQLite/WAL files beneath a running
server, delete the canonical volume, or prune source history to make room.

## Deploy and reconcile

1. Validate the exact candidate with root typechecks/tests and native builds.
   Keep the media, failed-source, WAL and moved-event regression tests green.
   Pin the image, deploy into the existing Compose service and volume, and verify
   actual running code, normalization 12, identity and source-history invariants.
2. Stage the same verified client artifact on every source machine. Keep each
   original machine identity and provider roots. Do not trust a shell symlink's
   package version as proof of the daemon's executable version.
3. Use preserved, isolated recovery manifests to bypass possibly poisoned local
   stat skips while retaining server fingerprint checks. **Do not use `--force`
   for a general reconciliation walk:** it bypasses server skips as well.
   This reads available sources but only submits missing/changed/unfinished
   sessions. Record every failure and inspect unexpected replacements/deletions.
4. Recompare actual per-session rows and content hashes with the source inventory.
   Account for sources that changed during inspection, duplicate source copies,
   and unavailable originals. Never erase unexplained exceptions from a report.
   Recover remaining known targets, then repeat verification.
5. Restore daemons using their recorded configuration and versioned binary.
   Enable `--amp` only on the designated polling machine; preserve the 20-minute
   list cadence. Verify scheduled cycles, incremental skipping, failures, vector
   coverage, queue progress and lexical/semantic/session/tool reads.

## Completion and unresolved evidence

Report deployed source/image/client checksums, preservation location, actual
recovery deltas, source-to-store comparison results and daemon health. Missing
original sources limit what can be proven about historical content, even if
stored counts agree. Escalate an unrecoverable or unexplained gap; never call
service readiness proof that all history is present. Delete a rogue database
only after positively identifying it and preserving any history absent from the
canonical store. If the known rogue file is already absent, report that fact.
