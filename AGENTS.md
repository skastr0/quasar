# Quasar — Agent Contract

Read this before touching anything. It is short because the project is, in truth,
simple — five previous architectures failed by refusing to believe that.

## What this is

Quasar ingests local AI-agent session histories (Claude Code, Codex, OpenCode, Grok,
Hermes, Antigravity), prunes provider noise, and serves deep session inspection —
including targeted tool-call retrieval — to agents via a CLI, MCP tools, and a
local Effect server on the Mac mini, reached over Tailscale. SQLite is the truth store,
durable queue, and lexical search (FTS5) index. Semantic search is served from a resident
f16 vector matrix scanned via SIMD (simsimd FFI).

## The data reality (measured 2026-06-11, full corpus, every row parsed)

The entire five-provider estate is **≈ 1.8 GB raw → ≈ 650 MB of product text**
(claude 35 MB, codex 240 MB, opencode ~300 MB, hermes ~20 MB, grok ~5 MB; ~2,360
sessions). **No legitimate session value over 1 MB exists anywhere** — a session is
context-window-bounded, so a single turn physically cannot approach the storage
boundaries that matter for this project. Anything that does is provider garbage, not
data.

## Three principles

1. **Measured data is the contract.** Never invent caps, clamps, gates,
   amplification ratios, or byte budgets. The local store should accept legitimate
   session data directly. A value beyond measured corpus reality is provider garbage:
   emit a named diagnostic `(provider, sessionId, field, observedBytes)`, write zero
   rows for that session, continue. Boundary rejection, never "robust handling."
2. **Store at the grain you read.** Rows are turns. Reading a session is a paginated
   index walk in `seq` order. No chunking, compaction, or reconstruction layers.
3. **Indexing is a separate decision from storing.** `messages` in SQLite is the
   product text source for search indexing. Lexical search is trigger-maintained in FTS5.
   Semantic search uses the resident f16 vector matrix loaded from `message_vectors`.
   `toolCalls` is the structural surface — full inputs/outputs stored, retrieved by
   `(projectKey, toolName)` or `(sessionId, seq)`, and **never search-indexed or embedded**
   by default, so tool payloads cannot pollute session search.

If you find yourself designing byte budgets, ratios, compaction, clamp taxonomies, or
"robust handling" of oversized data: stop. You are repeating a documented failure
mode. The corpus is ~650 MB. Think in absolute megabytes, and measure real data before
any shape decision.

## Canonical direction

Exactly one implementation direction:
`docs/architecture/quasar-effect-server-plan-2026-06-18.md` for the service graph and domain model,
and `docs/architecture/quasar-first-principles-rearchitecture-2026-07-03.md` for the SQLite FTS5
and resident f16 vector matrix search substrate. The measured corpus facts and normalized entity
model in `docs/architecture/quasar-data-reality-plan-2026-06-11.md` remain live evidence.

Work is tracked in Tower (project `quasar`, forge orbit), current migration sequence
QSR-096..108. Read
the glyph before building; never put board identifiers into code, tests, schemas,
fixtures, or file paths.

## Working here

- Runtime: bun. Validation: `bun run typecheck && bun run test` at the root. Keep it
  green through every change.
- Local server and CLI are Effect-first; load the `effect` and
  `agentic-cli-authoring` skills for that work. Use services/layers, one
  ManagedRuntime, typed errors, Effect Schema at boundaries, and bounded workers.
- Redaction (`redactSensitive` in core) is a mandatory safety line on every ingested
  text. Live SQLite sources are read without locks that could stall the owning agent.
- Provider knowledge stays inside the provider's adapter; the shared layer owns only
  normalized types.
- Prefer deleting over deprecating. One canonical path; delete what you replace in
  the same change. No placeholder or `not_ready` surfaces — this project has no users
  yet.
- Commit hygiene: atomic conventional commits; never commit secrets, session data, or
  tailnet hostnames.
