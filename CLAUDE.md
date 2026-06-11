# CLAUDE.md

Read `AGENTS.md` first — it is the binding contract for all agents in this
repository, and it encodes the hard-won lessons of two demolished
architectures. Nothing below overrides it.

Claude-specific notes:

- Load the `convex` skill family before touching Convex code, the `effect`
  skill before CLI/pipeline work, and `consolidation-engineering` before any
  cleanup or migration decision.
- Work items live in Tower (project `quasar`, forge orbit). Read the glyph
  before building; it is the source of truth for scope, gates, and escalation.
- When a gate is red or a Convex limit fires: stop, record the measurement,
  escalate. Do not engineer around it (AGENTS.md, Law 1).
- Prefer deleting over deprecating. One canonical path, always
  (AGENTS.md, Law 4).
