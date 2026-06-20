# Architecture Documents

There is exactly **one current direction**:

- **[Quasar — Effect Local Server Plan](quasar-effect-local-server-plan-2026-06-18.md)** —
  the authoritative migration architecture: Effect-owned local server, SQLite truth
  store plus durable queue, LanceDB as derived search index, Gemini embedding cache,
  and Docker/Tailscale deployment.
- **[Quasar — Data-Reality Plan](quasar-data-reality-plan-2026-06-11.md)** — still live
  as measured corpus evidence and normalized entity-model source: provider reality,
  turn-mapping rules, redaction requirements, and the store-at-read-grain lesson.

Operational deployment lives outside this architecture folder:

- **[Local-server Docker + Tailscale runbook](../operations/local-server-docker-tailscale.md)** —
  Mac mini Docker compose, Tailscale-IP access, persistent volumes, secrets, backup,
  restore, and launchd cutover.

Abandoned architecture documents are not part of the active tree. Use the two
documents above plus the operations runbook as the current contract.
