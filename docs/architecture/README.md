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

## Graveyard

The abandoned record-stream ingest plane was deleted from the tree on 2026-06-10. Its
knowledge remains minable from git history at commit `167fad8` (the last commit before
demolition): the v1 record taxonomy and envelope machinery
(`packages/core/src/records.ts`), the adapter record bridge
(`packages/core/src/adapters/record-stream.ts`), the CLI ingest ledger and runner
(`packages/cli/src/ledger.ts`, `packages/cli/src/ingest/`), the Convex record ingest
endpoint (`apps/control/convex/quasarRecordIngest.ts`), and the six zero-data provider
adapters (`amp`, `pi`, `kimi`, `droid`, `antigravity`, `cursor` under
`packages/core/src/adapters/`). Mine for parsing knowledge and test discipline; never
restore the architecture.

The remaining v1-shaped substrate was deleted the same day at commit `7f0daf1`'s
successor: the entire Convex control app and dashboard (`apps/control/` — schema,
read/search handlers, embedding outbox/RAG/readiness modules, HTTP routes, deploy and
Tailscale scripts) and the CLI server client and server-backed commands
(`packages/cli/src/api.ts`, `config.ts`, `commands/{ingest,search,sessions,tool-calls,projects}.ts`).
All of it is minable at commit `7f0daf1`. The embedding outbox / RAG sync / readiness
modules and the HTTP auth/body-cap patterns are the high-value mining targets for the
v2 Convex build; the architecture around them stays dead.
