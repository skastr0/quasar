# Quasar — Agent Contract

Read this before touching anything. It encodes the lessons of two failed
architectures (~16,000 lines built and demolished). The rules below are not
style preferences; each one maps to a specific, measured disaster.

## What this is

Quasar ingests local AI-agent session histories (Claude Code, Codex, OpenCode,
Grok, Hermes), prunes provider noise, and serves fusion search (BM25 +
embeddings + RRF) and deep session inspection to agents — via a CLI, MCP
tools, and a self-hosted Convex backend on this machine, reached over
Tailscale.

**Current state (honest):** `packages/core` holds provider parsing,
normalization, and redaction; `packages/cli` holds local read-only commands
(doctor, capabilities, schema, examples, sources discover). There is no
server, no ingest, and no search in this tree yet — the v2 build sequence
creates them fresh against measured gates.

## The one rule

**No work may build on an assumption that a cheaper step could have
measured.** Both prior architectures died from storage shapes decided before
they were measured. Measure first, on real data, then build.

## Laws (each one a dead architecture's tombstone)

1. **Escalate, never absorb.** Any Convex rejection (document size, mutation
   time, scan budget, OCC), crash, OOM, or byte amplification above a gate
   HALTS the work. These are guardrails doing their job. Record the
   measurement, surface it, and request a written shape decision. Never bypass
   a limit, raise a knob to hide a symptom, or add machinery to pass a gate.
2. **Boundary rejection, not robust handling.** Every contract field declares
   a reasonable expectation (clamp band + absurdity bound). Inputs past the
   absurdity bound are not large values — they are not the thing the field
   models. They get classified as named provider garbage or quarantined with a
   loud diagnostic, and produce zero domain records. Never write "robustly
   handle X" where X is outside the domain; use bounded/branded types so
   out-of-bound values are unrepresentable.
3. **The gate denominator is frozen.** Byte gates measure against
   product-required text (messages + tool payloads, counted once). Cutting
   fidelity to pass a gate fails the gate by definition. Only a human may
   revise the denominator.
4. **No interim surfaces.** This project has no users. A command or endpoint
   exists only when its backend works — no `not_ready` placeholders, no
   parked stubs, no compatibility shims, no dual paths. Delete what you
   replace, in the same change.
5. **Storage equals consumption.** Every stored field maps to a serving
   endpoint or it does not get stored. The previous system stored 3.5x what
   its product consumed.
6. **Gates are executable, not prose.** Acceptance criteria that cannot fail
   mechanically (CI test, measured number) will be rationalized away under
   momentum — that is how the first architecture shipped with rubber-stamp
   reviews. Build the harness before the feature.

## Stop-the-line signals

Any one of these means stop and write a shape decision before the next commit:

- More than ~40% of recent commits rework the immediately previous commit's files.
- A second consecutive work item exists to move the same metric.
- Anyone proposes reducing product fidelity to pass a gate.
- Work items are being authored in batches, minutes apart, with no feedback between them.

All four fired loudly before both disasters.

## Canonical direction

Exactly one: `docs/architecture/quasar-v2-greenfield-plan-2026-06-10.md` plus
`docs/architecture/convex-grain-quasar-v2.md`. Every other architecture
document is historical (banner-marked) — no instruction in a historical
document is live work.

Work is tracked in Tower (project `quasar`, forge orbit). Read the board for
the active sequence; glyphs are buildable cold and carry their own gates,
dependencies, and escalation rules. Never put board identifiers into code,
tests, schemas, fixtures, or file paths.

## History mining

The two dead architectures are minable from git history — see the Graveyard
section of `docs/architecture/README.md` for commits and paths (v1 ingest
plane, ledger, Convex app, embedding outbox, zero-data adapters). Mine
parsing knowledge, protocol discipline, and test patterns. **Never restore
the architecture around them.** The six zero-data provider adapters return
only when real data and a consuming endpoint exist.

## Working here

- Runtime: bun. Validation: `bun run typecheck && bun run test` at the root
  (covers packages/core and packages/cli). Keep it green through every change.
- CLI is Effect + @effect/cli with JSON envelopes; load the `effect` and
  `agentic-cli-authoring` skills for that work.
- Convex work: load the `convex` skills (quickstart, performance-audit,
  migration-helper, create-component) and follow the grain doc's rulings —
  index-only reads (`.filter()` is banned on growing tables), small chunked
  mutations, actions for side effects only, vector search in actions only.
- Adapters: provider knowledge stays inside the provider's adapter; the shared
  layer owns only normalized types, truncation markers, and binary detection.
  Extraction is read-only against native history; redaction is a mandatory
  safety line; live SQLite sources are read without locks that stall the
  owning agent.
- Commit hygiene: atomic conventional commits; never commit secrets, session
  data, or tailnet hostnames.
