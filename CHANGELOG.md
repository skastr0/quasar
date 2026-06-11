# Changelog

All notable changes to this project will be documented in this file.

This project follows Semantic Versioning for its declared public CLI behavior.
While Quasar is in `0.y.z`, command names, JSON envelopes, and local storage
formats may still change.

## [Unreleased]

### Changed

- Reoriented the repository to the v2 architecture direction
  (`docs/architecture/quasar-v2-greenfield-plan-2026-06-10.md`). Superseded
  architecture documents are marked historical; live server ingest remains
  gated until the v2 sync contract lands and its measured gates pass.

### Removed

- The Convex control app and dashboard (`apps/control`) in their entirety, the
  CLI server client, and the server-backed CLI commands (ingest, search,
  sessions, tool-calls, projects). The project has no users and no live data;
  nothing v1-shaped earns life by working. The CLI keeps only local read-only
  commands; the v2 server and surfaces are built fresh per the architecture
  plan.
- The entire abandoned record-stream ingest plane: the v1 record taxonomy and
  envelope machinery, the adapter record bridge, the CLI ingest ledger and
  runner, the Convex record-ingest endpoint and its `recordStates`/`tombstones`
  tables, and the `/api/ingest/records` route. Parsing knowledge remains
  minable from git history (see `docs/architecture/README.md`, Graveyard).
- The six provider adapters with no data on any real host (Amp, Pi, Kimi,
  Factory/Droid, Antigravity, Cursor); re-admitted only when data and a
  consuming endpoint exist.
- Compaction-era legacy-field rejection from the record envelope decoder, and
  the tests that pinned it.
- The banned-terminology source scan and the character-code keyword
  obfuscation it forced in the CLI ledger storage clause.

## [0.1.0] - 2026-06-06

### Added

- Initial public Quasar CLI package preparation.
- Local agent session discovery, planning, ingestion, search, and inspection
  commands.
- Convex-backed local control app and dashboard kept outside the npm publish
  surface.
