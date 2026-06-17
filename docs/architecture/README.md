# Architecture Documents

There is exactly **one current direction**:

- **[Quasar — Data-Reality Plan](quasar-data-reality-plan-2026-06-11.md)** — the
  authoritative architecture: measured corpus reality, the three principles (Convex
  limits are the contract; store at the grain you read; indexing is a separate decision
  from storing), the entity model (projects → sessions → messages + toolCalls),
  per-provider turn-mapping rules, ingest pipeline, and the LanceDB search cutover.
- **[Convex Grain — Quasar v2 Verdicts](convex-grain-quasar-v2.md)** — platform rulings
  for building on self-hosted Convex: mutation chunking, index-only reads, OLTP-only
  scope, idempotency, migration policy, component boundaries.

Everything else in this directory is **historical**: post-mortems, plans, and
measurement reports from the abandoned eras (the session-blob import era, the
record-stream compaction era, and the sync-contract/byte-gate era). They are preserved
as evidence and lessons. No instruction, follow-up, or verdict in a historical document
is live work.

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
All of it is minable at commit `7f0daf1` as failure evidence. The HTTP auth/body-cap
patterns may still be useful; the embedding outbox / RAG sync / readiness modules and
the architecture around them stay dead.

The sync-contract era artifacts were deleted on 2026-06-11 at QSR-053:
`packages/core/src/sync-contract.ts`, `packages/core/test/sync-contract.test.ts`, and
`scripts/check-sync-contract.ts` (the byte-floor measurement harness). They are minable
from git history at the commit preceding the QSR-053 reorientation. Their one durable
finding — tool events must be single-carried, never duplicated across message and
tool-call rows — lives on as a mapping rule in the data-reality plan.
