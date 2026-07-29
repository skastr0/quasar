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
| `77e0b5b` | message text/contentHash seal + ContentBlock kind payload (QSR-297/299) |
| `a04b494` | OpenCode pruned-garbage named diagnostics (QSR-300) |
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

## Re-ingest completion (continued)

- Long `--provider all` pass ran ~40+ min then hung at 0% CPU (likely Amp remote); process killed.
- Per-provider second pass (timed):

| provider | seen | written | skipped | failed | notes |
| --- | ---: | ---: | ---: | ---: | --- |
| codex | 1 | 0 | 1 | 0 | local root sparse on this host |
| claude | 3790 | 14 | 3762 | 14 | map_session_failed on 14 (ContentBlock/contract) |
| opencode | 0 | 0 | 0 | 0 | no sources on this machine path |
| grok | 497 | 2 | 494 | 1 | 1 map_session_failed |
| kimi | 0 | 0 | 0 | 0 | |
| hermes | 0* | 0 | 0 | 0 | *prior dedicated pass: 62 write then 62 skip |
| antigravity / omp / pi | 0 | 0 | 0 | 0 | |
| cursor | 7 | 7 | 0 | 0 | |
| devin | 46 | 0 | 46 | 0 | idempotent skip |
| amp | — | — | — | — | **TIMEOUT** (180s); stored amp sessions may 409 on trajectory |

- Queue after recovery: **failed embed-message = 0** (23 requeued earlier).
- Live corpus after cutover work: **~861k messages**, queue pending 0, failed 0.

## Dogfood (filesystem-free) — quiet

| surface | result |
| --- | --- |
| search lexical/fusion | ok |
| tool-calls | ok |
| enrichments | ok |
| trajectory | ok: hermes, devin, kimi, cursor, omp; **amp 409** until re-ingest |
| research-export | ok with `--provider hermes` (30 msgs, sha256 receipt); unfiltered hits amp invalid source |

## Residual

| item | note |
| --- | --- |
| Amp full re-ingest | hangs/timeouts on remote CLI — residual |
| 14 Claude + 1 Grok map failures | fail-closed ingest; not silent |
| npm | **0.5.2 prepared** on main (`c2f55ce`); **do not push/tag until operator approves** (0.5.1 already published) |
| Plugin | 0.4.1 committed in prism-plugins; no publish push |

## CLI for cutover ops

Use **`quasar-dev`** (0.5.2 HEAD), not global `quasar` 0.5.0, until a new npm tag ships.
