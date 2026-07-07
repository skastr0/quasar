# Architecture Documents

There is exactly **one current direction**:

- **[Quasar — First-Principles Re-Architecture Map](quasar-first-principles-rearchitecture-2026-07-03.md)** —
  the authoritative architecture: SQLite as the whole data plane (truth, durable
  queue, scoped-token FTS5, `message_vectors`), a resident f16 vector matrix with
  an exact-scan SIMD kernel for semantic/fusion, a local fp32 query embedder, and
  Docker/Tailscale deployment. LanceDB and the readiness gate were deleted on
  2026-07-04 (proof receipts in `../proofs/`).
- **[Quasar — Data-Reality Plan](quasar-data-reality-plan-2026-06-11.md)** — still live
  as measured corpus evidence and normalized entity-model source: provider reality,
  turn-mapping rules, redaction requirements, and the store-at-read-grain lesson.

Superseded (kept for provenance, no longer the direction):

- **[Quasar — Effect Local Server Plan](quasar-effect-server-plan-2026-06-18.md)** —
  the 2026-06 migration architecture (LanceDB derived index era). Its SQLite
  truth-store and queue design carried forward; its LanceDB search half did not.

Operational deployment lives outside this architecture folder:

- **[Local-server Docker + Tailscale runbook](../operations/server-docker-tailscale.md)** —
  Mac mini Docker compose, Tailscale-IP access, persistent volumes, secrets, backup,
  restore, and launchd cutover.

Abandoned architecture documents are not part of the active tree. Use the two
documents above plus the operations runbook as the current contract.
