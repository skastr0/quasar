# Architecture Documents

There is exactly **one current direction**:

- **[Quasar v2 — Canonical Greenfield Plan](quasar-v2-greenfield-plan-2026-06-10.md)** —
  the authoritative architecture: storage topology, wire contract (`quasar-sync/v2`),
  CLI/ledger design, Convex schema, adapter strategy, work decomposition, and kill
  criteria. Includes the self-hosted Convex hosting decision and the per-field
  expectation addendum (out-of-expectation inputs are contract breaches rejected at the
  adapter boundary — never absorbed).
- **[Convex Grain — Quasar v2 Verdicts](convex-grain-quasar-v2.md)** — platform rulings
  for building on self-hosted Convex: mutation chunking, index-only reads, action-based
  fusion, idempotency, migration policy, component boundaries.

Everything else in this directory is **historical**: post-mortems and measurement
reports from the two abandoned ingest architectures (the session-blob import era and the
record-stream compaction era). They are preserved as evidence and lessons. No
instruction, follow-up, or verdict in a historical document is live work.
