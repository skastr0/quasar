# CLAUDE.md

Read `AGENTS.md` first — it is the binding contract for all agents in this
repository. Nothing below overrides it.

Claude-specific notes:

- Load the `effect` skill before CLI/pipeline work and
  `consolidation-engineering` before any cleanup or migration decision.
- Work items live in Tower (project `quasar`, forge orbit), sequence
  QSR-096..108 and successors. Read the glyph before building; it is the source of truth for
  scope and acceptance.
- Provider garbage at the ingest boundary emits a named diagnostic, writes zero
  rows for that session, and continues. Never add invented byte budgets
  (AGENTS.md, principle 1).
- Prefer deleting over deprecating. One canonical path, always.
