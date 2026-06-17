# Convex Grain — Quasar v2 Verdicts

Date: 2026-06-10; updated 2026-06-17 after retiring Convex Searchlight/RAG. General
Convex guidance (Zen rules, full limits table, self-hosted ops, anti-grain warnings)
lives in the global `convex` skill; this doc now holds the **Quasar-specific Convex
OLTP rulings**. Search indexing belongs to LanceDB, not Convex.

## Hosting decision recap

Convex is **self-hosted on this machine**, SQLite persistence, pinned backend version,
served to agents over Tailscale. It owns projects, sessions, messages, and tool-call
rows only. Searchlight/RAG components are not part of the Quasar backend.

## Verdicts on v2 plan assumptions (each checked against current limits)

**(a) Envelopes ≤512 KiB / ≤800 records — legal, but chunk the mutations.**
Limits give huge headroom (16 MiB args, 16k docs written/mutation), but mutations have a
**1-second execution cap** and the Zen budget is "< a few hundred records, < 100ms."
Ruling: keep the 512 KiB envelope at the transport level; the receiving path commits in
chunks of **~200–400 records per mutation**, checkpointing progress per chunk. On a
single-writer ingest path OCC conflicts are unlikely — this is about the 1s cap, not
contention.

**(b) Convex search/vector indexes — retired for Quasar.**
Do not add `searchIndex`, `vectorIndex`, RAG components, or embedding Workpool state to
the Convex app. LanceDB owns FTS/vector indexes and indexing state.

**(c) LanceDB search access from Convex — action boundary.**
Convex actions may call the in-repo LanceDB client for filesystem-backed search work.
There is no separate Bun HTTP daemon and no client-side embedding control surface.

**(d) Paginated session reads — exactly the blessed pattern.**
`.withIndex("by_session", …).paginate(paginationOpts)`; cap `numItems` and let the
CLI/MCP client loop cursors. Never `.collect()` a session's messages.

**(e) Embedding outbox + scheduled drain — not in Convex.**
The old Convex embedding queue, cron, RAG component, and Workpool are deleted. LanceDB
indexing owns any future embed/backfill/invalidation lifecycle explicitly.

**(f) Ingest entry: prefer `ConvexHttpClient` → public mutation over an HTTP action.**
The CLI is a trusted local client; calling a public mutation directly is more idiomatic
(argument validators do the parsing; less hand-rolled auth/retry). Caveat: self-hosted
has no scoped deploy keys — the admin key grants everything, including internal
functions. Ruling: public ingest mutation guarded by an in-function **shared secret**
argument + Tailscale-only network exposure; the admin key never leaves the server. The
ingest mutation must be **idempotent on envelope/record identity** because the caller
retries (v2's key-based always-write upserts already satisfy this).

**(g) Hybrid/fusion search belongs to LanceDB.**
The endpoint shape is re-decided by the LanceDB search glyphs. Convex remains the OLTP
source and action host, not the index store.

## Plan-doc adjustments these rulings imply

- §4 ingest endpoint: "POST /sync HTTP action" → CLI `ConvexHttpClient` calling a public
  mutation with shared-secret arg; transport envelope unchanged; server-side commit
  chunking at 200–400 records.
- §4 reads: session/tool-call reads stay Convex queries; search is reintroduced through
  LanceDB.
- §4 embeddings: no Convex embedding state. LanceDB owns indexing state and rebuilds.
- Beachhead gates: self-hosted backend running under a pinned version with restart
  policy; no Convex search/RAG components; reachable from a second tailnet device.
- Ops invariants: pinned image, export-before-upgrade, `--disable-beacon` optional,
  single-node accepted, disaster recovery remains `quasar sync --rebuild` from source
  files (the server stays disposable; exports are a convenience, not a dependency).

## Rulings from the installed Convex skill suite (added 2026-06-10)

The machine now carries official-style Convex skills (`convex-quickstart`,
`convex-performance-audit`, `convex-migration-helper`, `convex-create-component`,
`convex-setup-auth`, plus a routing `convex` skill) alongside `effect`. Reviewed against
the v2 plan; no decision is overturned. Refinements:

**(h) Beachhead additions.** Run `npx convex ai-files install` in the repo so the managed
official Convex guidelines are in place for every future agent (routing-skill
recommendation). Use `npx convex dev --once` as the agent validation loop (pushes schema +
functions, typechecks, regenerates types, exits cleanly). Verify whether
`npx convex insights --details` works against the self-hosted backend; if not, perf gates
fall back to code audit per the performance-audit skill.

**(i) Index-only read discipline, stated stronger.** Convex's own `.filter()` does NOT
push predicates to storage — it costs the same as JS filtering and still burns the
scanned-documents budget. Every Convex read path over a growing table uses
`.withIndex()` only; `.filter()` is banned on tables that grow with the corpus.
Also: no redundant
prefix indexes (`by_foo` + `by_foo_and_bar`) — the planned index set already complies;
keep it that way when adding filters.

**(j) Mutation batching pattern confirmed verbatim.** The 200–400-record commit chunks
and the cursor-continuation cascade delete are exactly the skill's "self-scheduling
internalMutation chain" pattern (function-budget reference). Note the 1s mutation cap
covers user code only (DB ops excluded), which gives slack — but chunking stays.

**(k) Hot-document and digest-table restraint.** Session-doc rollups (eventCount, usage)
are patched on every ingest envelope — acceptable because v2 has no reactive subscribers
(CLI/MCP are point-in-time readers via ConvexHttpClient) and a single writer. Per the
performance-audit guardrails: no digest/summary tables, no document splitting, no
structural work without a measured signal. (This guardrail is also the anti-pattern #9
antidote: it forbids speculative complexity in Convex's own official voice.)

**(l) Migration policy.** v2 cutover needs no migration machinery — no live data was ever
written (the migration-helper skill's own "greenfield schema" exclusion). Post-launch
breaking schema changes have two paths: (1) **wipe + `quasar sync --rebuild`** — preferred
while re-ingest is cheap, since source files are the fidelity store; (2)
**widen-migrate-narrow with a migration tool** — adopt only when rebuild stops being
cheap. Search/vector rebuild cost belongs to LanceDB's lifecycle, not Convex RAG state.

**(m) Component boundary rules.**
Quasar currently uses no Convex components. Future components must prove real isolation
or reuse value; app-owned ingest and LanceDB orchestration stay app code.

## The one-line reconciliation with history

The 42 GB incident was our data shape, not Convex: we stored what no query consumed and
shipped blobs through a transactional engine. Every ruling above is the inverse move —
store only what queries consume, keep transactions small, let the sync engine do the
caching. That is "really understanding the opinionated architecture," operationalized.
