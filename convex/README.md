# Quasar Convex App

Functions for the self-hosted Quasar backend.

- `schema.ts` — projects / sessions / messages / toolCalls. Convex owns OLTP
  rows only; LanceDB owns the next search indexes.
- `quasar.ts` — ingest mutations (session-grain claims, delete-then-reinsert)
  and the serving queries (session reads, tool-call walks, project/session
  listings).
- `convex.config.ts` — plain Convex app definition; no RAG or Workpool
  components.

Batteries: `quasar.test.ts`, `consumption.test.ts` (vitest) and
`scripts/verify/convex-lint.ts` (grain rulings + no Convex search indexes).
