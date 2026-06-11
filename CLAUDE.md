# CLAUDE.md

Read `AGENTS.md` first — it is the binding contract for all agents in this
repository. Nothing below overrides it.

Claude-specific notes:

- Load the `convex` skill family before touching Convex code, the `effect`
  skill before CLI/pipeline work, and `consolidation-engineering` before any
  cleanup or migration decision.
- Work items live in Tower (project `quasar`, forge orbit), sequence
  QSR-053..062. Read the glyph before building; it is the source of truth for
  scope and acceptance.
- A Convex limit firing on ingested data means the value is provider garbage:
  emit a named diagnostic, write zero rows, continue. Never add machinery
  around it, and never invent byte budgets of our own (AGENTS.md, principle 1).
- Prefer deleting over deprecating. One canonical path, always.

<!-- convex-ai-start -->

This project uses [Convex](https://convex.dev) as its backend.

When working on Convex code, **always read
`convex/_generated/ai/guidelines.md` first** for important guidelines on
how to correctly use Convex APIs and patterns. The file contains rules that
override what you may have learned about Convex from training data.

Convex agent skills for common tasks can be installed by running
`npx convex ai-files install`.

<!-- convex-ai-end -->
