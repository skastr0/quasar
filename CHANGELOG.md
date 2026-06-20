# Changelog

All notable changes to this project will be documented in this file.

This project follows Semantic Versioning for its declared public CLI behavior.
While Quasar is in `0.y.z`, command names, JSON envelopes, and local storage
formats may still change.

## [Unreleased]

### Changed

- Reoriented the repository to the Effect local-server architecture direction:
  SQLite truth store, durable queue, LanceDB search, package-owned CLI, and
  Docker/Tailscale deployment.

### Removed

- Abandoned backend/runtime surfaces and stale CLI implementation paths from
  the active source tree.
- The entire abandoned record-stream ingest plane: the v1 record taxonomy and
  envelope machinery, adapter record bridge, old CLI ingest ledger and runner,
  and `/api/ingest/records` route.
- The six provider adapters with no data on any real host (Amp, Pi, Kimi,
  Factory/Droid, Antigravity, Cursor); re-admitted only when data and a
  consuming endpoint exist.
- Compaction-era legacy-field rejection from the record envelope decoder, and
  the tests that pinned it.
- The banned-terminology source scan and the character-code keyword
  obfuscation it forced in the CLI ledger storage clause.

## [0.1.0] - 2026-06-06

### Added

- A local per-machine ingest fingerprint cache consulted before parsing so
  unchanged sessions cost only a stat + cache read; the server remains the
  authoritative idempotency gate, and `--reset-ledger` / `--force` bypass it.
- Initial public Quasar CLI package preparation.
- Local agent session discovery, planning, ingestion, search, and inspection
  commands.
