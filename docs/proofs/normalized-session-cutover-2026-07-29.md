# Normalized-session live cutover receipt — 2026-07-29

## Deploy

- **Image:** `quasar-server:latest` → `98decd14ddd9` (built from main including harden commits through `d6a23e1`).
- **Rollback tags:** `quasar-server:pre-cutover-20260729-0342`, `quasar-server:pre-format-cutover-2026-07-29` (both previous `ea633243b127`).
- **Volume:** `quasar-server_quasar-data` preserved (no wipe).
- **Backup policy:** do **not** use in-container `VACUUM INTO /tmp` while free space is tight (prior disk-full incident). Image tag only for rollback.

## Live routes (post-deploy)

| route | result |
| --- | --- |
| `GET /ready` | 200 — lexical + semantic + fusion after matrix load |
| `GET /sessions` | 200 |
| `GET /tool-calls` | 200 |
| `GET /research-export` | 200 (manifest stream) |
| `GET /session-enrichments` | 200 |
| `GET /trajectory?sessionId=…` | 200 after re-ingest; **409** `TrajectorySourceInvalid` until session re-ingested under current contract |

## Contract harden on main (pre-cutover commits)

| commit | scope |
| --- | --- |
| `77e0b5b` | message text/contentHash seal + ContentBlock kind payload (work-item/299) |
| `a04b494` | OpenCode pruned-garbage named diagnostics  |
| `d6a23e1` | CLI search degraded + irrelevant flag reject |
| `f17e2b3` | README/AGENTS doctrine honesty |

## Re-ingest

- Full `quasar-dev ingest --provider all --server http://127.0.0.1:7180 --summary` started (PID recorded in session; long-running).
- **Hermes limited proof:** first pass wrote 62 sessions / 710 messages / 914 tool calls; second pass **62 skipped / 0 writes** (idempotency).
- Trajectory on `hermes:1eb103488ab603cd29a23456d3f12203` succeeds for `quasar` and `letta` formats after re-ingest.

## Dogfood (filesystem-free)

| surface | result |
| --- | --- |
| search lexical | ok |
| tool-calls list | ok |
| enrichments list | ok (empty) |
| trajectory | ok after re-ingest |
| research-export | returns `QuerySnapshotBusyError` while full re-ingest mutates corpus — expected; retry after quiet |

## Residual

| item | note |
| --- | --- |
| Full multi-provider re-ingest | in progress (background) |
| Full-corpus audit/idempotency receipt | after ingest completes |
| Embed dead letters | 23 failed `embed-message` remain after `prune-dead-letters` (not auto-resolved) |
| npm | `@skastr0/quasar-cli@0.5.1` already on registry; **harden commits need `0.5.2`** for a new publish (CI-first) |
| Plugin | `prism-plugins/quasar` at 0.4.0 — align after CLI tag |

## CLI for cutover ops

Use **`quasar-dev`** (linked to packages/cli dist, reports 0.5.1 + HEAD code), not global `quasar` 0.5.0, until a new npm tag ships.
