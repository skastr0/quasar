# Changelog

All notable changes to this project will be documented in this file.

This project follows Semantic Versioning for its declared public CLI behavior.
While Quasar is in `0.y.z`, command names, JSON envelopes, and local storage
formats may still change.

## [Unreleased]

## [0.3.2] - 2026-07-07

### Fixed

- Model five more drifted Claude Code on-disk shapes that fail-closed rejected
  ~137 real sessions on full re-ingest (a corpus-wide sweep found them; the
  daemon had surfaced only the two most-recently-touched). Attachments:
  `nested_memory` (injected CLAUDE.md content) and `structured_output` (captured
  tool output) signal as messages; `context_tip` drops as a harness tip.
  Top-level records: `custom-title` signals as a summary (sibling of ai-title);
  `frame-link` drops as session UI state. Verified against the real session
  files: previously-failing sessions now ingest, zero unknown-subtype
  diagnostics. A non-session ledger under an `artifacts/` subdirectory remains
  correctly rejected (it is not a transcript).

## [0.3.1] - 2026-07-07

### Fixed

- Model the Claude `model_refusal_fallback` system record (emitted when a
  model's safeguards refuse a message and the harness retries on a fallback
  model). It is refusal/retry telemetry carrying no turn content, so it decodes
  and drops with a named reason. Previously it hit the fail-closed
  `claude.system.unknown_subtype` path, which rejected the whole session — the
  daemon's per-tick exit-1 on affected sessions.

## [0.3.0] - 2026-07-07

### Changed

- **SQLite is now the only search engine.** LanceDB, the readiness gate, and the
  reconcile/index-repair/freshness maintenance workers were deleted (2026-07-04).
  Lexical search serves from trigger-maintained FTS5 with scope tokens
  (project/role/provider filters ride inside MATCH); semantic and fusion search
  serve from a resident f16 vector matrix scanned exactly via a simsimd SIMD
  kernel. Live receipts: warm p95 lexical/semantic/fusion 6/85/97 ms.
- Query embedding runs on a local fp32 ONNX model baked into the server image
  (fp32 pinned after a receipted parity experiment; q8 fails retrieval parity),
  with a bounded (3s + one retry) synthetic-API fallback while it loads.
  Document embeddings stay on the synthetic cache namespace.
- Fusion degrades to lexical-only (`degraded: true`) instead of returning 503
  when the query embedder is unavailable.
- **Session re-ingest applies row-level diffs.** A changed session used to be
  rewritten in full (delete-all + reinsert) inside one synchronous transaction,
  head-of-line blocking searches for up to tens of seconds and burning constant
  CPU re-tokenizing live sessions every daemon tick. Applies now write only
  changed rows in small chunk transactions with the event loop yielded between
  chunks; the source fingerprint commits last, so interrupted applies converge
  on the next tick. Ingest outcome counts are now honest row deltas.
- CLI commands `maintain`, `freshness`, and `repair-index` were removed with
  the LanceDB maintenance surface; `replay-embedding-cache`,
  `materialize-embedding-vectors`, and `tui` were added.

### Removed

- `@lancedb/lancedb` and `apache-arrow` dependencies; `QUASAR_SEARCH_DATA_DIR`.

## [0.2.2] - 2026-06-24

### Fixed

- Added a bounded Codex `legacy_header_v1` fallback for rollout files whose
  first record carries the native session id at top-level `id`.
- Rejected malformed or hintless Codex legacy headers with named diagnostics
  instead of silently reporting an empty ingest or collapsing sessions into
  `unknown-project`.
- Preserved adapter diagnostic codes in remote ingest failure reports.

### Changed

- Reoriented the repository to the Effect server architecture direction:
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
